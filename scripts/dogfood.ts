// just dogfood --yes-live: the PR question from the proposal, end to end with real agents. Alice, Bob and Carol
// share the workspace `team` and the channel `backend`. Bob and Carol answer with Codex (gpt-6-luna, low effort,
// through codex-acp, with the owner's normal setup) from their own sandbox repo; every gatekeeper uses the real
// Jev. Grants are realistic: allowed code and PR topics, a denied private topic, a posture rule, auto_answer for
// Alice and for #backend.
//
//   DM:      Alice's agent asks Bob's whether PR 812 changes the schema; Bob runs `watch --once --answer`.
//   Channel: Alice broadcasts the same question to #backend. Bob runs two `watch --once --answer` at once (the
//            claim lets only one answer); Carol runs one. Each answers once.
//
// Budget: 3 codex_acp units, spent one at a time just before each consumer that starts Codex; 24 jev units
// reserved up front (every gate in the instance asks the real Jev). Evidence: .verify/live/dogfood-<timestamp>/.
//
// The same flow runs deterministically as the scenario `dogfood-fake`: the fake ACP agent instead of Codex and
// the fake Jev instead of Jev. It proves the recipe, not the models.
import { existsSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { budgetLeft, readBudget, spend } from "./lib/budget";
import { codexSmokeEnv, preflightCodex, SMOKE_EFFORT, SMOKE_MODEL } from "./lib/codex";
import { EXIT_BUDGET_SPENT, EXIT_FAIL, EXIT_NO_KEY, liveGate } from "./lib/live";
import { SANDBOX_DIR, SECRETS_FILE, VERIFY_DIR } from "./lib/paths";
import { makeSandboxRepo } from "./lib/sandbox";
import { runScenario, type Scenario, type Transcript } from "./lib/scenario";
import { REPO } from "./lib/paths";
import type { FakeJevFixture } from "../test/fakes/fake-jev";
import { readSecret } from "./lib/secrets";

export const JEV_UNITS = 24;
const CODEX_UNITS = 3;

const topics = `    allow: ["code, pull requests, schema changes, migrations, CI and releases of the team's repositories"]
    deny: ["my salary, compensation and personal finances"]
    posture: ["never promise dates or commitments on my behalf"]`;
export const RESPONDER_GRANTS = `defaults:
  kinds: [question, request, heads-up]
contacts:
  alice:
    auto_answer: true
${topics}
channels:
  backend:
    auto_answer: true
${topics}
`;
const ALICE_GRANTS = `defaults:
  deny: ["my health"]
`;

export const QUESTION =
  "Does PR 812 change the database schema of the notifications service? If it does, which tables and columns change? " +
  "I'm building the notification digest and need to know before I write my query.";

type Mode = "live" | "fake";
const ctx = { mode: "live" as Mode, key: "", repos: {} as Record<string, string>, codex: {} as Record<string, Record<string, string>>, spent: 0, answers: [] as { who: string; ms: number }[] };
const liveEnv = (): Record<string, string> => (ctx.mode === "live" ? { TYPESAFE_API_KEY: ctx.key, PATIO_JEV_MAX_RETRIES: "0" } : {});

// The fake run: everything benign, the posture followed.
const FAKE_JEV: FakeJevFixture = { default: { type: "noul", noul: 0.02 }, answers: { allow: { type: "noul", noul: 0.98 }, posture_0: { type: "noul", noul: 0.97 } } };
// Several lines, as real agents answer: a reply is not one line of `wait`'s output.
const FAKE_REPLY =
  "Yes. PR 812 (branch pr-812-notification-preferences) changes the schema in db/migrations/0042_notification_preferences.sql:\n\n" +
  "- adds notifications.channel\n- creates the table notification_preferences";

const responder = (handle: string) => ({
  handle,
  channels: ["backend"],
  grants: RESPONDER_GRANTS,
  get env() {
    return liveEnv();
  },
  agentConfig: async (dir: string) => {
    const root = dirname(dir);
    const repo = join(SANDBOX_DIR, `${basename(root)}-${handle}-repo`);
    await makeSandboxRepo(repo, handle);
    ctx.repos[handle] = repo;
    if (ctx.mode === "live") {
      ctx.codex[handle] = codexSmokeEnv(join(root, `${handle}-codex-acp-logs`));
      return `agent: codex\ncwd: ${JSON.stringify(repo)}\n`;
    }
    // The fake agent works for 1.5 s, so Bob's two consumers really overlap.
    ctx.codex[handle] = {};
    const fixture = join(root, `${handle}-fake-acp.json`);
    await writeFile(fixture, JSON.stringify({ reply: FAKE_REPLY, delayMs: 1500 }));
    return `agent: ${JSON.stringify(`${process.execPath} ${join(REPO, "test/fakes/fake-acp-agent.ts")} --fixture ${fixture}`)}\ncwd: ${JSON.stringify(repo)}\n`;
  },
});

async function until<T>(what: string, fn: () => T | null | undefined | false, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await Bun.sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// Waits for an agent's input gate to decide on a message of `convo`; approves it once if the gate held it.
async function inputDecision(t: Transcript, agent: string, convo: string) {
  const entry = await until(`${agent}'s input gate on ${convo.slice(0, 8)}`, () => t.gateLog(agent, false).find((l) => l.direction === "in" && l.convo === convo && !l.by));
  if (entry.verdict === "ask-human") {
    const res = await t.webPost(agent, `/gates/${entry.message_id}/decide`, { decision: "approve" });
    t.note(`**${agent}'s input gate held the message** (${entry.reason}, rule ${entry.rule}); ${agent}'s owner approved it once: ${res.ok ?? res.error}`);
  }
  return entry;
}

async function spendCodex(t: Transcript) {
  if (ctx.mode === "fake") return;
  const left = await spend("codex_acp");
  ctx.spent++;
  t.note(`Spent 1 codex_acp unit (${ctx.spent} in this run); ${left} left.`);
}

const replyLine = (stderr: string) => {
  const line = stderr.split("\n").find((l) => l.startsWith("agent reply: "));
  return line ? (JSON.parse(line.slice("agent reply: ".length)) as string) : null;
};
// The migration or the new table: "channel" alone also matches the PR's title ("per channel"), which an agent can quote
// without having found the change (Carol's answer in the increment 10 live run did).
const SCHEMA = /0042|notification_preferences/i;

// Each answer runs in a disposable git worktree of the responder's sandbox repo (the default since increment 9):
// `answer` says so, and `watch --answer` reports what the agent changed there, which was discarded.
function workdirReport(t: Transcript, who: string, r: { stdout: string; stderr: string }) {
  const line = r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((x) => x.result === "answered");
  t.expect(`${who} answered in a disposable worktree of its repo`, r.stderr.includes("in a disposable worktree of "), r.stderr.split("\n").find((l) => l.startsWith("answering ")) ?? "");
  t.expect(`${who}'s watch --answer reports the discarded changes`, Array.isArray(line?.discarded), JSON.stringify(line));
  const said = r.stderr.split("\n").find((l) => l.startsWith("discarded changes: ") || l === "the agent changed nothing in its worktree");
  t.note(`**Discarded-changes report for ${who}:** ${JSON.stringify(line?.discarded)} (stderr: ${said ?? "none"})`);
}

const scenario = (mode: Mode): Scenario => ({
  name: mode === "live" ? "dogfood" : "dogfood-fake",
  description:
    mode === "live"
      ? `Live: the PR question by DM and in #backend. Bob and Carol answer with Codex (${SMOKE_MODEL}, ${SMOKE_EFFORT} effort) through \`patio watch --once --answer\`; every gate uses the real Jev.`
      : "The dogfood flow with test doubles: the PR question by DM and in #backend, answered by the fake ACP agent through `patio watch --once --answer`, gated with the fake Jev. Bob runs two consumers at once; the claim lets one answer.",
  label: mode === "live" ? "live" : "deterministic",
  jev: mode === "live" ? null : FAKE_JEV,
  // The mode is set here, before the instance starts: the rules, env and agents' files depend on it.
  agents: () => (ctx.mode = mode) && [
    {
      handle: "alice",
      channels: ["backend"],
      grants: ALICE_GRANTS,
      get env() {
        return liveEnv();
      },
    },
    responder("bob"),
    responder("carol"),
  ],
  async run(t) {
    if (mode === "live") {
      const pre = await preflightCodex(ctx.repos.bob!, ctx.codex.bob!);
      t.note(`Preflight (no prompt, no budget): codex-acp reports model \`${pre.model}\`, effort \`${pre.effort}\`, starting mode \`${pre.current_mode}\`.`);
      t.expect(`codex-acp uses ${SMOKE_MODEL} at ${SMOKE_EFFORT} effort`, pre.ok, `${pre.model}/${pre.effort}`);
      if (!pre.ok) return;
    }

    // ---- DM ----
    t.note("## Direct message");
    const ask = await t.cli("alice", ["ask", "bob", QUESTION, "--repo", "orbit-backend", "--pr", "812"]);
    t.expect("Alice's question passes her output gate", ask.code === 0, `${ask.code} ${ask.stderr}`);
    const dmIn = await inputDecision(t, "bob", ask.stdout);
    t.expect("Bob's input gate did not reject it", dmIn.verdict !== "reject", JSON.stringify(dmIn));
    await spendCodex(t);
    const w = await t.cli("bob", ["watch", "--once", "--answer"], 600_000, ctx.codex.bob);
    ctx.answers.push({ who: "bob (DM)", ms: w.ms });
    const result = w.stdout ? JSON.parse(w.stdout.split("\n")[0]!) : null;
    t.expect("Bob's watch --once --answer answered it", result?.result === "answered", w.stdout || w.stderr.slice(-800));
    t.audit("bob", w.stderr);
    workdirReport(t, "Bob (DM)", w);
    const dm = await t.cli("alice", ["wait", ask.stdout, "--timeout", "60"]);
    t.expect("Alice gets Bob's answer", dm.code === 0 && dm.stdout.startsWith("bob: "), dm.stdout.slice(0, 800));
    t.expect("the answer says what PR 812 changes in the schema", SCHEMA.test(dm.stdout), dm.stdout.slice(0, 800));
    t.expect("the answer cites no absolute path", !/(^|[\s(`])\/(home|Users|tmp)\//.test(dm.stdout), dm.stdout.slice(0, 400));
    const bobOut = t.gateLog("bob", false).find((l) => l.direction === "out" && l.convo === ask.stdout && !l.by);
    const aliceIn = t.gateLog("alice", false).find((l) => l.direction === "in" && l.convo === ask.stdout && l.kind === "reply");
    t.expect("the answer passed Bob's output gate and Alice's input gate", bobOut?.verdict === "send" && aliceIn?.verdict === "deliver", `${bobOut?.verdict} ${aliceIn?.verdict}`);

    // ---- Channel ----
    t.note("## Channel #backend");
    const bc = await t.cli("alice", ["ask", "--channel", "backend", QUESTION, "--repo", "orbit-backend", "--pr", "812"]);
    t.expect("the broadcast goes to Bob and Carol", bc.code === 0 && bc.stderr.includes("sent to 2 agents of #backend"), bc.stderr);
    for (const who of ["bob", "carol"]) {
      const d = await inputDecision(t, who, bc.stdout);
      t.expect(`${who}'s input gate applied the channel's grant and did not reject it`, d.verdict !== "reject" && d.grant === "channels.backend", JSON.stringify(d));
    }
    // Two consumers on Bob's machine at once: the claim lets only one start Codex and answer.
    await spendCodex(t);
    const [b1, b2] = await Promise.all([
      t.cli("bob", ["watch", "--once", "--answer"], 600_000, ctx.codex.bob),
      t.cli("bob", ["watch", "--once", "--answer"], 600_000, ctx.codex.bob),
    ]);
    const bobResults = [b1, b2].flatMap((r) => r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l)));
    t.expect(
      "of Bob's two consumers, one answered and the other did not answer (claimed, or nothing pending)",
      bobResults.filter((r) => r.result === "answered").length === 1 && bobResults.every((r) => r.result === "answered" || r.result === "already_claimed"),
      JSON.stringify(bobResults),
    );
    const winner = [b1, b2].find((r) => r.stdout.includes('"answered"'))!;
    ctx.answers.push({ who: "bob (#backend)", ms: winner.ms });
    t.audit("bob", winner.stderr);
    workdirReport(t, "Bob (#backend)", winner);
    t.expect("Codex started once on Bob's machine for the broadcast", [b1, b2].filter((r) => r.stderr.includes("answering ")).length === 1);
    await spendCodex(t);
    const c = await t.cli("carol", ["watch", "--once", "--answer"], 600_000, ctx.codex.carol);
    ctx.answers.push({ who: "carol (#backend)", ms: c.ms });
    t.expect("Carol's watch --once --answer answered it", c.stdout.includes('"answered"'), c.stdout || c.stderr.slice(-800));
    t.audit("carol", c.stderr);
    workdirReport(t, "Carol (#backend)", c);
    const wait = await t.cli("alice", ["wait", bc.stdout, "--timeout", "60"]);
    t.expect("Alice's wait returns the answers", wait.code === 0, wait.stdout.slice(0, 1200));
    // Replies span several lines, so they are read whole from Alice's inbox.
    const answers = (await t.cli("alice", ["inbox", "--all", "--json"])).stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.kind === "reply" && m.convo === bc.stdout);
    t.expect("Alice gets one answer from Bob and one from Carol", answers.map((a) => a.from).sort().join() === "bob,carol", answers.map((a) => a.from).join());
    t.expect("both answers say what PR 812 changes in the schema", answers.length === 2 && answers.every((a) => SCHEMA.test(a.text)), answers.map((a) => a.text).join("\n---\n").slice(0, 1500));
    const outs = ["bob", "carol"].map((who) => t.gateLog(who, false).find((l) => l.direction === "out" && l.convo === bc.stdout && !l.by));
    t.expect("both answers passed their output gates under the channel's grant", outs.every((o) => o?.verdict === "send" && o.grant === "channels.backend"), JSON.stringify(outs.map((o) => [o?.verdict, o?.grant])));
    t.expect("Alice's inbox has exactly two replies to the broadcast", answers.length === 2, String(answers.length));
    for (const who of ["bob", "carol"]) t.expect(`${who}'s sandbox repo is unchanged`, gitStatus(ctx.repos[who]!) === "", gitStatus(ctx.repos[who]!));
    const workdirs = ["bob", "carol"].flatMap((who) => t.gateLog(who, false).filter((l) => l.rule === "workdir"));
    t.expect("the audit logs have one discarded worktree per answer (3)", workdirs.length === 3 && workdirs.every((l) => l.verdict === "discarded"), JSON.stringify(workdirs));
    for (const who of ["bob", "carol"]) {
      const left = Bun.spawnSync(["git", "worktree", "list"], { cwd: ctx.repos[who]! }).stdout.toString().trim().split("\n");
      t.expect(`${who}'s repo has no worktree left`, left.length === 1, left.join(" | "));
    }

    // ---- Costs ----
    const homes = Object.values(t.m.agents);
    const jev = homes.reduce((n, a) => n + t.gateLog(a.handle, false).filter((l) => l.jev?.request_id).length, 0);
    const ms = homes.flatMap((a) => t.gateLog(a.handle, false).map((l) => l.jev?.ms).filter((x): x is number => typeof x === "number"));
    const costs = { codex_runs: ctx.spent, jev_requests: jev, jev_ms_median: ms.sort((a, b) => a - b)[Math.floor(ms.length / 2)] ?? null, answers: ctx.answers };
    t.note("## Costs\n\n```json\n" + JSON.stringify(costs, null, 2) + "\n```");
    await writeFile(join(t.m.root, "costs.json"), JSON.stringify(costs, null, 2) + "\n");
    for (const who of ["alice", "bob", "carol"]) t.gateLog(who);
  },
});

export const dogfood = scenario("live");
export const dogfoodFake = scenario("fake");

const gitStatus = (repo: string) => Bun.spawnSync(["git", "status", "--porcelain", "--untracked-files=all"], { cwd: repo }).stdout.toString().trim();

if (import.meta.main) {
  await liveGate("dogfood", "codex_acp", CODEX_UNITS);
  const jevLeft = budgetLeft(await readBudget(), "jev");
  if (jevLeft < JEV_UNITS) {
    console.error(`dogfood: jev budget spent (${jevLeft} left, ${JEV_UNITS} needed). Nothing was sent.`);
    process.exit(EXIT_BUDGET_SPENT);
  }
  const key = await readSecret("TYPESAFE_API_KEY");
  if (!key) {
    console.error(`dogfood: TYPESAFE_API_KEY is absent from ${SECRETS_FILE}. Nothing was sent.`);
    process.exit(EXIT_NO_KEY);
  }
  ctx.key = key;
  ctx.mode = "live";
  await spend("jev", JEV_UNITS);
  const r = await runScenario(dogfood);
  const out = join(VERIFY_DIR, "live", `dogfood-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "result.json"), JSON.stringify(r, null, 2) + "\n");
  if (r.transcript && existsSync(r.transcript)) await copyFile(r.transcript, join(out, "transcript.md"));
  const costs = join(dirname(r.transcript), "costs.json");
  if (existsSync(costs)) await copyFile(costs, join(out, "costs.json"));
  console.error(`${r.ok ? "PASS" : "FAIL"} dogfood (${r.ms} ms) transcript ${join(out, "transcript.md")}${r.error ? ` error: ${r.error}` : ""}`);
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : EXIT_FAIL);
}
