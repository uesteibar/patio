// One file per agent: $PATIO_HOME/agents/<name>.yaml. It says which coding tool answers for the agent and from which
// folder (`patio answer`, `patio watch --answer`), and the agent's rules (grants.ts): one set of rules per agent,
// whatever the workspace a message comes from:
//
//   tool: claude                # codex | claude | pi | hermes-docker | gemini | "<any command that speaks ACP>"
//   folder: ~/code/orbit        # where it answers from
//   in_place: false             # true: in the folder itself, not in a disposable git worktree of it
//   model: haiku                # optional: the tool's cheapest model by default
//   effort: low                 # optional
//   rules:                      # the agent's rules: what others may ask it, and what it may tell them
//     deny: ["…"]
//     contacts: { … }
//     channels: { … }
//
// There are no rules per workspace: the person decides their agent's rules, and a workspace cannot change them. The
// agent's workspaces are the server's to know (patio agents, patio status), not this file's.
//
// `~/.patio/new-agent.yaml`, when it exists, is the template a new agent's file copies (with its own tool and folder).
// Nothing is inherited between agents after that.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PRESETS } from "./agents";
import { EMPTY_GRANTS, GrantsError, parseRules, SECRETS_TOPIC, widenings, withConfirmed, type Grants, type Widening } from "./grants";
import { HANDLE_RE } from "./protocol";

export const AGENTS_DIR = "agents";
export const TEMPLATE_FILE = "new-agent.yaml";

export type AgentFile = {
  tool?: string;
  folder?: string;
  in_place?: boolean;
  model?: string;
  effort?: string;
  rules: Grants;
  // The workspaces whose join asked the person the three questions (answers.ts): a join again asks nothing.
  asked_in?: string[];
  // The third answer of `patio agents new`: answer on its own the workspaces `patio agents add` puts it in.
  answer_added?: boolean;
};

export const EMPTY_AGENT: AgentFile = { rules: EMPTY_GRANTS };

export class AgentFileError extends Error {}

export const agentFileName = (name: string) => `${AGENTS_DIR}/${name}.yaml`;
export const agentPath = (home: string, name: string) => join(home, AGENTS_DIR, `${name}.yaml`);

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const KEYS = ["tool", "folder", "in_place", "model", "effort", "rules", "asked_in", "answer_added"];

// Strict: an unknown key, a wrong type or an invalid rule is an error that names the file and the place.
export function parseAgentFile(text: string, name: string): AgentFile {
  const file = agentFileName(name);
  const fail = (message: string): never => {
    throw new AgentFileError(`${file}: ${message}`);
  };
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(text);
  } catch (err) {
    fail(`not valid YAML: ${(err as Error).message}`);
  }
  if (raw === null || raw === undefined) raw = {};
  if (!isMap(raw)) fail("it must be a map with tool, folder and rules");
  const m = raw as Record<string, unknown>;
  if (Object.hasOwn(m, "workspaces")) fail('unknown key "workspaces": an agent has one set of rules, the same in every workspace; put them under rules');
  for (const k of Object.keys(m)) if (!KEYS.includes(k)) fail(`unknown key "${k}"; use ${KEYS.join(", ")}`);
  const out: AgentFile = { rules: EMPTY_GRANTS };
  const what = { tool: `${Object.keys(PRESETS).join(", ")} or a command`, folder: "a directory", model: "a model name", effort: "an effort level, such as low" } as const;
  for (const k of Object.keys(what) as (keyof typeof what)[]) {
    const v = m[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string" || !v.trim()) fail(`${k} must be ${what[k]}`);
    out[k] = (v as string).trim();
  }
  if (m.in_place !== undefined && m.in_place !== null) {
    if (typeof m.in_place !== "boolean") fail("in_place must be true or false");
    out.in_place = m.in_place as boolean;
  }
  if (m.answer_added !== undefined && m.answer_added !== null) {
    if (typeof m.answer_added !== "boolean") fail("answer_added must be true or false");
    out.answer_added = m.answer_added as boolean;
  }
  if (m.asked_in !== undefined && m.asked_in !== null) {
    if (!Array.isArray(m.asked_in) || m.asked_in.some((w) => typeof w !== "string" || !/^[^\r\n/]{1,60}$/.test(w))) fail("asked_in must be a list of workspace names");
    out.asked_in = m.asked_in as string[];
  }
  try {
    out.rules = parseRules(m.rules, "rules");
  } catch (err) {
    if (err instanceof GrantsError) fail(err.message);
    throw err;
  }
  return out;
}

// The agent's rules as the gates apply them, whatever the workspace: with only the widening settings its owner
// turned on.
export function rulesOf(name: string, file: AgentFile, confirmed: Set<string>): Grants {
  return withConfirmed(file.rules, confirmed, name, "rules");
}

// Every setting of the file that widens what others can do, for the owner to turn on in the web app.
export function fileWidenings(name: string, file: AgentFile): Widening[] {
  return widenings(file.rules, name, "rules");
}

// ---- names and tools ----------------------------------------------------------------------------------------------

// An agent's name is its owner's login (lowercased), or starts with it and a hyphen: unai-orbit. The server enforces it.
export const ownsName = (login: string, name: string) => {
  const l = login.toLowerCase();
  return name === l || name.startsWith(`${l}-`);
};

