// just responders --yes-live [--only <name>] | --fake: the responder matrix. One instance; Alice asks Bob the PR
// schema question from the dogfood and a follow-up that needs a file read, and Bob answers each with one responder
// after another, through his real gates and Jev:
//
//   codex          codex-acp, gpt-6-luna at low effort (CODEX_CONFIG)
//   claude         claude-agent-acp, Claude Haiku 5.5 (haiku) at low effort (session options)
//   pi             pi-acp over `pi --mode rpc`, anthropic/claude-haiku-5-5 at low thinking, default Pi agent dir
//   hermes-docker  `hermes acp` in Docker, its own HERMES_HOME in a volume, the sandbox mounted read-only
//
// Bob's agent's file names the preset (`tool: <name>`) and nothing else, so the run tests the presets as a user
// would write them. The question goes through `patio watch --once --answer`, the follow-up through `patio answer`.
//
// Before any message, each responder gets a handshake (initialize and session/new, model and effort set, no
// prompt, nothing spent). A responder that is not logged in (Hermes without a login in its volume) is reported as
// skipped, not failed, and no message is sent for it.
//
// Checked per answer: fixed expected facts in the reply Alice receives, tool calls, seconds, and the sandbox repo
// against its pristine copy (no file may change). Also checked once: the agents' global configuration files are
// unchanged, and no Hermes container is left running.
//
// Live budget: 1 unit of the responder's kind (codex_acp, claude_acp, pi_acp, hermes_acp) spent just before each
// answer; 8 jev units reserved per message up front (every gate in the instance asks the real Jev), for Hermes only
// once a login is found. --fake: the fake
// ACP agent in place of each responder (Hermes's not-logged-in handshake included) and the fake Jev; it proves the
// recipe, not the models. Evidence: .verify/live/responders-<timestamp>/table.md, results.json, transcript.md.
//
// Exit 0 when every responder that ran answered correctly with no file change (and skipped ones are skipped only
// for a missing login), 1 otherwise.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { handshake, type Handshake } from "../src/acp";
import { HERMES_IMAGE, HERMES_LOGIN_DOC, PRESETS, presetAgent } from "../src/agents";
import { QUESTION, RESPONDER_GRANTS } from "./dogfood";
import { budgetLeft, readBudget, spend, type BudgetKind } from "./lib/budget";
import { gitState } from "./lib/git";
import { stop, up, type AgentSpec, type Manifest } from "./lib/instance";
import { EXIT_BUDGET_SPENT, EXIT_FAIL, EXIT_NO_FLAG, EXIT_NO_KEY } from "./lib/live";
import { REPO, SANDBOX_DIR, SECRETS_FILE, VERIFY_DIR } from "./lib/paths";
import { makeSandboxRepo, restoreSandbox, sandboxChanges } from "./lib/sandbox";
import { Transcript } from "./lib/scenario";
import { readSecret } from "./lib/secrets";
import type { Fixture } from "../test/fakes/fake-acp-agent";
import type { FakeJevFixture } from "../test/fakes/fake-jev";

export const RESPONDERS = ["codex", "claude", "pi", "hermes-docker"] as const;
export type Responder = (typeof RESPONDERS)[number];
const KIND: Record<Responder, BudgetKind> = { codex: "codex_acp", claude: "claude_acp", pi: "pi_acp", "hermes-docker": "hermes_acp" };
export const JEV_PER_MESSAGE = 8;
export const SKIPPED_LOGIN = `skipped: needs login (see ${HERMES_LOGIN_DOC})`;

export const FOLLOW_UP = "Follow-up: according to the release notes in that repo, how often are email notifications batched in release 2.4?";

// Fixed expected facts: the question needs the migration on the PR branch, the follow-up the release notes.
export const QUESTIONS = [
  { id: "schema", via: "watch --once --answer", text: QUESTION, ctx: ["--repo", "orbit-backend", "--pr", "812"], facts: [/notification_preferences/i, /\bchannel\b/i] },
  { id: "follow-up", via: "answer", text: FOLLOW_UP, ctx: ["--repo", "orbit-backend"], facts: [/\b(5|five)[\s-]*min/i] },
] as const;

export const factsHold = (reply: string | null, facts: readonly RegExp[]) => !!reply && facts.every((f) => f.test(reply));

// The agents' own global configuration, which a responder run must not change. Session logs are not included.
const GLOBAL_CONFIG = [".codex/config.toml", ".claude/settings.json", ".pi/agent/settings.json", ".pi/agent/models.json", ".hermes/config.yaml"].map((p) => join(homedir(), p));
const fingerprint = () =>
  Object.fromEntries(GLOBAL_CONFIG.map((f) => [f.replace(homedir(), "~"), existsSync(f) ? createHash("sha256").update(readFileSync(f)).digest("hex").slice(0, 16) : "absent"]));

