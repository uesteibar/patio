// Increment 2: GitHub sign-in, pairing, agent identities approved only by a human, workspaces.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { daemon, DaemonError, waitForReply } from "../src/local";
import { PROTOCOL_VERSION } from "../src/protocol";
import { startWorld, until, WebClient, type World } from "./helpers/world";
import { PROCESS_MS } from "./helpers/timeouts";

let world: World;
beforeAll(async () => {
  process.env.PATIO_NO_NOTIFY = "1";
  world = await startWorld({ extraUsers: ["latecomer"] });
}, PROCESS_MS);
afterAll(() => world.stop(), PROCESS_MS);

const errorOf = (p: Promise<unknown>) => p.then(() => null, (e) => e as DaemonError);

test("sign in, pair, request an identity, approve it in the web app, and register reports it ready", async () => {
  const g = await world.gatekeeper();
  expect(g.d.login()).toBeNull();
  // Before pairing a gatekeeper cannot ask for an identity.
  expect((await errorOf(daemon.register(g.cfg, "jorge-claude")))?.message).toContain("sign in on this computer first");

  await g.web.signIn("jorge");
  const { code } = await daemon.pair(g.cfg);
  expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  expect((await g.web.post("/pair", { code: "WRON-GCOD" })).error).toContain("unknown or has expired");
  expect((await g.web.post("/pair", { code })).ok).toContain("is now your computer, @jorge");
  await until("paired", () => g.d.login() === "jorge");
  expect((await g.web.post("/pair", { code })).error).toContain("unknown or has expired"); // one use only

  expect((await daemon.register(g.cfg, "jorge-claude")).agent.status).toBe("pending");
  const approvals = await (await g.web.get("/")).text();
  expect(approvals).toContain("<b>jorge-claude</b>");
  expect(approvals).toContain("asks to be your agent");
  expect((await g.web.post("/agents/jorge-claude/decide", { decision: "approve" })).ok).toBe("jorge-claude approved.");
  await until("approval pushed to the gatekeeper", () => g.d.agents().some((a) => a.name === "jorge-claude" && a.status === "approved"));
  expect((await daemon.register(g.cfg, "jorge-claude")).agent.status).toBe("approved");
  await g.stop();
}, PROCESS_MS);

test("a name is owned by one human, and lives on one device", async () => {
  const a = await world.person("alice", { agent: "alice-shared", team: false });
  const b = await world.gatekeeper();
  await b.web.signIn("bob");
  await b.web.post("/pair", { code: (await daemon.pair(b.cfg)).code });
  await until("paired", () => b.d.login() === "bob");
  expect((await errorOf(daemon.register(b.cfg, "alice-shared")))?.message).toContain("is taken");
  await a.stop();
  await b.stop();
}, PROCESS_MS);

test("an agent's name starts with its owner's login and a hyphen; any other is refused with a name to use", async () => {
  const g = await world.gatekeeper();
  await g.web.signIn("bob");
  await g.web.post("/pair", { code: (await daemon.pair(g.cfg)).code });
  await until("paired", () => g.d.login() === "bob");
  for (const name of ["pablo-backend", "backend", "bobby", "alice"]) {
    const err = await errorOf(daemon.register(g.cfg, name, true));
    expect(err?.message, name).toContain(`${name} is not a name for an agent of @bob: an agent's name starts with its owner's login and a hyphen; try bob-${name}`);
  }
  expect((await daemon.register(g.cfg, "bob-backend", true)).agent.status).toBe("approved");
  // The bare login is its owner's too.
  expect((await daemon.register(g.cfg, "bob", true)).agent.status).toBe("approved");
  await g.stop();
}, PROCESS_MS);

