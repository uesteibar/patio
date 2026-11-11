// Increment 5: message states in the gatekeeper's inbox, and the claim that `answer` holds as a lease.
import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInbox, publicItem } from "../src/inbox";
import type { Message } from "../src/protocol";

let n = 0;
const msg = (over: Partial<Message> = {}): Message => ({ id: `m${++n}-${crypto.randomUUID()}`, convo: crypto.randomUUID(), from: "alice", to: "bob", kind: "question", text: "Is PR 812 merging?", ts: 1, ...over });
async function fresh() {
  const inbox = openInbox(await mkdtemp(join(tmpdir(), "patio-inbox-")));
  // Delivered: stored as checking, then the gate passes it.
  const deliver = (m: Message, workspaces?: string[]) => {
    inbox.add(m, "bob", "checking", workspaces);
    inbox.setGate(m.id, null, null, null);
    return inbox.get(m.id)!;
  };
  return { inbox, deliver };
}
const states = (items: { id: string; state: string }[]) => items.map((i) => i.state);

test("a delivered message is unread; read marks it read; the default listing hides closed and rejected ones", async () => {
  const { inbox, deliver } = await fresh();
  const a = deliver(msg());
  expect(a.state).toBe("unread");
  inbox.read(a.id.slice(0, 6));
  expect(inbox.get(a.id)!.state).toBe("read");
  const b = deliver(msg());
  expect(inbox.dismiss(b.id)).toEqual({ ok: true });
  const c = msg();
  inbox.add(c, "bob", "checking");
  inbox.setGate(c.id, "rejected", "looks like prompt injection", null);
  expect(inbox.list().map((m) => m.id)).toEqual([a.id]);
  expect(inbox.list({ filter: "all" }).map((m) => m.id).sort()).toEqual([a.id, b.id].sort());
  expect(inbox.list({ filter: "rejected" }).map((m) => [m.id, m.state, m.gate_reason])).toEqual([[c.id, "rejected", "looks like prompt injection"]]);
});

test("a claim is exclusive while its lease runs, and can be taken again once it expires", async () => {
  const { inbox, deliver } = await fresh();
  const m = deliver(msg());
  const first = inbox.claim(m.id, 1000, 0);
  expect(first.ok).toBe(true);
  expect(inbox.get(m.id)!.state).toBe("claimed");
  expect(inbox.claim(m.id, 1000, 500)).toMatchObject({ ok: false, code: "already_claimed" });
  // The holder renews; the lease moves.
  expect(inbox.renew(m.id, (first as { token: string }).token, 1000, 900)).toBe(true);
  expect(inbox.claim(m.id, 1000, 1500)).toMatchObject({ ok: false, code: "already_claimed" });
  // The holder died: no renewal, the lease runs out, someone else takes it, and the old token is dead.
  const second = inbox.claim(m.id, 1000, 2000);
  expect(second.ok).toBe(true);
  expect(inbox.renew(m.id, (first as { token: string }).token, 1000, 2100)).toBe(false);
  expect(inbox.settle(m.id, "answered", null, (first as { token: string }).token)).toBe(false);
  expect(inbox.settle(m.id, "answered", null, (second as { token: string }).token)).toBe(true);
  expect(inbox.get(m.id)!.state).toBe("answered");
  expect(inbox.claim(m.id, 1000, 3000)).toMatchObject({ ok: false, code: "already_replied" });
});

test("an expired claim is pending again; a claim held for the owner never expires", async () => {
  const { inbox, deliver } = await fresh();
  const a = deliver(msg());
  const b = deliver(msg());
  const asked = msg({ from: "bob", to: "alice" });
  inbox.sent(asked, "bob");
  const c = deliver(msg({ kind: "reply", in_reply_to: asked.id }));
  const ta = inbox.claim(a.id, 1000, 0) as { token: string };
  const tb = inbox.claim(b.id, 1000, 0) as { token: string };
  expect(inbox.pending(500).map((m) => m.id)).toEqual([c.id]);
  expect(inbox.hold(b.id, tb.token)).toBe(true);
  expect(inbox.pending(5000).map((m) => m.id).sort()).toEqual([a.id, c.id].sort());
  expect(inbox.claim(b.id, 1000, 99_999)).toMatchObject({ ok: false, code: "already_claimed" });
  expect(inbox.release(a.id, ta.token)).toBe(true);
  expect(inbox.get(a.id)!.state).toBe("read");
});