const hermesContainers = () =>
  Bun.spawnSync(["docker", "ps", "-q", "--filter", `ancestor=${HERMES_IMAGE}`]).stdout.toString().trim().split("\n").filter(Boolean);

// --fake: each responder is the fake ACP agent with the session options its preset sets; Hermes offers only the
// setup login, as the real container without a login does.
const FAKE_JEV: FakeJevFixture = { default: { type: "noul", noul: 0.02 }, answers: { allow: { type: "noul", noul: 0.98 }, posture_0: { type: "noul", noul: 0.97 } } };
function fakeFixture(name: Responder): Fixture {
  const p = PRESETS[name]!;
  return {
    ...(name === "hermes-docker" && { authMethods: [{ id: "hermes-setup", name: "Configure Hermes provider", type: "terminal", args: ["--setup"] } as never] }),
    configOptions: [
      ...(p.model ? [{ id: "model", category: "model", current: "default", options: ["default", p.model] }] : []),
      { id: "effort", category: "thought_level", current: "high", options: ["low", "medium", "high"] },
    ],
    steps: [
      { id: "mig", tool: "execute", title: "git show pr-812-notification-preferences:db/migrations/0042_notification_preferences.sql", permission: false },
      { id: "notes", tool: "read", title: "Read docs/release-notes.md", path: "docs/release-notes.md", permission: false },
    ],
    reply:
      "PR 812 adds the column notifications.channel and the table notification_preferences (db/migrations/0042_notification_preferences.sql). " +
      "Release 2.4 batches email notifications every 5 minutes (docs/release-notes.md).",
  };
}

export type Answer = {
  question: string;
  via: string;
  result: string | null;
  input: string | null;
  output: string | null;
  reply: string | null;
  correct: boolean;
  // What the answer's own run logged: `model "<m>", effort "<e>"`.
  model: string | null;
  tools: number | null;
  tool_lines: string[];
  seconds: number;
  error: string | null;
};

export type Row = {
  responder: Responder;
  handshake: (Handshake & { ms: number }) | null;
  handshake_error: string | null;
  skipped: string | null;
  answers: Answer[];
  file_changes: string[];
};

const until = async <T>(what: string, fn: () => T | null | undefined | false | Promise<T | null | undefined | false>, ms = 60_000): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await Bun.sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const replyOf = (stderr: string) => {
  const line = stderr.split("\n").find((l) => l.startsWith("agent reply: "));
  return line ? (JSON.parse(line.slice("agent reply: ".length)) as string) : null;
};
const toolCount = (stderr: string) => {
  const m = /agent finished \([^)]*\), (\d+) tool calls?/.exec(stderr);
  return m ? Number(m[1]) : null;
};

