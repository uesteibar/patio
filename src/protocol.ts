// Wire format shared by the exchange, the gatekeeper (daemon) and every client.
// The exchange stores and forwards sealed envelopes. It routes on recipient, message id and conversation id;
// the kind, text and context only exist inside the ciphertext (see crypto.ts).

export const PROTOCOL_VERSION = 4;

export type Kind = "question" | "report" | "heads-up" | "request" | "reply";
export const KINDS: Kind[] = ["question", "report", "heads-up", "request", "reply"];

export type Context = {
  repo?: string;
  pr?: string;
  files?: string[];
};

// The channel a broadcast (or a reply to one) was sent to. Inside the signed message, so the sender vouches
// for it; the exchange only sees the channel id.
export type ChannelRef = { id: string; name: string; workspace: string };

export type Message = {
  id: string;
  // Every message belongs to a conversation; a reply carries the conversation of the message it answers.
  convo: string;
  // Stamped by the exchange from the authenticated connection, never trusted from the sender.
  from: string;
  // An agent name, or `#<channel id>` for a broadcast and the replies to it.
  to: string;
  kind: Kind;
  text: string;
  context?: Context;
  // Set on broadcasts and on the replies to them.
  channel?: ChannelRef;
  // A reply names the message it answers. Nothing may answer a reply.
  in_reply_to?: string;
  // Set on the reply a gatekeeper sends when its input gate (or its owner) rejects a message: the category,
  // never the owner's rule text.
  rejected?: { reason: string };
  ts: number;
};

export const CHANNEL_ADDRESS_RE = /^#[\w-]{1,100}$/;
export const isChannelAddress = (to: string) => CHANNEL_ADDRESS_RE.test(to);

// What a sender's gatekeeper submits before sealing; it becomes the signed message (crypto.ts Inner).
export type Outgoing = Omit<Message, "from" | "ts">;

// `label` and `owner`, when the exchange gives a contact's device: its computer's name and its owner's login, the
// exchange's word (outside anything signed), shown on the card that asks to trust new keys.
export type PublicDevice = { id: string; sign_pk: string; box_pk: string; label?: string; owner?: string };

// The other computer an agent lives on: its name, when it was last connected, and whether it is connected now.
export type Elsewhere = { agent: string; label: string; last_seen_at: number | null; online: boolean };

// An agent identity, as its gatekeeper sees it. Messages are addressed to approved agent identities.
export type AgentStatus = "pending" | "approved" | "rejected" | "revoked";
// `workspaces`: the workspaces it is in, by name.
export type AgentInfo = { name: string; status: AgentStatus; workspaces?: string[] };

// An agent's request to join a workspace or a channel. Approved once every approval it needs is given: the
// agent's owner always, and for a private channel the channel's owner too.
export type MembershipStatus = "pending" | "approved" | "rejected" | "left";

// What a gatekeeper sends to the exchange: one sealed copy per recipient device. `from` is one of the
// approved agents this device hosts; the exchange checks that before it stores anything. For a channel,
// `to` is `#<channel id>` and there is a copy for the device of every member agent.
export type OutgoingEnvelope = { id: string; convo: string; from: string; to: string; copies: Record<string, string> };

// Who a channel message goes to: every member agent except the sender, with its device's keys.
export type ChannelRecipients = { channel: ChannelRef; members: { agent: string; device: PublicDevice }[] };

// What the exchange hands to one recipient device.
export type DeliveredEnvelope = {
  id: string;
  convo: string;
  from: string;
  to: string;
  // The agent on this device the copy is for (for a channel message, the member agent).
  agent: string;
  from_device: string;
  ciphertext: string;
  sender_sign_pk: string;
  // The sending computer's name and owner, as the exchange knows them (for the key change card).
  from_label?: string;
  from_owner?: string | null;
  ts: number;
  // A direct message only: the workspaces both agents are in, as the exchange knows them. Outside the signed
  // message, so it is the exchange's word; used only to pick the workspace whose rules apply (agent-file.ts).
  workspaces?: string[];
};

export type UndeliverableReason = "unknown_recipient" | "not_allowed" | "invalid";