// A valid name from free text: lowercase, letters, digits, - and _, at most 32.
export const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|-+$/g, "");

// The default name of an agent for a workspace: <login>-<workspace>.
export const defaultAgentName = (login: string, workspace: string) => `${slug(login)}-${slug(workspace) || "agent"}`.slice(0, 32).replace(/-+$/, "");

export const validName = (name: string) => HANDLE_RE.test(name);

export const TOOL_LABELS: Record<string, string> = { claude: "Claude Code", codex: "Codex", pi: "Pi", "hermes-docker": "Hermes (Docker)", gemini: "Gemini" };
export const toolLabel = (tool: string | undefined) => (tool ? (TOOL_LABELS[tool] ?? tool) : "no tool");

// The coding tool this process runs under, from what each tool sets in its children's environment, else the first one
// installed, else codex.
export function detectTool(env = process.env, which: (cmd: string) => string | null = Bun.which): string {
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return "claude";
  if (env.CODEX_SANDBOX || env.CODEX_MANAGED_BY_NPM || env.CODEX_THREAD_ID) return "codex";
  if (env.PI_CODING_AGENT || env.PI_SESSION_ID) return "pi";
  for (const t of ["claude", "codex", "pi"]) if (which(t)) return t;
  return "codex";
}

// The folder an agent answers from by default: the git repository around `cwd`, else `cwd`.
export function detectFolder(cwd = process.cwd()): string {
  const r = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd, stdout: "pipe", stderr: "ignore" });
  const top = r.exitCode === 0 ? r.stdout.toString().trim() : "";
  return top || cwd;
}

export const isGitRepo = (folder: string) =>
  Bun.spawnSync(["git", "rev-parse", "--is-inside-work-tree"], { cwd: existsSync(folder) ? folder : "/", stdout: "pipe", stderr: "ignore" }).stdout.toString().trim() === "true";

// ---- a new agent's file ---------------------------------------------------------------------------------------------

const RULES_COMMENTS = `# rules: what other people's agents may ask this agent, and what it may tell them. patio checks every message twice
# with them: what comes in, and what this agent sends. Rules written in words are asked of the judge; the thresholds
# decide. Every decision is a line in audit.jsonl. patio reads this file again when you save it; a mistake keeps the
# last valid version (patio status says so). Try a rule before it matters:
#   patio rules <agent> test "<a message>" --from <other agent>`;

// `workspace`: the workspace the agent is set up for, for the examples (the person's own, never someone else's).
export function newAgentText(o: { name: string; tool: string; folder: string; in_place?: boolean; workspace?: string }, template?: string | null): string {
  const head = `# ${agentFileName(o.name)}: the agent ${o.name}. Edit it by hand; patio reloads it when you save it.\n`;
  const lines = { tool: `tool: ${JSON.stringify(o.tool)}`, folder: `folder: ${JSON.stringify(o.folder)}` };
  const ws = o.workspace ?? "<workspace>";
  if (template) {
    // The template's text, comments and all, with this agent's tool and folder.
    let text = template;
    for (const k of ["tool", "folder"] as const) {
      const re = new RegExp(`^${k}:.*$`, "m");
      text = re.test(text) ? text.replace(re, lines[k]) : `${lines[k]}\n${text}`;
    }
    return head + text;
  }
  return `${head}# tool: who answers for it (patio answer, patio watch --answer): ${Object.keys(PRESETS).join(", ")}, or a command that
# speaks ACP. A preset uses its cheapest model at low effort; set model and effort to change them.
${lines.tool}
# folder: where it answers from, with your normal setup of that tool. In a git repository it answers in a disposable
# worktree of it (at HEAD): whatever it changes there is listed and thrown away.
${lines.folder}
# in_place: true answers in the folder itself. Only when you allow an action that has to change the real repository.
in_place: ${o.in_place ? "true" : "false"}
${RULES_COMMENTS}
rules:
  # Message kinds others may send: question, report, heads-up, request. A reply is never checked by kind.
  kinds: [question, request]
  # The judge's thresholds: at or above reject, the message is rejected (or the reply not sent); at or above ask, it
  # waits for you.
  thresholds: { reject: 0.9, ask: 0.5 }
  # When in doubt: ask-human keeps it waiting for you in the web app; reject declines it.
  on_doubt: ask-human
  # Requests to do something beyond answering (change files, run commands, send messages): deny, ask-human, or a list
  # of the actions you allow, e.g. ["run the test suite"]. A list widens what others can do to this agent, so it
  # applies only once you turn it on in the web app.
  actions: ask-human
  # Topics nobody may ask this agent about, and it may not reveal. patio always denies the first one, even if you
  # remove it here.
  deny:
    - "${SECRETS_TOPIC}"
  # true lets the answer service answer on its own. Like an actions list, it applies only once you turn it on in the
  # web app; better per contact than here. auto_answer_in: [${ws}] answers the agents of ${ws} on its own instead (your
  # answer to the join's third question writes it, and turns it on).
  auto_answer: false
  # More: per_day: 20, allow: ["code, PRs and deployments of my team's repos"], posture: ["never promise a date for me"]
  # contacts:
  #   <their agent>: { auto_answer: true }
  # channels:
  #   ${ws}/<channel>: { allow: ["PR and deployment status"] }
`;
}
