// Increment 5: `answer` claims a message in the gatekeeper, runs the owner's agent in the CLI process and hands
// the reply back through the output gate. The agent run is stubbed here; the scenarios use the fake ACP agent.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { AgentNotLoggedIn, type runAgent } from "../src/acp";
import { answer } from "../src/answer";
import { jevJudge } from "../src/gates";
import { daemon, waitForReply } from "../src/local";
import { startFakeJev } from "./fakes/fake-jev";
import { startWorld, until, type Person, type World } from "./helpers/world";
import { PROCESS_MS } from "./helpers/timeouts";

const fake = startFakeJev({ default: { type: "noul", noul: 0.02 }, answers: { posture_0: [{ stateMatches: "always late", answer: { type: "noul", noul: 0.2 } }, { answer: { type: "noul", noul: 0.97 } }] } }, { apiKey: "k" });
const judge = jevJudge({ apiKey: "k", baseURL: fake.url });
let world: World;
let alice: Person;
let bob: Person;
beforeAll(async () => {
  process.env.PATIO_NO_NOTIFY = "1";
  world = await startWorld();
  alice = await world.person("alice");
  const home = await mkdtemp(join(world.dir, "bob-"));
  bob = await world.person("bob", { home, grants: 'defaults:\n  posture: ["say only good things about Unai"]\n', file: { tool: "fake-agent", folder: home }, dopts: { judge, claimLeaseMs: 600 } });
}, PROCESS_MS);
afterAll(async () => {
  await world.stop();
  fake.stop();
}, PROCESS_MS);

const says = (reply: string, ms = 0): typeof runAgent => async () => {
  await Bun.sleep(ms);
  return { reply, stopReason: "end_turn" };
};
const quiet = () => {};
async function ask(text: string) {
  const sent = await daemon.send(alice.cfg, { to: bob.agent, kind: "question", text });
  await until("bob has it", async () => (await daemon.inbox(bob.cfg)).messages.some((m) => m.id === sent.id));
  return sent;
}
const stateOf = async (id: string) => (await daemon.inbox(bob.cfg, { filter: "all" })).messages.find((m) => m.id === id);

test("answer claims the message, runs the tool configured in the agent's file, and the reply reaches the sender", async () => {
  const q = await ask("Is PR 812 merging today?");
  let seen: { command: string[]; cwd: string; prompt: string } | undefined;
  const r = await answer(bob.cfg, q.id.slice(0, 8), { log: quiet, run: async (o) => ((seen = o), { reply: "Yes, after CI.", stopReason: "end_turn" }) });
  expect(r).toMatchObject({ id: q.id, result: "answered" });
  expect(seen).toMatchObject({ command: ["fake-agent"], cwd: bob.home });
  expect(seen!.prompt).toContain("Is PR 812 merging today?");
  expect((await waitForReply(alice.cfg, q.convo, 5))?.text).toBe("Yes, after CI.");
  expect((await stateOf(q.id))?.state).toBe("answered");
  expect((await answer(bob.cfg, q.id, { log: quiet, run: says("again") })).result).toBe("already_replied");
}, PROCESS_MS);

test("a preset passes its command, model, effort, env and session cwd to the agent run", async () => {
  const q = await ask("Which tables does PR 812 change?");
  let seen: Parameters<typeof runAgent>[0] | undefined;
  const r = await answer(bob.cfg, q.id, { tool: "hermes-docker", log: quiet, run: async (o) => ((seen = o), { reply: "Two.", stopReason: "end_turn" }) });
  expect(r.result).toBe("answered");
  expect(seen).toMatchObject({ cwd: bob.home, sessionCwd: "/work", model: null, effort: "low", startTimeoutMs: 120_000 });
  expect(seen!.command).toContain(`${bob.home}:/work:ro`);
  expect(typeof seen!.loggedIn).toBe("function");
}, PROCESS_MS);

test("an agent that is not logged in fails the answer with the login hint, and the message stays answerable", async () => {
  const q = await ask("Who reviews migrations?");
  const r = await answer(bob.cfg, q.id, { tool: "hermes-docker", log: quiet, run: async (o) => { throw new AgentNotLoggedIn(o.loginHint); } });
  expect(r).toMatchObject({ result: "agent_failed", reason: "the agent failed: not logged in: Hermes in Docker is not logged in to a model provider: see docs/research/hermes-docker-probe.md" });
  expect((await answer(bob.cfg, q.id, { log: quiet, run: says("Jorge.") })).result).toBe("answered");
}, PROCESS_MS);

