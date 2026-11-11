// Client for the daemon's local socket, used by the CLI commands and the MCP server.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentChoice } from "./agents";
import type { Config } from "./config";
import type { Status } from "./status";
import type { DryRun, DryRunInput } from "./dryrun";
import type { ListFilter, PublicItem } from "./inbox";
import type { AgentInfo, ChannelRef, Context, Elsewhere, Kind, MembershipStatus, Message, Roster } from "./protocol";
import type { Answers } from "./answers";

export class DaemonError extends Error {
  constructor(
    message: string,
    readonly code: string,
    // code "agent_elsewhere": the other computer the agent lives on.
    readonly elsewhere?: Elsewhere,
  ) {
    super(message);
  }
}

// Why the local socket does not answer, and what to do: a computer patio never set up needs the invite link; one set up
// needs patio started again.
export function notRunning(cfg: Config): string {
  if (!existsSync(join(cfg.home, "device.json"))) return "patio is not set up on this computer yet: paste the prompt from your invite page into your coding agent, or run patio join <invite link>";
  return `patio is not running on this computer (no socket at ${cfg.socket}): start it with \`patio up\`, or run patio join <invite link> again`;
}

async function call<T>(cfg: Config, path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`http://daemon${path}`, { ...init, unix: cfg.socket } as RequestInit);
  } catch {
    throw new DaemonError(notRunning(cfg), "no_daemon");
  }
  const body = (await res.json()) as T & { error?: string; code?: string; elsewhere?: Elsewhere };
  if (!res.ok) throw new DaemonError(body.error ?? `daemon returned ${res.status}`, body.code ?? "error", body.elsewhere);
  return body;
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

// A direct message names `to`; a broadcast names `channel` (a channel id, `<workspace>/<channel>` or a name).
export type SendInput = { to?: string; channel?: string; as?: string; kind: Kind; text: string; context?: Context; convo?: string };

export type SendStatus = {
  id: string;
  convo: string;
  // held: your output gate holds it until your owner decides in the web app (`reason` says why, `web_url` where).
  // outbox: the exchange is unreachable; it passed the output gate and waits in your gatekeeper, sent once it is reachable.
  status: "delivered" | "queued" | "held" | "outbox";
  reason?: string;
  web_url?: string;
  // Broadcasts only: how many member agents it went to, and the channel.
  recipients?: number;
  channel?: ChannelRef;
  // A direct message: "carol-team answers on its own", or "carol-team is answered by @carol, may take hours".
  answers?: string;
};

export type ContactKeys = {
  agent: string;
  devices: { id: string; sign_pk: string; box_pk: string | null; pinned_at: number }[];
  change: { state: "pending" | "blocked"; devices: { id: string; sign_pk: string; box_pk: string | null }[]; detected_at: number; held_in: number; held_out: number } | null;
};

export type LinkJoin = {
  workspace: { id: string; name: string };
  inviter: string;
  people: number;
  // joined: the person is a member, and each agent here is in it (or waits for the person); pending: it all waits.
  status: "joined" | "pending";
  agents: { name: string; status: MembershipStatus; channels: string[] }[];
  // Agents that moved here from another computer of the person's (`from`: its name; `revoked`: it had no agent left).
  moved?: { agent: string; from: string; revoked: boolean }[];
  web_url: string;
};

// What a join started by an agent shows on the one confirmation screen: with the three answers it will write.
export type SetupJoin = { link: string; workspace: string; inviter: string; agent: string | null; tool: string | null; folder: string | null; answers?: Answers | null };

export type Membership = { kind: "workspace" | "channel"; target: string; status: MembershipStatus; needs: string[]; web_url: string };

