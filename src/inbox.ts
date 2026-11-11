// The gatekeeper's persistent store of messages, in clear, on this machine only ($PATIO_HOME/inbox.db, readable
// only by this user): what reached this person's agents (the inbox) and what they sent (needed to recognise
// the replies to it, to keep one reply per agent, and to show threads in the web app).
//
// Incoming messages pass the input gate (gates.ts) before they count as delivered. While the gate decides, or
// while the owner decides on a held message, or once it was rejected, the message is stored with a gate state
// (`checking`, `held`, `rejected`) and stays out of every listing, out of `read` and `reply`, and out of the web
// app's threads. Outgoing messages held by the output gate wait in `drafts` until the owner decides.
//
// Two rules live here because every gatekeeper must apply them on its own:
// - one reply per agent per message: a second reply from the same agent to the same message is dropped;
// - nobody answers an answer: a reply to a reply is refused (sending) and dropped (receiving).
import { Database } from "bun:sqlite";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { GateDecision } from "./gates";
import type { ChannelRef, Context, Kind, Message, Outgoing, PublicDevice } from "./protocol";

// null: delivered. The other states keep a message out of the inbox.
// `keys`: from a contact whose device keys changed; held until the owner trusts or blocks the new keys.
export type GateState = "checking" | "held" | "rejected" | "keys";

// What became of a delivered incoming message (docs/poc/plan.md, increment 5). `claimed` is a lease held by
// one `patio answer`: it expires unless renewed, and does not expire while the owner decides on a held reply.
// `rejected` is the input gate's state, or the recipient's (`patio reject`), shown with the others.
export type MessageState = "unread" | "read" | "claimed" | "answered" | "dismissed" | "failed" | "rejected";
// What an outgoing message can become after it left: `expired`, when the exchange dropped it undelivered (its TTL).
export type SentState = MessageState | "expired";
export type ListFilter = "open" | "unread" | "all" | "rejected";

export type ClaimResult =
  | { ok: true; token: string; until: number }
  | { ok: false; code: "unknown_message" | "already_claimed" | "already_replied" | "already_rejected" | "reply_to_reply"; until?: number | null };

export type RejectResult = { ok: true } | { ok: false; code: "unknown_message" | "already_claimed" | "already_replied" | "already_rejected" | "already_dismissed" };

// An outgoing message the output gate held for the owner, and what became of it.
export type Draft = {
  id: string;
  msg: Outgoing & { from: string };
  // For a broadcast: the channel as the agent named it (resolved again when the draft is sent).
  channel_ref: string | null;
  // For a reply: the text it answers, shown on the approval card.
  answering: string | null;
  created_at: number;
  // expired: nobody decided within the grant's hold_timeout; it was not sent.
  state: "held" | "sent" | "rejected" | "expired";
  decision: GateDecision;
  decided_by: string | null;
  decided_at: number | null;
  final_text: string | null;
};

export type Direction = "in" | "out";

export type OutboxRow = {
  seq: number;
  id: string;
  convo: string;
  from_agent: string;
  // The agent, or `#<channel>` as the sender named it.
  to_ref: string;
  kind: Kind;
  in_reply_to: string | null;
  sealed: string;
  created_at: number;
  state: "queued" | "sent" | "held" | "failed" | "cancelled" | "expired";
  reason: string | null;
  settled_at: number | null;
};

export type InboxItem = Message & {
  received_at: number;
  read: boolean;
  handled: string | null;
  state: MessageState;
  // Why it failed (or, for a claim held for the owner, why the reply is held).
  state_reason: string | null;
  // While claimed: when the lease runs out (null: held for the owner, no expiry).
  claim_until: number | null;
  // A direct message: the workspaces both agents share, as the exchange said.
  workspaces: string[] | null;
  direction: Direction;
  // The agent on this gatekeeper the message was for (incoming) or from (outgoing).
  local_agent: string;
  // For an outgoing broadcast: how many member agents it went to.
  expected: number | null;
  // Incoming only: the input gate's state (null once delivered), the category of a rejection, and the decision.
  gate: GateState | null;
  gate_reason: string | null;
  gate_decision: GateDecision | null;
  // Incoming only: the action its owner allowed (on the approval card) or its grant allows, if it asks for one.
  allowed_action: string | null;
  // Incoming only: when the input gate held it for the owner (for hold_timeout).
  held_at: number | null;
  // Incoming only: delivered because nobody reviewed it in time (on_timeout: inbox), not because a gate passed it.
  not_reviewed: boolean;
};

type Row = {
  id: string;
  convo: string;
  from_handle: string;
  to_handle: string;
  kind: Kind;
  text: string;
  context: string | null;
  sent_at: number;
  received_at: number;
  read_at: number | null;
  handled: string | null;
  // `rejected` here is the recipient's rejection; the input gate's is `gate`.
  state: MessageState;
  state_reason: string | null;
  claim_token: string | null;
  claim_until: number | null;
  workspaces: string | null;
  direction: Direction;
  channel: string | null;
  in_reply_to: string | null;
  local_agent: string;
  expected: number | null;
  gate: GateState | null;
  gate_reason: string | null;
  gate_detail: string | null;
  rejected: string | null;
  allowed_action: string | null;
  held_at: number | null;
  not_reviewed: number | null;
};

const toItem = (r: Row): InboxItem => ({
  id: r.id,
  convo: r.convo,
  from: r.from_handle,
  to: r.to_handle,
  kind: r.kind,
  text: r.text,
  ...(r.context ? { context: JSON.parse(r.context) as Context } : {}),
  ...(r.channel ? { channel: JSON.parse(r.channel) as ChannelRef } : {}),
  ...(r.in_reply_to ? { in_reply_to: r.in_reply_to } : {}),
  ...(r.rejected ? { rejected: { reason: r.rejected } } : {}),
  ts: r.sent_at,
  received_at: r.received_at,
  read: r.read_at !== null,
  handled: r.handled,
  state: r.gate === "rejected" ? "rejected" : r.state,
  state_reason: r.state_reason,
  claim_until: r.state === "claimed" ? r.claim_until : null,
  workspaces: r.workspaces ? (JSON.parse(r.workspaces) as string[]) : null,
  direction: r.direction,
  local_agent: r.local_agent,
  expected: r.expected,
  gate: r.gate,
  gate_reason: r.gate_reason,
  gate_decision: r.gate_detail ? (JSON.parse(r.gate_detail) as GateDecision) : null,
  allowed_action: r.allowed_action,
  held_at: r.held_at,
  not_reviewed: !!r.not_reviewed,
});