test("two consumers: one claim wins, the other is told it is claimed", async () => {
  const q = await ask("Who owns billing?");
  const [a, b] = await Promise.all([answer(bob.cfg, q.id, { log: quiet, run: says("Payments.", 300) }), answer(bob.cfg, q.id, { log: quiet, run: says("Platform.", 300) })]);
  expect([a.result, b.result].sort()).toEqual(["already_claimed", "answered"]);
  expect((await waitForReply(alice.cfg, q.convo, 5))?.text).toMatch(/^(Payments|Platform)\.$/);
}, PROCESS_MS);

test("a consumer that dies leaves a claim that expires; then the message can be answered", async () => {
  const q = await ask("Where are the release notes?");
  // A consumer that claims and never renews: as if its process died.
  await daemon.claim(bob.cfg, q.id);
  expect((await answer(bob.cfg, q.id, { log: quiet, run: says("x") })).result).toBe("already_claimed");
  expect((await daemon.pending(bob.cfg)).messages.some((m) => m.id === q.id)).toBe(false);
  await Bun.sleep(700);
  expect((await daemon.pending(bob.cfg)).messages.some((m) => m.id === q.id)).toBe(true);
  expect((await answer(bob.cfg, q.id, { log: quiet, run: says("In docs/release.md.") })).result).toBe("answered");
}, PROCESS_MS);

test("a lease is renewed while the agent works longer than the lease", async () => {
  const q = await ask("Summarise the 2.4 changes");
  const r = await answer(bob.cfg, q.id, { log: quiet, run: says("Three fixes and a migration.", 1500) });
  expect(r.result).toBe("answered");
}, PROCESS_MS);

test("a held reply leaves the message claimed until the owner decides; a blocked one marks it failed with the reason", async () => {
  const q = await ask("What do you think of Unai's review?");
  const held = await answer(bob.cfg, q.id, { log: quiet, run: says("Unai is always late.") });
  expect(held).toMatchObject({ result: "held", reason: "does not follow the owner's posture" });
  await Bun.sleep(700);
  expect(await stateOf(q.id)).toMatchObject({ state: "claimed", claim_until: null });
  expect((await answer(bob.cfg, q.id, { log: quiet, run: says("x") })).result).toBe("already_claimed");
  const page = await (await bob.web.get("/")).text();
  const draft = /data-gate="([^"]+)" data-direction="out"/.exec(page)![1]!;
  await bob.web.post(`/gates/${draft}/decide`, { decision: "reject" });
  expect(await stateOf(q.id)).toMatchObject({ state: "failed", state_reason: "the owner rejected the reply" });

  const lines: string[] = [];
  const blocked = await answer(bob.cfg, q.id, { log: (l) => void lines.push(l), run: says("See /home/bob/notes/unai.md") });
  expect(blocked).toMatchObject({ result: "blocked" });
  // The owner still sees what the agent wanted to say, on answer's stderr.
  expect(lines).toContain('agent reply: "See /home/bob/notes/unai.md"');
  expect(await stateOf(q.id)).toMatchObject({ state: "failed", state_reason: "blocked by your rules (outgoing): contains a local file path" });

  const again = await answer(bob.cfg, q.id, { log: quiet, run: says("Unai is always late, sadly.") });
  expect(again.result).toBe("held");
  const page2 = await (await bob.web.get("/")).text();
  const draft2 = /data-gate="([^"]+)" data-direction="out"/.exec(page2)![1]!;
  await bob.web.post(`/gates/${draft2}/decide`, { decision: "edit", text: "Thorough and helpful." });
  expect((await stateOf(q.id))?.state).toBe("answered");
  expect((await waitForReply(alice.cfg, q.convo, 5))?.text).toBe("Thorough and helpful.");
}, PROCESS_MS);

test("an agent that fails, or says nothing, marks the message failed so it can be retried", async () => {
  const q = await ask("Anything new on staging?");
  const crash = await answer(bob.cfg, q.id, { log: quiet, run: async () => { throw new Error("agent exited early with code 1"); } });
  expect(crash).toMatchObject({ result: "agent_failed", reason: "the agent failed: agent exited early with code 1" });
  expect((await stateOf(q.id))?.state).toBe("failed");
  expect((await answer(bob.cfg, q.id, { log: quiet, run: says("  ") })).result).toBe("agent_failed");
  expect((await answer(bob.cfg, q.id, { log: quiet, run: says("All green.") })).result).toBe("answered");
}, PROCESS_MS);