export const daemon = {
  // Everything `patio status` prints, with what needs attention (status.ts).
  status: (cfg: Config) => call<Status>(cfg, "/status"),
  // A code that binds this computer to its person's GitHub account. `url`: where they sign in (and, for a join
  // started by an agent, confirm the computer, the agent and the join on one screen).
  pair: (cfg: Config, o: { interactive?: boolean; join?: SetupJoin } = {}) =>
    call<{ code: string; expires_at: number; web_url: string; url: string; device: string; label: string }>(cfg, "/pair", post(o)),
  // Asks for an agent identity. From the owner's own terminal (`interactive`) it is theirs at once; otherwise it waits
  // for them in the web app.
  register: (cfg: Config, name: string, interactive = false) => call<{ agent: AgentInfo; web_url: string }>(cfg, "/register", post({ name, interactive })),
  // Which agent a call speaks as: `as`, else PATIO_AGENT, else the only agent; fails with several and none named.
  speaker: (cfg: Config, as?: string | null) => call<{ name: string }>(cfg, `/speaker${as ? `?as=${encodeURIComponent(as)}` : ""}`),
  // The person's answer "yes, answer <workspace> on its own" turns on the agent's auto_answer_in list (exactly it).
  answerRule: (cfg: Config, agent: string, list: string[], by: "join" | "rules") => call<{ said: string }>(cfg, "/rules/answer", post({ agent, list, by })),
  // The agent's guide in plain words (guide.ts): who it is, its rules, how to ask and answer, who is in its workspaces.
  guide: (cfg: Config, as?: string | null) => call<{ agent: string; text: string }>(cfg, `/guide${as ? `?as=${encodeURIComponent(as)}` : ""}`),
  // The channels of the agent's workspaces, and whether it is in each.
  channels: (cfg: Config, as?: string | null) =>
    call<{ agent: string; channels: { workspace: string; name: string; private: boolean; member: boolean; is_default: boolean }[] }>(cfg, `/channels${as ? `?as=${encodeURIComponent(as)}` : ""}`),
  // The agents you can reach that are online, whose each is, and every agent of each of your agents' workspaces.
  who: (cfg: Config) =>
    call<{ online: string[]; owners: Record<string, string>; workspaces: Roster[] | null; connected: boolean; members: WhoMember[] }>(cfg, "/who"),
  // This computer revokes itself at the server (patio uninstall). Final.
  revokeSelf: (cfg: Config) => call<{ label: string }>(cfg, "/revoke-self", post({})),
  // An add to a workspace that waits with the agent's own card (the agent waits for its owner).
  pendingAdd: (cfg: Config, agent: string, workspace: string) => call<{ web_url: string }>(cfg, "/pending-add", post({ agent, workspace })),
  // A change of an agent's three answers that widens what others can do, from outside the person's terminal: it waits
  // for the person as a card in the web app (answers.ts splitWidening).
  ruleRequest: (cfg: Config, input: { agent: string; workspace: string; answers: Partial<Answers>; by: "join" | "rules" }) =>
    call<{ web_url: string; sentences: string[] }>(cfg, "/rules/request", post(input)),
  // Each contact's pinned device keys, and a change of keys waiting for the owner's decision (or blocked).
  contacts: (cfg: Config) => call<{ contacts: ContactKeys[]; web_url: string }>(cfg, "/contacts"),
  // Asks for the agent to join a workspace or a channel; its owner approves in the web app. Reports the status.
  join: (cfg: Config, input: { as?: string; workspace?: string; channel?: string; interactive?: boolean }) => call<Membership>(cfg, "/join", post(input)),
  // These agents of this computer join the workspace of an invite link (registered when new). `move`, from the person's
  // own terminal only: an agent of theirs on another of their computers moves here (DaemonError "agent_elsewhere" asks).
  joinLink: (cfg: Config, code: string, agents: string[], interactive = false, move = false) => call<LinkJoin>(cfg, "/join-link", post({ code, agents, interactive, move })),
  // The agent leaves a workspace and its channels there.
  leaveWorkspace: (cfg: Config, input: { as: string; workspace: string }) => call<Membership>(cfg, "/leave-workspace", post(input)),
  // A new workspace with the agent in it, and its invite link (from the person's own terminal only).
  workspaceNew: (cfg: Config, input: { name: string; agent: string; interactive: boolean }) =>
    call<{ url: string; workspace: string; channels?: string[] }>(cfg, "/workspace-new", post(input)),
  // An admin's invite link, from their own terminal only.
  invite: (cfg: Config, input: { workspace: string; expires_ms?: number; max_uses?: number; interactive: boolean }) =>
    call<{ url: string; expires_at: number | null; max_uses: number | null; workspace: string }>(cfg, "/invite", post(input)),
  leave: (cfg: Config, input: { as?: string; channel: string }) => call<Membership>(cfg, "/leave", post(input)),
  // `queued` means the recipient is offline: the exchange keeps the message until one of their devices connects.
  send: (cfg: Config, input: SendInput) => call<SendStatus>(cfg, "/send", post(input)),
  // `ref` is the conversation id or the id of the message being answered (or a unique prefix of either).
  reply: (cfg: Config, ref: string, text: string, as?: string) => call<SendStatus>(cfg, "/reply", post({ convo: ref, text, as })),
  // open (default): unread, read, claimed and failed; all: also answered and dismissed; rejected: only those.
  inbox: (cfg: Config, opts: { unreadOnly?: boolean; filter?: ListFilter; as?: string } = {}) =>
    call<{ messages: PublicItem[] }>(cfg, `/inbox?filter=${opts.unreadOnly ? "unread" : (opts.filter ?? "open")}${opts.as ? `&as=${encodeURIComponent(opts.as)}` : ""}`),
  // Unread messages and expired claims, oldest first, each with whether its grant allows auto-answer.
  pending: (cfg: Config, as?: string) => call<{ messages: (PublicItem & { auto_answer: boolean })[] }>(cfg, `/pending${as ? `?as=${encodeURIComponent(as)}` : ""}`),
  // `agent`: the agent the message reached; `agent_config`: its tool and folder, from its file.
  claim: (cfg: Config, id: string, as?: string) =>
    call<{ message: PublicItem; token: string; lease_ms: number; agent: string; agent_config: AgentChoice; owner?: string | null }>(cfg, "/claim", post({ id, as })),
  renew: (cfg: Config, id: string, token: string) => call<{ ok: true }>(cfg, "/claim/renew", post({ id, token })),
  release: (cfg: Config, id: string, token: string) => call<{ ok: boolean }>(cfg, "/claim/release", post({ id, token })),
  failClaim: (cfg: Config, id: string, token: string, reason: string) => call<{ ok: true }>(cfg, "/claim/fail", post({ id, token, reason })),
  // The agent's reply to a claimed message: delivered or queued (answered), held (claim kept), or blocked.
  complete: (cfg: Config, id: string, token: string, text: string) => call<SendStatus>(cfg, "/claim/complete", post({ id, token, text })),
  dismiss: (cfg: Config, id: string, as?: string) => call<{ id: string; state: "dismissed" }>(cfg, "/dismiss", post({ id, as })),
  // Declines a message: the sender is told "declined by the recipient", with `reason` when given.
  reject: (cfg: Config, id: string, reason?: string | null, as?: string) => call<{ id: string; state: "rejected" }>(cfg, "/reject", post({ id, reason: reason ?? null, as })),
  // A gate as a dry run (`patio grants test`): nothing is sent, stored or logged.
  grantsTest: (cfg: Config, input: DryRunInput) => call<DryRun>(cfg, "/rules/test", post(input)),
  // What waits in the outbox for the exchange, oldest first; and taking one back.
  outbox: (cfg: Config) =>
    call<{ connected: boolean; ttl_ms: number; items: { id: string; convo: string; from: string; to: string; kind: Kind; text: string; queued_at: number; expires_at: number }[] }>(cfg, "/outbox"),
  cancelOutbox: (cfg: Config, id: string) => call<{ id: string; state: "cancelled" }>(cfg, "/outbox/cancel", post({ id })),
  // Marks the message read.
  read: (cfg: Config, id: string, as?: string) => call<{ message: PublicItem }>(cfg, `/read?id=${encodeURIComponent(id)}${as ? `&as=${encodeURIComponent(as)}` : ""}`),
  // One long-poll round; returns null when nothing arrived within `seconds`.
  waitOnce: async (cfg: Config, convo: string, seconds: number) => {
    const res = await daemon.waitRound(cfg, convo, seconds);
    return "reply" in res ? res.reply : (res.replies[0] ?? null);
  },
  waitRound: (cfg: Config, convo: string, seconds: number) =>
    call<
      // not_sent: the message will get no reply, and why (not reviewed in time, rejected, expired undelivered).
      | { reply: Message | null; not_sent?: string; waiting_on?: WaitingOn }
      | { broadcast: { id: string; convo: string; expected: number }; replies: Message[]; total: number }
    >(cfg, `/wait?convo=${encodeURIComponent(convo)}&timeout=${seconds}`),
};