test("only agents in a shared workspace can message each other; revoking their owner ends it", async () => {
  const carol = await world.person("carol", { team: false });
  const dave = await world.person("dave", { team: false });
  // No shared workspace yet.
  const refused = await errorOf(daemon.send(carol.cfg, { to: dave.agent, kind: "question", text: "hello?" }));
  expect(refused?.code).toBe("not_allowed");
  expect((await daemon.who(carol.cfg)).online).not.toContain(dave.agent);

  // Carol creates a workspace; her agent and Dave's join it with her invite link, each from its owner's terminal.
  const created = await carol.web.post("/workspaces", { name: "pairs" });
  const ws = decodeURIComponent(created.location!.pathname.split("/").pop()!);
  const code = await world.inviteLink(carol.web, ws);
  await world.joinByLink(carol, code);
  expect((await errorOf(daemon.send(carol.cfg, { to: dave.agent, kind: "question", text: "Now?" })))?.code).toBe("not_allowed");
  await world.joinByLink(dave, code);
  const sent = await daemon.send(carol.cfg, { to: dave.agent, kind: "question", text: "Now?" });
  expect(sent.status).toBe("delivered");
  expect((await daemon.who(carol.cfg)).online).toContain(dave.agent);

  // The admin sees a notice with Dave's device fingerprint and whose link he used; the agents list says whose they are.
  const page = await (await carol.web.get(`/workspaces/${ws}`)).text();
  expect(page).toContain("@dave joined");
  expect(page).toContain(dave.d.device.id.slice(0, 4) + " " + dave.d.device.id.slice(4, 8));
  expect(page).toContain("invited by @carol");
  expect(page).toContain(`${dave.agent} <span class="meta">· @dave</span>`);

  // Dave is not an admin: he cannot create invite links or revoke.
  expect((await dave.web.post(`/workspaces/${ws}/links`, { expires: "" })).error).toContain("only an admin");
  expect((await dave.web.post(`/workspaces/${ws}/revoke`, { login: "carol" })).error).toContain("only an admin");

  expect((await carol.web.post(`/workspaces/${ws}/revoke`, { login: "dave" })).ok).toBe("Removed @dave from the team.");
  expect((await errorOf(daemon.send(carol.cfg, { to: dave.agent, kind: "question", text: "Still there?" })))?.code).toBe("not_allowed");
  // A removed person cannot come back with the link.
  expect((await errorOf(daemon.joinLink(dave.cfg, code, [dave.agent], true)))?.message).toContain("you were removed from pairs");
  await carol.stop();
  await dave.stop();
}, PROCESS_MS);

test("a person with an agent in a workspace puts another agent of theirs in it; it enters the default channels", async () => {
  const admin = await world.person("alice", { team: false });
  const created = await admin.web.post("/workspaces", { name: "early" });
  const ws = decodeURIComponent(created.location!.pathname.split("/").pop()!);
  const general = await world.channel(admin.web, ws, "general");
  await admin.web.post(`/channels/${general}/default`, { default: "1", back: `/workspaces/${ws}` });
  await world.joinByLink(admin, await world.inviteLink(admin.web, ws));
  expect((await daemon.register(admin.cfg, "alice-second", true)).agent.status).toBe("approved");
  // From the person's terminal it is done at once (patio agents add), and the agent enters #general.
  const m = await daemon.join(admin.cfg, { as: "alice-second", workspace: "early", interactive: true });
  expect(m.status).toBe("approved");
  await until("alice-second is in early", () => !!admin.d.agents().find((a) => a.name === "alice-second")?.workspaces?.includes("early"));
  const page = await (await admin.web.get(`/workspaces/${ws}`)).text();
  expect(page).toMatch(/data-channel="general"[\s\S]*?2 member agents/);
  // And out again (patio agents remove): it leaves the workspace and its channels there.
  expect((await daemon.leaveWorkspace(admin.cfg, { as: "alice-second", workspace: "early" })).status).toBe("left");
  await until("alice-second left early", () => !admin.d.agents().find((a) => a.name === "alice-second")?.workspaces?.includes("early"));
  expect(await (await admin.web.get(`/workspaces/${ws}`)).text()).toMatch(/data-channel="general"[\s\S]*?1 member agent[^s]/);
  await admin.stop();
}, PROCESS_MS);