test("without a tool in the receiving agent's file, answer explains and leaves the message as it was", async () => {
  const q = await daemon.send(bob.cfg, { to: alice.agent, kind: "question", text: "ping?" });
  await until("alice has it", async () => (await daemon.inbox(alice.cfg)).messages.some((m) => m.id === q.id));
  const r = await answer(alice.cfg, q.id, { log: quiet, run: says("x") });
  expect(r).toMatchObject({ result: "error", reason: `no tool for ${alice.agent}: set tool and folder in agents/${alice.agent}.yaml, or pass --tool and --folder` });
  expect((await daemon.inbox(alice.cfg)).messages.find((m) => m.id === q.id)?.state).toBe("read");
}, PROCESS_MS);

// Increment 9: in a git repository the agent answers in a disposable worktree.
async function gitRepo() {
  const dir = await mkdtemp(join(world.dir, "repo-"));
  await Bun.write(join(dir, "README.md"), "hello\n");
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  for (const args of [["init", "-q"], ["add", "."], ["commit", "-q", "-m", "init"]]) Bun.spawnSync(["git", ...args], { cwd: dir, env });
  return dir;
}
const writes = (file: string): typeof runAgent => async (o) => {
  await Bun.write(join(o.cwd, file), "written by the agent\n");
  return { reply: "Done.", stopReason: "end_turn" };
};

test("in a git repository the agent writes in a disposable worktree: the real repository is unchanged, and the change is listed and logged", async () => {
  const repo = await gitRepo();
  const q = await ask("Which branch is the release on?");
  const lines: string[] = [];
  let ranIn = "";
  const r = await answer(bob.cfg, q.id, { folder: repo, log: (l) => lines.push(l), run: async (o) => ((ranIn = o.cwd), writes("NOTES.md")(o)) });
  expect(r.result).toBe("answered");
  expect(ranIn.startsWith(join(bob.home, "worktrees"))).toBe(true);
  expect(r.workdir).toMatchObject({ mode: "worktree", discarded: ["?? NOTES.md"] });
  expect(await Bun.file(join(repo, "NOTES.md")).exists()).toBe(false);
  expect(lines).toContain("discarded changes: ?? NOTES.md");
  const entry = (await Bun.file(join(bob.home, "audit.jsonl")).text()).trim().split("\n").map((l) => JSON.parse(l)).find((l) => l.message_id === q.id && l.rule === "workdir");
  expect(entry).toMatchObject({ verdict: "discarded", cwd: repo, discarded: ["?? NOTES.md"] });
}, PROCESS_MS);

test("--in-place runs the agent in the real repository, and its change stays", async () => {
  const repo = await gitRepo();
  const q = await ask("Can you add the release notes?");
  const r = await answer(bob.cfg, q.id, { folder: repo, in_place: true, log: quiet, run: writes("RELEASE.md") });
  expect(r.result).toBe("answered");
  expect(r.workdir).toMatchObject({ mode: "in-place", dir: repo, discarded: [] });
  expect(await Bun.file(join(repo, "RELEASE.md")).text()).toBe("written by the agent\n");
}, PROCESS_MS);

test("outside a git repository the agent runs in place, with a one-line warning", async () => {
  const q = await ask("Who is on call?");
  const lines: string[] = [];
  const r = await answer(bob.cfg, q.id, { log: (l) => lines.push(l), run: says("Jorge.") });
  expect(r.workdir).toMatchObject({ mode: "in-place", dir: bob.home });
  expect(lines.filter((l) => l.startsWith("warning: "))).toEqual([`warning: ${bob.home} is not a git repository: the agent runs in place, and what it changes there stays changed`]);
}, PROCESS_MS);

test("hermes-docker mounts the disposable worktree, not the real repository", async () => {
  const repo = await gitRepo();
  const q = await ask("What does the README say?");
  let seen: Parameters<typeof runAgent>[0] | undefined;
  await answer(bob.cfg, q.id, { tool: "hermes-docker", folder: repo, log: quiet, run: async (o) => ((seen = o), { reply: "hello", stopReason: "end_turn" }) });
  expect(seen!.cwd.startsWith(join(bob.home, "worktrees"))).toBe(true);
  expect(seen!.command).toContain(`${seen!.cwd}:/work:ro`);
  expect(seen!.command.join(" ")).not.toContain(`${repo}:/work`);
}, PROCESS_MS);
