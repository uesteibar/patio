// Several agents per person: two agents of Bob's on one computer, each in its own workspaces with its own rules; the
// gates apply the receiving agent's rules, the same whatever workspace the sender shares with it. `patio mcp --as`
// acts as one agent, and without it a computer with two agents fails clearly. `patio workspace new` makes a working link.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { daemon, DaemonError } from "../src/local";
import { writeAgentFile } from "./helpers/agent-file";
import { startWorld, until, type Person, type World } from "./helpers/world";
import { PROCESS_MS } from "./helpers/timeouts";

let world: World;
let alice: Person;
let carol: Person;
let bob: Person;

// bob-orbit takes questions only, in every workspace; bob-side takes questions, reports and heads-ups.
const ORBIT = { rules: "defaults:\n  kinds: [question]\n" };
const SIDE = { rules: "defaults:\n  kinds: [question, report, heads-up]\n" };

beforeAll(async () => {
  process.env.PATIO_NO_NOTIFY = "1";
  world = await startWorld();
  alice = await world.person("alice", { team: false });
  carol = await world.person("carol");
  // Bob's first agent is in `team` (with Carol) and in orbit (with Alice).
  bob = await world.person("bob", { agent: "bob-orbit", file: ORBIT });
  const orbit = decodeURIComponent((await alice.web.post("/workspaces", { name: "orbit" })).location!.pathname.split("/").pop()!);
  const orbitLink = await world.inviteLink(alice.web, orbit);
  await world.joinByLink(alice, orbitLink);
  await world.joinByLink(bob, orbitLink);
  // His second agent, created later on the same computer, is in `side` (with Carol) only.
  await writeAgentFile(bob.home, "bob-side", SIDE);
  const side = decodeURIComponent((await carol.web.post("/workspaces", { name: "side" })).location!.pathname.split("/").pop()!);
  const sideLink = await world.inviteLink(carol.web, side);
  await world.joinByLink(carol, sideLink);
  expect((await daemon.joinLink(bob.cfg, sideLink, ["bob-side"], true)).status).toBe("joined");
  await until("both of Bob's agents in their workspaces", () => {
    const a = bob.d.agents();
    return !!a.find((x) => x.name === "bob-side")?.workspaces?.includes("side") && !!a.find((x) => x.name === "bob-orbit")?.workspaces?.includes("orbit");
  });
}, PROCESS_MS);
afterAll(() => world.stop(), PROCESS_MS);

const verdict = async (from: Person, to: string, kind: "question" | "report" | "heads-up") => {
  const sent = await daemon.send(from.cfg, { to, kind, text: `a ${kind} for ${to}` });
  await until(`the gate on ${sent.id.slice(0, 8)}`, async () => (await audit()).some((l) => l.message_id === sent.id && l.direction === "in"));
  return (await audit()).find((l) => l.message_id === sent.id && l.direction === "in")!;
};
const audit = async () => {
  const f = Bun.file(join(bob.home, "audit.jsonl"));
  return (await f.exists()) ? (await f.text()).trim().split("\n").map((l) => JSON.parse(l)) : [];
};

test("each agent's rules apply to what reaches it, whatever the workspace the sender shares with it", async () => {
  // Alice shares orbit with bob-orbit, Carol shares team: the same rules (questions only) for both.
  expect(await verdict(alice, "bob-orbit", "report")).toMatchObject({ to: "bob-orbit", verdict: "reject", rule: "kinds", grant: "defaults" });
  expect(await verdict(carol, "bob-orbit", "report")).toMatchObject({ to: "bob-orbit", verdict: "reject", rule: "kinds", grant: "defaults" });
  expect(await verdict(alice, "bob-orbit", "question")).toMatchObject({ to: "bob-orbit", verdict: "deliver", grant: "defaults" });
  expect(await verdict(carol, "bob-orbit", "heads-up")).toMatchObject({ verdict: "reject", rule: "kinds" });
  // bob-side, on the same computer, has rules of its own.
  expect(await verdict(carol, "bob-side", "report")).toMatchObject({ to: "bob-side", verdict: "deliver", grant: "defaults" });
  expect(await verdict(carol, "bob-side", "heads-up")).toMatchObject({ to: "bob-side", verdict: "deliver" });
  // The dry run names the agent.
  const r = (as: string) => daemon.grantsTest(bob.cfg, { text: "a report", as, from: "someone", kind: "report" });
  expect((await r("bob-orbit")).decision.verdict).toBe("reject");
  expect((await r("bob-side")).decision.verdict).toBe("deliver");
}, PROCESS_MS);