test("the agent's credentials cannot approve, pair, invite or revoke", async () => {
  const owner = await world.person("bob", { team: false });
  const g = await world.gatekeeper();
  await g.web.signIn("bob");
  await g.web.post("/pair", { code: (await daemon.pair(g.cfg)).code });
  await until("paired", () => g.d.login() === "bob");
  expect((await daemon.register(g.cfg, "bob-rogue")).agent.status).toBe("pending");

  // 1. The local socket (what the CLI and MCP use) has no approval endpoint.
  for (const path of ["/agents/bob-rogue/decide", "/agents/bob-rogue/approve", "/approve", "/api/agents/bob-rogue/approve", "/pair/confirm"]) {
    const res = await fetch(`http://daemon${path}`, { unix: g.cfg.socket, method: "POST", body: "{}" } as RequestInit);
    expect(res.status).toBe(404);
  }
  // Since increment 11 an admin can create an invite link from their own terminal (`patio invite`), never from an
  // agent's request: without the terminal flag the socket refuses it.
  const invite = await fetch("http://daemon/invite", { unix: g.cfg.socket, method: "POST", body: JSON.stringify({ workspace: "team" }) } as RequestInit);
  expect(invite.status).toBe(403);
  // 2. The MCP server offers no tool that approves, pairs, invites or revokes.
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, "../src/cli.ts"), "mcp"], env: { ...process.env, PATIO_HOME: g.home } as Record<string, string> }),
  );
  const tools = (await client.listTools()).tools.map((t) => t.name);
  await client.close();
  expect(tools).toContain("whoami");
  expect(tools.filter((t) => /approv|pair|invite|revoke|decide/.test(t))).toEqual([]);

  // 3. The exchange's approval API needs a web session; nothing a device holds is one.
  const api = `${world.exchangeUrl}/api/agents/bob-rogue/approve`;
  expect((await fetch(api, { method: "POST" })).status).toBe(401);
  expect((await fetch(api, { method: "POST", headers: { authorization: `Bearer ${g.d.device.sign_pk}` } })).status).toBe(401);

  // 4. The web app refuses a POST without the session cookie, with a wrong CSRF token, or from another origin.
  const stranger = new WebClient(g.d.webUrl);
  expect((await stranger.post("/agents/bob-rogue/decide", { decision: "approve" })).res.status).toBe(401);
  await g.web.signIn("bob");
  expect((await g.web.post("/agents/bob-rogue/decide", { decision: "approve" }, { csrf: "forged" })).res.status).toBe(403);
  expect((await g.web.post("/agents/bob-rogue/decide", { decision: "approve" }, { origin: "http://evil.example" })).res.status).toBe(403);

  // 5. A device frame that tries to approve is not something the exchange understands.
  g.d.sendRaw({ type: "approve", name: "bob-rogue" } as never);
  g.d.sendRaw({ type: "decide", name: "bob-rogue", decision: "approve" } as never);
  await Bun.sleep(100);
  expect((await daemon.register(g.cfg, "bob-rogue")).agent.status).toBe("pending");

  // Only the signed-in human, through the web app, approves.
  expect((await g.web.post("/agents/bob-rogue/decide", { decision: "approve" })).ok).toBe("bob-rogue approved.");
  await until("approved", () => g.d.agents().some((a) => a.name === "bob-rogue" && a.status === "approved"));
  await g.stop();
  await owner.stop();
}, PROCESS_MS);

test("the exchange only hands a sign-in back to a gatekeeper on this machine", async () => {
  for (const evil of ["https://evil.example/auth/done", "http://evil.example/auth/done", "http://127.0.0.1:1/other", "javascript:alert(1)"]) {
    const res = await fetch(`${world.exchangeUrl}/auth/github/start?return_to=${encodeURIComponent(evil)}&state=x`, { redirect: "manual" });
    expect(res.status).toBe(400);
  }
  const ok = await fetch(`${world.exchangeUrl}/auth/github/start?return_to=${encodeURIComponent("http://127.0.0.1:9/auth/done")}&state=x`, { redirect: "manual" });
  expect(ok.status).toBe(302);
}, PROCESS_MS);

test("a device that cannot sign the exchange's challenge is refused", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${world.port}`);
  const frames: { type: string; message?: string }[] = [];
  const closed = new Promise<number>((resolve) => (ws.onclose = (e) => resolve(e.code)));
  ws.onmessage = (e) => {
    const f = JSON.parse(String(e.data));
    frames.push(f);
    if (f.type === "challenge")
      ws.send(JSON.stringify({ type: "hello", v: PROTOCOL_VERSION, label: "x", sig: "AAAA", device: { id: "00", sign_pk: "AAAA", box_pk: "AAAA" } }));
  };
  expect(await closed).toBe(4004);
  expect(frames.some((f) => f.type === "error" && f.message?.includes("signature"))).toBe(true);
}, PROCESS_MS);

test("a message between members still flows end to end after the identity work", async () => {
  const a = await world.person("alice");
  const b = await world.person("bob");
  const { convo } = await daemon.send(a.cfg, { to: b.agent, kind: "question", text: "ping" });
  await until("bob has it", async () => (await daemon.inbox(b.cfg)).messages.some((m) => m.convo === convo));
  await daemon.reply(b.cfg, convo, "pong");
  const reply = await waitForReply(a.cfg, convo, 5);
  expect(reply).toMatchObject({ from: b.agent, to: a.agent, text: "pong" });
  await a.stop();
  await b.stop();
}, PROCESS_MS);

// Security audit S17: the sign-ins in flight at the exchange are bounded.
test("the exchange refuses to start more than 1000 sign-ins at once", async () => {
  const start = () => fetch(`${world.exchangeUrl}/auth/github/start?return_to=${encodeURIComponent("http://127.0.0.1:9/auth/done")}&state=x`, { redirect: "manual" });
  let last = 0;
  for (let i = 0; i < 1005; i++) last = (await start()).status;
  expect(last).toBe(429);
}, PROCESS_MS);
