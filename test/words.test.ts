// Increment 15, part D: words, states and messages. --help on every subcommand; an unknown command says so; an invite
// link is recognized however it was pasted; states say what is true; one id works everywhere; Activity speaks in
// sentences and never logs a send the server refused.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { activitySentence } from "../src/activity";
import { readAudit } from "../src/audit";
import { COMMANDS, helpFor } from "../src/help";
import { looksLikeLink, parseInviteLink } from "../src/links";
import { daemon, waitForReply } from "../src/local";
import { agentState, agentsTable, type AgentRow } from "../src/status";
import { fakeTools, runCli } from "./helpers/cli";
import { startWorld, until, type Person, type World } from "./helpers/world";
import { PROCESS_MS } from "./helpers/timeouts";

let world: World;
let alice: Person;
let bob: Person;
let env: Record<string, string>;
let fresh: Record<string, string>;
let folder: string;
let fake: Awaited<ReturnType<typeof fakeTools>>;
let root: string;

beforeAll(async () => {
  process.env.PATIO_NO_NOTIFY = "1";
  world = await startWorld();
  alice = await world.person("alice");
  root = await mkdtemp(join(world.dir, "bob-"));
  folder = join(root, "code", "orbit");
  await mkdir(folder, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: folder });
  bob = await world.person("bob", { file: { tool: "claude", folder } });
  fake = await fakeTools(join(root, "bin"), ["claude"]);
  env = { PATH: fake.path, HOME: root, PATIO_HOME: bob.home, PATIO_NO_NOTIFY: "1", PATIO_NO_PREFLIGHT: "1" };
  const other = await mkdtemp(join(world.dir, "fresh-"));
  fresh = { PATH: process.env.PATH!, HOME: other, PATIO_HOME: join(other, ".patio"), PATIO_NO_NOTIFY: "1" };
}, PROCESS_MS);
afterAll(async () => {
  await world.stop();
}, PROCESS_MS);

test("-h and --help on every subcommand print its own help; an unknown command says so and lists the commands", async () => {
  for (const c of COMMANDS) {
    const name = c === "version" ? "--version" : c;
    if (name === "--version") continue;
    for (const flag of ["--help", "-h"]) {
      const r = await runCli([name, flag], fresh);
      expect(r.code, `${name} ${flag}`).toBe(0);
      expect(r.out.trim(), `${name} ${flag}`).toBe(helpFor(c)!);
    }
  }
  // Also after other arguments, and for the aliases.
  expect((await runCli(["rules", "bob-x", "--help"], fresh)).out.trim()).toBe(helpFor("rules")!);
  expect((await runCli(["list", "-h"], fresh)).out.trim()).toBe(helpFor("inbox")!);
  const unknown = await runCli(["foo"], fresh);
  expect(unknown.code).toBe(1);
  expect(unknown.out).toStartWith("unknown command: foo\n");
  expect(unknown.out).toContain("patio <command> --help says more about each one.");
  // patio wait takes --as, like the other agent commands.
  const sent = await daemon.send(alice.cfg, { to: bob.agent, kind: "question", text: "ping" });
  const waited = await runCli(["wait", sent.convo, "--as", alice.agent, "--timeout", "1"], { ...env, PATIO_HOME: alice.home });
  expect(waited.out).not.toContain("Unknown option");
  expect(waited.code).toBe(2);
}, PROCESS_MS);

test("an invite link is anything with /join/, https:// added when it is missing; a word on a fresh computer is not one", async () => {
  expect(parseInviteLink("patio.example.com/join/AbC123")).toEqual({ code: "AbC123", server: "https://patio.example.com" });
  expect(parseInviteLink("  https://patio.example/join/AbC123/ ")).toEqual({ code: "AbC123", server: "https://patio.example" });
  expect(looksLikeLink("patio.example.com/join/AbC123")).toBe(true);
  expect(looksLikeLink("orbit/backend")).toBe(false);
  const word = await runCli(["join", "not-a-link"], fresh);
  expect(word.code).toBe(1);
  expect(word.out.trim()).toBe("This is not an invite link. Paste the link from your invite page.");
  // Never "patio up" to someone patio never set up.
  const status = await runCli(["status"], fresh);
  expect(status.out).toContain("patio is not set up on this computer yet: paste the prompt from your invite page into your coding agent, or run patio join <invite link>");
  expect(status.out).not.toContain("patio up");
  // A link pasted without https:// goes to the server, which answers for the code (unknown here).
  const bare = await runCli(["join", `${world.exchangeUrl.replace("http://", "")}/join/nope`, "--no-wait"], fresh);
  expect(bare.out).toContain("cannot reach the server at https://127.0.0.1");
}, PROCESS_MS);