type DraftRow = {
  id: string;
  msg: string;
  channel_ref: string | null;
  answering: string | null;
  created_at: number;
  state: Draft["state"];
  decision: string;
  decided_by: string | null;
  decided_at: number | null;
  final_text: string | null;
};

const toDraft = (r: DraftRow): Draft => ({ ...r, msg: JSON.parse(r.msg), decision: JSON.parse(r.decision) });

// What leaves the gatekeeper for the CLI, the MCP server and `watch --exec`: the message and its state,
// without the gate's details (those hold the owner's rule texts and stay in the web app and the audit log).
export function publicItem(m: InboxItem) {
  const { gate, gate_reason, gate_decision, handled, held_at, ...rest } = m;
  return { ...rest, ...(gate === "rejected" ? { state_reason: gate_reason } : {}) };
}
export type PublicItem = ReturnType<typeof publicItem>;

export class AmbiguousId extends Error {}
export class ReplyRule extends Error {
  constructor(
    readonly code: "reply_to_reply" | "already_replied",
    message: string,
  ) {
    super(message);
  }
}

type PinRow = { agent: string; device_id: string; sign_pk: string; box_pk: string | null; pinned_at: number };
const pinDevice = (p: PinRow) => ({ id: p.device_id, sign_pk: p.sign_pk, box_pk: p.box_pk, pinned_at: p.pinned_at });
// A device of a key change: its keys, and its computer's name and owner as the exchange gave them (when it did).
export type KeyChangeDevice = { id: string; sign_pk: string; box_pk: string | null; label?: string; owner?: string };

const sameSet = (a: { id: string; sign_pk: string; box_pk: string | null }[], b: { id: string; sign_pk: string; box_pk: string | null }[]) =>
  a.length === b.length && a.every((x) => b.some((y) => y.id === x.id && y.sign_pk === x.sign_pk && (x.box_pk === null || y.box_pk === null || x.box_pk === y.box_pk)));

export const WEB_SESSION_MS = 7 * 86_400_000;
export const SIGN_IN_MS = 10 * 60_000;
const hash = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

export type AddResult = "added" | "duplicate" | "reply_to_reply" | "second_reply" | "unknown_target" | "wrong_sender";