async function run(opts: { live: boolean; key: string; out: string; only: Responder[] }) {
  const ctx = { repo: "", root: "" };
  const liveEnv: Record<string, string> = opts.live ? { TYPESAFE_API_KEY: opts.key, PATIO_JEV_MAX_RETRIES: "0" } : {};
  const bob: AgentSpec = {
    handle: "bob",
    grants: RESPONDER_GRANTS,
    env: liveEnv,
    agentConfig: async (dir) => {
      ctx.root = dirname(dir);
      ctx.repo = join(SANDBOX_DIR, `${basename(ctx.root)}-bob-repo`);
      await makeSandboxRepo(ctx.repo, "bob");
      return "";
    },
  };
  const alice: AgentSpec = { handle: "alice", grants: 'defaults:\n  deny: ["my health"]\n', env: liveEnv };
  const m: Manifest = await up([alice, bob], { jev: opts.live ? null : FAKE_JEV });
  const t = new Transcript(m);
  const rows: Row[] = [];
  const bobHome = m.agents.bob!.home;
  const fixtures = join(ctx.root, "fake-responders");
  try {
    for (const name of opts.only) {
      await restoreSandbox(ctx.repo);
      t.note(`## ${name}`);
      const row: Row = { responder: name, handshake: null, handshake_error: null, skipped: null, answers: [], file_changes: [] };
      rows.push(row);
      // What Bob's agent's file says: the preset by name (live), or the fake agent with the preset's model and effort.
      const preset = PRESETS[name]!;
      let yaml = `tool: ${name}\nfolder: ${JSON.stringify(ctx.repo)}\n`;
      let launch = presetAgent(name, ctx.repo);
      if (!opts.live) {
        await mkdir(fixtures, { recursive: true });
        const fixture = join(fixtures, `${name}.json`);
        await writeFile(fixture, JSON.stringify(fakeFixture(name)));
        const cmd = `${process.execPath} ${join(REPO, "test/fakes/fake-acp-agent.ts")} --fixture ${fixture}`;
        yaml = `tool: ${JSON.stringify(cmd)}\nfolder: ${JSON.stringify(ctx.repo)}\n${preset.model ? `model: ${JSON.stringify(preset.model)}\n` : ""}effort: ${preset.effort}\n`;
        launch = { ...presetAgent(cmd, ctx.repo, { model: preset.model ?? undefined, effort: preset.effort ?? undefined }), loggedIn: preset.loggedIn };
      }
      // The tool changes; the rules Bob's file already has (auto_answer for Alice) stay.
      const file = join(bobHome, "agents", "bob.yaml");
      const kept = existsSync(file) ? ((Bun.YAML.parse(readFileSync(file, "utf8")) ?? {}) as Record<string, unknown>) : {};
      await mkdir(join(bobHome, "agents"), { recursive: true });
      await writeFile(file, JSON.stringify({ ...kept, tool: undefined, folder: undefined, model: undefined, effort: undefined, ...(Bun.YAML.parse(yaml) as Record<string, unknown>) }, null, 2) + "\n");
      t.note("Bob's agents/bob.yaml:\n\n```yaml\n" + yaml.trimEnd() + "\n```");

      // Handshake: initialize and session/new, model and effort set, no prompt.
      const h0 = Date.now();
      try {
        const h = await handshake({ ...launch, log: (l) => void (l.startsWith("agent stderr") || t.lines.push(`    [handshake] ${l}`)) });
        row.handshake = { ...h, ms: Date.now() - h0 };
        t.note(`Handshake (no prompt) in ${row.handshake.ms} ms: \`${JSON.stringify(row.handshake)}\``);
      } catch (err) {
        row.handshake_error = (err as Error).message;
        t.note(`**Handshake failed:** ${row.handshake_error}`);
        continue;
      }
      if (!row.handshake.logged_in) {
        row.skipped = SKIPPED_LOGIN;
        t.note(`**${row.skipped}**`);
        continue;
      }
      // Hermes's Jev units are reserved only once a login is found.
      if (opts.live && name === "hermes-docker") await spend("jev", JEV_PER_MESSAGE * QUESTIONS.length);

      for (const q of QUESTIONS) {
        const a: Answer = { question: q.id, via: q.via, result: null, input: null, output: null, reply: null, correct: false, model: null, tools: null, tool_lines: [], seconds: 0, error: null };
        row.answers.push(a);
        try {
          const ask = await t.cli("alice", ["ask", "bob", q.text, ...q.ctx]);
          if (ask.code !== 0) throw new Error(`Alice's ask exited ${ask.code}: ${ask.stderr.slice(-300)}`);
          const convo = ask.stdout;
          const inp = await until(`Bob's input gate on ${convo.slice(0, 8)}`, () => t.gateLog("bob", false).find((l) => l.direction === "in" && l.convo === convo && !l.by));
          a.input = `${inp.verdict}${inp.rule ? ` (${inp.rule})` : ""}`;
          if (inp.verdict === "ask-human") {
            const res = await t.webPost("bob", `/gates/${inp.message_id}/decide`, { decision: "approve" });
            a.input += `, approved by Bob: ${res.ok ?? res.error}`;
          } else if (inp.verdict !== "deliver") throw new Error(`Bob's input gate: ${a.input}`);
          const item = await until("Bob's inbox", async () =>
            (await t.cli("bob", ["inbox", "--json"])).stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((x) => x.convo === convo),
          );
          if (opts.live) {
            const kind = KIND[name];
            if (budgetLeft(await readBudget(), kind) < 1) throw new Error(`${kind} budget spent`);
            const left = await spend(kind);
            t.note(`Spent 1 ${kind} unit; ${left} left.`);
          }
          const env: Record<string, string> = name === "codex" ? { APP_SERVER_LOGS: join(ctx.root, "codex-acp-logs") } : {};
          const args = q.via === "answer" ? ["answer", item.id] : ["watch", "--once", "--answer"];
          const r = await t.cli("bob", args, 600_000, env);
          a.seconds = Math.round(r.ms / 100) / 10;
          a.result = q.via === "answer" ? (r.code === 0 ? "answered" : `exit ${r.code}`) : (r.stdout ? JSON.parse(r.stdout.split("\n")[0]!).result : `exit ${r.code}`);
          a.tool_lines = t.audit("bob", r.stderr).tools;
          a.tools = toolCount(r.stderr);
          a.model = /\[agent\] (model "[^\n]*)/.exec(r.stderr)?.[1] ?? null;
          const out = t.gateLog("bob", false).find((l) => l.direction === "out" && l.convo === convo && !l.by);
          a.output = out ? `${out.verdict}${out.rule ? ` (${out.rule})` : ""}` : null;
          const got = await t.cli("alice", ["wait", convo, "--timeout", "30"]);
          // Replies span lines: read the whole text from Alice's inbox.
          const reply = (await t.cli("alice", ["inbox", "--all", "--json"])).stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((x) => x.kind === "reply" && x.convo === convo);
          a.reply = reply?.text ?? null;
          a.correct = factsHold(a.reply, q.facts);
          if (a.result !== "answered") a.error = `${a.result}: ${(/"reason":"([^"]*)"/.exec(r.stdout)?.[1] ?? r.stderr.split("\n").filter((l) => !l.startsWith("[agent]")).slice(-2).join(" ")).slice(0, 300)}`;
          else if (got.code !== 0) a.error = `Alice's wait exited ${got.code}`;
          else if (!a.correct) a.error = `expected facts missing (agent said: ${JSON.stringify((replyOf(r.stderr) ?? "").slice(0, 200))})`;
        } catch (err) {
          a.error = (err as Error).message;
        }
        t.note("```json\n" + JSON.stringify(a, null, 2) + "\n```");
      }
      row.file_changes = sandboxChanges(ctx.repo);
      t.note(`Sandbox changes after ${name}: ${row.file_changes.length ? row.file_changes.join(", ") : "none"}.`);
    }
    t.gateLog("alice");
    t.gateLog("bob");
  } finally {
    await stop(m);
    await writeFile(join(opts.out, "transcript.md"), [`# responders, ${opts.live ? "live" : "fake (test doubles)"}`, "", `Instance \`${m.id}\`.`, "", ...t.lines].join("\n"));
  }
  return rows;
}

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ");

export function rowOk(r: Row): boolean {
  if (r.handshake_error) return false;
  if (r.skipped) return r.skipped === SKIPPED_LOGIN && r.handshake?.session === true;
  return r.answers.length === QUESTIONS.length && r.answers.every((a) => a.correct && !a.error) && r.file_changes.length === 0;
}

export function tableLines(rows: Row[]): string[] {
  const lines = ["| Responder | Model | Question | Answer correct | Tool calls | Seconds | File changes in the sandbox | Errors |", "|---|---|---|---|---|---|---|---|"];
  for (const r of rows) {
    const model = r.handshake ? `${r.handshake.model ?? "(its own)"}, effort ${r.handshake.effort ?? "(its own)"}` : "?";
    const changes = r.file_changes.length ? r.file_changes.join(", ") : "none";
    if (r.handshake_error || r.skipped) {
      lines.push(`| ${r.responder} | ${esc(model)} | none | ${r.skipped ? "skipped" : "no"} | - | - | ${r.skipped ? "none (no prompt)" : "-"} | ${esc(r.handshake_error ? `handshake failed: ${r.handshake_error}` : `${r.skipped}; handshake OK (initialize ${r.handshake!.initialize_ms} ms, session/new ${r.handshake!.session_ms} ms)`)} |`);
      continue;
    }
    for (const a of r.answers)
      lines.push(`| ${r.responder} | ${esc(a.model ?? model)} | ${a.question} (${a.via}) | ${a.correct ? "yes" : "no"} | ${a.tools ?? "?"} | ${a.seconds} | ${changes} | ${esc(a.error ?? "none")} |`);
  }
  return lines;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const fake = argv.includes("--fake");
  const live = !fake;
  const onlyArg = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;
  const only = RESPONDERS.filter((r) => !onlyArg || r === onlyArg);
  if (!only.length) {
    console.error(`responders: --only takes ${RESPONDERS.join(", ")}`);
    process.exit(EXIT_FAIL);
  }
  let key = "";
  if (live) {
    if (!argv.includes("--yes-live")) {
      console.error("responders makes paid live calls. Re-run with --yes-live, or --fake for the test doubles.");
      process.exit(EXIT_NO_FLAG);
    }
    const b = await readBudget();
    const jev = JEV_PER_MESSAGE * QUESTIONS.length * only.filter((r) => r !== "hermes-docker").length;
    const short = [["jev", jev] as const, ...only.map((r) => [KIND[r], QUESTIONS.length] as const)].filter(([k, n]) => k !== "hermes_acp" && budgetLeft(b, k) < n);
    if (short.length) {
      console.error(`responders: budget spent (${short.map(([k, n]) => `${k}: ${budgetLeft(b, k)} left, ${n} needed`).join("; ")}). Nothing was sent.`);
      process.exit(EXIT_BUDGET_SPENT);
    }
    key = (await readSecret("TYPESAFE_API_KEY")) ?? "";
    if (!key) {
      console.error(`responders: TYPESAFE_API_KEY is absent from ${SECRETS_FILE}. Nothing was sent.`);
      process.exit(EXIT_NO_KEY);
    }
    if (jev) await spend("jev", jev);
  }
  const at = new Date().toISOString();
  const out = join(VERIFY_DIR, "live", `responders-${fake ? "fake-" : ""}${at.replace(/[:.]/g, "-")}`);
  await mkdir(out, { recursive: true });
  const before = fingerprint();
  const budgetBefore = await readBudget();
  const started = Date.now();
  let rows: Row[] = [];
  let error: string | undefined;
  try {
    rows = await run({ live, key, out, only });
  } catch (err) {
    error = err instanceof Error ? (err.stack ?? err.message) : String(err);
  }
  const after = fingerprint();
  const configChanged = Object.keys(before).filter((k) => before[k] !== after[k]);
  const leftovers = live && only.includes("hermes-docker") ? hermesContainers() : [];
  const budgetAfter = await readBudget();
  const runs = {
    codex_acp: budgetAfter.codex_acp.build_used - budgetBefore.codex_acp.build_used,
    claude_acp: budgetAfter.responders.claude_acp.used - budgetBefore.responders.claude_acp.used,
    pi_acp: budgetAfter.responders.pi_acp.used - budgetBefore.responders.pi_acp.used,
    hermes_acp: budgetAfter.responders.hermes_acp.used - budgetBefore.responders.hermes_acp.used,
  };
  const ok = !error && rows.length === only.length && rows.every(rowOk) && configChanged.length === 0 && leftovers.length === 0;
  const git = await gitState();
  const md = [
    `# responders: ${ok ? "PASS" : "FAIL"}${live ? " (live: real responders, real Jev in every gate)" : " (fake: test doubles, not live evidence)"}`,
    "",
    `Revision \`${git.revision.slice(0, 12)}\`${git.dirty ? " (dirty)" : ""}, ${at}, ${Math.round((Date.now() - started) / 1000)} s. Runs: ${Object.entries(runs).map(([k, v]) => `${k} ${v}`).join(", ")}.${error ? ` **Error:** ${error.split("\n")[0]}` : ""}`,
    "",
    `Question (\`watch --once --answer\`): "${QUESTION}" Expected: notification_preferences and channel.`,
    "",
    `Follow-up (\`answer\`): "${FOLLOW_UP}" Expected: 5 minutes.`,
    "",
    ...tableLines(rows),
    "",
    "## Handshakes (initialize and session/new, no prompt)",
    "",
    "| Responder | Agent | Logged in | Model | Effort | Mode | initialize | session/new |",
    "|---|---|---|---|---|---|---|---|",
    ...rows.map((r) =>
      r.handshake
        ? `| ${r.responder} | ${r.handshake.agent ? `${r.handshake.agent.name} ${r.handshake.agent.version}` : "?"} | ${r.handshake.logged_in ? "yes" : "no"} | ${r.handshake.model ?? "-"} | ${r.handshake.effort ?? "-"} | ${r.handshake.mode ?? "-"} | ${r.handshake.initialize_ms} ms | ${r.handshake.session_ms} ms |`
        : `| ${r.responder} | failed: ${esc(r.handshake_error ?? "")} | | | | | | |`,
    ),
    "",
    "## Other checks",
    "",
    `- [${configChanged.length ? " " : "x"}] the agents' global configuration is unchanged (${Object.keys(before).join(", ")})${configChanged.length ? `: changed ${configChanged.join(", ")}` : ""}`,
    ...(live && only.includes("hermes-docker") ? [`- [${leftovers.length ? " " : "x"}] no ${HERMES_IMAGE} container left running${leftovers.length ? `: ${leftovers.join(", ")}` : ""}`] : []),
    "",
  ].join("\n");
  await writeFile(join(out, "table.md"), md);
  await writeFile(join(out, "results.json"), JSON.stringify({ ok, live, at, revision: git.revision, dirty: git.dirty, runs, config_changed: configChanged, leftovers, error: error ?? null, rows }, null, 2) + "\n");
  console.error(`${ok ? "PASS" : "FAIL"} responders; report ${join(out, "table.md")}`);
  console.log(md);
  process.exit(ok ? 0 : EXIT_FAIL);
}