test("the CLI and MCP act as one agent; with two agents and none named, a call fails clearly", async () => {
  // Without an agent named, sending is refused: which of Bob's agents would it be?
  const err = await daemon.send(bob.cfg.handle ? { ...bob.cfg, handle: "" } : bob.cfg, { to: "carol-2", kind: "question", text: "?" }).catch((e: DaemonError) => e);
  expect(err).toBeInstanceOf(DaemonError);
  expect((err as DaemonError).message).toBe("this computer hosts bob-orbit, bob-side: say which agent this is with --as <agent> (patio mcp --as <agent>, or PATIO_AGENT=<agent>)");

  const mcp = async (args: string[]) => {
    const client = new Client({ name: "test", version: "0" });
    const env = { ...process.env, PATIO_HOME: bob.home } as Record<string, string>;
    delete env.PATIO_AGENT;
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, "../src/cli.ts"), "mcp", ...args], env }));
    return client;
  };
  const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]!.text);

  const side = await mcp(["--as", "bob-side"]);
  expect(JSON.parse(text(await side.callTool({ name: "whoami", arguments: {} })))).toEqual({ agent: "bob-side" });
  // Its inbox holds only what reached bob-side.
  const inbox = text(await side.callTool({ name: "inbox", arguments: { include_closed: true } }));
  expect(inbox).not.toBe("No messages.");
  const tos = inbox.split("\n").map((l) => JSON.parse(l).preview as string);
  expect(tos.length).toBeGreaterThan(0);
  expect(tos.every((p) => p.endsWith("for bob-side"))).toBe(true);
  // What it sends is from bob-side.
  const sent = JSON.parse(text(await side.callTool({ name: "ask", arguments: { to: carol.agent, text: "From the side project: is staging up?" } })));
  await until("carol has it", async () => (await daemon.inbox(carol.cfg)).messages.some((m) => m.id === sent.id));
  expect((await daemon.inbox(carol.cfg)).messages.find((m) => m.id === sent.id)!.from).toBe("bob-side");
  // A message that reached the other agent is not this one's to read.
  const other = (await daemon.inbox(bob.cfg, { filter: "all", as: "bob-orbit" })).messages[0]!;
  const read = await side.callTool({ name: "read", arguments: { id: other.id } });
  expect(read.isError).toBe(true);
  expect(text(read)).toContain("no message with that id");
  await side.close();

  const none = await mcp([]);
  const failed = await none.callTool({ name: "inbox", arguments: {} });
  expect(failed.isError).toBe(true);
  expect(text(failed)).toBe("choose_agent: this computer hosts bob-orbit, bob-side: say which agent this is with --as <agent> (patio mcp --as <agent>, or PATIO_AGENT=<agent>)");
  await none.close();
}, PROCESS_MS);

test("patio workspace new: the workspace with the agent in it and #general, and a working invite link", async () => {
  const refused = await daemon.workspaceNew(alice.cfg, { name: "launch", agent: alice.agent, interactive: false }).catch((e: DaemonError) => e);
  expect((refused as DaemonError).message).toContain("only from your own terminal");
  const r = await daemon.workspaceNew(alice.cfg, { name: "launch", agent: alice.agent, interactive: true });
  expect(r).toMatchObject({ workspace: "launch", channels: ["general"] });
  expect(r.url).toStartWith(`${world.exchangeUrl}/join/`);
  const page = await (await fetch(r.url)).text();
  expect(page).toContain("@alice invited you to <b>launch</b></h1>");
  const dave = await world.person("dave", { team: false });
  const joined = await daemon.joinLink(dave.cfg, r.url.split("/").pop()!, [dave.agent], true);
  expect(joined).toMatchObject({ status: "joined", agents: [{ name: dave.agent, status: "approved", channels: ["general"] }] });
  const hello = await daemon.send(dave.cfg, { channel: "launch/general", kind: "heads-up", text: "hello launch" });
  expect(hello).toMatchObject({ recipients: 1 });
  await dave.stop();
}, PROCESS_MS);