export type ClientFrame =
  // Answers the exchange's challenge: `sig` signs `patio-hello:<nonce>` with the device's signing key.
  | { type: "hello"; v: number; device: PublicDevice; label: string; sig: string }
  | { type: "pair"; rid: string }
  // `by_owner`: the owner asked from their own interactive terminal, which counts as their approval (README: who
  // confirms what). Never set for an agent's request (MCP, or a command not run from a terminal).
  | { type: "register"; rid: string; name: string; by_owner?: boolean }
  | { type: "send"; env: OutgoingEnvelope }
  | { type: "keys"; rid: string; from: string; to: string }
  // Who a channel message from `from` goes to. `channel` is a channel id, `<workspace>/<channel>` or a bare name.
  | { type: "channel_keys"; rid: string; from: string; channel: string }
  // An agent asks to join a workspace or a channel; its owner approves in the web app.
  | { type: "join"; rid: string; agent: string; workspace?: string; channel?: string; by_owner?: boolean }
  // These agents of this device's person join the workspace of an invite link (created when missing).
  // `move` (by its owner only): an agent of theirs that lives on another of their computers moves here.
  | { type: "join_link"; rid: string; code: string; agents: string[]; by_owner?: boolean; move?: boolean }
  // An agent leaves a workspace (and its channels there).
  | { type: "leave_workspace"; rid: string; agent: string; workspace: string }
  // From the person's own terminal: a new workspace with this agent in it, and an invite link.
  | { type: "workspace_new"; rid: string; name: string; agent: string; by_owner?: boolean }
  // An admin creates an invite link from their own terminal (`patio invite`).
  | { type: "invite"; rid: string; workspace: string; expires_ms?: number; max_uses?: number }
  | { type: "leave"; rid: string; agent: string; channel: string }
  | { type: "ack"; id: string }
  // The sender's gatekeeper has recorded an "expired undelivered" notice.
  | { type: "ack_expired"; id: string }
  | { type: "who" }
  // The workspaces each agent of this computer answers on its own, from its owner's rules (increment 15).
  | { type: "answering"; agents: { agent: string; workspaces: string[] }[] }
  // The channels of an agent's workspaces, and whether it is in each.
  | { type: "channels"; rid: string; agent: string }
  // `patio uninstall`: this computer revokes itself (its person signed it in; it leaves for good).
  | { type: "revoke_self"; rid: string };

export type RelayFrame =
  | { type: "challenge"; nonce: string }
  // `login` is the GitHub user this device is paired with, or null before pairing.
  | { type: "welcome"; device: string; login: string | null; agents: AgentInfo[] }
  | { type: "error"; message: string }
  // `elsewhere`: the agent lives on another computer of the same person (code "agent_elsewhere"); its owner may move it.
  | { type: "failed"; rid: string; error: string; code?: string; elsewhere?: Elsewhere }
  | { type: "pairing"; rid: string; code: string; expires_at: number }
  | { type: "paired"; login: string }
  | { type: "registered"; rid: string; agent: AgentInfo }
  // Pushed whenever the status of one of this device's agents changes (approved in the web app, say).
  | { type: "agents"; agents: AgentInfo[] }
  // delivered: pushed to an online device; queued: stored until the recipient's device connects.
  | { type: "sent"; id: string; status: "delivered" | "queued"; recipients?: number }
  | { type: "undeliverable"; id: string; reason: UndeliverableReason; detail?: string }
  | { type: "deliver"; env: DeliveredEnvelope }
  // To the sender's device: the exchange dropped its message to `to` undelivered, after `after_ms` (the message TTL).
  // Sent again on every connection until acknowledged with ack_expired.
  | { type: "expired"; id: string; convo: string; to: string; channel: string | null; after_ms: number }
  // `workspaces`: the workspaces both agents are in (the sender's rules for one of them may apply).
  | { type: "keys"; rid: string; to: string; devices: PublicDevice[]; error?: UndeliverableReason; workspaces?: string[]; answers?: "self" | "owner"; owner?: string }
  | { type: "channel_keys"; rid: string; recipients: ChannelRecipients }
  // joined: the person is a member and `agents` says where each agent is; pending: it waits for the person.
  | { type: "link_joined"; rid: string; workspace: { id: string; name: string }; inviter: string; people: number; status: "joined" | "pending"; agents: { name: string; status: MembershipStatus; channels: string[] }[]; moved?: { agent: string; from: string; revoked: boolean }[] }
  | { type: "invite_link"; rid: string; url: string; expires_at: number | null; max_uses: number | null; workspace: string; channels?: string[] }
  | { type: "membership"; rid: string; kind: "workspace" | "channel"; target: string; status: MembershipStatus; needs: string[] }
  // `owners`: each online agent's owner (a GitHub login), so a directory can say whose agent it is. `workspaces`: every
  // agent (online or not) in each workspace an agent of this computer is in, for `patio guide`.
  | { type: "presence"; online: string[]; owners?: Record<string, string>; workspaces?: Roster[] }
  | { type: "revoked_self"; rid: string; label: string }
  | { type: "channel_list"; rid: string; channels: { workspace: string; name: string; private: boolean; member: boolean; is_default: boolean }[] };

