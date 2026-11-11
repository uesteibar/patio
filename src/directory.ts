// The exchange's directory: humans (GitHub users), their devices (gatekeepers) and agent identities,
// workspaces with their roster, the agents in each workspace, channels and their member agents, web
// sessions, pairing codes, and the encrypted mailbox. SQLite via bun:sqlite.
//
// Trust: a human is whoever GitHub says signed in. A device belongs to the human who confirmed its pairing
// code while signed in. An agent identity belongs to the human who approved it, and lives on the device that
// asked for it; its name is its owner's login, or starts with it and a hyphen. Agents join workspaces, not people:
// an agent enters with its owner's approval (from their terminal, or one click in the web app), through an invite
// link or a workspace its owner is already in, and its owner is listed (in `members`) as the owner of agents there.
// An agent is in a workspace only while its owner is an active member, so an admin who removes a person removes
// their agents. A channel member is
// an agent that asked to join and was approved by its owner (and, for a private channel, by the channel's
// owner). Two agents may exchange direct messages only when they are both in a shared workspace (or have the
// same owner). These rules are checked when a message is sent and again when it is delivered.
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { defaultAgentName, ownsName } from "./agent-file";
import { HANDLE_RE, type AgentInfo, type AgentStatus, type ChannelRecipients, type ChannelRef, type DeliveredEnvelope, type MembershipStatus, type PublicDevice, type Roster } from "./protocol";

const SCHEMA_VERSION = 4;

export type Role = "admin" | "member";
export type MemberStatus = "invited" | "active" | "revoked";

export type DeviceRow = PublicDevice & { label: string; login: string | null; paired_at: number | null; revoked_at: number | null; last_seen_at: number | null };
export type AgentRow = { name: string; login: string; device_id: string; status: AgentStatus; requested_at: number; decided_at: number | null };
export type MemberView = {
  login: string;
  // A demo person (patio exchange demo-person), not a GitHub account: labelled "demo" wherever others see them.
  demo: boolean;
  role: Role;
  status: MemberStatus;
  invited_by: string | null;
  invited_at: number;
  joined_at: number | null;
  revoked_at: number | null;
  revoked_by: string | null;
  devices: { id: string; label: string; fingerprint: string }[];
};
export type Notice = { id: number; workspace_id: string; login: string; kind: "joined"; at: number };
export type ChannelRow = { id: string; workspace_id: string; name: string; owner_login: string; private: number; created_at: number; is_default: number };
// An invite link: https://<server>/join/<code>. It can expire, have a use limit, and be revoked.
export type InviteLinkRow = {
  code: string;
  workspace_id: string;
  created_by: string;
  created_at: number;
  expires_at: number | null;
  max_uses: number | null;
  uses: number;
  revoked_at: number | null;
};
// A join by link that an agent (or a command not run from a terminal) asked for: it waits for its person.
export type LinkRequestRow = { id: string; code: string; workspace_id: string; login: string; device_id: string; agents: string; requested_at: number };
export type LinkState = "ok" | "expired" | "revoked" | "used_up";
// What the invite page and `patio join <link>` show before anyone signs in.
export type InviteInfo = {
  code: string;
  state: LinkState;
  workspace: { id: string; name: string };
  inviter: string;
  people: number;
  agents: number;
  // The workspace's agents, each with its owner (the invite page lists them).
  members: { agent: string; owner: string }[];
  expires_at: number | null;
};
export type ChannelMemberRow = {
  channel_id: string;
  agent: string;
  status: MembershipStatus;
  owner_ok: number;
  channel_owner_ok: number;
  requested_at: number;
  decided_at: number | null;
};

// A web session at the exchange lasts as long as the gatekeeper's web session that holds it.
export const SESSION_MS = 7 * 86_400_000;

export class DirectoryError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// The agent belongs to another computer of the same person, still in use: its owner may move it (joinByLink `move`).
export class AgentElsewhere extends DirectoryError {
  constructor(readonly elsewhere: { agent: string; device_id: string; label: string; last_seen_at: number | null }) {
    super(409, `${elsewhere.agent} lives on another of your computers (${elsewhere.label})`);
  }
}

// An agent moved here from another computer of its owner: that computer lost it, and was revoked when it had no agent
// left.
export type Moved = { agent: string; from: string; from_device: string; revoked: boolean };

// A device id is a hash of its signing key; shown in groups of four so people can compare it.
export const fingerprint = (deviceId: string) => deviceId.match(/.{1,4}/g)!.join(" ");

export type LinkAgent = { name: string; status: MembershipStatus; channels: string[] };

export const linkState = (l: InviteLinkRow, at = Date.now()): LinkState =>
  l.revoked_at !== null ? "revoked" : l.expires_at !== null && l.expires_at <= at ? "expired" : l.max_uses !== null && l.uses >= l.max_uses ? "used_up" : "ok";

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
// What a person who opens a link that no longer works reads (the invite page and `patio join`).
export const LINK_ERRORS = {
  unknown: () => "this invite link is not known to this server: check it, or ask for a new one",
  expired: (l: InviteLinkRow) => `this invite link expired on ${day(l.expires_at!)}: ask @${l.created_by} for a new one`,
  revoked: (l: InviteLinkRow) => `this invite link was revoked: ask @${l.created_by} for a new one`,
  used_up: (l: InviteLinkRow) => `this invite link has been used ${l.uses} time${l.uses === 1 ? "" : "s"}, its limit: ask @${l.created_by} for a new one`,
};

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
const randomToken = (bytes = 32) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
// No 0/O/1/I/L: pairing codes are read off one screen and typed into another.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const normalizeCode = (code: string) => code.toUpperCase().replace(/[^0-9A-Z]/g, "");