// Waits for the replies to a broadcast: returns those that arrived within `totalSeconds`, or sooner once every
// member agent has answered. For a direct conversation, returns the first reply (or none) as a list.
// `not_sent`: the message was never sent or never delivered (it expired), so no reply will come.
// One agent of your agents' workspaces: whose, online or not, and whether it answers on its own.
export type WhoMember = { agent: string; owner: string; online: boolean; answers: "self" | "owner"; workspaces: string[]; yours: boolean };

// `waiting_on`: a direct message with no reply yet: its recipient, and whether it answers on its own.
export type WaitingOn = { agent: string; owner: string; answers: "self" | "owner"; say: string };

export async function waitForReplies(cfg: Config, convo: string, totalSeconds: number): Promise<{ broadcast: boolean; replies: Message[]; not_sent?: string; waiting_on?: WaitingOn }> {
  const deadline = Date.now() + totalSeconds * 1000;
  const replies: Message[] = [];
  let waitingOn: WaitingOn | undefined;
  let direct = false;
  while (true) {
    const left = Math.ceil((deadline - Date.now()) / 1000);
    if (left <= 0) return { broadcast: !direct, replies, ...(waitingOn ? { waiting_on: waitingOn } : {}) };
    const res = await daemon.waitRound(cfg, convo, Math.min(left, 50));
    if ("reply" in res) {
      direct = true;
      if (res.not_sent) return { broadcast: false, replies: [], not_sent: res.not_sent };
      if (res.reply) return { broadcast: false, replies: [res.reply] };
      waitingOn = res.waiting_on ?? waitingOn;
      continue;
    }
    replies.push(...res.replies);
    if (res.total >= res.broadcast.expected) return { broadcast: true, replies };
  }
}