// A workspace and the agents in it, each with its owner's login.
// `answers`: self when the agent answers that workspace on its own, owner when its owner answers (it may take hours).
export type Roster = { workspace: string; agents: { agent: string; owner: string; answers?: "self" | "owner" }[] };

export const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function newId(): string {
  return crypto.randomUUID();
}

export function validateOutgoing(msg: unknown): string | null {
  if (typeof msg !== "object" || msg === null) return "message must be an object";
  const m = msg as Record<string, unknown>;
  if (typeof m.id !== "string" || !m.id) return "id is required";
  if (typeof m.convo !== "string" || !m.convo) return "convo is required";
  if (typeof m.to !== "string" || !(HANDLE_RE.test(m.to) || CHANNEL_ADDRESS_RE.test(m.to))) return "to must be an agent or a channel";
  if (!KINDS.includes(m.kind as Kind)) return `kind must be one of ${KINDS.join(", ")}`;
  if (m.kind === "reply" && (typeof m.in_reply_to !== "string" || !m.in_reply_to)) return "a reply must name the message it answers";
  if (m.kind !== "reply" && m.in_reply_to !== undefined) return "only a reply answers a message";
  if (m.rejected !== undefined) {
    const r = m.rejected as Record<string, unknown> | null;
    if (m.kind !== "reply") return "only a reply carries a rejection";
    if (typeof r !== "object" || r === null || Object.keys(r).join() !== "reason" || typeof r.reason !== "string" || !CONTEXT_FIELD_RE.test(r.reason))
      return "a rejection carries a short single-line reason";
  }
  if (CHANNEL_ADDRESS_RE.test(m.to)) {
    const c = m.channel as Record<string, unknown> | undefined;
    if (!c || typeof c !== "object" || `#${c.id}` !== m.to || typeof c.name !== "string" || typeof c.workspace !== "string")
      return "a channel message must carry its channel";
    if (!CONTEXT_FIELD_RE.test(c.name) || !CONTEXT_FIELD_RE.test(c.workspace)) return "channel names are short single lines";
  } else if (m.channel !== undefined) return "only a channel message carries a channel";
  if (typeof m.text !== "string" || !m.text.trim()) return "text is required";
  if (m.text.length > 32_000) return "text is over 32000 characters";
  return validateContext(m.context);
}

// Context ends up in the receiving agent's prompt, so keep it to short single-line strings. Checked by the
// sender's gatekeeper and again by the receiver's, since the exchange cannot see it.
const CONTEXT_FIELD_RE = /^[^\r\n]{1,200}$/;

function validateContext(ctx: unknown): string | null {
  if (ctx === undefined || ctx === null) return null;
  if (typeof ctx !== "object" || Array.isArray(ctx)) return "context must be an object";
  const c = ctx as Record<string, unknown>;
  for (const key of Object.keys(c)) if (!["repo", "pr", "files"].includes(key)) return `unknown context field ${key}`;
  for (const key of ["repo", "pr"] as const)
    if (c[key] !== undefined && (typeof c[key] !== "string" || !CONTEXT_FIELD_RE.test(c[key] as string)))
      return `context.${key} must be a single line under 200 characters`;
  if (c.files !== undefined) {
    if (!Array.isArray(c.files) || c.files.length > 50) return "context.files must be a list of at most 50 paths";
    if (c.files.some((f) => typeof f !== "string" || !CONTEXT_FIELD_RE.test(f)))
      return "each context.files entry must be a single line under 200 characters";
  }
  return null;
}