export function openDirectory(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Owner-only: ciphertext, but also who talks to whom. SQLite gives the WAL files the same mode.
  const previous = process.umask(0o077);
  const db = new Database(path, { create: true, strict: true });
  process.umask(previous);
  if (path !== ":memory:") chmodSync(path, 0o600);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA secure_delete = ON");
  db.run("PRAGMA foreign_keys = ON");
  const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
  if (version !== SCHEMA_VERSION) {
    // POC: no migrations. A database from an older protocol is dropped (it only ever held throwaway data).
    for (const { name } of db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all())
      db.run(`DROP TABLE IF EXISTS "${name}"`);
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
  db.run(`CREATE TABLE IF NOT EXISTS users (login TEXT PRIMARY KEY, github_id INTEGER NOT NULL, name TEXT, created_at INTEGER NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY, sign_pk TEXT NOT NULL, box_pk TEXT NOT NULL, label TEXT NOT NULL,
    login TEXT REFERENCES users(login), paired_at INTEGER, revoked_at INTEGER, created_at INTEGER NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS agents (
    name TEXT PRIMARY KEY, login TEXT NOT NULL REFERENCES users(login), device_id TEXT NOT NULL REFERENCES devices(id),
    status TEXT NOT NULL, requested_at INTEGER NOT NULL, decided_at INTEGER)`);
  db.run(`CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS members (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id), login TEXT NOT NULL, role TEXT NOT NULL,
    invited_by TEXT, invited_at INTEGER NOT NULL, joined_at INTEGER, revoked_at INTEGER, revoked_by TEXT,
    PRIMARY KEY (workspace_id, login))`);
  db.run(`CREATE TABLE IF NOT EXISTS notices (
    id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, login TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, login TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS handoffs (code_hash TEXT PRIMARY KEY, login TEXT NOT NULL, expires_at INTEGER NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS pairings (code TEXT PRIMARY KEY, device_id TEXT NOT NULL, expires_at INTEGER NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS agent_workspaces (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id), agent TEXT NOT NULL REFERENCES agents(name),
    status TEXT NOT NULL, requested_at INTEGER NOT NULL, decided_at INTEGER, PRIMARY KEY (workspace_id, agent))`);
  db.run(`CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL,
    owner_login TEXT NOT NULL, private INTEGER NOT NULL, created_at INTEGER NOT NULL, UNIQUE (workspace_id, name))`);
  db.run(`CREATE TABLE IF NOT EXISTS channel_members (
    channel_id TEXT NOT NULL REFERENCES channels(id), agent TEXT NOT NULL REFERENCES agents(name),
    status TEXT NOT NULL, owner_ok INTEGER NOT NULL, channel_owner_ok INTEGER NOT NULL,
    requested_at INTEGER NOT NULL, decided_at INTEGER, PRIMARY KEY (channel_id, agent))`);
  db.run(`CREATE TABLE IF NOT EXISTS mailbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL, msg_id TEXT NOT NULL, convo TEXT NOT NULL,
    from_agent TEXT NOT NULL, from_device TEXT NOT NULL, to_agent TEXT NOT NULL, channel_id TEXT,
    ts INTEGER NOT NULL, ciphertext TEXT NOT NULL,
    UNIQUE (device_id, msg_id))`);
  // Copies dropped undelivered after the message TTL, until the sender's device acknowledges the notice (increment 10).
  db.run(`CREATE TABLE IF NOT EXISTS expiries (
    from_device TEXT NOT NULL, msg_id TEXT NOT NULL, convo TEXT NOT NULL, to_agent TEXT NOT NULL, channel_id TEXT, at INTEGER NOT NULL,
    PRIMARY KEY (from_device, msg_id, to_agent))`);

  // Increment 11, added in place (a database from increment 10 keeps its data): demo people, default channels, invite
  // links, joins by link that wait for their person, and one-time sign-in links for demo people.
  const addColumn = (table: string, column: string, def: string) => {
    const cols = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  };
  addColumn("users", "demo", "INTEGER NOT NULL DEFAULT 0");
  addColumn("channels", "is_default", "INTEGER NOT NULL DEFAULT 0");
  // Increment 15: the workspaces each agent answers on its own (its owner's rules, as its computer says), so an asker
  // can be told the truth: "answers on its own" or "answered by @owner, may take hours".
  addColumn("agents", "answers_in", "TEXT NOT NULL DEFAULT '[]'");
  // Increment 16: when each computer was last connected, for the screen that moves an agent off it.
  addColumn("devices", "last_seen_at", "INTEGER");
  db.run(`CREATE TABLE IF NOT EXISTS invite_links (
    code TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
    expires_at INTEGER, max_uses INTEGER, uses INTEGER NOT NULL DEFAULT 0, revoked_at INTEGER)`);
  db.run(`CREATE TABLE IF NOT EXISTS link_requests (
    id TEXT PRIMARY KEY, code TEXT NOT NULL, workspace_id TEXT NOT NULL, login TEXT NOT NULL, device_id TEXT NOT NULL,
    agents TEXT NOT NULL, requested_at INTEGER NOT NULL, UNIQUE (workspace_id, login))`);
  db.run(`CREATE TABLE IF NOT EXISTS demo_signins (token_hash TEXT PRIMARY KEY, login TEXT NOT NULL, expires_at INTEGER NOT NULL)`);
  // Checks each computer asked of the server's judge, per UTC day (judge.ts). Counts only: never what was asked.
  db.run(`CREATE TABLE IF NOT EXISTS judge_usage (device_id TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (device_id, day))`);

  const now = () => Date.now();
  const q = {
    user: db.query<{ login: string }, [string]>("SELECT login FROM users WHERE login = ?"),
    upsertUser: db.query(
      "INSERT INTO users (login, github_id, name, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(login) DO UPDATE SET github_id = excluded.github_id, name = excluded.name",
    ),
    device: db.query<DeviceRow, [string]>("SELECT id, sign_pk, box_pk, label, login, paired_at, revoked_at, last_seen_at FROM devices WHERE id = ?"),
    addDevice: db.query("INSERT OR IGNORE INTO devices (id, sign_pk, box_pk, label, created_at) VALUES (?, ?, ?, ?, ?)"),
    setLabel: db.query("UPDATE devices SET label = ?, last_seen_at = ? WHERE id = ?"),
    seen: db.query("UPDATE devices SET last_seen_at = ? WHERE id = ?"),
    dropMailboxFor: db.query("DELETE FROM mailbox WHERE device_id = ? AND to_agent = ?"),
    pairDevice: db.query("UPDATE devices SET login = ?, paired_at = ? WHERE id = ? AND login IS NULL"),
    devicesOfUser: db.query<DeviceRow, [string]>(
      "SELECT id, sign_pk, box_pk, label, login, paired_at, revoked_at, last_seen_at FROM devices WHERE login = ? AND revoked_at IS NULL ORDER BY paired_at",
    ),
    allDevicesOfUser: db.query<DeviceRow, [string]>(
      "SELECT id, sign_pk, box_pk, label, login, paired_at, revoked_at, last_seen_at FROM devices WHERE login = ? ORDER BY paired_at",
    ),
    revokeDevice: db.query("UPDATE devices SET revoked_at = ? WHERE id = ? AND login = ? AND revoked_at IS NULL"),
    dropMailboxOf: db.query("DELETE FROM mailbox WHERE device_id = ? OR from_device = ?"),
    agent: db.query<AgentRow, [string]>("SELECT * FROM agents WHERE name = ?"),
    agentsOfDevice: db.query<AgentRow, [string]>("SELECT * FROM agents WHERE device_id = ? ORDER BY requested_at"),
    agentsOfUser: db.query<AgentRow & { label: string }, [string]>(
      "SELECT a.*, d.label FROM agents a JOIN devices d ON d.id = a.device_id WHERE a.login = ? ORDER BY a.requested_at DESC",
    ),
    addAgent: db.query("INSERT INTO agents (name, login, device_id, status, requested_at) VALUES (?, ?, ?, 'pending', ?)"),
    rerequest: db.query("UPDATE agents SET status = 'pending', requested_at = ?, decided_at = NULL WHERE name = ?"),
    moveAgent: db.query("UPDATE agents SET device_id = ?, status = 'pending', requested_at = ?, decided_at = NULL WHERE name = ?"),
    decide: db.query("UPDATE agents SET status = ?, decided_at = ? WHERE name = ? AND login = ?"),
    workspace: db.query<{ id: string; name: string; created_by: string; created_at: number }, [string]>("SELECT * FROM workspaces WHERE id = ?"),
    addWorkspace: db.query("INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)"),
    member: db.query<Omit<MemberView, "status" | "devices">, [string, string]>("SELECT * FROM members WHERE workspace_id = ? AND login = ?"),
    members: db.query<Omit<MemberView, "status" | "devices">, [string]>("SELECT * FROM members WHERE workspace_id = ? ORDER BY invited_at"),
    workspacesOf: db.query<{ id: string; name: string; role: Role; joined_at: number | null; revoked_at: number | null }, [string]>(
      "SELECT w.id, w.name, m.role, m.joined_at, m.revoked_at FROM members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.login = ? ORDER BY w.created_at",
    ),
    addMember: db.query(
      `INSERT INTO members (workspace_id, login, role, invited_by, invited_at, joined_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, login) DO UPDATE SET invited_by = excluded.invited_by, invited_at = excluded.invited_at,
         joined_at = excluded.joined_at, revoked_at = NULL, revoked_by = NULL`,
    ),
    revokeMember: db.query("UPDATE members SET revoked_at = ?, revoked_by = ? WHERE workspace_id = ? AND login = ? AND revoked_at IS NULL"),
    addNotice: db.query("INSERT INTO notices (workspace_id, login, kind, at) VALUES (?, ?, 'joined', ?)"),
    notices: db.query<Notice, [string]>("SELECT * FROM notices WHERE workspace_id = ? ORDER BY at DESC, id DESC LIMIT 20"),
    shared: db.query<{ ok: number }, [string, string]>(
      `SELECT 1 AS ok FROM members a JOIN members b ON a.workspace_id = b.workspace_id
       WHERE a.login = ? AND b.login = ? AND a.joined_at IS NOT NULL AND a.revoked_at IS NULL
         AND b.joined_at IS NOT NULL AND b.revoked_at IS NULL LIMIT 1`,
    ),
    addSession: db.query("INSERT INTO sessions (token_hash, login, created_at, expires_at) VALUES (?, ?, ?, ?)"),
    session: db.query<{ login: string }, [string, number]>("SELECT login FROM sessions WHERE token_hash = ? AND expires_at > ?"),
    dropSession: db.query("DELETE FROM sessions WHERE token_hash = ?"),
    addHandoff: db.query("INSERT INTO handoffs (code_hash, login, expires_at) VALUES (?, ?, ?)"),
    takeHandoff: db.query<{ login: string }, [string, number]>("DELETE FROM handoffs WHERE code_hash = ? AND expires_at > ? RETURNING login"),
    addPairing: db.query("INSERT INTO pairings (code, device_id, expires_at) VALUES (?, ?, ?)"),
    dropPairingsOf: db.query("DELETE FROM pairings WHERE device_id = ?"),
    takePairing: db.query<{ device_id: string }, [string, number]>("DELETE FROM pairings WHERE code = ? AND expires_at > ? RETURNING device_id"),
    store: db.query(
      "INSERT OR IGNORE INTO mailbox (device_id, msg_id, convo, from_agent, from_device, to_agent, channel_id, ts, ciphertext) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    pending: db.query<DeliveredEnvelope & { channel_id: string | null }, [string]>(
      `SELECT m.msg_id AS id, m.convo, m.from_agent AS "from",
              CASE WHEN m.channel_id IS NULL THEN m.to_agent ELSE '#' || m.channel_id END AS "to",
              m.to_agent AS agent, m.channel_id, m.from_device, m.ciphertext, d.sign_pk AS sender_sign_pk, d.label AS from_label, d.login AS from_owner, m.ts
       FROM mailbox m JOIN devices d ON d.id = m.from_device WHERE m.device_id = ? ORDER BY m.seq`,
    ),
    one: db.query<DeliveredEnvelope & { channel_id: string | null }, [string, string]>(
      `SELECT m.msg_id AS id, m.convo, m.from_agent AS "from",
              CASE WHEN m.channel_id IS NULL THEN m.to_agent ELSE '#' || m.channel_id END AS "to",
              m.to_agent AS agent, m.channel_id, m.from_device, m.ciphertext, d.sign_pk AS sender_sign_pk, d.label AS from_label, d.login AS from_owner, m.ts
       FROM mailbox m JOIN devices d ON d.id = m.from_device WHERE m.device_id = ? AND m.msg_id = ?`,
    ),
    agentWs: db.query<{ status: MembershipStatus }, [string, string]>("SELECT status FROM agent_workspaces WHERE workspace_id = ? AND agent = ?"),
    upsertAgentWs: db.query(
      `INSERT INTO agent_workspaces (workspace_id, agent, status, requested_at) VALUES (?, ?, 'pending', ?)
       ON CONFLICT(workspace_id, agent) DO UPDATE SET status = 'pending', requested_at = excluded.requested_at, decided_at = NULL`,
    ),
    decideAgentWs: db.query("UPDATE agent_workspaces SET status = ?, decided_at = ? WHERE workspace_id = ? AND agent = ? AND status = 'pending'"),
    // Workspaces both agents are in: approved agent membership, and each owner an active member.
    sharedAgents: db.query<{ ok: number }, [string, string]>(
      `SELECT 1 AS ok FROM agent_workspaces wa JOIN agent_workspaces wb ON wa.workspace_id = wb.workspace_id
       JOIN agents a ON a.name = wa.agent JOIN agents b ON b.name = wb.agent
       JOIN members ma ON ma.workspace_id = wa.workspace_id AND ma.login = a.login
       JOIN members mb ON mb.workspace_id = wb.workspace_id AND mb.login = b.login
       WHERE wa.agent = ? AND wb.agent = ? AND wa.status = 'approved' AND wb.status = 'approved'
         AND ma.joined_at IS NOT NULL AND ma.revoked_at IS NULL AND mb.joined_at IS NOT NULL AND mb.revoked_at IS NULL LIMIT 1`,
    ),
    sharedWorkspaceNames: db.query<{ name: string }, [string, string]>(
      `SELECT DISTINCT w.name FROM agent_workspaces wa JOIN agent_workspaces wb ON wa.workspace_id = wb.workspace_id
       JOIN workspaces w ON w.id = wa.workspace_id
       JOIN agents a ON a.name = wa.agent JOIN agents b ON b.name = wb.agent
       JOIN members ma ON ma.workspace_id = wa.workspace_id AND ma.login = a.login
       JOIN members mb ON mb.workspace_id = wb.workspace_id AND mb.login = b.login
       WHERE wa.agent = ? AND wb.agent = ? AND wa.status = 'approved' AND wb.status = 'approved'
         AND ma.joined_at IS NOT NULL AND ma.revoked_at IS NULL AND mb.joined_at IS NOT NULL AND mb.revoked_at IS NULL ORDER BY w.name`,
    ),
    inWorkspace: db.query<{ ok: number }, [string, string]>(
      `SELECT 1 AS ok FROM agent_workspaces w JOIN agents a ON a.name = w.agent
       JOIN members m ON m.workspace_id = w.workspace_id AND m.login = a.login
       WHERE w.workspace_id = ? AND w.agent = ? AND w.status = 'approved' AND a.status = 'approved'
         AND m.joined_at IS NOT NULL AND m.revoked_at IS NULL`,
    ),
    agentWorkspacesOf: db.query<{ id: string; name: string; status: MembershipStatus }, [string]>(
      "SELECT w.id, w.name, aw.status FROM agent_workspaces aw JOIN workspaces w ON w.id = aw.workspace_id WHERE aw.agent = ? ORDER BY w.name",
    ),
    workspaceAgents: db.query<{ agent: string; login: string; status: MembershipStatus; requested_at: number }, [string]>(
      "SELECT aw.agent, a.login, aw.status, aw.requested_at FROM agent_workspaces aw JOIN agents a ON a.name = aw.agent WHERE aw.workspace_id = ? ORDER BY aw.agent",
    ),
    channel: db.query<ChannelRow, [string]>("SELECT * FROM channels WHERE id = ?"),
    channelByName: db.query<ChannelRow, [string, string]>("SELECT * FROM channels WHERE workspace_id = ? AND name = ?"),
    channelsOf: db.query<ChannelRow, [string]>("SELECT * FROM channels WHERE workspace_id = ? ORDER BY name"),
    addChannel: db.query("INSERT INTO channels (id, workspace_id, name, owner_login, private, created_at) VALUES (?, ?, ?, ?, ?, ?)"),
    chMember: db.query<ChannelMemberRow, [string, string]>("SELECT * FROM channel_members WHERE channel_id = ? AND agent = ?"),
    channelMembers: db.query<ChannelMemberRow & { login: string }, [string]>(
      "SELECT cm.*, a.login FROM channel_members cm JOIN agents a ON a.name = cm.agent WHERE cm.channel_id = ? ORDER BY cm.agent",
    ),
    upsertMember: db.query(
      `INSERT INTO channel_members (channel_id, agent, status, owner_ok, channel_owner_ok, requested_at) VALUES (?, ?, 'pending', 0, ?, ?)
       ON CONFLICT(channel_id, agent) DO UPDATE SET status = 'pending', owner_ok = 0, channel_owner_ok = excluded.channel_owner_ok,
         requested_at = excluded.requested_at, decided_at = NULL`,
    ),
    setMember: db.query("UPDATE channel_members SET status = ?, owner_ok = ?, channel_owner_ok = ?, decided_at = ? WHERE channel_id = ? AND agent = ?"),
    pendingWorkspaceJoins: db.query<{ workspace_id: string; workspace: string; agent: string; requested_at: number }, [string]>(
      `SELECT aw.workspace_id, w.name AS workspace, aw.agent, aw.requested_at FROM agent_workspaces aw
       JOIN agents a ON a.name = aw.agent JOIN workspaces w ON w.id = aw.workspace_id
       WHERE a.login = ? AND aw.status = 'pending' ORDER BY aw.requested_at`,
    ),
    pendingChannelJoins: db.query<
      { channel_id: string; channel: string; workspace: string; private: number; channel_owner: string; agent: string; agent_owner: string; owner_ok: number; channel_owner_ok: number; requested_at: number },
      [string, string]
    >(
      `SELECT cm.channel_id, c.name AS channel, w.name AS workspace, c.private, c.owner_login AS channel_owner, cm.agent,
              a.login AS agent_owner, cm.owner_ok, cm.channel_owner_ok, cm.requested_at
       FROM channel_members cm JOIN channels c ON c.id = cm.channel_id JOIN agents a ON a.name = cm.agent
       JOIN workspaces w ON w.id = c.workspace_id
       WHERE cm.status = 'pending' AND ((a.login = ? AND cm.owner_ok = 0) OR (c.owner_login = ? AND cm.channel_owner_ok = 0))
       ORDER BY cm.requested_at`,
    ),
    ack: db.query("DELETE FROM mailbox WHERE device_id = ? AND msg_id = ?"),
    stale: db.query<{ from_device: string; msg_id: string; convo: string; to_agent: string; channel_id: string | null }, [number]>(
      "SELECT from_device, msg_id, convo, to_agent, channel_id FROM mailbox WHERE ts < ?",
    ),
    dropStale: db.query("DELETE FROM mailbox WHERE ts < ?"),
    addExpiry: db.query("INSERT OR IGNORE INTO expiries (from_device, msg_id, convo, to_agent, channel_id, at) VALUES (?, ?, ?, ?, ?, ?)"),
    expiriesFor: db.query<{ msg_id: string; convo: string; to_agent: string; channel_id: string | null }, [string]>(
      "SELECT msg_id, convo, to_agent, channel_id FROM expiries WHERE from_device = ? ORDER BY at",
    ),
    ackExpiry: db.query("DELETE FROM expiries WHERE from_device = ? AND msg_id = ?"),
    addLink: db.query("INSERT INTO invite_links (code, workspace_id, created_by, created_at, expires_at, max_uses) VALUES (?, ?, ?, ?, ?, ?)"),
    link: db.query<InviteLinkRow, [string]>("SELECT * FROM invite_links WHERE code = ?"),
    linksOf: db.query<InviteLinkRow, [string]>("SELECT * FROM invite_links WHERE workspace_id = ? ORDER BY created_at DESC"),
    useLink: db.query("UPDATE invite_links SET uses = uses + 1 WHERE code = ?"),
    revokeLink: db.query("UPDATE invite_links SET revoked_at = ? WHERE code = ? AND revoked_at IS NULL"),
    // Agents in the workspace: approved, and their owner an active member.
    agentCount: db.query<{ n: number }, [string]>(
      `SELECT count(*) AS n FROM agent_workspaces w JOIN agents a ON a.name = w.agent
       JOIN members m ON m.workspace_id = w.workspace_id AND m.login = a.login
       WHERE w.workspace_id = ? AND w.status = 'approved' AND a.status = 'approved' AND m.joined_at IS NOT NULL AND m.revoked_at IS NULL`,
    ),
    activeCount: db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM members WHERE workspace_id = ? AND joined_at IS NOT NULL AND revoked_at IS NULL"),
    upsertLinkRequest: db.query(
      `INSERT INTO link_requests (id, code, workspace_id, login, device_id, agents, requested_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, login) DO UPDATE SET code = excluded.code, device_id = excluded.device_id, agents = excluded.agents, requested_at = excluded.requested_at`,
    ),
    linkRequest: db.query<LinkRequestRow, [string]>("SELECT * FROM link_requests WHERE id = ?"),
    linkRequestOf: db.query<LinkRequestRow, [string, string]>("SELECT * FROM link_requests WHERE workspace_id = ? AND login = ?"),
    leaveAgentWs: db.query("UPDATE agent_workspaces SET status = 'left', decided_at = ? WHERE workspace_id = ? AND agent = ?"),
    linkRequestsOf: db.query<LinkRequestRow & { workspace: string; inviter: string }, [string]>(
      `SELECT r.*, w.name AS workspace, l.created_by AS inviter FROM link_requests r JOIN workspaces w ON w.id = r.workspace_id
       JOIN invite_links l ON l.code = r.code WHERE r.login = ? ORDER BY r.requested_at`,
    ),
    dropLinkRequest: db.query("DELETE FROM link_requests WHERE id = ?"),
    setDefault: db.query("UPDATE channels SET is_default = ? WHERE id = ?"),
    defaultChannels: db.query<ChannelRow, [string]>("SELECT * FROM channels WHERE workspace_id = ? AND is_default = 1 AND private = 0 ORDER BY name"),
    approveAgentWs: db.query(
      `INSERT INTO agent_workspaces (workspace_id, agent, status, requested_at, decided_at) VALUES (?1, ?2, 'approved', ?3, ?3)
       ON CONFLICT(workspace_id, agent) DO UPDATE SET status = 'approved', decided_at = ?3`,
    ),
    approveChMember: db.query(
      `INSERT INTO channel_members (channel_id, agent, status, owner_ok, channel_owner_ok, requested_at, decided_at) VALUES (?1, ?2, 'approved', 1, 1, ?3, ?3)
       ON CONFLICT(channel_id, agent) DO UPDATE SET status = 'approved', owner_ok = 1, channel_owner_ok = 1, decided_at = ?3`,
    ),
    isDemo: db.query<{ demo: number }, [string]>("SELECT demo FROM users WHERE login = ?"),
    addDemoUser: db.query("INSERT INTO users (login, github_id, name, created_at, demo) VALUES (?, 0, ?, ?, 1) ON CONFLICT(login) DO UPDATE SET demo = 1"),
    addDemoSignIn: db.query("INSERT INTO demo_signins (token_hash, login, expires_at) VALUES (?, ?, ?)"),
    takeDemoSignIn: db.query<{ login: string }, [string, number]>("DELETE FROM demo_signins WHERE token_hash = ? AND expires_at > ? RETURNING login"),
    useJudge: db.query<{ count: number }, [string, string, number]>(
      `INSERT INTO judge_usage (device_id, day, count) VALUES (?1, ?2, 1)
       ON CONFLICT(device_id, day) DO UPDATE SET count = count + 1 WHERE count < ?3 RETURNING count`,
    ),
  };

  const memberStatus = (m: { joined_at: number | null; revoked_at: number | null }): MemberStatus =>
    m.revoked_at !== null ? "revoked" : m.joined_at !== null ? "active" : "invited";

  const requireAdmin = (workspaceId: string, login: string) => {
    const me = q.member.get(workspaceId, login);
    if (!q.workspace.get(workspaceId) || !me || memberStatus(me) !== "active") throw new DirectoryError(404, "no such workspace");
    if (me.role !== "admin") throw new DirectoryError(403, "only an admin of this workspace can do that");
  };

  // The approved agent `name`, hosted on `deviceId`.
  const hosted = (deviceId: string, name: string) => {
    const a = q.agent.get(name);
    if (!a || a.device_id !== deviceId || a.status !== "approved") throw new DirectoryError(403, `${name} is not an agent of this computer`);
    return a;
  };

  const dir = {
    db,

    // ---- humans and web sessions ------------------------------------------------
    // Called after GitHub said who signed in. A demo person signs in with their one-time link instead (`demo`); a
    // GitHub login that collides with one is refused.
    signedIn(user: { login: string; id: number; name?: string | null }, demo = false): { joined: string[] } {
      if (!demo && dir.isDemo(user.login))
        throw new DirectoryError(409, `@${user.login} is a demo person on this server, so the GitHub account @${user.login} cannot sign in here; ask the server's operator about it`);
      if (!demo) q.upsertUser.run(user.login, user.id, user.name ?? null, now());
      return { joined: [] };
    },
    isDemo: (login: string) => !!q.isDemo.get(login)?.demo,
    // `patio exchange demo-person`: a person without GitHub, created (or an existing one marked demo) by the server's
    // operator, with a one-time sign-in token valid 10 minutes (exchange-api.ts /auth/demo).
    demoPerson(login: string): { token: string; expires_at: number; created: boolean } {
      const clean = login.trim().replace(/^@/, "");
      if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(clean)) throw new DirectoryError(400, "a login is letters, digits and - (up to 39), like a GitHub login");
      const created = !q.user.get(clean);
      const token = randomToken(24);
      const expires_at = now() + 10 * 60_000;
      db.transaction(() => {
        q.addDemoUser.run(clean, clean, now());
        q.addDemoSignIn.run(sha256(token), clean, expires_at);
      })();
      return { token, expires_at, created };
    },
    // Used once: the second time it is unknown.
    takeDemoSignIn: (token: string) => q.takeDemoSignIn.get(sha256(token), now())?.login ?? null,
    // A one-time code the gatekeeper's web app trades for a session token, so the token never travels in a URL.
    issueHandoff(login: string): string {
      const code = randomToken(24);
      q.addHandoff.run(sha256(code), login, now() + 2 * 60_000);
      return code;
    },
    redeemHandoff(code: string): { token: string; login: string } | null {
      const row = q.takeHandoff.get(sha256(code), now());
      if (!row) return null;
      const token = randomToken();
      q.addSession.run(sha256(token), row.login, now(), now() + SESSION_MS);
      return { token, login: row.login };
    },
    sessionLogin: (token: string) => q.session.get(sha256(token), now())?.login ?? null,
    endSession: (token: string) => void q.dropSession.run(sha256(token)),

    // ---- devices and pairing ---------------------------------------------------------
    device: (id: string) => q.device.get(id) ?? null,
    seenDevice(d: PublicDevice, label: string): DeviceRow {
      q.addDevice.run(d.id, d.sign_pk, d.box_pk, label, now());
      q.setLabel.run(label, now(), d.id);
      return q.device.get(d.id)!;
    },
    // Its connection closed: it was last seen now.
    deviceOffline: (id: string) => void q.seen.run(now(), id),
    startPairing(deviceId: string): { code: string; expires_at: number } {
      const device = q.device.get(deviceId);
      if (!device) throw new DirectoryError(404, "unknown device");
      if (device.login) throw new DirectoryError(409, `this computer is already signed in as @${device.login}`);
      const bytes = crypto.getRandomValues(new Uint8Array(8));
      const code = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
      const expires_at = now() + 10 * 60_000;
      db.transaction(() => {
        q.dropPairingsOf.run(deviceId);
        q.addPairing.run(code, deviceId, expires_at);
      })();
      return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expires_at };
    },
    confirmPairing(login: string, code: string): DeviceRow {
      const row = q.takePairing.get(normalizeCode(code), now());
      if (!row) throw new DirectoryError(404, "that code is unknown or has expired");
      const res = q.pairDevice.run(login, now(), row.device_id);
      if (!res.changes) throw new DirectoryError(409, "that computer is already confirmed");
      return q.device.get(row.device_id)!;
    },
    devicesOf: (login: string) => q.devicesOfUser.all(login),
    // Every device the human ever paired, revoked ones too (for their Devices page).
    allDevicesOf: (login: string) => q.allDevicesOfUser.all(login),
    // The owner revokes one of their devices: final. The exchange stops delivering to it, drops the copies queued
    // for it and those it sent that are not delivered yet, and refuses its connection (and so its signatures).
    revokeDevice(login: string, deviceId: string): DeviceRow {
      const d = q.device.get(deviceId);
      if (!d || d.login !== login) throw new DirectoryError(404, "no such computer of yours");
      if (d.revoked_at) throw new DirectoryError(409, "this computer is already revoked");
      db.transaction(() => {
        q.revokeDevice.run(now(), deviceId, login);
        q.dropMailboxOf.run(deviceId, deviceId);
      })();
      return q.device.get(deviceId)!;
    },
    // `patio uninstall`, signed with the computer's own key (self-revoke.ts): its agents leave their workspaces, then the
    // computer is revoked. Their names stay their owner's, free for another of their computers.
    revokeSelf(deviceId: string): { state: "revoked" | "already" | "not_signed_in"; label: string; left: { agent: string; workspace: string }[] } {
      const d = q.device.get(deviceId)!;
      if (d.revoked_at) return { state: "already", label: d.label, left: [] };
      if (!d.login) return { state: "not_signed_in", label: d.label, left: [] };
      const login = d.login;
      return db.transaction(() => {
        const left: { agent: string; workspace: string }[] = [];
        for (const a of q.agentsOfDevice.all(deviceId).filter((x) => x.status === "approved"))
          for (const w of q.agentWorkspacesOf.all(a.name).filter((w) => w.status === "approved" && dir.inWorkspace(w.id, a.name))) {
            dir.ownerRemoveAgent(login, a.name, w.id);
            left.push({ agent: a.name, workspace: w.name });
          }
        dir.revokeDevice(login, deviceId);
        return { state: "revoked" as const, label: d.label, left };
      })();
    },

    // ---- agent identities ----------------------------------------------------------------
    agent: (name: string) => q.agent.get(name) ?? null,
    agentsOfDevice: (deviceId: string): AgentInfo[] =>
      q.agentsOfDevice.all(deviceId).map((a) => ({
        name: a.name,
        status: a.status,
        workspaces: q.agentWorkspacesOf.all(a.name).filter((w) => w.status === "approved" && dir.inWorkspace(w.id, a.name)).map((w) => w.name),
      })),
    agentsOf: (login: string) => q.agentsOfUser.all(login),
    // The agents (with their owners) in each workspace an agent of this device is in, for `patio guide`: who it can ask.
    workspaceRosters(deviceId: string): Roster[] {
      const out = new Map<string, Roster>();
      for (const mine of q.agentsOfDevice.all(deviceId).filter((a) => a.status === "approved"))
        for (const w of q.agentWorkspacesOf.all(mine.name).filter((w) => w.status === "approved" && dir.inWorkspace(w.id, mine.name)))
          if (!out.has(w.id))
            out.set(w.id, {
              workspace: w.name,
              agents: q.workspaceAgents
                .all(w.id)
                .filter((a) => a.status === "approved" && dir.inWorkspace(w.id, a.agent))
                .map((a) => ({ agent: a.agent, owner: a.login, answers: dir.answersIn(a.agent).includes(w.name) ? ("self" as const) : ("owner" as const) })),
            });
      return [...out.values()];
    },
    // An agent asks; the request waits for its owner. A rejected or revoked name can be asked for again, and so can
    // a name that lived on a device its owner revoked: it moves to the asking device, pending the owner's approval.
    // `byOwner`: the owner asked from their own terminal, so it is approved at once (README, who confirms what).
    requestAgent(deviceId: string, name: string, byOwner = false): AgentInfo {
      const info = dir.requestAgentPending(deviceId, name);
      if (byOwner && info.status === "pending") {
        q.decide.run("approved", now(), name, q.device.get(deviceId)!.login!);
        return { name, status: "approved" };
      }
      return info;
    },
    requestAgentPending(deviceId: string, name: string): AgentInfo {
      const device = q.device.get(deviceId);
      if (!device?.login || device.revoked_at) throw new DirectoryError(403, "sign in on this computer first (patio join <link>)");
      const existing = q.agent.get(name);
      if (existing) {
        if (existing.login !== device.login) throw new DirectoryError(409, `the name ${name} is taken`);
        if (existing.device_id !== deviceId) {
          const old = q.device.get(existing.device_id);
          if (old && !old.revoked_at) throw new AgentElsewhere({ agent: name, device_id: old.id, label: old.label, last_seen_at: old.last_seen_at });
          q.moveAgent.run(deviceId, now(), name);
          return { name, status: "pending" };
        }
        if (existing.status === "rejected" || existing.status === "revoked") q.rerequest.run(now(), name);
        return { name, status: q.agent.get(name)!.status };
      }
      dir.checkName(device.login, name);
      q.addAgent.run(name, device.login, deviceId, now());
      return { name, status: "pending" };
    },
    // Agent names are global and messages are addressed to them, so a name says whose agent it is: the owner's login,
    // or the login and a hyphen. Nobody else can register unai-backend and receive questions meant for Unai.
    checkName(login: string, name: string) {
      if (!HANDLE_RE.test(name)) throw new DirectoryError(400, "an agent name is lowercase letters, digits, - and _ (up to 32)");
      if (!ownsName(login, name))
        throw new DirectoryError(400, `${name} is not a name for an agent of @${login}: an agent's name starts with its owner's login and a hyphen; try ${defaultAgentName(login, name)}`);
    },
    // The approved agent `name` of `login` on `deviceId`: created, or approved, as its owner says.
    ownAgent(deviceId: string, login: string, name: string): AgentRow {
      const existing = q.agent.get(name);
      if (existing && existing.login === login && existing.device_id === deviceId && existing.status === "approved") return existing;
      const info = dir.requestAgentPending(deviceId, name);
      if (info.status !== "approved") q.decide.run("approved", now(), name, login);
      return q.agent.get(name)!;
    },
    // Its owner moves the agent here from another of their computers (the Move button, or yes in their terminal). That
    // computer keeps its other agents, and is revoked when it has none left. What was queued for the agent there is
    // dropped: it was sealed for that computer's keys. Null: nothing to move.
    moveAgentHere(login: string, name: string, deviceId: string): Moved | null {
      const a = q.agent.get(name);
      if (!a || a.login !== login || a.device_id === deviceId) return null;
      const old = q.device.get(a.device_id);
      if (!old || old.revoked_at) return null;
      return db.transaction(() => {
        q.moveAgent.run(deviceId, now(), name);
        q.dropMailboxFor.run(old.id, name);
        const revoked = !q.agentsOfDevice.all(old.id).some((x) => x.status === "approved" || x.status === "pending");
        if (revoked) dir.revokeDevice(login, old.id);
        return { agent: name, from: old.label, from_device: old.id, revoked };
      })();
    },
    // What moving `name` to another computer would do to the one it lives on: whether that one would be left with no agent.
    lastAgentOn: (deviceId: string, name: string) => !q.agentsOfDevice.all(deviceId).some((x) => x.name !== name && (x.status === "approved" || x.status === "pending")),
    decideAgent(login: string, name: string, decision: "approved" | "rejected" | "revoked"): AgentRow {
      const a = q.agent.get(name);
      if (!a || a.login !== login) throw new DirectoryError(404, "no such agent request");
      if (decision !== "revoked" && a.status !== "pending") throw new DirectoryError(409, `this request is already ${a.status}`);
      q.decide.run(decision, now(), name, login);
      return q.agent.get(name)!;
    },

    // ---- workspaces ------------------------------------------------------------------------
    createWorkspace(login: string, name: string): { id: string; name: string } {
      const clean = name.trim();
      if (!clean || clean.length > 60) throw new DirectoryError(400, "a workspace name has 1 to 60 characters");
      const id = `ws_${randomToken(9)}`;
      db.transaction(() => {
        q.addWorkspace.run(id, clean, login, now());
        q.addMember.run(id, login, "admin", null, now(), now());
      })();
      return { id, name: clean };
    },
    workspacesOf: (login: string) =>
      q.workspacesOf.all(login).map((w) => ({ id: w.id, name: w.name, role: w.role, status: memberStatus(w) })),
    revoke(adminLogin: string, workspaceId: string, login: string) {
      requireAdmin(workspaceId, adminLogin);
      if (login === adminLogin) throw new DirectoryError(400, "you cannot remove yourself from the team");
      if (!q.revokeMember.run(now(), adminLogin, workspaceId, login).changes) throw new DirectoryError(404, `@${login} is not a member`);
    },
    // An admin clears a notice from the workspace's page.
    dismissNotice(adminLogin: string, workspaceId: string, noticeId: number) {
      requireAdmin(workspaceId, adminLogin);
      db.query("DELETE FROM notices WHERE id = ? AND workspace_id = ?").run(noticeId, workspaceId);
    },
    workspace(login: string, workspaceId: string) {
      const ws = q.workspace.get(workspaceId);
      const me = q.member.get(workspaceId, login);
      if (!ws || !me || memberStatus(me) !== "active") throw new DirectoryError(404, "no such workspace");
      const members: MemberView[] = q.members.all(workspaceId).map((m) => ({
        ...m,
        demo: dir.isDemo(m.login),
        status: memberStatus(m),
        devices: q.devicesOfUser.all(m.login).map((d) => ({ id: d.id, label: d.label, fingerprint: fingerprint(d.id) })),
      }));
      return {
        ...ws,
        role: me.role,
        members,
        notices: me.role === "admin" ? q.notices.all(workspaceId) : [],
        agents: q.workspaceAgents.all(workspaceId).map((a) => ({ ...a, demo: dir.isDemo(a.login) })),
        channels: dir.channelsOfWorkspace(workspaceId),
        links: me.role === "admin" ? q.linksOf.all(workspaceId).map((l) => ({ ...l, state: linkState(l) })) : [],
      };
    },

    // ---- agents in workspaces ------------------------------------------------------------
    // An agent asks to join one of its owner's workspaces (by id, or by name when that is unambiguous).
    requestWorkspaceJoin(deviceId: string, agentName: string, ref: string, byOwner = false) {
      const agent = hosted(deviceId, agentName);
      const mine = q.workspacesOf.all(agent.login).filter((w) => memberStatus(w) === "active");
      const matches = mine.filter((w) => w.id === ref || w.name === ref);
      if (!matches.length) throw new DirectoryError(404, `@${agent.login} is not an active member of a workspace called ${ref}`);
      if (matches.length > 1) throw new DirectoryError(409, `more than one of your workspaces is called ${ref}; use its id`);
      const ws = matches[0]!;
      const existing = q.agentWs.get(ws.id, agentName);
      if (byOwner && existing?.status !== "approved") dir.approveInWorkspace(ws.id, agentName);
      else if (!existing || existing.status === "rejected" || existing.status === "left") q.upsertAgentWs.run(ws.id, agentName, now());
      return { workspace: { id: ws.id, name: ws.name }, status: q.agentWs.get(ws.id, agentName)!.status, needs: [] as string[] };
    },
    // An agent is in the workspace (its owner said so), and enters the workspace's default channels.
    approveInWorkspace(workspaceId: string, agentName: string): string[] {
      return db.transaction(() => {
        q.approveAgentWs.run(workspaceId, agentName, now());
        return dir.enterDefaultChannels(workspaceId, agentName);
      })();
    },
    // The public channels an admin marked as default: an agent that joins the workspace is a member at once. Returns
    // their names.
    enterDefaultChannels(workspaceId: string, agentName: string): string[] {
      const entered: string[] = [];
      for (const c of q.defaultChannels.all(workspaceId)) {
        if (q.chMember.get(c.id, agentName)?.status === "approved") continue;
        q.approveChMember.run(c.id, agentName, now());
        entered.push(c.name);
      }
      return entered;
    },
    decideWorkspaceJoin(login: string, workspaceId: string, agentName: string, decision: "approved" | "rejected") {
      const a = q.agent.get(agentName);
      if (!a || a.login !== login) throw new DirectoryError(404, "no such request");
      if (!q.decideAgentWs.run(decision, now(), workspaceId, agentName).changes) throw new DirectoryError(409, "this request is not pending");
      if (decision === "approved") dir.enterDefaultChannels(workspaceId, agentName);
      return a;
    },
    agentWorkspaces: (agent: string) => q.agentWorkspacesOf.all(agent),
    inWorkspace: (workspaceId: string, agent: string) => !!q.inWorkspace.get(workspaceId, agent),

    // ---- channels -------------------------------------------------------------------------------
    createChannel(login: string, workspaceId: string, name: string, isPrivate: boolean) {
      const me = q.member.get(workspaceId, login);
      if (!q.workspace.get(workspaceId) || !me || memberStatus(me) !== "active") throw new DirectoryError(404, "no such workspace");
      const clean = name.trim().replace(/^#/, "");
      if (!HANDLE_RE.test(clean)) throw new DirectoryError(400, "a channel name is lowercase letters, digits, - and _ (up to 32)");
      if (q.channelByName.get(workspaceId, clean)) throw new DirectoryError(409, `#${clean} already exists in this workspace`);
      const id = `ch_${randomToken(9)}`;
      q.addChannel.run(id, workspaceId, clean, login, isPrivate ? 1 : 0, now());
      return q.channel.get(id)!;
    },
    channel: (id: string) => q.channel.get(id) ?? null,
    channelRef(c: ChannelRow): ChannelRef {
      return { id: c.id, name: c.name, workspace: q.workspace.get(c.workspace_id)!.name };
    },
    // Resolves a channel id, `<workspace>/<channel>` or a bare name, among the workspaces `agent` is in.
    resolveChannel(agent: string, ref: string): ChannelRow {
      const clean = ref.replace(/^#/, "");
      const byId = q.channel.get(clean);
      if (byId) return byId;
      const [wsRef, chName] = clean.includes("/") ? clean.split("/", 2) : [null, clean];
      const workspaces = q.agentWorkspacesOf.all(agent).filter((w) => w.status === "approved" && (!wsRef || w.id === wsRef || w.name === wsRef));
      const found = workspaces.map((w) => q.channelByName.get(w.id, chName!)).filter((c): c is ChannelRow => !!c);
      if (!found.length) throw new DirectoryError(404, `${agent} is in no workspace with a channel called #${chName}`);
      if (found.length > 1) throw new DirectoryError(409, `more than one #${chName}; write it as <workspace>/${chName}`);
      return found[0]!;
    },
    // `byOwner`: the owner asked from their own terminal, which counts as their approval. A private channel still
    // needs its owner's.
    requestChannelJoin(deviceId: string, agentName: string, ref: string, byOwner = false) {
      const agent = hosted(deviceId, agentName);
      const c = dir.resolveChannel(agentName, ref);
      if (!dir.inWorkspace(c.workspace_id, agentName)) throw new DirectoryError(403, `${agentName} must join the workspace first`);
      const existing = q.chMember.get(c.id, agentName);
      if (!existing || existing.status === "rejected" || existing.status === "left")
        q.upsertMember.run(c.id, agentName, c.private ? 0 : 1, now());
      const pending = q.chMember.get(c.id, agentName)!;
      if (byOwner && pending.status === "pending" && !pending.owner_ok) {
        const channelOk = pending.channel_owner_ok || (c.owner_login === agent.login ? 1 : 0);
        q.setMember.run(channelOk ? "approved" : "pending", 1, channelOk, channelOk ? now() : null, c.id, agentName);
      }
      const m = q.chMember.get(c.id, agentName)!;
      const needs = m.status === "pending" ? [!m.owner_ok && `@${agent.login} (owner of ${agentName})`, !m.channel_owner_ok && `@${c.owner_login} (owner of the private channel)`].filter((x): x is string => !!x) : [];
      return { channel: dir.channelRef(c), status: m.status, needs };
    },
    // The agent's owner and, for a private channel, the channel's owner both approve; either can reject.
    decideChannelJoin(login: string, channelId: string, agentName: string, decision: "approved" | "rejected") {
      const c = q.channel.get(channelId);
      const m = q.chMember.get(channelId, agentName);
      const a = q.agent.get(agentName);
      if (!c || !m || !a) throw new DirectoryError(404, "no such request");
      if (m.status !== "pending") throw new DirectoryError(409, `this request is already ${m.status}`);
      const asOwner = a.login === login;
      const asChannelOwner = c.owner_login === login && !!c.private;
      if (!asOwner && !asChannelOwner) throw new DirectoryError(403, "only the agent's owner or the channel's owner can decide");
      let ownerOk = m.owner_ok || (asOwner ? 1 : 0);
      let channelOk = m.channel_owner_ok || (asChannelOwner ? 1 : 0);
      if (decision === "rejected") q.setMember.run("rejected", ownerOk, channelOk, now(), channelId, agentName);
      else q.setMember.run(ownerOk && channelOk ? "approved" : "pending", ownerOk, channelOk, ownerOk && channelOk ? now() : null, channelId, agentName);
      return { agent: a, member: q.chMember.get(channelId, agentName)! };
    },
    leaveChannel(deviceId: string, agentName: string, ref: string) {
      hosted(deviceId, agentName);
      const c = dir.resolveChannel(agentName, ref);
      const m = q.chMember.get(c.id, agentName);
      if (!m || m.status === "left") throw new DirectoryError(404, `${agentName} is not in #${c.name}`);
      q.setMember.run("left", m.owner_ok, m.channel_owner_ok, now(), c.id, agentName);
      return { channel: dir.channelRef(c), status: "left" as MembershipStatus, needs: [] as string[] };
    },
    isChannelMember: (channelId: string, agent: string) => {
      const c = q.channel.get(channelId);
      return !!c && q.chMember.get(channelId, agent)?.status === "approved" && dir.inWorkspace(c.workspace_id, agent);
    },
    // Every current member agent except the sender, with its device's keys. The sender must be a member.
    channelRecipients(fromAgent: string, ref: string): ChannelRecipients {
      const c = dir.resolveChannel(fromAgent, ref);
      if (!dir.isChannelMember(c.id, fromAgent)) throw new DirectoryError(403, `${fromAgent} is not a member of #${c.name}`);
      const members = q.channelMembers
        .all(c.id)
        .filter((m) => m.agent !== fromAgent && dir.isChannelMember(c.id, m.agent))
        .map((m) => ({ agent: m.agent, device: dir.agentDevice(m.agent) }))
        .filter((m): m is { agent: string; device: PublicDevice } => !!m.device);
      return { channel: dir.channelRef(c), members };
    },
    // The channels of an agent's workspaces it can see (public ones, and private ones it is in), and whether it is in each.
    channelsForAgent: (agent: string) =>
      q.agentWorkspacesOf
        .all(agent)
        .filter((w) => w.status === "approved" && dir.inWorkspace(w.id, agent))
        .flatMap((w) =>
          q.channelsOf
            .all(w.id)
            .map((c) => ({ workspace: w.name, name: c.name, private: !!c.private, member: dir.isChannelMember(c.id, agent), is_default: !!(c as { is_default?: number }).is_default }))
            .filter((c) => !c.private || c.member),
        ),
    channelsOfWorkspace: (workspaceId: string) =>
      q.channelsOf.all(workspaceId).map((c) => ({
        ...c,
        members: q.channelMembers.all(c.id).map((m) => ({ agent: m.agent, login: m.login, status: m.status })),
      })),
    pendingRequests: (login: string) => ({
      workspace_joins: q.pendingWorkspaceJoins.all(login),
      channel_joins: q.pendingChannelJoins.all(login, login),
      link_joins: q.linkRequestsOf.all(login).map((r) => ({ id: r.id, workspace: r.workspace, workspace_id: r.workspace_id, inviter: r.inviter, agents: JSON.parse(r.agents) as string[], requested_at: r.requested_at })),
    }),
    // An admin marks a public channel as one of the workspace's defaults (or not).
    setChannelDefault(adminLogin: string, channelId: string, isDefault: boolean) {
      const c = q.channel.get(channelId);
      if (!c) throw new DirectoryError(404, "no such channel");
      requireAdmin(c.workspace_id, adminLogin);
      if (isDefault && c.private) throw new DirectoryError(400, "a private channel cannot be a default channel");
      q.setDefault.run(isDefault ? 1 : 0, channelId);
      return q.channel.get(channelId)!;
    },

    // ---- invite links ------------------------------------------------------------------------
    // An admin creates a link (expiry and use limit optional). `ref`: the workspace id, or its name among theirs.
    createInviteLink(adminLogin: string, ref: string, o: { expiresAt?: number | null; maxUses?: number | null } = {}): InviteLinkRow {
      const mine = q.workspacesOf.all(adminLogin).filter((w) => memberStatus(w) === "active" && (w.id === ref || w.name === ref));
      if (!mine.length) throw new DirectoryError(404, `you are in no workspace called ${ref}`);
      if (mine.length > 1) throw new DirectoryError(409, `more than one of your workspaces is called ${ref}; use its id`);
      const ws = mine[0]!;
      requireAdmin(ws.id, adminLogin);
      if (o.maxUses !== undefined && o.maxUses !== null && !(Number.isInteger(o.maxUses) && o.maxUses > 0)) throw new DirectoryError(400, "a use limit is a whole number above 0");
      if (o.expiresAt !== undefined && o.expiresAt !== null && !(o.expiresAt > now())) throw new DirectoryError(400, "the expiry must be in the future");
      const code = randomToken(12);
      q.addLink.run(code, ws.id, adminLogin, now(), o.expiresAt ?? null, o.maxUses ?? null);
      return q.link.get(code)!;
    },
    revokeInviteLink(adminLogin: string, code: string) {
      const l = q.link.get(code);
      if (!l) throw new DirectoryError(404, "no such invite link");
      requireAdmin(l.workspace_id, adminLogin);
      if (!q.revokeLink.run(now(), code).changes) throw new DirectoryError(409, "this link is already revoked");
      return q.link.get(code)!;
    },
    inviteLinkRow: (code: string) => q.link.get(code) ?? null,
    // Public: what the invite page shows. Null for an unknown code.
    inviteInfo(code: string): InviteInfo | null {
      const l = q.link.get(code);
      if (!l) return null;
      const ws = q.workspace.get(l.workspace_id)!;
      const members = q.workspaceAgents
        .all(ws.id)
        .filter((a) => a.status === "approved" && dir.inWorkspace(ws.id, a.agent))
        .map((a) => ({ agent: a.agent, owner: a.login }));
      return { code, state: linkState(l), workspace: { id: ws.id, name: ws.name }, inviter: l.created_by, people: q.activeCount.get(ws.id)!.n, agents: q.agentCount.get(ws.id)!.n, members, expires_at: l.expires_at };
    },
    // Agents of this computer's person join the link's workspace and its default channels. `byOwner`: the person
    // started it in their own terminal, so it is done at once (agents named here that do not exist yet are created
    // for them). Otherwise (an agent, or a command not run from a terminal) the agents are asked for and the join
    // waits for the person in the web app: one card, one click. A person whose agents are in already needs no link use.
    joinByLink(deviceId: string, code: string, agentNames: string[], byOwner: boolean, move = false) {
      const device = q.device.get(deviceId);
      if (!device?.login || device.revoked_at) throw new DirectoryError(403, "sign in on this computer first (patio join <link>)");
      const login = device.login;
      if (!agentNames.length) throw new DirectoryError(400, "name the agent that joins (patio join <link> --agent <name>)");
      for (const name of agentNames) dir.checkName(login, name);
      const l = q.link.get(code);
      if (!l) throw new DirectoryError(404, LINK_ERRORS.unknown());
      const ws = q.workspace.get(l.workspace_id)!;
      const member = q.member.get(ws.id, login);
      if (member && memberStatus(member) === "revoked") throw new DirectoryError(403, `you were removed from ${ws.name}; ask one of its admins`);
      const inAlready = (name: string) => q.agentWs.get(ws.id, name)?.status === "approved" && q.agent.get(name)?.status === "approved" && q.agent.get(name)?.device_id === deviceId;
      const base = { workspace: { id: ws.id, name: ws.name }, inviter: l.created_by };
      if (member && memberStatus(member) === "active" && agentNames.every(inAlready))
        return { ...base, people: q.activeCount.get(ws.id)!.n, status: "joined" as const, agents: agentNames.map((name) => ({ name, status: "approved" as MembershipStatus, channels: [] as string[] })) };
      if (!member || memberStatus(member) !== "active") {
        const state = linkState(l);
        if (state !== "ok") throw new DirectoryError(410, LINK_ERRORS[state](l));
      }
      if (!byOwner) {
        // Each agent asks for its identity (pending), and the person decides on the join and the identities at once.
        for (const name of agentNames) dir.requestAgentPending(deviceId, name);
        const prior = q.linkRequestOf.get(ws.id, login);
        const names = [...new Set([...(prior ? (JSON.parse(prior.agents) as string[]) : []), ...agentNames.filter((n) => !inAlready(n))])];
        q.upsertLinkRequest.run(prior?.id ?? `lr_${randomToken(9)}`, code, ws.id, login, deviceId, JSON.stringify(names), now());
        return { ...base, people: q.activeCount.get(ws.id)!.n, status: "pending" as const, agents: names.map((name) => ({ name, status: "pending" as MembershipStatus, channels: [] as string[] })) };
      }
      return db.transaction(() => {
        if (!member || memberStatus(member) !== "active") dir.acceptLink(l, login);
        // Its owner said move: an agent of theirs on another computer comes here.
        const moved = move ? agentNames.map((name) => dir.moveAgentHere(login, name, deviceId)).filter((m): m is Moved => !!m) : [];
        const agents: LinkAgent[] = agentNames.map((name) => {
          if (inAlready(name)) return { name, status: "approved", channels: [] };
          dir.ownAgent(deviceId, login, name);
          return { name, status: "approved", channels: dir.approveInWorkspace(ws.id, name) };
        });
        return { ...base, people: q.activeCount.get(ws.id)!.n, status: "joined" as const, agents, moved };
      })();
    },
    // The person is a member through the link: one use, a notice for the admins.
    acceptLink(l: InviteLinkRow, login: string) {
      db.transaction(() => {
        q.addMember.run(l.workspace_id, login, "member", l.created_by, now(), now());
        q.addNotice.run(l.workspace_id, login, now());
        q.useLink.run(l.code);
      })();
    },
    // The person decides in the web app on a join by link their agent asked for: one click approves the agents'
    // identities and their join.
    decideLinkRequest(login: string, id: string, decision: "approved" | "rejected") {
      const r = q.linkRequest.get(id);
      if (!r || r.login !== login) throw new DirectoryError(404, "no such request");
      const ws = q.workspace.get(r.workspace_id)!;
      const names = (JSON.parse(r.agents) as string[]).filter((name) => {
        const a = q.agent.get(name);
        return a && a.login === login && a.status !== "revoked";
      });
      if (decision === "rejected") {
        db.transaction(() => {
          q.dropLinkRequest.run(id);
          for (const name of names) if (q.agent.get(name)?.status === "pending") q.decide.run("rejected", now(), name, login);
        })();
        return { workspace: ws.name, agents: [] as LinkAgent[], devices: [r.device_id] };
      }
      const l = q.link.get(r.code)!;
      return db.transaction(() => {
        const member = q.member.get(ws.id, login);
        if (!member || memberStatus(member) !== "active") {
          const state = linkState(l);
          if (state !== "ok") throw new DirectoryError(410, LINK_ERRORS[state](l));
          dir.acceptLink(l, login);
        }
        q.dropLinkRequest.run(id);
        const agents = names.map((name) => {
          if (q.agent.get(name)!.status !== "approved") q.decide.run("approved", now(), name, login);
          return { name, status: "approved" as MembershipStatus, channels: dir.approveInWorkspace(ws.id, name) };
        });
        return { workspace: ws.name, agents, devices: [...new Set([r.device_id, ...names.map((n) => q.agent.get(n)!.device_id)])] };
      })();
    },
    // The one confirmation of a first run started by an agent: the person, signed in, confirms this computer (its
    // pairing code), its agent (created and approved; `agent` null: <login>-<workspace>) and the join by link, with
    // one click. All or nothing.
    confirmSetup(login: string, o: { code: string; link: string; agent: string | null; move?: boolean }) {
      const l = q.link.get(o.link);
      if (!l) throw new DirectoryError(404, LINK_ERRORS.unknown());
      const ws = q.workspace.get(l.workspace_id)!;
      const name = o.agent || defaultAgentName(login, ws.name);
      dir.checkName(login, name);
      return db.transaction(() => {
        const device = dir.confirmPairing(login, o.code);
        const r = dir.joinByLink(device.id, o.link, [name], true, o.move === true);
        return { device, workspace: ws.name, agent: name, channels: r.agents[0]?.channels ?? [], moved: "moved" in r ? (r.moved[0] ?? null) : null };
      })();
    },

    // An agent leaves a workspace, and the channels it was in there.
    leaveWorkspace(deviceId: string, agentName: string, ref: string) {
      const agent = hosted(deviceId, agentName);
      return dir.ownerRemoveAgent(agent.login, agentName, ref);
    },
    // From the web app: the owner takes their agent out of a workspace (by id or name).
    ownerRemoveAgent(login: string, agentName: string, ref: string) {
      const a = q.agent.get(agentName);
      if (!a || a.login !== login) throw new DirectoryError(404, `${agentName} is not your agent`);
      const ws = q.agentWorkspacesOf.all(agentName).find((w) => (w.id === ref || w.name === ref) && w.status === "approved");
      if (!ws) throw new DirectoryError(404, `${agentName} is not in a workspace called ${ref}`);
      db.transaction(() => {
        q.leaveAgentWs.run(now(), ws.id, agentName);
        for (const c of q.channelsOf.all(ws.id)) {
          const m = q.chMember.get(c.id, agentName);
          if (m && m.status !== "left") q.setMember.run("left", m.owner_ok, m.channel_owner_ok, now(), c.id, agentName);
        }
      })();
      return { workspace: { id: ws.id, name: ws.name }, status: "left" as MembershipStatus, device: a.device_id };
    },
    // From the web app: the owner puts their agent in one of the workspaces they have agents in (at once: it is their
    // click), and it enters the default channels.
    ownerAddAgent(login: string, agentName: string, workspaceId: string) {
      const a = q.agent.get(agentName);
      if (!a || a.login !== login || a.status !== "approved") throw new DirectoryError(404, `${agentName} is not your agent`);
      const me = q.member.get(workspaceId, login);
      const ws = q.workspace.get(workspaceId);
      if (!ws || !me || memberStatus(me) !== "active") throw new DirectoryError(404, "you have no agent in that workspace; join it with an invite link");
      return { workspace: { id: ws.id, name: ws.name }, channels: dir.approveInWorkspace(workspaceId, agentName), device: a.device_id };
    },
    // `patio workspace new <name> --agent <agent>`, from the person's own terminal: the workspace, with that agent in
    // it (created when missing), a default #general it enters, and an invite link.
    createWorkspaceWithAgent(deviceId: string, name: string, agentName: string) {
      const device = q.device.get(deviceId);
      if (!device?.login || device.revoked_at) throw new DirectoryError(403, "sign in on this computer first (patio join <link>, or patio code)");
      const login = device.login;
      dir.checkName(login, agentName);
      return db.transaction(() => {
        const ws = dir.createWorkspace(login, name);
        const general = dir.createChannel(login, ws.id, "general", false);
        q.setDefault.run(1, general.id);
        dir.ownAgent(deviceId, login, agentName);
        const channels = dir.approveInWorkspace(ws.id, agentName);
        const link = dir.createInviteLink(login, ws.id, {});
        return { workspace: ws, agent: agentName, channels, link };
      })();
    },

    // ---- who may talk to whom ------------------------------------------------------------
    agentDevice(name: string): PublicDevice | null {
      const agent = q.agent.get(name);
      if (!agent || agent.status !== "approved") return null;
      const device = q.device.get(agent.device_id);
      if (!device || device.revoked_at || device.login !== agent.login) return null;
      return { id: device.id, sign_pk: device.sign_pk, box_pk: device.box_pk, label: device.label, owner: agent.login };
    },
    // Same owner, or both agents in a shared workspace.
    agentsMayExchange(a: string, b: string) {
      const x = q.agent.get(a);
      const y = q.agent.get(b);
      if (!x || !y || x.status !== "approved" || y.status !== "approved") return false;
      return x.login === y.login || !!q.sharedAgents.get(a, b);
    },
    // The names of the workspaces both agents are in (the recipient uses them to pick its agent configuration).
    sharedWorkspaces: (a: string, b: string) => q.sharedWorkspaceNames.all(a, b).map((r) => r.name),
    // What the agent's computer says: the workspaces it answers on its own.
    setAnswering(deviceId: string, agent: string, workspaces: string[]) {
      const a = q.agent.get(agent);
      if (!a || a.device_id !== deviceId) return false;
      db.query("UPDATE agents SET answers_in = ? WHERE name = ?").run(JSON.stringify([...new Set(workspaces.map(String))].slice(0, 100)), agent);
      return true;
    },
    answersIn(agent: string): string[] {
      const row = db.query<{ answers_in: string }, [string]>("SELECT answers_in FROM agents WHERE name = ?").get(agent);
      try {
        return row ? (JSON.parse(row.answers_in) as string[]) : [];
      } catch {
        return [];
      }
    },
    // The recipient agent's device, when `fromAgent` may write to it; otherwise why not.
    route(fromAgent: string, to: string): { devices: PublicDevice[] } | { error: "unknown_recipient" | "not_allowed" } {
      const device = dir.agentDevice(to);
      if (!device) return { error: "unknown_recipient" };
      if (!dir.agentsMayExchange(fromAgent, to)) return { error: "not_allowed" };
      return { devices: [device] };
    },
    // Checked again when a stored copy is about to be delivered: memberships may have changed since it was sent.
    stillDeliverable(row: { from: string; agent: string; channel_id: string | null; from_device: string }) {
      if (q.device.get(row.from_device)?.revoked_at) return false;
      if (row.channel_id) return dir.isChannelMember(row.channel_id, row.from) && dir.isChannelMember(row.channel_id, row.agent);
      return !!dir.agentDevice(row.agent) && dir.agentsMayExchange(row.from, row.agent);
    },

    // ---- mailbox ------------------------------------------------------------------------------
    store: (
      device: string,
      env: { id: string; convo: string; from: string },
      toAgent: string,
      channelId: string | null,
      fromDevice: string,
      ciphertext: string,
      ts: number,
    ) => q.store.run(device, env.id, env.convo, env.from, fromDevice, toAgent, channelId, ts, ciphertext),
    pending: (device: string) => q.pending.all(device),
    one: (device: string, id: string) => q.one.get(device, id) ?? null,
    ack: (device: string, id: string) => void q.ack.run(device, id),
    // Drops every copy stored before `cutoff` (the message TTL) and keeps a notice for its sender's device. One
    // notice per message and recipient agent (a broadcast's copies for one member count once).
    expire(cutoff: number, at = now()) {
      return db.transaction(() => {
        const rows = q.stale.all(cutoff);
        q.dropStale.run(cutoff);
        const seen = new Set<string>();
        const out: typeof rows = [];
        for (const r of rows) {
          const key = `${r.from_device} ${r.msg_id} ${r.to_agent}`;
          if (seen.has(key)) continue;
          seen.add(key);
          q.addExpiry.run(r.from_device, r.msg_id, r.convo, r.to_agent, r.channel_id, at);
          out.push(r);
        }
        return out;
      })();
    },
    // The notices a sender's device has not acknowledged yet.
    expiriesFor: (device: string) => q.expiriesFor.all(device),
    ackExpiry: (device: string, id: string) => void q.ackExpiry.run(device, id),

    // ---- the server's judge ---------------------------------------------------------------------
    // One more check for this computer today, or null when it has used `limit` already.
    useJudge(deviceId: string, day: string, limit: number): number | null {
      if (limit <= 0) return null;
      return q.useJudge.get(deviceId, day, limit)?.count ?? null;
    },
  };
  return dir;
}

export type Directory = ReturnType<typeof openDirectory>;