// Waits up to `totalSeconds`, polling in short rounds so no single HTTP request stays open too long.
export async function waitForReply(cfg: Config, convo: string, totalSeconds: number): Promise<Message | null> {
  const deadline = Date.now() + totalSeconds * 1000;
  while (true) {
    const left = Math.ceil((deadline - Date.now()) / 1000);
    if (left <= 0) return null;
    const reply = await daemon.waitOnce(cfg, convo, Math.min(left, 50));
    if (reply) return reply;
  }
}

const fp = (id: string) => id.match(/.{1,4}/g)!.join(" ");
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// `patio contacts`: one block per contact, with the fingerprints of its pinned devices and any change of keys.
export function formatContacts(contacts: ContactKeys[], webUrl: string): string {
  return contacts
    .map((c) => {
      const lines = [`${c.agent}`, ...c.devices.map((d) => `  pinned  ${fp(d.id)}  (since ${day(d.pinned_at)})`)];
      if (c.change?.state === "pending") {
        lines.push(...c.change.devices.map((d) => `  NEW     ${fp(d.id)}  (seen ${day(c.change!.detected_at)})`));
        lines.push(`  keys changed: ${c.change.held_in} incoming and ${c.change.held_out} outgoing message(s) wait; trust or block them in the web app: ${webUrl}`);
      } else if (c.change?.state === "blocked") lines.push(...c.change.devices.map((d) => `  blocked ${fp(d.id)}`));
      return lines.join("\n");
    })
    .join("\n");
}
