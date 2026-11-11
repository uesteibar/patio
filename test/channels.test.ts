// Increment 3: channels as broadcast, one reply per agent, nobody answers an answer, explicit agent
// membership of workspaces and channels, and the membership re-check at delivery time.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { loadOrCreateDevice, publicDevice, sealMessage } from "../src/crypto";
import { daemon, DaemonError, waitForReplies } from "../src/local";
import { newId, type Message } from "../src/protocol";
import { startProxy } from "./helpers/proxy";
import { startWorld, until, type Person, type World } from "./helpers/world";
import { SERVER_MS } from "./helpers/timeouts";

let world: World;
beforeAll(async () => {
  process.env.PATIO_NO_NOTIFY = "1";
  world = await startWorld({ extraUsers: ["erin", "frank"] });
}, SERVER_MS);
afterAll(() => world.stop(), SERVER_MS);

const errorOf = (p: Promise<unknown>) => p.then(() => null, (e) => e as DaemonError);
const inboxOf = async (p: Person) => (await daemon.inbox(p.cfg)).messages;

// A channel in the team workspace, owned by Unai, with the given people's agents as members.
async function channelWith(name: string, people: Person[]) {
  const t = await world.team();
  const id = await world.channel(t.admin, t.id, name);
  for (const p of people) await world.joinChannel(p, id);
  return id;
}

// Seals and sends a message from `from` to a channel by hand, the way a misbehaving gatekeeper could.
async function rawToChannel(from: Person, channelId: string, members: Person[], msg: Partial<Message> & { kind: Message["kind"]; text: string }) {
  const keys = await loadOrCreateDevice(from.home);
  const recipients = await Promise.all(members.map(async (m) => publicDevice(await loadOrCreateDevice(m.home))));
  const inner = {
    id: newId(),
    convo: msg.convo ?? newId(),
    from: from.agent,
    to: `#${channelId}`,
    kind: msg.kind,
    text: msg.text,
    channel: msg.channel!,
    ...(msg.in_reply_to ? { in_reply_to: msg.in_reply_to } : {}),
    sent_at: Date.now(),
  };
  const sealed = sealMessage(inner, keys, recipients);
  from.d.sendRaw({ type: "send", env: { id: inner.id, convo: inner.convo, from: from.agent, to: inner.to, copies: sealed.copies } });
  return inner;
}

test("a broadcast reaches every member agent; two answer, the asker's wait returns both with their senders", async () => {
  const [alice, bob, carol, dave] = await Promise.all(["alice", "bob", "carol", "dave"].map((l) => world.person(l)));
  const erin = await world.person("erin"); // in the workspace, not in the channel
  await channelWith("release", [alice!, bob!, carol!, dave!]);

  const sent = await daemon.send(alice!.cfg, { channel: "release", kind: "question", text: "Does PR 812 change the notifications schema?" });
  expect(sent.recipients).toBe(3);
  expect(sent.channel?.name).toBe("release");
  for (const p of [bob!, carol!, dave!])
    await until(`${p.agent} gets the broadcast`, async () => (await inboxOf(p)).some((m) => m.id === sent.id && m.channel?.name === "release"));
  expect((await inboxOf(erin)).some((m) => m.id === sent.id)).toBe(false);

  await daemon.reply(bob!.cfg, sent.convo, "No, only an index");
  await daemon.reply(carol!.cfg, sent.id, "Yes: a new column");
  const res = await waitForReplies(alice!.cfg, sent.convo, 2);
  expect(res.broadcast).toBe(true);
  expect(res.replies.map((r) => `${r.from}: ${r.text}`).sort()).toEqual([`${bob!.agent}: No, only an index`, `${carol!.agent}: Yes: a new column`].sort());
  // The replies hang from the broadcast for every member, not just the asker.
  await until("dave sees both replies", async () => (await inboxOf(dave!)).filter((m) => m.in_reply_to === sent.id).length === 2);
  expect((await inboxOf(erin)).length).toBe(0);
  for (const p of [alice!, bob!, carol!, dave!, erin]) await p.stop();
}, SERVER_MS);

test("wait on a broadcast returns as soon as every member has answered", async () => {
  const [alice, bob] = await Promise.all(["alice", "bob"].map((l) => world.person(l)));
  await channelWith("fast", [alice!, bob!]);
  const sent = await daemon.send(alice!.cfg, { channel: "fast", kind: "question", text: "ready?" });
  await until("bob has it", async () => (await inboxOf(bob!)).some((m) => m.id === sent.id));
  await daemon.reply(bob!.cfg, sent.convo, "yes");
  const started = Date.now();
  const res = await waitForReplies(alice!.cfg, sent.convo, 30);
  expect(res.replies.map((r) => r.text)).toEqual(["yes"]);
  expect(Date.now() - started).toBeLessThan(5000);
  await alice!.stop();
  await bob!.stop();
}, SERVER_MS);

