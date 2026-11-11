// One file per agent (agents/<name>.yaml): its tool, folder and rules (one set, whatever the workspace); parsed strictly.
// Which tool answers a message, and where: the receiving agent's file, with command flags over it.
import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { hermesLoggedIn, resolveAgent } from "../src/agents";
import { AgentFileError, defaultAgentName, fileWidenings, newAgentText, ownsName, parseAgentFile, rulesOf } from "../src/agent-file";
import { grantFor, SECRETS_TOPIC } from "../src/grants";

const FILE = `
tool: codex
folder: ~/code/orbit
rules:
  kinds: [question, report]
  deny: ["salaries"]
  contacts:
    jorge-claude: { per_day: 5, auto_answer: true }
`;
const file = parseAgentFile(FILE, "unai-orbit");
const all = new Set(fileWidenings("unai-orbit", file).map((w) => w.key));

test("an agent's file holds its tool, folder and one set of rules, for every workspace", () => {
  expect(file).toMatchObject({ tool: "codex", folder: "~/code/orbit" });
  expect(grantFor(rulesOf("unai-orbit", file, all), { contact: "pablo-x" })).toMatchObject({ kinds: ["question", "report"], per_day: null, deny: ["salaries"] });
  expect(grantFor(rulesOf("unai-orbit", file, all), { contact: "jorge-claude" })).toMatchObject({ per_day: 5, auto_answer: true, deny: ["salaries"] });
});

test("a workspace cannot change an agent's rules: a file with rules per workspace is refused", () => {
  const yaml = `${FILE}workspaces:\n  orbit:\n    rules:\n      per_day: 50\n`;
  expect(() => parseAgentFile(yaml, "unai-orbit")).toThrow(AgentFileError);
  expect(() => parseAgentFile(yaml, "unai-orbit")).toThrow('agents/unai-orbit.yaml: unknown key "workspaces": an agent has one set of rules, the same in every workspace; put them under rules');
});

test("settings that widen what others can do are confirmed per agent", () => {
  const w = fileWidenings("unai-orbit", file);
  expect(w.map((x) => x.key)).toEqual(["unai-orbit:rules.contacts.jorge-claude.auto_answer"]);
  expect(w[0]!.text).toBe("unai-orbit answers jorge-claude's questions and requests on its own (auto_answer)");
  // Not turned on: left out. Turned on for another agent: still left out.
  expect(grantFor(rulesOf("unai-orbit", file, new Set()), { contact: "jorge-claude" }).auto_answer).toBe(false);
  expect(grantFor(rulesOf("unai-orbit", file, new Set(["unai-side:rules.contacts.jorge-claude.auto_answer"])), { contact: "jorge-claude" }).auto_answer).toBe(false);
});

test("a file with a mistake fails loudly, naming the file and the place", () => {
  for (const [yaml, err] of [
    ["agent: codex", 'agents/unai-x.yaml: unknown key "agent"'],
    ["tool: 3", "agents/unai-x.yaml: tool must be"],
    ["in_place: yes please", "agents/unai-x.yaml: in_place must be true or false"],
    ["rules:\n  on_doubt: maybe", "agents/unai-x.yaml: rules: on_doubt must be ask-human or reject"],
    ["rules:\n  contacts:\n    Bad Name: {}", 'agents/unai-x.yaml: rules.contacts: "Bad Name" is not an agent name'],
    ["rules: { kinds: [gossip] }", "agents/unai-x.yaml: rules: kinds must list some of"],
    ["rules: { thresholds: { reject: 0.6, ask: 0.8 } }", "rules: thresholds.ask (0.8) must not be above thresholds.reject (0.6)"],
    ["- a list", "agents/unai-x.yaml: it must be a map"],
  ] as const) {
    expect(() => parseAgentFile(yaml, "unai-x"), yaml).toThrow(AgentFileError);
    expect(() => parseAgentFile(yaml, "unai-x"), yaml).toThrow(err);
  }
  expect(parseAgentFile("", "unai-x")).toEqual({ rules: { defaults: {}, contacts: {}, channels: {} } });
});

test("a new agent's file is commented and valid; a template is copied with the new agent's tool and folder", () => {
  const text = newAgentText({ name: "unai-side", tool: "claude", folder: "/srv/side" });
  const f = parseAgentFile(text, "unai-side");
  expect(f).toMatchObject({ tool: "claude", folder: "/srv/side", in_place: false });
  expect(f.rules.defaults.deny).toEqual([SECRETS_TOPIC]);
  expect(text).toContain("# rules: what other people's agents may ask this agent");
  const template = "# my template\ntool: codex\nfolder: /tmp\nrules:\n  per_day: 9\n";
  const copy = parseAgentFile(newAgentText({ name: "unai-side", tool: "pi", folder: "/srv/side" }, template), "unai-side");
  expect(copy).toMatchObject({ tool: "pi", folder: "/srv/side", rules: { defaults: { per_day: 9 } } });
});