export function openInbox(home: string) {
  const file = join(home, "inbox.db");
  const fresh = !existsSync(file);
  const previous = process.umask(0o077);
  const db = new Database(file, { create: true, strict: true });
  process.umask(previous);
  if (fresh) chmodSync(file, 0o600);
  db.run("PRAGMA journal_mode = WAL");
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, convo TEXT NOT NULL, from_handle TEXT NOT NULL, to_handle TEXT NOT NULL,
    kind TEXT NOT NULL, text TEXT NOT NULL, context TEXT, sent_at INTEGER NOT NULL,
    received_at INTEGER NOT NULL, read_at INTEGER, handled TEXT)`);
  // Columns added in increment 3; an inbox from before gains them.
  // Columns added in increment 4: the input gate's state.
  for (const col of ["direction TEXT NOT NULL DEFAULT 'in'", "channel TEXT", "in_reply_to TEXT", "local_agent TEXT NOT NULL DEFAULT ''", "expected INTEGER", "gate TEXT", "gate_reason TEXT", "gate_detail TEXT", "rejected TEXT"])
    try {
      db.run(`ALTER TABLE messages ADD COLUMN ${col}`);
    } catch {}
  // Columns added in increment 5: message states and claims. An inbox from before keeps read messages read.
  const cols = new Set(db.query<{ name: string }, []>("PRAGMA table_info(messages)").all().map((c) => c.name));
  if (!cols.has("state")) {
    db.run("ALTER TABLE messages ADD COLUMN state TEXT NOT NULL DEFAULT 'unread'");
    db.run("UPDATE messages SET state = 'read' WHERE read_at IS NOT NULL");
  }
  // allowed_action: increment 7. held_at, not_reviewed: increment 10.
  for (const col of ["state_reason TEXT", "claim_token TEXT", "claim_until INTEGER", "workspaces TEXT", "allowed_action TEXT", "held_at INTEGER", "not_reviewed INTEGER"]) if (!cols.has(col.split(" ")[0]!)) db.run(`ALTER TABLE messages ADD COLUMN ${col}`);
  db.run("CREATE INDEX IF NOT EXISTS messages_convo ON messages (convo, received_at)");
  db.run(`CREATE TABLE IF NOT EXISTS drafts (
    id TEXT PRIMARY KEY, msg TEXT NOT NULL, channel_ref TEXT, answering TEXT, created_at INTEGER NOT NULL, state TEXT NOT NULL,
    decision TEXT NOT NULL, decided_by TEXT, decided_at INTEGER, final_text TEXT)`);
  // The web app's sessions and in-progress GitHub sign-ins (increment 9), so they survive a restart. A session is
  // keyed by a hash of its cookie and holds the exchange's session token, which the web app needs to act.
  db.run("CREATE TABLE IF NOT EXISTS web_sessions (id_hash TEXT PRIMARY KEY, login TEXT NOT NULL, token TEXT NOT NULL, csrf TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)");
  db.run("CREATE TABLE IF NOT EXISTS sign_ins (state_hash TEXT PRIMARY KEY, next TEXT NOT NULL, expires_at INTEGER NOT NULL)");
  // Contact key pinning (increment 9): each contact's device keys as first seen, a change the owner has not decided
  // yet (or blocked), and outgoing messages held until then.
  db.run("CREATE TABLE IF NOT EXISTS pins (agent TEXT NOT NULL, device_id TEXT NOT NULL, sign_pk TEXT NOT NULL, box_pk TEXT, pinned_at INTEGER NOT NULL, PRIMARY KEY (agent, device_id))");
  db.run("CREATE TABLE IF NOT EXISTS key_changes (agent TEXT PRIMARY KEY, devices TEXT NOT NULL, state TEXT NOT NULL, detected_at INTEGER NOT NULL)");
  db.run("CREATE TABLE IF NOT EXISTS held_sends (id TEXT NOT NULL, agent TEXT NOT NULL, msg TEXT NOT NULL, channel_ref TEXT, created_at INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY (id, agent))");
  // The local outbox (increment 10): what local agents sent while the exchange was unreachable, after the output gate,
  // in order. Routing fields in clear; the message itself sealed for this device (crypto.ts sealForSelf).
  db.run(`CREATE TABLE IF NOT EXISTS outbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, convo TEXT NOT NULL, from_agent TEXT NOT NULL, to_ref TEXT NOT NULL,
    kind TEXT NOT NULL, in_reply_to TEXT, sealed TEXT NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL, reason TEXT, settled_at INTEGER)`);
  // Small facts kept across restarts: who this device is paired with and the agents it hosts, so a gatekeeper that
  // starts while the exchange is unreachable can still queue what its agents send.
  db.run("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  // One reply per agent per message, enforced by the database itself.
  db.run("CREATE UNIQUE INDEX IF NOT EXISTS one_reply_per_agent ON messages (in_reply_to, from_handle) WHERE kind = 'reply'");

  const q = {
    add: db.query(
      `INSERT OR IGNORE INTO messages (id, convo, from_handle, to_handle, kind, text, context, sent_at, received_at, direction, channel, in_reply_to, local_agent, expected, gate, rejected, workspaces)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    setGate: db.query("UPDATE messages SET gate = ?1, gate_reason = ?2, gate_detail = ?3, allowed_action = ?4, held_at = CASE WHEN ?1 = 'held' THEN coalesce(?6, received_at) ELSE held_at END WHERE id = ?5"),
    deliverUnreviewed: db.query("UPDATE messages SET gate = NULL, gate_reason = NULL, allowed_action = NULL, not_reviewed = 1 WHERE id = ? AND gate = 'held'"),
    expireSent: db.query("UPDATE messages SET state = 'expired', state_reason = ? WHERE id = ? AND direction = 'out'"),
    notSentDraft: db.query<{ state: string }, [string]>(
      "SELECT state FROM drafts WHERE json_extract(msg, '$.convo') = ? AND json_extract(msg, '$.kind') != 'reply' AND state IN ('expired', 'rejected') ORDER BY created_at DESC LIMIT 1",
    ),
    notSentMessage: db.query<{ state_reason: string | null }, [string]>(
      "SELECT state_reason FROM messages WHERE direction = 'out' AND convo = ? AND kind != 'reply' AND state = 'expired' ORDER BY received_at DESC LIMIT 1",
    ),
    byGate: db.query<Row, [string]>("SELECT * FROM messages WHERE direction = 'in' AND gate = ? ORDER BY received_at, rowid"),
    countFrom: db.query<{ n: number }, [string, number]>(
      "SELECT count(*) AS n FROM messages WHERE direction = 'in' AND kind != 'reply' AND (gate IS NULL OR gate = 'held') AND from_handle = ? AND received_at >= ?",
    ),
    countChannel: db.query<{ n: number }, [string, number]>(
      "SELECT count(*) AS n FROM messages WHERE direction = 'in' AND kind != 'reply' AND (gate IS NULL OR gate = 'held') AND json_extract(channel, '$.id') = ? AND received_at >= ?",
    ),
    addDraft: db.query("INSERT INTO drafts (id, msg, channel_ref, answering, created_at, state, decision) VALUES (?, ?, ?, ?, ?, 'held', ?)"),
    draft: db.query<DraftRow, [string]>("SELECT * FROM drafts WHERE id = ?"),
    heldDrafts: db.query<DraftRow, []>("SELECT * FROM drafts WHERE state = 'held' ORDER BY created_at"),
    decideDraft: db.query("UPDATE drafts SET state = ?, decided_by = ?, decided_at = ?, final_text = ? WHERE id = ? AND state = 'held'"),
    get: db.query<Row, [string]>("SELECT * FROM messages WHERE id = ?"),
    replyBy: db.query<Row, [string, string]>("SELECT * FROM messages WHERE kind = 'reply' AND in_reply_to = ? AND from_handle = ?"),
    list: db.query<Row, [string, number]>(
      `SELECT * FROM messages WHERE direction = 'in' AND CASE ?1
         WHEN 'rejected' THEN gate = 'rejected' OR (gate IS NULL AND state = 'rejected')
         WHEN 'all' THEN gate IS NULL AND state != 'rejected'
         WHEN 'unread' THEN gate IS NULL AND state = 'unread'
         ELSE gate IS NULL AND state IN ('unread', 'read', 'claimed', 'failed') END
       ORDER BY received_at DESC, rowid DESC LIMIT ?2`,
    ),
    pending: db.query<Row, [number]>(
      `SELECT * FROM messages WHERE direction = 'in' AND gate IS NULL
         AND (state = 'unread' OR (state = 'claimed' AND claim_until IS NOT NULL AND claim_until < ?)) ORDER BY received_at, rowid`,
    ),
    claim: db.query(
      `UPDATE messages SET state = 'claimed', claim_token = ?, claim_until = ?, state_reason = NULL, read_at = coalesce(read_at, ?)
       WHERE id = ? AND direction = 'in' AND gate IS NULL AND kind != 'reply'
         AND (state IN ('unread', 'read', 'failed', 'dismissed') OR (state = 'claimed' AND claim_until IS NOT NULL AND claim_until < ?))`,
    ),
    renew: db.query("UPDATE messages SET claim_until = ? WHERE id = ? AND claim_token = ? AND state = 'claimed' AND claim_until IS NOT NULL"),
    hold: db.query("UPDATE messages SET claim_until = NULL, state_reason = ? WHERE id = ? AND claim_token = ? AND state = 'claimed'"),
    release: db.query("UPDATE messages SET state = 'read', claim_token = NULL, claim_until = NULL WHERE id = ? AND claim_token = ? AND state = 'claimed'"),
    settleClaim: db.query("UPDATE messages SET state = ?, state_reason = ?, claim_token = NULL, claim_until = NULL WHERE id = ? AND claim_token = ? AND state = 'claimed'"),
    settle: db.query("UPDATE messages SET state = ?, state_reason = ?, claim_token = NULL, claim_until = NULL WHERE id = ? AND direction = 'in'"),
    dismiss: db.query(
      `UPDATE messages SET state = 'dismissed', claim_token = NULL, claim_until = NULL WHERE id = ? AND direction = 'in' AND gate IS NULL
         AND (state IN ('unread', 'read', 'failed') OR (state = 'claimed' AND claim_until IS NOT NULL AND claim_until < ?))`,
    ),
    reject: db.query(
      `UPDATE messages SET state = 'rejected', state_reason = ?, claim_token = NULL, claim_until = NULL WHERE id = ? AND direction = 'in' AND gate IS NULL
         AND kind != 'reply' AND (state IN ('unread', 'read', 'failed') OR (state = 'claimed' AND claim_until IS NOT NULL AND claim_until < ?))`,
    ),
    byPrefix: db.query<Row, [string]>("SELECT * FROM messages WHERE direction = 'in' AND gate IS NULL AND id LIKE ? ESCAPE '\\' LIMIT 2"),
    markRead: db.query("UPDATE messages SET read_at = coalesce(read_at, ?), state = CASE WHEN state = 'unread' THEN 'read' ELSE state END WHERE id = ?"),
    handled: db.query("UPDATE messages SET handled = ? WHERE id = ?"),
    nextReply: db.query<Row, [string]>(
      "SELECT * FROM messages WHERE direction = 'in' AND gate IS NULL AND convo = ? AND kind = 'reply' AND read_at IS NULL ORDER BY received_at, rowid LIMIT 1",
    ),
    repliesTo: db.query<Row, [string]>(
      "SELECT * FROM messages WHERE direction = 'in' AND gate IS NULL AND kind = 'reply' AND in_reply_to = ? AND read_at IS NULL ORDER BY received_at, rowid",
    ),
    replyCount: db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM messages WHERE kind = 'reply' AND in_reply_to = ? AND direction = 'in' AND (gate IS NULL OR gate = 'rejected')"),
    sentBroadcast: db.query<Row, [string, string]>(
      "SELECT * FROM messages WHERE direction = 'out' AND kind != 'reply' AND channel IS NOT NULL AND (convo = ? OR id = ?) LIMIT 1",
    ),
    // A direct message this computer sent, by its conversation or message id (or a unique prefix of either).
    sentDirect: db.query<Row, [string, string]>(
      "SELECT * FROM messages WHERE direction = 'out' AND kind != 'reply' AND channel IS NULL AND (convo LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\') ORDER BY rowid DESC LIMIT 2",
    ),
    original: db.query<Row, [string, string]>(
      "SELECT * FROM messages WHERE direction = 'in' AND gate IS NULL AND kind != 'reply' AND (convo LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\') ORDER BY received_at DESC LIMIT 2",
    ),
    replyById: db.query<Row, [string]>("SELECT * FROM messages WHERE kind = 'reply' AND id LIKE ? ESCAPE '\\' LIMIT 1"),
    unread: db.query<{ n: number }, []>("SELECT count(*) AS n FROM messages WHERE direction = 'in' AND gate IS NULL AND state = 'unread'"),
    counts: db.query<{ state: MessageState; n: number }, []>(
      "SELECT CASE WHEN gate = 'rejected' THEN 'rejected' ELSE state END AS state, count(*) AS n FROM messages WHERE direction = 'in' AND (gate IS NULL OR gate = 'rejected') GROUP BY 1",
    ),
    channels: db.query<{ channel: string; last: number; n: number }, []>(
      "SELECT channel, max(received_at) AS last, count(*) AS n FROM messages WHERE channel IS NOT NULL AND gate IS NULL GROUP BY json_extract(channel, '$.id') ORDER BY last DESC",
    ),
    channelRoots: db.query<Row, [string]>(
      "SELECT * FROM messages WHERE channel IS NOT NULL AND gate IS NULL AND json_extract(channel, '$.id') = ? AND kind != 'reply' ORDER BY received_at DESC, rowid DESC LIMIT 100",
    ),
    replies: db.query<Row, [string]>("SELECT * FROM messages WHERE kind = 'reply' AND in_reply_to = ? AND gate IS NULL ORDER BY received_at, rowid"),
    addWebSession: db.query("INSERT INTO web_sessions (id_hash, login, token, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)"),
    webSession: db.query<{ login: string; token: string; csrf: string; created_at: number }, [string, number]>(
      "SELECT login, token, csrf, created_at FROM web_sessions WHERE id_hash = ? AND expires_at > ?",
    ),
    dropWebSession: db.query("DELETE FROM web_sessions WHERE id_hash = ?"),
    dropExpired: db.query("DELETE FROM web_sessions WHERE expires_at <= ?1"),
    dropExpiredSignIns: db.query("DELETE FROM sign_ins WHERE expires_at <= ?1"),
    addSignIn: db.query("INSERT INTO sign_ins (state_hash, next, expires_at) VALUES (?, ?, ?)"),
    takeSignIn: db.query<{ next: string; expires_at: number }, [string]>("DELETE FROM sign_ins WHERE state_hash = ? RETURNING next, expires_at"),
    pins: db.query<PinRow, [string]>("SELECT * FROM pins WHERE agent = ? ORDER BY device_id"),
    allPins: db.query<PinRow, []>("SELECT * FROM pins ORDER BY agent, device_id"),
    addPin: db.query("INSERT OR REPLACE INTO pins (agent, device_id, sign_pk, box_pk, pinned_at) VALUES (?, ?, ?, ?, ?)"),
    fillBox: db.query("UPDATE pins SET box_pk = ? WHERE agent = ? AND device_id = ? AND box_pk IS NULL"),
    dropPins: db.query("DELETE FROM pins WHERE agent = ?"),
    keyChange: db.query<{ agent: string; devices: string; state: "pending" | "blocked"; detected_at: number }, [string]>("SELECT * FROM key_changes WHERE agent = ?"),
    keyChanges: db.query<{ agent: string; devices: string; state: "pending" | "blocked"; detected_at: number }, []>("SELECT * FROM key_changes ORDER BY detected_at"),
    setKeyChange: db.query("INSERT OR REPLACE INTO key_changes (agent, devices, state, detected_at) VALUES (?, ?, ?, ?)"),
    dropKeyChange: db.query("DELETE FROM key_changes WHERE agent = ?"),
    holdSend: db.query("INSERT OR IGNORE INTO held_sends (id, agent, msg, channel_ref, created_at, state) VALUES (?, ?, ?, ?, ?, 'held')"),
    heldSends: db.query<{ id: string; agent: string; msg: string; channel_ref: string | null; created_at: number }, [string]>(
      "SELECT * FROM held_sends WHERE agent = ? AND state = 'held' ORDER BY created_at",
    ),
    settleSend: db.query("UPDATE held_sends SET state = ? WHERE id = ? AND agent = ? AND state = 'held'"),
    addOutbox: db.query("INSERT INTO outbox (id, convo, from_agent, to_ref, kind, in_reply_to, sealed, created_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued')"),
    outbox: db.query<OutboxRow, []>("SELECT * FROM outbox WHERE state = 'queued' ORDER BY seq"),
    outboxItem: db.query<OutboxRow, [string]>("SELECT * FROM outbox WHERE id = ?"),
    outboxByPrefix: db.query<OutboxRow, [string]>("SELECT * FROM outbox WHERE state = 'queued' AND id LIKE ? ESCAPE '\\' LIMIT 2"),
    settleOutbox: db.query("UPDATE outbox SET state = ?, reason = ?, settled_at = ? WHERE id = ? AND state = 'queued'"),
    outboxReply: db.query<{ n: number }, [string, string]>("SELECT count(*) AS n FROM outbox WHERE state = 'queued' AND kind = 'reply' AND in_reply_to = ? AND from_agent = ?"),
    notSentOutbox: db.query<{ state: string; reason: string | null }, [string]>(
      "SELECT state, reason FROM outbox WHERE convo = ? AND kind != 'reply' AND state IN ('cancelled', 'expired', 'failed') ORDER BY seq DESC LIMIT 1",
    ),
    getKv: db.query<{ value: string }, [string]>("SELECT value FROM kv WHERE key = ?"),
    setKv: db.query("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)"),
    dms: db.query<Row, []>(
      "SELECT * FROM messages WHERE channel IS NULL AND gate IS NULL AND kind != 'reply' ORDER BY received_at DESC, rowid DESC LIMIT 100",
    ),
  };
  const like = (prefix: string) => prefix.replace(/[\\%_]/g, (c) => `\\${c}`) + "%";

  const insert = (msg: Message, direction: Direction, localAgent: string, expected: number | null = null, gate: GateState | null = null, workspaces: string[] | null = null) =>
    q.add.run(
      msg.id,
      msg.convo,
      msg.from,
      msg.to,
      msg.kind,
      msg.text,
      msg.context ? JSON.stringify(msg.context) : null,
      msg.ts,
      Date.now(),
      direction,
      msg.channel ? JSON.stringify(msg.channel) : null,
      msg.in_reply_to ?? null,
      localAgent,
      expected,
      gate,
      msg.rejected?.reason ?? null,
      workspaces ? JSON.stringify(workspaces) : null,
    ).changes > 0;

  const inbox = {
    // Stores an incoming message, applying the reply rules. Only "added" is new and should be acted on.
    // `gate: "checking"` stores it out of the inbox until the input gate decides.
    add(msg: Message, localAgent: string, gate: "checking" | "keys" | null = null, workspaces?: string[]): AddResult {
      if (msg.kind === "reply") {
        const target = q.get.get(msg.in_reply_to ?? "");
        if (!target) return "unknown_target";
        if (target.kind === "reply") return "reply_to_reply";
        // Only the agent a direct message was sent to may answer it; a broadcast is answered in its own channel
        // (security audit S12). A reply to a message that reached this gatekeeper from the network is a channel case.
        // A rejection notice is the one reply that travels as a direct message for a broadcast: the gatekeeper that
        // refused it tells the sender why (batch 2, `patio reject` and the input gate). Dropping it would silence the
        // refusal, so a notice that answers the owner's own outgoing message is accepted from any recipient.
        const targetChannel = target.channel ? (JSON.parse(target.channel) as ChannelRef).id : null;
        const notice = msg.rejected !== undefined && target.direction === "out";
        if (!notice && (targetChannel ? msg.channel?.id !== targetChannel : !(target.direction === "out" && msg.from === target.to_handle)))
          return "wrong_sender";
        if (q.replyBy.get(msg.in_reply_to!, msg.from)) return q.get.get(msg.id) ? "duplicate" : "second_reply";
      }
      return insert(msg, "in", localAgent, null, gate, workspaces ?? null) ? "added" : "duplicate";
    },
    // Records what a local agent sent (already read; it is not part of the inbox listing).
    sent(msg: Message, localAgent: string, expected: number | null = null) {
      insert(msg, "out", localAgent, expected);
      q.markRead.run(Date.now(), msg.id);
    },
    // Before a local agent answers `targetId`: refuses a reply to a reply, and a second reply.
    checkReply(targetId: string, fromAgent: string) {
      const target = q.get.get(targetId);
      if (target?.kind === "reply") throw new ReplyRule("reply_to_reply", "that message is itself a reply; nobody answers an answer");
      if (q.replyBy.get(targetId, fromAgent)) throw new ReplyRule("already_replied", `${fromAgent} has already answered that message; each agent answers once`);
      if (q.outboxReply.get(targetId, fromAgent)!.n)
        throw new ReplyRule("already_replied", `${fromAgent}'s answer to that message waits in the outbox; each agent answers once (patio outbox cancel to take it back)`);
    },
    list(opts: { filter?: ListFilter; unreadOnly?: boolean; limit?: number } = {}): InboxItem[] {
      return q.list.all(opts.unreadOnly ? "unread" : (opts.filter ?? "open"), opts.limit ?? 50).map(toItem);
    },
    // Delivered messages nobody has dealt with: unread, or claimed by a consumer whose lease ran out. Oldest first.
    pending: (now = Date.now()) => q.pending.all(now).map(toItem),

    // ---- claims: `patio answer` holds a lease on a message while the owner's agent answers it ---------------
    claim(id: string, leaseMs: number, now = Date.now()): ClaimResult {
      const token = crypto.randomUUID();
      if (q.claim.run(token, now + leaseMs, now, id, now).changes > 0) return { ok: true, token, until: now + leaseMs };
      const row = q.get.get(id);
      if (!row || row.direction !== "in" || row.gate !== null) return { ok: false, code: "unknown_message" };
      if (row.kind === "reply") return { ok: false, code: "reply_to_reply" };
      if (row.state === "answered") return { ok: false, code: "already_replied" };
      if (row.state === "rejected") return { ok: false, code: "already_rejected" };
      return { ok: false, code: "already_claimed", until: row.claim_until };
    },
    renew: (id: string, token: string, leaseMs: number, now = Date.now()) => q.renew.run(now + leaseMs, id, token).changes > 0,
    // The reply is held for the owner: the claim stays, without expiry, until the owner decides.
    hold: (id: string, token: string, reason: string | null = null) => q.hold.run(reason, id, token).changes > 0,
    release: (id: string, token: string) => q.release.run(id, token).changes > 0,
    // Closes a message as answered or failed. With a token, only while that claim holds it.
    settle(id: string, state: "answered" | "failed", reason: string | null, token?: string) {
      return (token ? q.settleClaim.run(state, reason, id, token) : q.settle.run(state, reason, id)).changes > 0;
    },
    dismiss(id: string, now = Date.now()): { ok: true } | { ok: false; code: "unknown_message" | "already_claimed" | "already_replied" | "already_rejected" } {
      if (q.dismiss.run(id, now).changes > 0) return { ok: true };
      const row = q.get.get(id);
      if (!row || row.direction !== "in" || row.gate !== null) return { ok: false, code: "unknown_message" };
      return { ok: false, code: row.state === "claimed" ? "already_claimed" : row.state === "rejected" ? "already_rejected" : "already_replied" };
    },
    // The recipient declines a delivered message (`patio reject`): open, failed, or claimed by a consumer whose
    // lease ran out. `reason` is what the owner (or their agent) wrote, kept as the state's reason.
    reject(id: string, reason: string | null, now = Date.now()): RejectResult {
      if (q.reject.run(reason, id, now).changes > 0) return { ok: true };
      const row = q.get.get(id);
      if (!row || row.direction !== "in" || row.gate !== null) return { ok: false, code: "unknown_message" };
      if (row.kind === "reply" || row.state === "answered") return { ok: false, code: "already_replied" };
      if (row.state === "rejected") return { ok: false, code: "already_rejected" };
      if (row.state === "dismissed") return { ok: false, code: "already_dismissed" };
      return { ok: false, code: "already_claimed" };
    },
    // An incoming delivered message by id or unique id prefix, without marking it read.
    find(idPrefix: string): InboxItem | null {
      const rows = idPrefix ? q.byPrefix.all(like(idPrefix)) : [];
      if (rows.length > 1) throw new AmbiguousId(`more than one message starts with ${idPrefix}`);
      return rows[0] ? toItem(rows[0]) : null;
    },
    unreadCount: () => q.unread.get()!.n,
    // Delivered incoming messages (and rejected ones) by state, for `patio status`.
    counts() {
      const c: Record<MessageState, number> = { unread: 0, read: 0, claimed: 0, failed: 0, answered: 0, dismissed: 0, rejected: 0 };
      for (const r of q.counts.all()) c[r.state] = (c[r.state] ?? 0) + r.n;
      return c;
    },
    get: (id: string) => {
      const row = q.get.get(id);
      return row ? toItem(row) : null;
    },
    // Finds an incoming message by id or unique id prefix, and marks it read.
    read(idPrefix: string): InboxItem | null {
      const rows = idPrefix ? q.byPrefix.all(like(idPrefix)) : [];
      if (rows.length > 1) throw new AmbiguousId(`more than one message starts with ${idPrefix}`);
      if (!rows[0]) return null;
      q.markRead.run(Date.now(), rows[0].id);
      return toItem(rows[0]);
    },
    markHandled: (id: string, how: string) => void q.handled.run(how, id),
    markRead: (id: string) => void q.markRead.run(Date.now(), id),
    // The oldest unread reply on a direct conversation, marked read. This is what `wait` returns for a DM.
    takeReply(convo: string): InboxItem | null {
      const row = q.nextReply.get(convo);
      if (!row) return null;
      q.markRead.run(Date.now(), row.id);
      return toItem(row);
    },
    // A broadcast this gatekeeper sent, found by its conversation or message id.
    sentBroadcast(ref: string): InboxItem | null {
      const row = q.sentBroadcast.get(ref, ref);
      return row ? toItem(row) : null;
    },
    // The unread replies to a broadcast, marked read, and how many replies it has had in all.
    takeBroadcastReplies(broadcastId: string) {
      const rows = q.repliesTo.all(broadcastId);
      for (const r of rows) q.markRead.run(Date.now(), r.id);
      return { replies: rows.map(toItem), total: q.replyCount.get(broadcastId)!.n };
    },
    // A direct message this computer sent, by its conversation or message id (or a unique prefix of either): for `wait`,
    // which takes either.
    sentDirect(ref: string): InboxItem | null {
      if (!ref) return null;
      const rows = q.sentDirect.all(like(ref), like(ref));
      if (rows.length > 1 && rows[0]!.convo !== rows[1]!.convo) throw new AmbiguousId(`more than one conversation matches ${ref}`);
      return rows[0] ? toItem(rows[0]) : null;
    },
    // The incoming message a `reply` answers: by conversation id or message id (or a unique prefix of either).
    // Naming a reply is refused: nobody answers an answer.
    original(ref: string): InboxItem | null {
      if (!ref) return null;
      const rows = q.original.all(like(ref), like(ref));
      if (rows.length > 1 && rows[0]!.convo !== rows[1]!.convo) throw new AmbiguousId(`more than one conversation matches ${ref}`);
      if (!rows[0] && q.replyById.get(like(ref))) throw new ReplyRule("reply_to_reply", "that message is a reply; nobody answers an answer");
      return rows[0] ? toItem(rows[0]) : null;
    },

    // ---- the input gate ------------------------------------------------------------------------
    // `allowedAction`: delivered with an action the owner or the grant allows. `at`: when it was held (for hold_timeout).
    setGate(id: string, state: GateState | null, reason: string | null, decision: GateDecision | null, allowedAction: string | null = null, at: number | null = null) {
      q.setGate.run(state, reason, decision ? JSON.stringify(decision) : null, allowedAction, id, at);
    },
    // A held message nobody reviewed in time, delivered anyway (on_timeout: inbox), marked as not reviewed.
    deliverUnreviewed: (id: string) => q.deliverUnreviewed.run(id).changes > 0,
    // Incoming messages in one gate state, oldest first: `checking` after a restart, `held` for approval cards.
    gated: (state: GateState) => q.byGate.all(state).map(toItem),
    // Messages (not replies) delivered or held today from one sender, or in one channel: for per_day.
    countToday(who: { from: string } | { channel: string }, now = new Date()) {
      const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      return "from" in who ? q.countFrom.get(who.from, midnight)!.n : q.countChannel.get(who.channel, midnight)!.n;
    },

    // ---- the output gate's held drafts ----------------------------------------------------------
    addDraft(msg: Outgoing & { from: string }, channelRef: string | null, answering: string | null, decision: GateDecision) {
      q.addDraft.run(msg.id, JSON.stringify(msg), channelRef, answering, Date.now(), JSON.stringify(decision));
    },
    draft: (id: string) => {
      const row = q.draft.get(id);
      return row ? toDraft(row) : null;
    },
    heldDrafts: () => q.heldDrafts.all().map(toDraft),
    // Records the owner's decision on a held draft; false when it was no longer held.
    decideDraft: (id: string, state: "sent" | "rejected" | "expired", by: string, finalText: string | null) =>
      q.decideDraft.run(state, by, Date.now(), finalText, id).changes > 0,
    // The exchange dropped an outgoing message undelivered (its TTL ran out).
    expireSent: (id: string, reason: string) => q.expireSent.run(reason, id).changes > 0,
    // Why the message that started a conversation was never sent or never delivered, if so: what `wait` reports.
    notSent(convo: string): string | null {
      const d = q.notSentDraft.get(convo);
      if (d) return d.state === "expired" ? "not sent: your owner did not review it in time" : "not sent: your owner rejected it";
      const o = q.notSentOutbox.get(convo);
      if (o) return o.state === "cancelled" ? "not sent: cancelled in the outbox" : `not sent: ${o.reason ?? o.state}`;
      const m = q.notSentMessage.get(convo);
      return m ? (m.state_reason ?? "expired undelivered") : null;
    },

    // ---- the outbox: sends that wait for the exchange ------------------------------------------------------
    queue(item: { id: string; convo: string; from: string; to: string; kind: Kind; in_reply_to?: string }, sealed: string, now = Date.now()) {
      q.addOutbox.run(item.id, item.convo, item.from, item.to, item.kind, item.in_reply_to ?? null, sealed, now);
    },
    // What waits, oldest first (the order it is sent in).
    outbox: () => q.outbox.all(),
    outboxItem: (id: string) => q.outboxItem.get(id) ?? null,
    outboxFind(prefix: string): OutboxRow | null {
      const rows = prefix ? q.outboxByPrefix.all(like(prefix)) : [];
      if (rows.length > 1) throw new AmbiguousId(`more than one queued message starts with ${prefix}`);
      return rows[0] ?? null;
    },
    // sent, held (its recipient's keys changed), failed, cancelled or expired. False when it no longer waited.
    settleOutbox: (id: string, state: "sent" | "held" | "failed" | "cancelled" | "expired", reason: string | null = null, now = Date.now()) =>
      q.settleOutbox.run(state, reason, now, id).changes > 0,

    getKv: <T>(key: string): T | null => {
      const row = q.getKv.get(key);
      return row ? (JSON.parse(row.value) as T) : null;
    },
    setKv: (key: string, value: unknown) => void q.setKv.run(key, JSON.stringify(value)),

    // ---- read-only views for the web app ------------------------------------------------------
    channels: () => q.channels.all().map((c) => ({ channel: JSON.parse(c.channel) as ChannelRef, last: c.last, messages: c.n })),
    channelThreads: (channelId: string) =>
      q.channelRoots.all(channelId).map((r) => ({ message: toItem(r), replies: q.replies.all(r.id).map(toItem) })),
    directThreads: () => q.dms.all().map((r) => ({ message: toItem(r), replies: q.replies.all(r.id).map(toItem) })),

    // ---- contact key pinning ------------------------------------------------------------------------
    pins: (agent: string) => q.pins.all(agent).map(pinDevice),
    allPins: () => q.allPins.all(),
    // A contact's full key set, as the exchange gives it for sending. Pinned at first use; otherwise the same
    // devices with the same keys (a box key first learnt here is filled in), or a change: "blocked" when it is
    // the set the owner blocked.
    checkPins(agent: string, devices: PublicDevice[], now = Date.now()): "ok" | "changed" | "blocked" {
      const pinned = q.pins.all(agent);
      if (!pinned.length) {
        for (const d of devices) q.addPin.run(agent, d.id, d.sign_pk, d.box_pk, now);
        return "ok";
      }
      const same =
        pinned.length === devices.length &&
        devices.every((d) => pinned.some((p) => p.device_id === d.id && p.sign_pk === d.sign_pk && (p.box_pk === null || p.box_pk === d.box_pk)));
      if (same) {
        for (const d of devices) q.fillBox.run(d.box_pk, agent, d.id);
        return "ok";
      }
      const change = q.keyChange.get(agent);
      return change?.state === "blocked" && sameSet(JSON.parse(change.devices), devices) ? "blocked" : "changed";
    },
    // The device a message came from (a delivery carries its signing key, not its box key).
    checkSender(agent: string, device: { id: string; sign_pk: string }, now = Date.now()): "ok" | "changed" | "blocked" {
      const pinned = q.pins.all(agent);
      if (!pinned.length) {
        q.addPin.run(agent, device.id, device.sign_pk, null, now);
        return "ok";
      }
      if (pinned.some((p) => p.device_id === device.id && p.sign_pk === device.sign_pk)) return "ok";
      const change = q.keyChange.get(agent);
      const listed = change && (JSON.parse(change.devices) as PublicDevice[]).some((d) => d.id === device.id && d.sign_pk === device.sign_pk);
      return change?.state === "blocked" && listed ? "blocked" : "changed";
    },
    // Records the keys the exchange now gives for a contact, for the owner to decide. A device seen only as a
    // sender is added to the pending set. Returns true when this is news (a new card, or a new set on it).
    recordKeyChange(agent: string, devices: (PublicDevice | KeyChangeDevice)[], now = Date.now()): boolean {
      const change = q.keyChange.get(agent);
      const before: PublicDevice[] = change && change.state === "pending" ? JSON.parse(change.devices) : [];
      const merged = devices.every((d) => d.box_pk === null) ? [...before.filter((b) => !devices.some((d) => d.id === b.id)), ...devices] : devices;
      if (change?.state === "pending" && sameSet(before, merged)) return false;
      q.setKeyChange.run(agent, JSON.stringify(merged), "pending", change?.state === "pending" ? change.detected_at : now);
      return true;
    },
    keyChange(agent: string) {
      const c = q.keyChange.get(agent);
      return c ? { agent: c.agent, devices: JSON.parse(c.devices) as KeyChangeDevice[], state: c.state, detected_at: c.detected_at } : null;
    },
    keyChanges: () => q.keyChanges.all().map((c) => ({ agent: c.agent, devices: JSON.parse(c.devices) as KeyChangeDevice[], state: c.state, detected_at: c.detected_at })),
    // The owner trusts the new keys: they become the pins.
    trustKeys(agent: string, now = Date.now()) {
      const c = q.keyChange.get(agent);
      if (!c) return false;
      db.transaction(() => {
        q.dropPins.run(agent);
        for (const d of JSON.parse(c.devices) as { id: string; sign_pk: string; box_pk: string | null }[]) q.addPin.run(agent, d.id, d.sign_pk, d.box_pk, now);
        q.dropKeyChange.run(agent);
      })();
      return true;
    },
    // The owner blocks them: the old pins stay, and this set is refused until it changes again.
    blockKeys(agent: string) {
      const c = q.keyChange.get(agent);
      if (!c) return false;
      q.setKeyChange.run(agent, c.devices, "blocked", c.detected_at);
      return true;
    },
    // An outgoing message (or, for a broadcast, one member's copy) held until the owner decides on `agent`'s keys.
    holdSend(msg: Outgoing & { from: string }, channelRef: string | null, agent: string) {
      q.holdSend.run(msg.id, agent, JSON.stringify(msg), channelRef, Date.now());
    },
    heldSends: (agent: string) => q.heldSends.all(agent).map((r) => ({ ...r, msg: JSON.parse(r.msg) as Outgoing & { from: string } })),
    settleSend: (id: string, agent: string, state: "sent" | "dropped") => q.settleSend.run(state, id, agent).changes > 0,

    // ---- the web app's sessions and sign-ins ---------------------------------------------------
    addWebSession(id: string, s: { login: string; token: string; csrf: string }, now = Date.now()) {
      q.dropExpired.run(now);
      q.addWebSession.run(hash(id), s.login, s.token, s.csrf, now, now + WEB_SESSION_MS);
    },
    webSession: (id: string, now = Date.now()) => q.webSession.get(hash(id), now) ?? null,
    dropWebSession: (id: string) => void q.dropWebSession.run(hash(id)),
    addSignIn(state: string, next: string, now = Date.now()) {
      q.dropExpiredSignIns.run(now);
      q.addSignIn.run(hash(state), next, now + SIGN_IN_MS);
    },
    // Used once: taken whether or not it is still valid.
    takeSignIn(state: string, now = Date.now()): { next: string } | null {
      const row = q.takeSignIn.get(hash(state));
      return row && row.expires_at > now ? { next: row.next } : null;
    },

    close: () => db.close(),
  };
  return inbox;
}

export type Inbox = ReturnType<typeof openInbox>;