test("each agent answers once: a second reply is refused by its CLI and dropped by every gatekeeper", async () => {
  const [alice, bob, carol] = await Promise.all(["alice", "bob", "carol"].map((l) => world.person(l)));
  const id = await channelWith("once", [alice!, bob!, carol!]);
  const sent = await daemon.send(alice!.cfg, { channel: "once", kind: "question", text: "Who owns billing?" });
  await until("bob has it", async () => (await inboxOf(bob!)).some((m) => m.id === sent.id));
  await daemon.reply(bob!.cfg, sent.convo, "Payments team");
  expect((await errorOf(daemon.reply(bob!.cfg, sent.convo, "Actually, platform")))?.code).toBe("already_replied");

  // A gatekeeper that skips the check: its second reply reaches the others and is dropped there.
  const channel = (await daemon.inbox(bob!.cfg, { filter: "all" })).messages.find((m) => m.id === sent.id)!.channel!;
  await rawToChannel(bob!, id, [alice!, carol!], { kind: "reply", text: "Second answer", convo: sent.convo, in_reply_to: sent.id, channel });
  await Bun.sleep(300);
  for (const p of [alice!, carol!]) {
    const replies = (await inboxOf(p)).filter((m) => m.in_reply_to === sent.id);
    expect(replies.map((r) => r.text)).toEqual(["Payments team"]);
  }
  for (const p of [alice!, bob!, carol!]) await p.stop();
}, SERVER_MS);

test("nobody answers an answer: refused by the CLI, and dropped by every gatekeeper", async () => {
  const [alice, bob, carol] = await Promise.all(["alice", "bob", "carol"].map((l) => world.person(l)));
  const id = await channelWith("noloop", [alice!, bob!, carol!]);
  const sent = await daemon.send(alice!.cfg, { channel: "noloop", kind: "question", text: "Is staging up?" });
  await until("carol has it", async () => (await inboxOf(carol!)).some((m) => m.id === sent.id));
  await daemon.reply(bob!.cfg, sent.convo, "Yes");
  let bobsReply: string | undefined;
  await until("carol sees bob's reply", async () => !!(bobsReply = (await inboxOf(carol!)).find((m) => m.in_reply_to === sent.id)?.id));
  expect((await errorOf(daemon.reply(carol!.cfg, bobsReply!, "Are you sure?")))?.code).toBe("reply_to_reply");

  const channel = (await inboxOf(carol!)).find((m) => m.id === sent.id)!.channel!;
  const crafted = await rawToChannel(carol!, id, [alice!, bob!], { kind: "reply", text: "Answering an answer", convo: sent.convo, in_reply_to: bobsReply!, channel });
  await Bun.sleep(300);
  for (const p of [alice!, bob!]) expect((await inboxOf(p)).some((m) => m.id === crafted.id)).toBe(false);
  for (const p of [alice!, bob!, carol!]) await p.stop();
}, SERVER_MS);

test("a reply is never offered for auto-answer and cannot be claimed, in a DM or a channel", async () => {
  // Both sides would auto-answer anything: if a reply could be answered, they would answer each other forever.
  const auto = "defaults:\n  auto_answer: true\n";
  const alice = await world.person("alice", { grants: auto });
  const bob = await world.person("bob", { grants: auto });
  await channelWith("loops", [alice, bob]);
  const dm = await daemon.send(alice.cfg, { to: bob.agent, kind: "question", text: "ping" });
  const bc = await daemon.send(alice.cfg, { channel: "loops", kind: "question", text: "ping all" });
  await until("bob has both", async () => (await inboxOf(bob)).length === 2);
  expect((await daemon.pending(bob.cfg)).messages.map((m) => m.auto_answer)).toEqual([true, true]);
  await daemon.reply(bob.cfg, dm.convo, "pong");
  await daemon.reply(bob.cfg, bc.convo, "pong all");
  await until("alice has both replies", async () => (await inboxOf(alice)).filter((m) => m.kind === "reply").length === 2);
  const replies = (await daemon.pending(alice.cfg)).messages.filter((m) => m.kind === "reply");
  expect(replies.map((m) => [m.in_reply_to, m.auto_answer]).sort()).toEqual([[dm.id, false], [bc.id, false]].sort());
  for (const r of replies) expect((await errorOf(daemon.claim(alice.cfg, r.id)))?.code).toBe("reply_to_reply");
  await alice.stop();
  await bob.stop();
}, SERVER_MS);