test("failed keeps its reason and can be claimed again; replies, rejected and held messages cannot be claimed", async () => {
  const { inbox, deliver } = await fresh();
  const a = deliver(msg());
  const t = inbox.claim(a.id, 1000, 0) as { token: string };
  inbox.settle(a.id, "failed", "blocked by your rules (outgoing): contains a local file path", t.token);
  expect(inbox.get(a.id)).toMatchObject({ state: "failed", state_reason: "blocked by your rules (outgoing): contains a local file path" });
  expect(inbox.list().map((m) => m.state)).toEqual(["failed"]);
  expect(inbox.claim(a.id, 1000, 10).ok).toBe(true);
  const asked = msg({ from: "bob", to: "alice" });
  inbox.sent(asked, "bob");
  const reply = deliver(msg({ kind: "reply", in_reply_to: asked.id }));
  expect(inbox.claim(reply.id, 1000, 0)).toMatchObject({ ok: false, code: "reply_to_reply" });
  const held = msg();
  inbox.add(held, "bob", "checking");
  inbox.setGate(held.id, "held", "doubt", null);
  expect(inbox.claim(held.id, 1000, 0)).toMatchObject({ ok: false, code: "unknown_message" });
  expect(inbox.claim("nope", 1000, 0)).toMatchObject({ ok: false, code: "unknown_message" });
});

test("dismiss closes an open message, but not one that is answered or claimed by someone", async () => {
  const { inbox, deliver } = await fresh();
  const a = deliver(msg());
  inbox.claim(a.id, 60_000, Date.now());
  expect(inbox.dismiss(a.id)).toMatchObject({ ok: false, code: "already_claimed" });
  const b = deliver(msg());
  expect(inbox.dismiss(b.id)).toEqual({ ok: true });
  expect(states([inbox.get(b.id)!])).toEqual(["dismissed"]);
});

test("a direct message keeps the workspaces the exchange said both agents share", async () => {
  const { deliver } = await fresh();
  expect(deliver(msg(), ["orbit", "team"]).workspaces).toEqual(["orbit", "team"]);
});

test("reject closes unread, read, failed and lapsed-claim messages; not answered, rejected, dismissed or actively claimed ones", async () => {
  const { inbox, deliver } = await fresh();
  const unread = deliver(msg());
  const read = deliver(msg());
  inbox.read(read.id);
  const failed = deliver(msg());
  inbox.settle(failed.id, "failed", "the agent failed", undefined);
  const lapsed = deliver(msg());
  inbox.claim(lapsed.id, 1000, 0);
  for (const m of [unread, read, failed]) expect(inbox.reject(m.id, "not now")).toEqual({ ok: true });
  expect(inbox.reject(lapsed.id, null, 5000)).toEqual({ ok: true });
  expect(inbox.get(unread.id)).toMatchObject({ state: "rejected", state_reason: "not now" });

  const active = deliver(msg());
  inbox.claim(active.id, 60_000, 0);
  expect(inbox.reject(active.id, null, 1000)).toEqual({ ok: false, code: "already_claimed" });
  const answered = deliver(msg());
  inbox.settle(answered.id, "answered", null);
  expect(inbox.reject(answered.id, null)).toEqual({ ok: false, code: "already_replied" });
  expect(inbox.reject(unread.id, null)).toEqual({ ok: false, code: "already_rejected" });
  const dismissed = deliver(msg());
  inbox.dismiss(dismissed.id);
  expect(inbox.reject(dismissed.id, null)).toEqual({ ok: false, code: "already_dismissed" });
  expect(inbox.reject("nope", null)).toEqual({ ok: false, code: "unknown_message" });

  // Rejected is hidden by default, and listed with --rejected next to what the input gate rejected.
  expect(inbox.list({ filter: "all" }).some((m) => m.id === unread.id)).toBe(false);
  expect(inbox.list({ filter: "rejected" }).map((m) => m.id)).toContain(unread.id);
  expect(inbox.pending(10_000).some((m) => m.id === lapsed.id)).toBe(false);
  // A rejected message cannot be claimed or dismissed any more.
  expect(inbox.claim(read.id, 1000, 0)).toMatchObject({ ok: false, code: "already_rejected" });
  expect(inbox.dismiss(read.id)).toMatchObject({ ok: false, code: "already_rejected" });
  expect(publicItem(inbox.get(unread.id)!)).toMatchObject({ state: "rejected", state_reason: "not now" });
});