test("states say what is true: each tool listed, written and waiting for trust, or not set up; an agent is Working only when it is", async () => {
  const row = (o: Partial<AgentRow>): AgentRow => ({ name: "bob-x", status: "approved", workspaces: ["team"], tool: "claude", folder: "/r", in_place: false, file: true, error: null, connected: [], tools: { claude: "listed", codex: "not set up", pi: "written" }, answered: true, ...o });
  expect(agentState(row({}))).toEqual({ key: "working", text: "Working" });
  expect(agentState(row({ workspaces: [] })).text).toBe("Not in a workspace");
  expect(agentState(row({ answered: false })).text).toBe("Waits for your three answers");
  expect(agentState(row({ tools: { claude: "written", codex: "not set up", pi: "not set up" } })).text).toBe("Not connected to Claude Code");
  expect(agentsTable([row({})], "laptop")).toContain("Claude Code: listed; Codex: not set up; Pi: written, waits for your trust in Pi");
  expect(agentsTable([row({})], "laptop")).not.toContain("Ready");

  // patio status runs the agent's own tool's listing: written but not trusted is a "!" step, and exit 1.
  expect((await runCli(["connect", "claude", "--as", bob.agent], env)).code).toBe(0);
  const pending = await runCli(["status"], env);
  expect(pending.code).toBe(1);
  expect(pending.out).toContain(`! ${bob.agent}: Claude Code: start claude in ~/code/orbit once, trust the folder and approve the patio MCP server`);
  expect((await daemon.status(bob.cfg)).agents.find((a) => a.name === bob.agent)?.tools).toEqual({ claude: "written", codex: "not set up", pi: "not set up" });
  await fake.trust(root, "claude", folder);
  const listed = await runCli(["status"], env);
  expect(listed.out).not.toContain("! ");
  expect((await daemon.status(bob.cfg)).agents.find((a) => a.name === bob.agent)?.tools?.claude).toBe("listed");
}, PROCESS_MS);

test("one id: read, reply and dismiss take the message id or the conversation id; inbox prints a header and one id", async () => {
  const q = await daemon.send(alice.cfg, { to: bob.agent, kind: "question", text: "Who owns billing?" });
  await until("bob has it", async () => (await daemon.inbox(bob.cfg)).messages.some((m) => m.id === q.id));
  expect((await daemon.read(bob.cfg, q.convo, bob.agent)).message.id).toBe(q.id);
  expect((await daemon.read(bob.cfg, q.id.slice(0, 8), bob.agent)).message.id).toBe(q.id);
  const inbox = await runCli(["inbox", "--as", bob.agent], env);
  const [head, ...rows] = inbox.out.trim().split("\n");
  expect(head!.split(/\s{2,}/).filter(Boolean)).toEqual(["ID", "FROM", "KIND", "STATE", "MESSAGE"]);
  const line = rows.find((l) => l.includes("Who owns billing?"))!;
  expect(line).toContain(q.id.slice(0, 8));
  expect(line).not.toContain(q.convo.slice(0, 8));
  await daemon.reply(bob.cfg, q.convo, "The payments team.", bob.agent);
  // wait takes the message id too.
  expect((await waitForReply(alice.cfg, q.id, 5))?.text).toBe("The payments team.");
  const q2 = await daemon.send(alice.cfg, { to: bob.agent, kind: "question", text: "Lunch?" });
  await until("bob has it", async () => (await daemon.inbox(bob.cfg)).messages.some((m) => m.id === q2.id));
  expect((await daemon.dismiss(bob.cfg, q2.convo, bob.agent)).id).toBe(q2.id);
}, PROCESS_MS);

test("Activity in sentences; a send the server refused is logged as not sent, never as sent", async () => {
  const say = (e: Record<string, unknown>, fate?: "waits") => activitySentence({ at: "", ...e } as never, fate);
  expect(say({ direction: "out", from: "unai-orbit", to: "pablo", kind: "question", verdict: "send" })).toBe("unai-orbit asked pablo. Sent.");
  expect(say({ direction: "in", from: "pablo", to: "unai-orbit", kind: "question", verdict: "deliver" }, "waits")).toBe("pablo asked unai-orbit. Waits for you.");
  expect(say({ direction: "out", from: "unai-orbit", to: "pablo", kind: "reply", verdict: "ask-human", reason: "contains personal data (an email address or phone number)", dlp: [{ what: "email address" }] })).toBe("unai-orbit answered pablo. Waits for you: it contains an email address.");
  expect(say({ direction: "out", from: "unai-orbit", to: "carol", kind: "question", verdict: "not-sent", reason: "no agent named carol" })).toBe("unai-orbit asked carol. Not sent: no agent named carol.");

  const r = await runCli(["ask", "carol", "hi", "--as", alice.agent], { ...env, PATIO_HOME: alice.home });
  expect(r.code).toBe(3);
  const lines = readAudit(alice.home).filter((e) => e.to === "carol");
  expect(lines.map((e) => e.verdict)).toEqual(["not-sent"]);
  expect(lines[0]).toMatchObject({ reason: "no agent named carol" });
  const page = await (await alice.web.get("/activity")).text();
  expect(page).toContain(`${alice.agent} asked carol. Not sent: no agent named carol.`);
  expect(page).not.toContain(`${alice.agent} asked carol. Sent.`);
}, PROCESS_MS);