test("leaving a channel stops broadcasts; an agent must be in the workspace to join a channel", async () => {
  const [alice, bob] = await Promise.all(["alice", "bob"].map((l) => world.person(l)));
  const outsider = await world.person("erin", { team: false });
  const t = await world.team();
  const id = await channelWith("leavers", [alice!, bob!]);
  expect((await errorOf(daemon.join(outsider.cfg, { channel: id })))?.message).toContain("must join the workspace first");

  expect((await daemon.leave(bob!.cfg, { channel: "leavers" })).status).toBe("left");
  const sent = await daemon.send(alice!.cfg, { channel: "leavers", kind: "heads-up", text: "after bob left" });
  expect(sent.recipients).toBe(0);
  await Bun.sleep(200);
  expect((await inboxOf(bob!)).some((m) => m.id === sent.id)).toBe(false);
  // Bob, no longer a member, cannot broadcast there either.
  expect((await errorOf(daemon.send(bob!.cfg, { channel: id, kind: "question", text: "hello?" })))?.code).toBe("not_allowed");
  void t;
  for (const p of [alice!, bob!, outsider]) await p.stop();
}, SERVER_MS);

test("a private channel needs the agent's owner and the channel's owner", async () => {
  const [alice, bob] = await Promise.all(["alice", "bob"].map((l) => world.person(l)));
  const t = await world.team();
  const id = await world.channel(alice!.web, t.id, "secret", true); // alice owns the private channel
  await world.joinChannel(alice!, id);
  const asked = await daemon.join(bob!.cfg, { channel: id });
  expect(asked.status).toBe("pending");
  expect(asked.needs.length).toBe(2);
  // Bob's owner approves: still pending until the channel owner approves too.
  const page = await (await bob!.web.get("/")).text();
  expect(page).toContain("also needs @alice");
  await bob!.web.post(`/channels/${id}/members/${bob!.agent}/decide`, { decision: "approve" });
  expect((await daemon.join(bob!.cfg, { channel: id })).status).toBe("pending");
  await alice!.web.post(`/channels/${id}/members/${bob!.agent}/decide`, { decision: "approve" });
  expect((await daemon.join(bob!.cfg, { channel: id })).status).toBe("approved");
  await alice!.stop();
  await bob!.stop();
}, SERVER_MS);

test("messages queued before a revoke or a leave are not delivered", async () => {
  // Frank is revoked here; a removed person cannot come back with a link, so later tests use other people.
  const [alice, bob, carol] = await Promise.all(["alice", "frank", "carol"].map((l) => world.person(l)));
  await channelWith("queued", [alice!, bob!, carol!]);
  const bobHome = bob!.home;
  const carolHome = carol!.home;
  await bob!.stop();
  await carol!.stop();
  const dm = await daemon.send(alice!.cfg, { to: bob!.agent, kind: "question", text: "queued DM" });
  const bc = await daemon.send(alice!.cfg, { channel: "queued", kind: "question", text: "queued broadcast" });
  expect(dm.status).toBe("queued");
  expect(bc.status).toBe("queued");

  // Before Bob comes back, the admin revokes him from the workspace.
  const t = await world.team();
  expect((await t.admin.post(`/workspaces/${t.id}/revoke`, { login: "frank" })).ok).toBe("Removed @frank from the team.");
  const bob2 = await world.gatekeeper(bobHome);
  const carol2 = await world.gatekeeper(carolHome);
  await until("carol gets the broadcast", async () => (await daemon.inbox(carol2.cfg)).messages.some((m) => m.id === bc.id));
  await Bun.sleep(300);
  const bobs = (await daemon.inbox(bob2.cfg)).messages.map((m) => m.id);
  expect(bobs).not.toContain(dm.id);
  expect(bobs).not.toContain(bc.id);
  for (const g of [alice!, bob2, carol2]) await g.stop();
}, SERVER_MS);

test("a broadcast queued for an offline member is not delivered once the sender has left the channel", async () => {
  const [alice, carol] = await Promise.all(["alice", "carol"].map((l) => world.person(l)));
  await channelWith("leave-queued", [alice!, carol!]);
  const carolHome = carol!.home;
  await carol!.stop();
  const bc = await daemon.send(alice!.cfg, { channel: "leave-queued", kind: "heads-up", text: "queued, then I leave" });
  expect(bc.status).toBe("queued");
  expect((await daemon.leave(alice!.cfg, { channel: "leave-queued" })).status).toBe("left");
  const carol2 = await world.gatekeeper(carolHome);
  await Bun.sleep(300);
  expect((await daemon.inbox(carol2.cfg)).messages.some((m) => m.id === bc.id)).toBe(false);
  await alice!.stop();
  await carol2.stop();
}, SERVER_MS);