test("names: an agent's name is its owner's login, or starts with it and a hyphen; the default is <login>-<workspace>", () => {
  expect(ownsName("unai", "unai-orbit")).toBe(true);
  expect(ownsName("Unai", "unai")).toBe(true);
  expect(ownsName("unai", "unaix")).toBe(false);
  expect(ownsName("unai", "pablo-orbit")).toBe(false);
  expect(defaultAgentName("Unai", "Orbit Team")).toBe("unai-orbit-team");
  expect(defaultAgentName("a-very-long-github-login", "and-a-long-workspace-name")).toHaveLength(32);
});

const one = (yaml: string, folder = "/srv/repo") => {
  const r = resolveAgent("unai-x", parseAgentFile(`${yaml}\nfolder: ${folder}`, "unai-x"), {});
  if ("error" in r) throw new Error(r.error);
  return r;
};

test("the receiving agent's tool and folder answer; flags win; presets expand to their command", () => {
  expect(one("tool: codex", "~/code/default")).toMatchObject({ name: "codex", command: [process.execPath, "x", "@agentclientprotocol/codex-acp@2.5.0"], cwd: join(homedir(), "code/default"), source: "agents/unai-x.yaml" });
  expect(resolveAgent("unai-x", { tool: "codex", folder: "/a" }, { tool: "gemini", folder: "/tmp/x" })).toMatchObject({ command: ["gemini", "--acp"], cwd: "/tmp/x", source: "flags" });
  expect(resolveAgent("unai-x", {}, {})).toEqual({ error: "no tool for unai-x: set tool and folder in agents/unai-x.yaml, or pass --tool and --folder" });
  expect(resolveAgent("unai-x", { tool: "codex" }, {})).toEqual({ error: "no folder for unai-x: set folder in agents/unai-x.yaml, or pass --folder" });
});

test("each responder preset sets its command and the cheapest model at low effort", () => {
  expect(one("tool: codex")).toMatchObject({ model: "gpt-6-luna", effort: "low", env: { CODEX_CONFIG: JSON.stringify({ model: "gpt-6-luna", model_reasoning_effort: "low" }) } });
  expect(one("tool: claude")).toMatchObject({ command: [process.execPath, "x", "@agentclientprotocol/claude-agent-acp@0.101.0"], model: "haiku", effort: "low" });
  const pi = one("tool: pi");
  expect(pi).toMatchObject({ command: [process.execPath, "x", "pi-acp@0.0.34"], model: "anthropic/claude-haiku-5-5", effort: "low" });
  expect(Object.hasOwn(pi.env, "PI_CODING_AGENT_DIR") && pi.env.PI_CODING_AGENT_DIR === undefined).toBe(true);
});

test("the hermes-docker preset mounts the working directory read-only at /work and waits at least 60 s to start", () => {
  const r = one("tool: hermes-docker", "/srv/repo");
  expect(r.command).toEqual(["docker", "run", "--rm", "-i", "-v", "patio-hermes-test-home:/opt/data", "-v", "/srv/repo:/work:ro", "patio-hermes-test:local", "hermes", "acp"]);
  expect(r).toMatchObject({ cwd: "/srv/repo", sessionCwd: "/work", model: null, effort: "low" });
  expect(r.startTimeoutMs).toBeGreaterThanOrEqual(60_000);
});

test("model and effort override the preset's; a command has none unless set; in_place runs in the folder itself", () => {
  expect(one("tool: codex\nmodel: gpt-6\neffort: medium")).toMatchObject({ model: "gpt-6", effort: "medium", env: { CODEX_CONFIG: JSON.stringify({ model: "gpt-6", model_reasoning_effort: "medium" }) } });
  expect(one('tool: "bunx my-acp"')).toMatchObject({ name: "command", command: ["bunx", "my-acp"], sessionCwd: "/srv/repo", model: null, effort: null, env: {} });
  expect(one("tool: codex\nin_place: true")).toMatchObject({ inPlace: true });
  expect(one("tool: codex")).toMatchObject({ inPlace: false });
  expect(resolveAgent("unai-x", { tool: "codex", folder: "/r" }, { in_place: true })).toMatchObject({ inPlace: true });
});

test("Hermes counts as logged in only when its handshake offers its runtime credentials, not just the setup login", () => {
  const setup = { id: "hermes-setup", name: "Configure Hermes provider", type: "terminal", args: ["--setup"], description: "Open Hermes' interactive model/provider setup" };
  expect(hermesLoggedIn({ protocolVersion: 1, authMethods: [setup] } as never)).toBe(false);
  expect(hermesLoggedIn({ protocolVersion: 1 } as never)).toBe(false);
  expect(hermesLoggedIn({ protocolVersion: 1, authMethods: [{ id: "anthropic", name: "anthropic runtime credentials", description: null }, setup] } as never)).toBe(true);
});