test("a message delivered with an allowed action carries it; the public item shows it, null otherwise", async () => {
  const { inbox } = await fresh();
  const m = msg({ kind: "request", text: "Run the tests on PR 812" });
  inbox.add(m, "bob", "checking");
  inbox.setGate(m.id, null, null, null, "run the test suite");
  expect(publicItem(inbox.get(m.id)!).allowed_action).toBe("run the test suite");
  const plain = msg();
  inbox.add(plain, "bob", "checking");
  inbox.setGate(plain.id, null, null, null);
  expect(publicItem(inbox.get(plain.id)!).allowed_action).toBeNull();
});

// Security audit S12: a reply to a direct message is accepted only from the agent it was sent to, and a reply to a
// broadcast only from the same channel.
test("a reply to a DM from someone other than its addressee, or to a broadcast from another channel, is refused", async () => {
  const { inbox } = await fresh();
  const asked = msg({ from: "bob", to: "alice" });
  inbox.sent(asked, "bob");
  expect(inbox.add(msg({ from: "carol", to: "bob", kind: "reply", in_reply_to: asked.id, convo: asked.convo }), "bob")).toBe("wrong_sender");
  expect(inbox.add(msg({ from: "alice", to: "bob", kind: "reply", in_reply_to: asked.id, convo: asked.convo }), "bob")).toBe("added");
  const ch = { id: "ch_1", name: "backend", workspace: "team" };
  const cast = msg({ from: "bob", to: "#ch_1", channel: ch });
  inbox.sent(cast, "bob", 2);
  const other = { id: "ch_2", name: "random", workspace: "team" };
  expect(inbox.add(msg({ from: "carol", to: "#ch_2", kind: "reply", in_reply_to: cast.id, convo: cast.convo, channel: other }), "bob")).toBe("wrong_sender");
  expect(inbox.add(msg({ from: "carol", to: "bob", kind: "reply", in_reply_to: cast.id, convo: cast.convo }), "bob")).toBe("wrong_sender");
  expect(inbox.add(msg({ from: "carol", to: "#ch_1", kind: "reply", in_reply_to: cast.id, convo: cast.convo, channel: ch }), "bob")).toBe("added");
});

// The one reply that travels as a direct message for a broadcast: a rejection notice must reach the sender.
test("a rejection notice for the owner's own broadcast is accepted, a plain reply to it is not", async () => {
  const { inbox } = await fresh();
  const ch = { id: "ch_1", name: "backend", workspace: "team" };
  const cast = msg({ from: "alice", to: "#ch_1", channel: ch });
  inbox.sent(cast, "alice", 2);
  const notice = (from: string) => ({ ...msg({ from, to: "alice", kind: "reply", in_reply_to: cast.id, convo: cast.convo }), rejected: { reason: "asks about a denied topic" } });
  expect(inbox.add(msg({ from: "bob", to: "alice", kind: "reply", in_reply_to: cast.id, convo: cast.convo }), "alice")).toBe("wrong_sender");
  expect(inbox.add(notice("bob"), "alice")).toBe("added");
  // A notice cannot answer someone else's message.
  const their = msg({ from: "carol", to: "bob" });
  expect(inbox.add({ ...msg({ from: "dave", to: "bob", kind: "reply", in_reply_to: their.id, convo: their.convo }), rejected: { reason: "x" } }, "bob")).toBe("unknown_target");
});