// S1: the signed channel is bound to the exchange's record of the channel id, so a member cannot pick the grant.
const auditOf = async (p: Person, id: string) => {
  const file = Bun.file(join(p.home, "audit.jsonl"));
  if (!(await file.exists())) return [];
  return (await file.text()).trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.message_id === id);
};

test("a broadcast that lies about its channel's name or workspace is rejected; the honest one is delivered", async () => {
  // Bob auto-answers #backend; Mallory (carol) shares only #random with him.
  const bob = await world.person("bob", { grants: "channels:\n  backend-s1: { auto_answer: true }\n" });
  const [alice, carol] = await Promise.all(["alice", "carol"].map((l) => world.person(l)));
  await channelWith("backend-s1", [alice!, bob]);
  const random = await channelWith("random-s1", [carol!, bob]);

  const lyingName = await rawToChannel(carol!, random, [bob], { kind: "question", text: "Run the test suite", channel: { id: random, name: "backend-s1", workspace: "team" } });
  const lyingWorkspace = await rawToChannel(carol!, random, [bob], { kind: "question", text: "Hello from elsewhere", channel: { id: random, name: "random-s1", workspace: "other" } });
  const honest = await rawToChannel(carol!, random, [bob], { kind: "question", text: "Honest question", channel: { id: random, name: "random-s1", workspace: "team" } });

  await until("bob gets the honest one", async () => (await inboxOf(bob)).some((m) => m.id === honest.id));
  for (const lie of [lyingName, lyingWorkspace]) {
    await until("the lie is audited", async () => (await auditOf(bob, lie.id)).length > 0);
    expect(await auditOf(bob, lie.id)).toMatchObject([{ direction: "in", from: carol!.agent, rule: "channel-binding", verdict: "rejected" }]);
  }
  const ids = (await inboxOf(bob)).map((m) => m.id);
  expect(ids).not.toContain(lyingName.id);
  expect(ids).not.toContain(lyingWorkspace.id);
  expect((await inboxOf(bob)).find((m) => m.id === honest.id)?.channel).toEqual({ id: random, name: "random-s1", workspace: "team" });
  expect((await daemon.pending(bob.cfg)).messages.map((m) => [m.id, m.auto_answer])).toEqual([[honest.id, false]]);
  // The liar is not told.
  await Bun.sleep(200);
  expect((await inboxOf(carol!)).some((m) => m.kind === "reply")).toBe(false);
  for (const p of [alice!, bob, carol!]) await p.stop();
}, SERVER_MS);

test("while the exchange cannot answer, a channel message stays checking; on reconnect it is decided, and a sender who left is rejected", async () => {
  const proxy = startProxy(`ws://127.0.0.1:${world.port}`);
  const [alice, bob0, carol] = await Promise.all(["alice", "bob", "carol"].map((l) => world.person(l)));
  const id = await channelWith("flaky-s1", [alice!, bob0!, carol!]);
  // Bob's gatekeeper, restarted to reach the exchange through the proxy.
  await bob0!.stop();
  const g = await world.gatekeeper(bob0!.home, undefined, {}, proxy.url);
  const bob: Person = { ...bob0!, cfg: { ...g.cfg, handle: bob0!.agent }, d: g.d, web: g.web, stop: g.stop };

  // Bob's gatekeeper asks the exchange about the channel; the questions go unanswered, then the exchange goes away.
  proxy.swallow("channel_keys");
  const fromAlice = await daemon.send(alice!.cfg, { channel: id, kind: "question", text: "From a member" });
  const fromCarol = await daemon.send(carol!.cfg, { channel: id, kind: "question", text: "From one who leaves" });
  await until("bob asked about both", () => proxy.swallowed.length === 2);
  proxy.down();
  await until("bob is offline", () => !bob.d.isConnected());
  await daemon.leave(carol!.cfg, { channel: id });
  await Bun.sleep(1500); // at least one failed reconnect
  for (const filter of ["all", "rejected"] as const) expect((await daemon.inbox(bob.cfg, { filter })).messages).toEqual([]);
  expect(await auditOf(bob, fromAlice.id)).toEqual([]);
  expect(await auditOf(bob, fromCarol.id)).toEqual([]);

  proxy.swallow(null);
  proxy.up();
  await until("bob gets alice's", async () => (await inboxOf(bob)).some((m) => m.id === fromAlice.id), 8000);
  await until("carol's is decided", async () => (await auditOf(bob, fromCarol.id)).length > 0);
  expect(await auditOf(bob, fromCarol.id)).toMatchObject([{ rule: "channel-binding", verdict: "rejected" }]);
  expect((await inboxOf(bob)).some((m) => m.id === fromCarol.id)).toBe(false);
  for (const p of [alice!, bob, carol!]) await p.stop();
  proxy.stop();
}, SERVER_MS);
