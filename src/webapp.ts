// The local web app, served by the gatekeeper on 127.0.0.1. It is the only place where a human approves
// agent identities and their workspace and channel memberships, pairs devices and manages workspaces and
// channels. It also shows, read-only, the channels and direct messages of this gatekeeper's agents: humans
// read them here but never write. Every action needs a browser session that was
// created by signing in with GitHub through the exchange; the session token stays in this process and the
// browser only holds an opaque, HttpOnly, SameSite=Strict cookie. Every POST also needs the session's CSRF
// token and, when the browser sends one, a same-origin Origin header.

import type { AuditEntry } from "./audit";
import { activitySentence, because, sureness, type Fate } from "./activity";
import { HeldError, type GateDecision } from "./gates";
import { WEB_SESSION_MS, type Inbox, type InboxItem } from "./inbox";
import type { ChannelRef } from "./protocol";
import { ago, parseDuration } from "./clock";
import { defaultAgentName, ownsName, toolLabel, type AgentFile } from "./agent-file";
import { agentState, type AgentRow } from "./status";
import { toolStateText } from "./connect";
import type { Grants } from "./grants";
import { checkGrants } from "./grants-check";
import { ACT_WORDS, ASK_WORDS, type Answers } from "./answers";

// A message the owner's rules held for them: incoming, or an outgoing draft.
export type HeldCard = {
  id: string;
  direction: "in" | "out";
  from: string;
  to: string;
  kind: string;
  channel: ChannelRef | null;
  text: string;
  // For an outgoing reply: the message it answers.
  answering: string | null;
  at: number;
  decision: GateDecision;
  // An incoming request for an action: the action taken from the message, or null when patio found none.
  action_summary: string | null;
};

// A question or request that waits for the person (Questions for you).
export type QuestionRow = { id: string; from: string; to: string; kind: string; text: string; channel: ChannelRef | null; at: number; failed: string | null };

// A contact whose device keys changed: what this gatekeeper pinned, what the exchange now gives, what waits.
export type KeyChangeCard = {
  agent: string;
  // Whose agent it is and the computer the new keys are on, as the server says (null and [] when it did not say).
  owner?: string | null;
  computers?: string[];
  pinned: { id: string; box_pk: string | null; pinned_at: number }[];
  devices: { id: string; box_pk: string | null }[];
  detected_at: number;
  held_in: number;
  held_out: number;
};

export type GatekeeperView = {
  device: { id: string; label: string };
  login: () => string | null;
  connected: () => boolean;
  // The messages this gatekeeper's agents received and sent, decrypted locally, for the read-only views; and the
  // web sessions and in-progress sign-ins, kept in the gatekeeper's database so they survive a restart.
  inbox: Pick<Inbox, "channels" | "channelThreads" | "directThreads" | "addWebSession" | "webSession" | "dropWebSession" | "addSignIn" | "takeSignIn">;
  // Present when the gatekeeper has a grants.yaml. Only the gatekeeper's owner sees and decides held messages.
  gates: {
    held: () => HeldCard[];
    // `allow`: deliver an incoming message with the action in `text`; `edit`: send an outgoing draft as `text`.
    decide: (id: string, decision: "approve" | "allow" | "reject" | "edit", by: string, text?: string) => Promise<string>;
  } | null;
  // The audit log, for the Activity page (the owner's only), and the text of one of the owner's own messages.
  activity?: { entries: () => AuditEntry[]; ownText: (messageId: string) => string | null; fate?: (messageId: string) => Fate | null };
  // Errors in the agents' files: patio keeps the last valid version, and every page says so.
  configErrors?: () => string[];
  // The agents of this computer (the Agents page): the server's word and their files, and their rules as applied.
  agents?: {
    rows: () => AgentRow[];
    file: (name: string) => AgentFile | null;
    rules: (name: string) => Grants;
    // The agent's guide (guide.ts), the same text its coding tool gets from the MCP tool `guide`.
    guide: (name: string) => Promise<string>;
    // The three answers of the join, as sentences (answers.ts).
    answers: (name: string) => string[];
    // The agent left a workspace: its open messages from there close. Returns how many.
    closeOpen?: (name: string, workspace: string) => number;
  };
  // A first run in progress (`patio join <link>`): the pairing code it asked for and, when an agent started it, the
  // join to confirm on one screen.
  setup?: {
    current: () => {
      code: string;
      interactive: boolean;
      join: { link: string; workspace: string; inviter: string; agent: string | null; tool: string | null; folder: string | null; answers?: Answers | null } | null;
      state: "waiting" | "confirmed" | "declined";
    } | null;
    // `moved`: confirmed with Move, from this other computer of the person's.
    settle: (state: "confirmed" | "declined", agent: string | null, moved?: string | null) => void;
  };
  // Settings in the agents' rules that widen what others can do (auto_answer, allowed actions): off until the owner
  // turns each one on here, even when they wrote it in their own terminal.
  rules?: {
    pending: () => { key: string; agent: string; where: string; text: string }[];
    confirm: (key: string, by: string) => Promise<string>;
    // Changes of an agent's three answers that widen what others can do, asked from outside the person's terminal.
    requests?: () => { id: string; agent: string; workspace: string; sentences: string[]; by: "join" | "rules"; at: number }[];
    decide?: (id: string, decision: "approve" | "reject", by: string) => Promise<string>;
  };
  // What waits for the person: questions and requests nobody answers on its own, and the three ways to settle one.
  questions?: {
    list: () => QuestionRow[];
    answer: (id: string, by: string) => string;
    reply: (id: string, text: string, by: string) => Promise<string>;
    decline: (id: string, reason: string, by: string) => Promise<string>;
  };
  // `patio agents add` for an agent that waits for its owner: the workspaces it joins once the owner confirms it.
  pendingAdds?: { of: (agent: string) => string[]; clear: (agent: string) => void };
  // Contacts whose device keys changed since this gatekeeper pinned them. Only the owner sees and decides.
  keys?: {
    changes: () => KeyChangeCard[];
    decide: (agent: string, decision: "trust" | "block", by: string) => Promise<string>;
  };
};

// `id` is the cookie's value; the database keeps only its hash.
type WebSession = { id: string; login: string; token: string; csrf: string };

type Me = {
  login: string;
  devices: { id: string; label: string; paired_at: number | null; revoked_at: number | null; last_seen_at?: number | null; online?: boolean }[];
  agents: {
    name: string;
    status: string;
    label: string;
    device_id: string;
    requested_at: number;
    decided_at: number | null;
    workspaces: { id: string; name: string; status: string }[];
  }[];
  workspaces: { id: string; name: string; role: string; status: string }[];
  requests: {
    workspace_joins: { workspace_id: string; workspace: string; agent: string; requested_at: number }[];
    channel_joins: {
      channel_id: string;
      channel: string;
      workspace: string;
      private: number;
      channel_owner: string;
      agent: string;
      agent_owner: string;
      owner_ok: number;
      channel_owner_ok: number;
      requested_at: number;
    }[];
    // Joins by invite link that an agent (or a command not run from a terminal) asked for: they wait for this person.
    link_joins: { id: string; workspace: string; workspace_id: string; inviter: string; agents: string[]; requested_at: number }[];
  };
};

type WorkspaceView = {
  id: string;
  name: string;
  role: string;
  created_by: string;
  members: {
    login: string;
    demo: boolean;
    role: string;
    status: string;
    invited_by: string | null;
    invited_at: number;
    joined_at: number | null;
    revoked_by: string | null;
    devices: { id: string; label: string; fingerprint: string }[];
  }[];
  notices: { id: number; login: string; kind: string; at: number }[];
  agents: { agent: string; login: string; demo: boolean; status: string; requested_at: number }[];
  channels: { id: string; name: string; owner_login: string; private: number; is_default: number; members: { agent: string; login: string; status: string }[] }[];
  // An admin's invite links, newest first.
  links: { code: string; created_by: string; created_at: number; expires_at: number | null; max_uses: number | null; uses: number; revoked_at: number | null; state: "ok" | "expired" | "revoked" | "used_up" }[];
};

const demoTag = (demo: boolean) => (demo ? ' <span class="tag demo" title="A demo person, not a GitHub account">demo</span>' : "");
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fingerprint = (id: string) => id.match(/.{1,4}/g)!.join(" ");
// A folder as a person writes it: ~ for their home.
const tilde = (path: string | null | undefined) => {
  const home = process.env.HOME;
  return path && home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : (path ?? "");
};
const until = async (fn: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!fn() && Date.now() < end) await Bun.sleep(25);
};
const when = (ms: number | null) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "");

class ExchangeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const CSS = `
:root{--bg:#f6f6f5;--surface:#fff;--line:#e4e4e2;--line-strong:#d0d0cd;--text:#1c1c1c;--muted:#6e6e6b;--faint:#9a9a96;--accent:#3f3f3d;--accent-hover:#2a2a29;--danger-bg:#f1f1f0}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit}
.app{display:grid;grid-template-columns:220px 1fr;min-height:100vh}
.side{border-right:1px solid var(--line);padding:22px 14px;background:#fbfbfa}
.brand{font-weight:600;letter-spacing:-.01em;padding:0 10px 18px;font-size:15px}
.brand span{color:var(--faint);font-weight:400}
.nav a{display:flex;justify-content:space-between;align-items:center;padding:7px 10px;border-radius:6px;text-decoration:none;color:var(--muted);margin-bottom:2px;transition:background .15s,color .15s}
.nav a:hover{background:#f0f0ee;color:var(--text)}
.nav a.on{background:#ebebe9;color:var(--text);font-weight:500}
.count{font-size:12px;min-width:20px;text-align:center;padding:0 6px;border-radius:10px;background:var(--accent);color:#fff}
.who{margin-top:28px;padding:12px 10px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}
.who b{color:var(--text);font-weight:500}
.who form{margin-top:8px}
main{padding:36px 48px;max-width:920px}
h1{font-size:22px;font-weight:600;letter-spacing:-.015em;margin:0 0 4px}
.sub{color:var(--muted);margin:0 0 28px}
h2{font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:32px 0 10px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:10px}
.row{display:flex;align-items:center;gap:16px;padding:14px 18px;border-top:1px solid var(--line)}
.row:first-child{border-top:0}
.grow{flex:1;min-width:0}
.title{font-weight:500}
.meta{color:var(--muted);font-size:13px}
.mono{font:12.5px/1.4 ui-monospace,"SF Mono",Menlo,monospace;color:var(--muted)}
.state{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--muted);white-space:nowrap}
.state::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--line-strong);flex:none}
.state.pending::before{background:transparent;border:1.5px solid var(--muted);width:5px;height:5px}
.state.approved::before,.state.active::before,.state.paired::before{background:#5b5b58}
.state.revoked,.state.rejected{color:var(--faint)}
.actions{display:flex;gap:8px}
button,.button{font:inherit;font-size:13px;padding:6px 14px;border-radius:6px;border:1px solid var(--line-strong);background:var(--surface);color:var(--text);cursor:pointer;text-decoration:none;transition:background .15s,border-color .15s}
button:hover,.button:hover{background:#f3f3f2}
button.primary,.button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button.primary:hover,.button.primary:hover{background:var(--accent-hover)}
button.quiet{border-color:transparent;background:transparent;color:var(--muted);padding-left:0}
button.quiet:hover{background:transparent;color:var(--text)}
input[type=text]{font:inherit;padding:6px 10px;border:1px solid var(--line-strong);border-radius:6px;background:#fff;min-width:220px}
input[type=text]:focus,button:focus-visible{outline:2px solid #bdbdba;outline-offset:1px}
.inline{display:flex;gap:8px;align-items:center;padding:14px 18px}
.empty{padding:28px 18px;color:var(--muted);text-align:center}
.flash{padding:10px 14px;border-radius:8px;margin:0 0 20px;border:1px solid var(--line);border-left:3px solid var(--line-strong);background:var(--surface);color:var(--muted)}
.flash.error{background:var(--danger-bg);border-color:var(--line-strong);border-left-color:var(--accent);color:var(--text);font-weight:500}
.meta .mono{white-space:nowrap}
.meta .mono.path{white-space:normal;word-break:break-all}
.signin{max-width:420px}
.signin{max-width:380px;margin:14vh auto;padding:36px;text-align:center}
.signin h1{margin-bottom:8px}
.signin p{color:var(--muted);margin:0 0 24px}
.code{font:600 20px/1 ui-monospace,"SF Mono",Menlo,monospace;letter-spacing:.12em}
.thread{padding:16px 18px;border-top:1px solid var(--line)}
.thread:first-child{border-top:0}
.msg .head{display:flex;gap:10px;align-items:baseline;margin-bottom:4px}
.msg .who{margin:0;padding:0;border:0;font-weight:600;color:var(--text);font-size:14px}
.msg .kind{font-size:12px;color:var(--muted);border:1px solid var(--line);border-radius:4px;padding:0 6px}
.msg .time{font-size:12px;color:var(--faint);margin-left:auto}
.msg .body{white-space:pre-wrap;word-wrap:break-word}
.replies{margin:12px 0 0 14px;padding-left:16px;border-left:2px solid var(--line)}
.replies .msg{padding:8px 0}
.replies .msg + .msg{border-top:1px dashed var(--line)}
.noreply{margin:10px 0 0 30px;font-size:13px;color:var(--faint)}
.readonly{font-size:12px;color:var(--faint);border:1px dashed var(--line-strong);border-radius:999px;padding:2px 10px}
.tag{font-size:12px;color:var(--muted)}
label.check{display:flex;gap:6px;align-items:center;color:var(--muted);font-size:13px}
.agent{margin-bottom:16px}
.agent .label,.confirm .label{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin:0 0 6px}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{display:inline-flex;align-items:center;gap:2px;font-size:13px;padding:2px 4px 2px 10px;border:1px solid var(--line-strong);border-radius:999px;background:#fafaf9}
.chip form{display:inline}
.chip .x{border:0;background:transparent;color:var(--faint);padding:0 6px;font-size:14px;line-height:1;text-decoration:none}
.chip .x:hover{color:var(--text);background:transparent}
.inline.tight{padding:0;gap:6px}
select{font:inherit;font-size:13px;padding:5px 8px;border:1px solid var(--line-strong);border-radius:6px;background:#fff}
.tools{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.tool{display:flex;flex-direction:column;align-items:flex-start;gap:4px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;font-size:13px}
.tool .mono{font-size:11.5px}
.mono.wrap{white-space:normal;word-break:break-all}
.dot{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--muted);white-space:nowrap}
.dot::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--line-strong);flex:none}
.dot.on::before{background:#5b5b58}
.dot.wait::before{background:transparent;border:1.5px solid var(--muted);width:5px;height:5px}
.tool .dot{white-space:normal}
.faint{color:var(--faint)}
.rule{padding:6px 0;border-top:1px solid var(--line)}
.answers{margin:0 0 10px}
.answers p{margin:0 0 3px;font-size:13.5px;color:var(--text)}
.answers .meta{margin-top:6px}
.guide{padding:8px 22px 18px;max-width:760px}
.guide h2{font-size:14px;font-weight:600;margin:18px 0 6px;text-transform:none;letter-spacing:0;color:var(--text)}
.guide p,.guide li{font-size:13.5px;line-height:1.55;color:var(--text);margin:0 0 6px}
.guide ul{margin:0 0 8px;padding-left:20px}
.rule .title{font-size:13px}
.confirm{max-width:560px;padding:28px 30px}
main.focus{max-width:620px;margin:8vh auto;padding:0 24px}
main.focus .brand{padding:0 0 18px}
details.why{margin-top:10px}
details.why summary,details.meta summary{cursor:pointer;color:var(--muted);font-size:13px}
.confirm h1{font-size:19px;line-height:1.4;font-weight:500}
.confirm h1 b{font-weight:600}
.confirm .actions{margin-top:20px;justify-content:flex-end}
.gate{padding:16px 18px;border-top:1px solid var(--line)}
.gate:first-child{border-top:0}
.gate .head{display:flex;gap:10px;align-items:baseline;margin-bottom:4px}
.gate .head .title{flex:1;min-width:0}
.gate .kind{font-size:12px;color:var(--muted);border:1px solid var(--line);border-radius:4px;padding:0 6px;margin-left:4px}
.gate .time{font-size:12px;color:var(--faint);white-space:nowrap}
.quote{margin:10px 0;padding:10px 12px;border-left:2px solid var(--line-strong);background:#fafaf9;border-radius:0 6px 6px 0;white-space:pre-wrap;word-wrap:break-word}
.quote.small{font-size:13px;color:var(--muted);margin-top:4px}
.label{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-top:12px}
textarea{display:block;width:100%;min-height:84px;margin:6px 0 10px;font:inherit;padding:8px 10px;border:1px solid var(--line-strong);border-radius:6px;background:#fff;resize:vertical}
textarea:focus{outline:2px solid #bdbdba;outline-offset:1px}
table.probs{width:100%;border-collapse:collapse;margin:6px 0 4px;font-size:13px}
table.probs td{padding:4px 0;border-top:1px dashed var(--line);vertical-align:middle}
table.probs tr:first-child td{border-top:0}
table.probs td.q{color:var(--muted);padding-right:12px}
table.probs tr.decided td.q{color:var(--text);font-weight:500}
table.probs td.p{width:44px;text-align:right;font:12.5px ui-monospace,"SF Mono",Menlo,monospace}
table.probs td.meter{width:130px;padding-left:12px}
.bar{height:6px;background:var(--line);border-radius:3px;overflow:hidden}
.bar i{display:block;height:100%;background:var(--accent)}
.gate .actions{margin-top:12px;justify-content:flex-end}
.answer-actions{display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap;margin-top:12px}
.answer-actions details{flex-basis:100%}
.answer-actions details:not([open]){flex-basis:auto}
.answer-actions summary{list-style:none;display:inline-block}
.answer-actions summary::-webkit-details-marker{display:none}
.answer-actions details[open] summary{background:#f0f0ee}
.answer-actions details form{margin-top:10px}
.answer-actions input[type=text]{display:block;width:100%;margin:0 0 6px}
.gate input.action{display:block;width:100%;margin:6px 0 4px}
.filters{display:flex;gap:8px;align-items:center;margin:0 0 14px;flex-wrap:wrap}
select{font:inherit;font-size:13px;padding:5px 8px;border:1px solid var(--line-strong);border-radius:6px;background:#fff;color:var(--text)}
.acts .act{border-top:1px solid var(--line)}
.acts .act:first-child{border-top:0}
.act summary{display:flex;gap:12px;align-items:baseline;padding:10px 18px;font-size:13.5px;list-style:none;cursor:pointer}
.act summary .sentence{flex:1;min-width:0}
.act summary::-webkit-details-marker{display:none}
.act summary:hover{background:#fafaf9}
.act.head{cursor:default;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.act .party{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.act .kind,.act .by,.act .time{color:var(--muted)}
.act .time{font-size:12px;white-space:nowrap}
.act .rule{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.act .p{font:12.5px ui-monospace,"SF Mono",Menlo,monospace}
.act .state{justify-self:start}
.dir{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
.dir.out{color:var(--text)}
.act .more{padding:2px 18px 16px 18px}
.act[open] summary{background:#fafaf9}
.linkline{display:flex;gap:8px;align-items:center}
input.link{flex:1;min-width:0;font:12.5px/1.4 ui-monospace,"SF Mono",Menlo,monospace;color:var(--text);background:#fafaf9}
input.short{min-width:0;width:170px}
.tag.demo{border:1px solid var(--line-strong);border-radius:999px;padding:0 7px;font-weight:400}
.banner{padding:12px 16px;border-radius:8px;margin:0 0 20px;border:1px solid var(--accent);border-left:4px solid var(--accent);background:var(--surface);color:var(--text)}
`;

export function startWebApp(opts: { port?: number; exchangeUrl: string; gatekeeper: GatekeeperView; log: (line: string) => void }) {
  const store = opts.gatekeeper.inbox;
  const random = () => Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
  let origin = "";
  // Browsers share cookies across ports, so each gatekeeper's web app on this machine needs its own name.
  let cookieName = "";

  const exchange = async <T>(s: WebSession | null, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${opts.exchangeUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(s ? { authorization: `Bearer ${s.token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).catch(() => null);
    if (!res) throw new ExchangeError(503, "the server is not reachable");
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new ExchangeError(res.status, data.error ?? `exchange returned ${res.status}`);
    return data;
  };

  const sessionOf = (req: Request) => {
    const cookie = req.headers.get("cookie") ?? "";
    const id = new RegExp(`(?:^|; )${cookieName}=([^;]+)`).exec(cookie)?.[1];
    const row = id ? store.webSession(id) : null;
    return row ? { id: id!, login: row.login, token: row.token, csrf: row.csrf } : null;
  };

  const page = (title: string, body: string, status = 200, headers: Record<string, string> = {}) =>
    new Response(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · patio</title><style>${CSS}</style></head><body>${body}</body></html>`,
      { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", ...headers } },
    );

  const redirect = (to: string, headers: Record<string, string> = {}) => new Response(null, { status: 303, headers: { location: to, ...headers } });
  const back = (path: string, kind: "ok" | "error", text: string) => redirect(`${path}${path.includes("?") ? "&" : "?"}${kind}=${encodeURIComponent(text)}`);

  const cap = (t: string | null) => (t ? t[0]!.toUpperCase() + t.slice(1) : t);
  const flash = (url: URL) => {
    const ok = url.searchParams.get("ok");
    const err = cap(url.searchParams.get("error"));
    return (ok ? `<div class="flash" role="status">${esc(ok)}</div>` : "") + (err ? `<div class="flash error" role="alert">${esc(err)}</div>` : "");
  };

  // Held messages are this gatekeeper's owner's business only.
  const heldFor = (s: WebSession) => (opts.gatekeeper.gates && s.login === opts.gatekeeper.login() ? opts.gatekeeper.gates.held() : []);
  const rulesFor = (s: WebSession) => (opts.gatekeeper.rules && s.login === opts.gatekeeper.login() ? opts.gatekeeper.rules.pending() : []);
  const questionsFor = (s: WebSession) => (opts.gatekeeper.questions && s.login === opts.gatekeeper.login() ? opts.gatekeeper.questions.list() : []);
  const ruleRequestsFor = (s: WebSession) => (opts.gatekeeper.rules?.requests && s.login === opts.gatekeeper.login() ? opts.gatekeeper.rules.requests() : []);
  const keysFor = (s: WebSession) => (opts.gatekeeper.keys && s.login === opts.gatekeeper.login() ? opts.gatekeeper.keys.changes() : []);
  const boxPrint = (box: string | null) => (box ? new Bun.CryptoHasher("sha256").update(box).digest("hex").slice(0, 8) : "not known yet");

  const keyCard = (s: WebSession, c: KeyChangeCard) => {
    const list = (ds: { id: string; box_pk: string | null }[]) =>
      ds.map((d) => `<div class="mono">${esc(fingerprint(d.id))} <span class="tag">· encryption key ${esc(boxPrint(d.box_pk))}</span></div>`).join("") || `<div class="meta">none</div>`;
    const waiting = [c.held_in && `${c.held_in} incoming`, c.held_out && `${c.held_out} outgoing`].filter(Boolean).join(" and ");
    return `<div class="gate" data-keys="${esc(c.agent)}"><div class="head"><span class="state pending">Keys changed</span><div class="title">The server now gives other keys for <b>${esc(c.agent)}</b>${c.owner ? `, an agent of @${esc(c.owner)}` : ""}${c.computers?.length ? `, now on the computer ${c.computers.map((l) => `<b>${esc(l)}</b>`).join(" and ")}` : ""}</div><span class="time">${esc(when(c.detected_at))}</span></div>
<div class="meta">Nothing is sealed for the new keys or accepted from them until you decide${waiting ? `: ${esc(waiting)} message${c.held_in + c.held_out === 1 ? " waits" : "s wait"}` : ""}.</div>
<div class="label">Pinned (first seen ${esc(when(c.pinned[0]?.pinned_at ?? null))})</div>${list(c.pinned)}
<div class="label">New</div>${list(c.devices)}
<div class="meta" style="margin-top:10px">This is expected when ${esc(c.agent)}'s owner adds or moves to a new computer: their own patio approves that, and from here it looks the same as a swap of keys by someone else, such as a compromised server. Check the new fingerprint with the owner (in person or on another channel) before you trust it.</div>
<form class="actions" method="post" action="/keys/${encodeURIComponent(c.agent)}/decide">${csrfField(s)}<button type="submit" name="decision" value="block">Block</button><button class="primary" type="submit" name="decision" value="trust">Trust the new keys</button></form></div>`;
  };

  const shell = (s: WebSession, me: Me, active: string, url: URL, content: string) => {
    const pending =
      unlinkedPending(me).length + me.requests.workspace_joins.length + me.requests.channel_joins.length + (me.requests.link_joins?.length ?? 0) + heldFor(s).length + keysFor(s).length + rulesFor(s).length + ruleRequestsFor(s).length + questionsFor(s).length;
    const link = (href: string, label: string, extra = "") =>
      `<a href="${href}" class="${active === href ? "on" : ""}">${label}${extra}</a>`;
    return page(
      ({ "/": "Needs you", "/setup": "Set up", "/confirm": "Confirm", "/agents": "Agents", "/conversations": "Conversations", "/activity": "Activity", "/computers": "Computers", "/workspaces": "Workspaces" } as Record<string, string>)[active] ?? "patio",
      `<div class="app"><aside class="side"><div class="brand">patio <span>on this computer</span></div><nav class="nav">
${link("/", "Needs you", pending ? `<span class="count" aria-label="${pending} waiting for you">${pending}</span>` : "")}
${link("/conversations", "Conversations")}
${link("/agents", "Agents")}
${link("/workspaces", "Workspaces")}
${link("/computers", "Computers")}
${link("/activity", "Activity")}
</nav><div class="who">Signed in as <b>@${esc(s.login)}</b><form method="post" action="/logout"><input type="hidden" name="csrf" value="${s.csrf}"><button class="quiet" type="submit">Sign out</button></form></div></aside>
<main>${banner(s)}${flash(url)}${content}</main></div>`,
    );
  };

  // A one-step page, without the sidebar: the confirmation screen of a join.
  const focused = (title: string, url: URL, content: string) =>
    page(title, `<main class="focus"><div class="brand">patio</div>${flash(url)}${content}</main>`);

  // Where a form goes back to: a path of this app only.
  const safeBack = (v: unknown, fallback: string) => (typeof v === "string" && /^\/(?![/\\])/.test(v) ? v : fallback);

  const csrfField = (s: WebSession) => `<input type="hidden" name="csrf" value="${s.csrf}">`;

  // A configuration file with an error, on every page, for the owner (or anyone, before the pairing).
  const banner = (s: WebSession) => {
    const owner = opts.gatekeeper.login();
    const errors = owner && s.login !== owner ? [] : (opts.gatekeeper.configErrors?.() ?? []);
    return errors.map((e) => `<div class="banner" role="alert" data-config-error><b>Configuration error.</b> ${esc(e)}</div>`).join("");
  };

  // An agent of this computer, as one line: "unai-side (Claude Code in ~/code/side)".
  const agentLine = (name: string) => {
    const f = opts.gatekeeper.agents?.file(name);
    return `<b>${esc(name)}</b>${f?.tool ? ` <span class="meta">(${esc(toolLabel(f.tool))}${f.folder ? ` in <span class="mono path">${esc(tilde(f.folder))}</span>` : ""})</span>` : ""}`;
  };

  // An agent's three answers, as sentences, on the card that confirms it: the click covers them too.
  const answersBlock = (name: string) => {
    const lines = opts.gatekeeper.agents?.answers(name) ?? [];
    return lines.length ? `<div class="answers small" data-card-answers="${esc(name)}">${lines.map((l) => `<div class="meta">${esc(l)}</div>`).join("")}</div>` : "";
  };

  const approvals = (s: WebSession, me: Me) => {
    const pending = unlinkedPending(me);
    const pendingRows = pending
      .map(
        (a) => `<div class="row" data-agent="${esc(a.name)}"><div class="grow"><div class="title">${agentLine(a.name)} on <b>${esc(a.label)}</b> asks to be your agent${(() => {
          const adds = opts.gatekeeper.pendingAdds?.of(a.name) ?? [];
          return adds.length ? ` and to join <b>${adds.map(esc).join("</b>, <b>")}</b>` : "";
        })()}</div>${answersBlock(a.name)}
<div class="meta">Asked ${esc(when(a.requested_at))} · computer <span class="mono">${esc(fingerprint(a.device_id))}</span></div></div>
<span class="state pending">Waiting for you</span>
<form class="actions" method="post" action="/agents/${encodeURIComponent(a.name)}/decide">${csrfField(s)}
<button type="submit" name="decision" value="reject">Decline</button><button class="primary" type="submit" name="decision" value="approve">Confirm</button></form></div>`,
      )
      .join("");
    const decide = (action: string, yes = "Confirm", no = "Decline") =>
      `<form class="actions" method="post" action="${action}">${csrfField(s)}<button type="submit" name="decision" value="reject">${no}</button><button class="primary" type="submit" name="decision" value="approve">${yes}</button></form>`;
    const wsRows = me.requests.workspace_joins.map(
      (r) => `<div class="row" data-request="ws:${esc(r.agent)}:${esc(r.workspace)}"><div class="grow"><div class="title">${agentLine(r.agent)} wants to join <b>${esc(r.workspace)}</b></div>
<div class="meta">Asked ${esc(when(r.requested_at))}</div></div><span class="state pending">Waiting for you</span>
${decide(`/workspaces/${encodeURIComponent(r.workspace_id)}/agents/${encodeURIComponent(r.agent)}/decide`)}</div>`,
    );
    const chRows = me.requests.channel_joins.map((r) => {
      const asOwner = r.agent_owner === s.login && !r.owner_ok;
      const other = asOwner ? (r.private && !r.channel_owner_ok && r.channel_owner !== s.login ? `also needs @${r.channel_owner}, who owns this private channel` : "") : r.owner_ok ? "" : `also needs @${r.agent_owner}, the agent's owner`;
      return `<div class="row" data-request="ch:${esc(r.agent)}:${esc(r.channel)}"><div class="grow"><div class="title">${asOwner ? agentLine(r.agent) : `<b>${esc(r.agent)}</b> · @${esc(r.agent_owner)}`} wants to join ${r.private ? "the private channel" : ""} <b>#${esc(r.channel)}</b> in ${esc(r.workspace)}</div>
<div class="meta">Asked ${esc(when(r.requested_at))}${other ? ` · ${esc(other)}` : ""}</div></div><span class="state pending">Waiting for you</span>
${decide(`/channels/${encodeURIComponent(r.channel_id)}/members/${encodeURIComponent(r.agent)}/decide`)}</div>`;
    });
    // A later agent of a signed-in person, asking with an invite link: one card, one click (its identity and the join).
    const linkRows = (me.requests.link_joins ?? []).map(
      (r) => `<div class="row" data-request="link:${esc(r.workspace)}"><div class="grow"><div class="title">${r.agents.map(agentLine).join(", ") || "Your agent"} ${r.agents.length > 1 ? "want" : "wants"} to join <b>${esc(r.workspace)}</b></div>${r.agents.map(answersBlock).join("")}
<div class="meta">With an invite link from @${esc(r.inviter)} · asked ${esc(when(r.requested_at))} by a command that did not run in your terminal</div></div><span class="state pending">Waiting for you</span>
${decide(`/link-requests/${encodeURIComponent(r.id)}/decide`)}</div>`,
    );
    const joins = [...linkRows, ...pendingRows ? [pendingRows] : [], ...wsRows, ...chRows].join("");
    const pendingRules = rulesFor(s);
    const requestRows = ruleRequestsFor(s)
      .map(
        (r) => `<div class="row" data-rule-request="${esc(r.agent)}"><div class="grow"><div class="title">${r.sentences.map((x) => esc(x)).join("<br>")}</div>
<div class="meta">Asked ${esc(when(r.at))} by ${r.by === "join" ? "patio join" : "patio rules"}, run by an agent (not in your terminal). It widens what others can do to ${esc(r.agent)}, so it waits for you.</div></div>
<form class="actions" method="post" action="/rules/requests/${encodeURIComponent(r.id)}/decide">${csrfField(s)}<button type="submit" name="decision" value="reject">Decline</button><button class="primary" type="submit" name="decision" value="approve">Confirm</button></form></div>`,
      )
      .join("");
    const rules = pendingRules.length || requestRows
      ? `<h2>Your rules</h2><div class="card">${requestRows}${pendingRules
          .map(
            (r) => `<div class="row" data-rule="${esc(r.key)}"><div class="grow"><div class="title">${esc(r.text)}</div>
<div class="meta">This widens what others can do to ${esc(r.agent)}, so it stays off until you turn it on here. <span class="mono">agents/${esc(r.agent)}.yaml: ${esc(r.where)}</span></div></div>
<form method="post" action="/rules/confirm">${csrfField(s)}<input type="hidden" name="key" value="${esc(r.key)}"><button class="primary" type="submit">Turn it on</button></form></div>`,
          )
          .join("")}</div>`
      : "";
    const keyChanges = keysFor(s);
    const keys = keyChanges.length ? `<h2>Keys changed</h2><div class="card">${keyChanges.map((c) => keyCard(s, c)).join("")}</div>` : "";
    const held = heldFor(s);
    const messages = held.length ? `<h2>Messages your rules kept for you</h2><div class="card">${held.map((c) => heldCard(s, c)).join("")}</div>` : "";
    const qs = questionsFor(s);
    const questions = qs.length ? `<h2>Questions for you</h2><div class="card">${qs.map((q) => questionCard(s, q)).join("")}</div>` : "";
    const agentsJoining = joins ? `<h2>Your agents</h2><div class="card">${joins}</div>` : "";
    const body = `${questions}${messages}${agentsJoining}${rules}${keys}`;
    return `<h1>Needs you</h1><p class="sub">What waits for your decision. Only you can decide, here.</p>
${body || `<div class="card"><div class="empty" data-empty>Nothing waits for you. A question nobody answers on its own, a message your rules kept for you, or an agent that asks to join shows up here.</div></div>`}`;
  };

  // A question or request that waits for the person: who asked which of their agents, the text, and three ways out.
  const questionCard = (s: WebSession, q: QuestionRow) => {
    const id = encodeURIComponent(q.id);
    const where = q.channel ? ` in <b>#${esc(q.channel.name)}</b>` : "";
    return `<div class="gate" data-question="${esc(q.id)}"><div class="head"><div class="title"><b>${esc(q.from)}</b> asked your agent <b>${esc(q.to)}</b>${where}<span class="kind">${esc(q.kind)}</span></div><span class="time">${esc(when(q.at))}</span></div>
<div class="quote">${esc(q.text)}</div>${q.failed ? `<div class="meta">${esc(q.to)} could not answer it: ${esc(q.failed)}</div>` : ""}
<div class="answer-actions">
<form method="post" action="/questions/${id}/answer">${csrfField(s)}<button class="primary" type="submit">Let ${esc(q.to)} answer</button></form>
<details><summary class="button">Reply myself</summary><form method="post" action="/questions/${id}/reply">${csrfField(s)}<textarea name="text" required aria-label="Your reply" placeholder="Your reply, sent as ${esc(q.to)}"></textarea><div class="meta">Sent as ${esc(q.to)}'s reply, through your rules (outgoing).</div><div class="actions"><button type="submit">Send</button></div></form></details>
<details><summary class="button">Decline</summary><form method="post" action="/questions/${id}/decline">${csrfField(s)}<input type="text" name="reason" maxlength="1000" aria-label="Reason" placeholder="A reason for ${esc(q.from)} (optional)"><div class="actions"><button type="submit">Decline</button></div></form></details>
</div></div>`;
  };

  const heldCard = (s: WebSession, c: HeldCard) => {
    const d = c.decision;
    const incoming = c.direction === "in";
    const where = c.channel ? ` in <b>#${esc(c.channel.name)}</b>` : "";
    const title = incoming
      ? `<b>${esc(c.from)}</b> sent your agent <b>${esc(c.to)}</b> a message${where}`
      : `Your agent <b>${esc(c.from)}</b> wants to send ${c.channel ? `a message to <b>#${esc(c.channel.name)}</b>` : `<b>${esc(c.to)}</b> a message`}`;
    const rules = incoming ? "your rules (incoming)" : "your rules (outgoing)";
    const why = `Waits for you: ${esc(because({ at: "", direction: c.direction, reason: d.reason ?? "", dlp: d.dlp, from: c.from, to: c.to }))}.`;
    // The checks' answers, and how sure each was, behind Details.
    const probs = d.scores.length
      ? `<details class="why"><summary>Details</summary><div class="meta">Kept by ${rules}: rule <span class="mono">${esc(d.rule ?? "-")}</span> of <span class="mono">${esc(d.grant)}</span>.</div><div class="label">The checks <span class="tag">· the answer, and how sure</span></div><table class="probs">${d.scores
          .map(
            (x) =>
              `<tr class="${x.rule === d.rule ? "decided" : ""}"><td class="q">${esc(x.label)}</td><td class="p" title="probability of yes">${x.p >= 0.5 ? "yes" : "no"} ${x.p.toFixed(2)}</td><td class="meter" title="how sure: ${sureness(x.p).toFixed(2)}"><div class="bar"><i style="width:${Math.round((sureness(x.p) - 0.5) * 200)}%"></i></div></td></tr>`,
          )
          .join("")}</table></details>`
      : "";
    const jev = d.jev && "error" in d.jev ? `<div class="meta">The judge: ${esc(d.jev.error)}</div>` : "";
    const dlp = d.dlp.length ? `<div class="meta">Data checks: ${d.dlp.map((f) => `${esc(f.what)} <span class="mono">${esc(f.sample)}</span>`).join(", ")}</div>` : "";
    const formId = `g-${esc(c.id)}`;
    // An incoming message that asks for an action: the owner allows it (as written here, or narrowed), delivers the
    // message without it, or rejects it.
    const asksAction = incoming && !!d.action?.requested;
    const actionBox = asksAction
      ? `<div class="label">Requested action</div><div class="meta">${esc(c.from)} asks your agent to do something beyond answering (your rules' actions policy: ${esc(d.action!.policy === "list" ? "a list of allowed actions" : d.action!.policy)}). Read the message above.</div>
<div class="label">Action you allow</div><input class="action" type="text" name="text" value="${esc(c.action_summary ?? "")}" form="${formId}" maxlength="300" required placeholder="Write the action, e.g. create DAVE.md in the repo root" aria-label="Action you allow">
<div class="meta">${c.action_summary ? "Taken from the message. " : "patio could not find the action in the message: write it to allow it. "}If you allow it, your agent may do this and nothing else beyond answering. Narrow it to the exact file, command or message if you want.</div>`
      : "";
    const body = incoming
      ? `<div class="quote">${esc(c.text)}</div>${actionBox}`
      : `${c.answering ? `<div class="label">Answering</div><div class="quote small">${esc(c.answering)}</div>` : ""}<div class="label">Draft</div><textarea name="text" form="${formId}" aria-label="Draft">${esc(c.text)}</textarea>`;
    const buttons = asksAction
      ? `<button type="submit" name="decision" value="reject" formnovalidate>Reject</button><button type="submit" name="decision" value="approve" formnovalidate>Deliver without the action</button><button class="primary" type="submit" name="decision" value="allow">Allow the action</button>`
      : incoming
      ? `<button type="submit" name="decision" value="reject">Reject</button><button class="primary" type="submit" name="decision" value="approve">Approve</button>`
      : `<button type="submit" name="decision" value="reject">Reject</button><button type="submit" name="decision" value="edit">Send edited</button><button class="primary" type="submit" name="decision" value="approve">Approve</button>`;
    return `<div class="gate" data-gate="${esc(c.id)}" data-direction="${c.direction}"${asksAction ? ' data-action="requested"' : ""}><div class="head"><span class="state pending">${incoming ? "Incoming" : "Outgoing"}</span><div class="title">${title}<span class="kind">${esc(c.kind)}</span></div><span class="time">${esc(when(c.at))}</span></div>
<div class="meta">${why}</div>${body}${probs}${jev}${dlp}
<form class="actions" id="${formId}" method="post" action="/gates/${encodeURIComponent(c.id)}/decide">${csrfField(s)}${buttons}</form></div>`;
  };

  // The audit log as a timeline, newest first: what came in and went out, what the gates decided and why, and who
  // decided. Read-only. Only the owner of this gatekeeper sees it; the text is shown for the owner's own messages only.
  // The decrypted threads of this gatekeeper's agents are its owner's business only (security audit S3), like the
  // held cards and the activity: another signed-in human sees a note, never the text.
  // Pending identities that are not part of a join by link (that card covers them).
  const unlinkedPending = (me: Me) => {
    const linked = new Set((me.requests.link_joins ?? []).flatMap((r) => r.agents));
    return me.agents.filter((a) => a.status === "pending" && !linked.has(a.name));
  };

  const ownerOnly = (s: WebSession, title: string, render: () => string) =>
    s.login === opts.gatekeeper.login() ? render() : `<h1>${esc(title)}</h1><p class="sub">Only @${esc(opts.gatekeeper.login() ?? "the owner")}, who owns patio on this computer, reads its agents' messages.</p>`;

  const activityPage = (s: WebSession, url: URL) => {
    const gk = opts.gatekeeper;
    if (!gk.activity || s.login !== gk.login())
      return `<h1>Activity</h1><p class="sub">Only @${esc(gk.login() ?? "the owner")}, who owns patio on this computer, sees its activity.</p>`;
    const all = gk.activity.entries().filter((e) => e.direction === "in" || e.direction === "out").reverse();
    const party = (e: AuditEntry) => (e.channel ? `#${String(e.channel).split("/").pop()}` : String((e.direction === "in" ? e.from : e.to) ?? "?"));
    const probs = (e: AuditEntry) => Object.entries((e.probabilities ?? {}) as Record<string, number>).sort((a, b) => sureness(b[1]) - sureness(a[1]));
    const f = { direction: url.searchParams.get("direction") ?? "", verdict: url.searchParams.get("verdict") ?? "", contact: url.searchParams.get("contact") ?? "" };
    const rows = all.filter((e) => (!f.direction || e.direction === f.direction) && (!f.verdict || e.verdict === f.verdict) && (!f.contact || party(e) === f.contact)).slice(0, 300);
    const words: Record<string, string> = {
      deliver: "Let in",
      reject: "Not let in",
      "ask-human": "Waited for you",
      held: "Waited for you",
      send: "Sent",
      sent: "Sent",
      block: "Not sent by your rules",
      "not-sent": "Refused by the server",
      approved: "Your decisions",
      rejected: "Declined",
      queued: "Waited to be sent",
      expired: "Expired",
    };
    const options = (name: string, label: string, values: [string, string][], current: string, every: string) =>
      `<select name="${name}" aria-label="${label}"><option value="">${every}</option>${values.map(([v, w]) => `<option value="${esc(v)}"${v === current ? " selected" : ""}>${esc(w)}</option>`).join("")}</select>`;
    const verdicts = [...new Set(all.map((e) => String(e.verdict ?? "")).filter(Boolean))].sort().map((v): [string, string] => [v, words[v] ?? v]);
    const contacts = [...new Set(all.map(party))].sort().map((c): [string, string] => [c, c]);
    const filters = `<form class="filters" method="get" action="/activity">${options("direction", "Direction", [["in", "Incoming"], ["out", "Outgoing"]], f.direction, "In and out")}${options("verdict", "What happened", verdicts, f.verdict, "Everything")}${options("contact", "Contact", contacts, f.contact, "Every contact and channel")}<button type="submit">Filter</button>${f.direction || f.verdict || f.contact ? '<a class="button" href="/activity">Clear</a>' : ""}</form>`;
    const row = (e: AuditEntry) => {
      const p = probs(e);
      const text = e.direction === "out" && typeof e.message_id === "string" ? gk.activity!.ownText(e.message_id) : null;
      const fate = e.direction === "in" && e.verdict === "deliver" && typeof e.message_id === "string" ? (gk.activity!.fate?.(e.message_id) ?? null) : null;
      const judge = e.jev as { model?: string; ms?: number; error?: string } | null | undefined;
      const details = [
        e.rule && e.rule !== "owner" ? `<div class="meta">Rule: <span class="mono">${esc(e.rule)}</span>${e.grant ? ` · from <span class="mono">${esc(e.grant)}</span>` : ""}${e.reason ? ` · ${esc(e.reason)}` : ""}</div>` : "",
        p.length
          ? `<div class="label">The checks <span class="tag">· the answer, and how sure</span></div><table class="probs">${p
              .map(
                ([id, v]) =>
                  `<tr class="${id === e.rule ? "decided" : ""}"><td class="q mono">${esc(id)}</td><td class="p">${v >= 0.5 ? "yes" : "no"} ${v.toFixed(2)}</td><td class="meter" title="how sure: ${sureness(v).toFixed(2)}"><div class="bar"><i style="width:${Math.round((sureness(v) - 0.5) * 200)}%"></i></div></td></tr>`,
              )
              .join("")}</table>`
          : "",
        judge ? `<div class="meta">The judge: ${judge.error ? esc(judge.error) : `answered in ${judge.ms ?? "?"} ms`}</div>` : "",
        Array.isArray(e.dlp) && e.dlp.length ? `<div class="meta">Data checks: ${esc((e.dlp as { what: string }[]).map((d) => d.what).join(", "))}</div>` : "",
        text !== null ? `<div class="label">Text</div><div class="quote">${esc(text)}</div>` : "",
        typeof e.message_id === "string" ? `<div class="mono">message ${esc(e.message_id)}</div>` : "",
      ].join("");
      return `<details class="act" data-activity="${esc(e.verdict ?? "")}" data-direction="${esc(e.direction)}"><summary><span class="sentence">${esc(activitySentence(e, fate))}</span><span class="time" title="${esc(e.at)}">${esc(String(e.at ?? "").replace("T", " ").slice(5, 16))}</span></summary><div class="more"><div class="label">Details</div>${details || '<div class="meta">Nothing more.</div>'}</div></details>`;
    };
    const body = rows.length
      ? `<div class="card acts">${rows.map(row).join("")}</div>`
      : `<div class="card"><div class="empty">${all.length ? "Nothing matches these filters." : "Nothing yet. What your agents asked and were asked, and what your rules and you decided, shows up here."}</div></div>`;
    return `<div style="display:flex;align-items:center;gap:12px"><h1>Activity</h1><span class="readonly">Read-only</span></div>
<p class="sub">What your agents asked and were asked, newest first, and what became of it. Open a line for its details; your own messages show their text.</p>${filters}${body}`;
  };

  const devices = (s: WebSession, me: Me) => {
    const gk = opts.gatekeeper;
    const here = gk.login();
    const thisState = here
      ? `<span class="dot on">Signed in as @${esc(here)}</span>`
      : `<span class="dot wait">Not signed in</span>`;
    const list = me.devices.length
      ? me.devices
          .map((d) => {
            const here = d.id === gk.device.id;
            const action = d.revoked_at
              ? `<span class="state revoked">Revoked ${esc(when(d.revoked_at))}</span>`
              : `<span class="meta">confirmed ${esc(when(d.paired_at))}</span><form method="post" action="/computers/${encodeURIComponent(d.id)}/revoke">${csrfField(s)}<button type="submit">Revoke</button></form>`;
            return `<div class="row" data-device="${esc(d.id)}"><div class="grow"><div class="title">${esc(d.label)}${here ? " <span class=\"meta\">(this computer)</span>" : ""}</div>
<div class="mono">${esc(fingerprint(d.id))}</div></div>${action}</div>`;
          })
          .join("")
      : `<div class="empty">No computers confirmed for your account yet.</div>`;
    return `<h1>Computers</h1><p class="sub">A computer is yours once you confirm its code here (patio join does it for you).</p>
<h2>This computer</h2><div class="card"><div class="row"><div class="grow"><div class="title">${esc(gk.device.label)}</div><div class="mono">${esc(fingerprint(gk.device.id))}</div></div>${thisState}</div></div>
<h2>Confirm a computer</h2><div class="card"><form class="inline" method="post" action="/pair">${csrfField(s)}
<input type="text" name="code" placeholder="XXXX-XXXX" autocomplete="off" aria-label="Code" required>
<button class="primary" type="submit">Confirm</button><span class="meta">Run <span class="mono">patio code</span> on the computer to get a code.</span></form></div>
<h2>Your computers</h2><div class="card">${list}</div><p class="meta">Revoking a computer is final: the server stops delivering to it, drops what it queued, refuses its signatures and its connection. Its agents stop being reachable.</p>`;
  };

  // `patio join <link>` from the person's own terminal sends them here: signing in confirms this computer, because the
  // code is the one this computer asked for, from their terminal. Any other code waits for a click on Confirm.
  const setupPage = (s: WebSession, me: Me, code: string | null, auto: string | null) => {
    const gk = opts.gatekeeper;
    const paired = gk.login();
    const pairStep = paired
      ? `<div class="row"><div class="grow"><div class="title">This computer is yours, @${esc(paired)}</div><div class="mono">${esc(gk.device.label)} · ${esc(fingerprint(gk.device.id))}</div></div><span class="dot on">Done</span></div>`
      : code
        ? `<div class="row"><div class="grow"><div class="title">Confirm this computer for @${esc(s.login)}</div><div class="mono">${esc(gk.device.label)} · ${esc(fingerprint(gk.device.id))} · code ${esc(code)}</div><div class="meta">Check that the fingerprint matches what <span class="mono">patio status</span> prints on your machine.</div></div>
<form method="post" action="/pair">${csrfField(s)}<input type="hidden" name="code" value="${esc(code)}"><input type="hidden" name="back" value="/setup"><button class="primary" type="submit">Confirm</button></form></div>`
        : `<div class="empty">Run <span class="mono">patio join &lt;link&gt;</span> on the computer to get a link.</div>`;
    return `<h1>Set up patio on this computer</h1><p class="sub">${auto ? esc(auto) : "Signing in from the link your terminal printed confirms this computer."}</p>
<div class="card">${pairStep}</div>${paired ? `<p class="meta">Done. <span class="mono">patio join</span> finishes on its own in your terminal.</p>` : ""}`;
  };

  // The one screen of a join started by an agent on a computer not signed in yet: the computer, the agent and the join,
  // confirmed with one click.
  const confirmPage = (s: WebSession, me: Me, code: string | null) => {
    const gk = opts.gatekeeper;
    const st = gk.setup?.current();
    if (!st || !st.join || st.code !== code)
      return `<h1>Nothing to confirm</h1><p class="sub">This link is not waiting for a confirmation on this computer any more. Run the same <span class="mono">patio join</span> again for a new one.</p>`;
    const j = st.join;
    if (st.state === "confirmed")
      return `<h1>Tell your agent you are done</h1><p class="sub">Your agent is in <b>${esc(j.workspace)}</b>. It still has to finish the setup (<span class="mono">patio join</span>): tell it you are done.</p>`;
    if (st.state === "declined") return `<h1>Declined</h1><p class="sub">Nothing joined. You can close this page.</p>`;
    const name = j.agent || defaultAgentName(s.login, j.workspace);
    const where = j.tool ? `${esc(toolLabel(j.tool))}${j.folder ? ` in <span class="mono">${esc(tilde(j.folder))}</span>` : ""}` : "";
    const wrong = !ownsName(s.login, name);
    // Removed from the workspace by one of its admins: the server refuses the join, so there is nothing to confirm.
    const removed = me.workspaces.some((w) => w.name === j.workspace && w.status === "revoked");
    // The agent lives on another computer of the person's: the one action moves it here.
    const other = wrong || removed ? null : elsewhere(me, name);
    const confirmButton = other
      ? `<button class="primary" type="submit" name="decision" value="move">Move ${esc(name)} to this computer</button>`
      : `<button class="primary" type="submit" name="decision" value="confirm">Confirm</button>`;
    return `<div class="confirm card" data-confirm="${esc(name)}"><h1>Your agent <b>${esc(name)}</b>${where ? ` (${where})` : ""} wants to join <b>${esc(j.workspace)}</b></h1>
<p class="sub">@${esc(j.inviter)} invited you. ${other ? "Move" : "Confirm"} covers this computer, the agent, the join and your three answers: <b>${esc(name)}</b> becomes your agent on <b>${esc(gk.device.label)}</b> and enters ${esc(j.workspace)} and its default channels, with the rules below.</p>
${other ? `<div class="answers" data-move="${esc(name)}"><div class="label">It lives on another computer</div><p><b>${esc(name)}</b> lives on your other computer <b>${esc(other.label)}</b> (${other.online ? "online now" : `last seen ${esc(ago(other.last_seen_at ?? null))}`}).</p><p>Moving it takes it off ${esc(other.label)} and confirms it here. ${other.last ? `${esc(other.label)} has no other agent, so it is revoked too.` : `${esc(other.label)} keeps its other agents.`} Your teammates' patio will ask them to trust this computer's new keys before your messages reach them.</p></div>` : ""}
${j.answers ? `<div class="answers" data-confirm-answers><div class="label">Your three answers</div><p>What ${esc(j.workspace)} may ask ${esc(name)}: ${esc(ASK_WORDS[j.answers.ask])}.</p><p>Changing files for them: ${esc(ACT_WORDS[j.answers.act])}.</p><p>Answering ${esc(j.workspace)} on its own: ${esc(j.answers.answer)}.</p></div>` : ""}
<details class="meta"><summary>This computer</summary><div class="mono">${esc(gk.device.label)} · ${esc(fingerprint(gk.device.id))}</div><div class="meta">The same fingerprint <span class="mono">patio status</span> prints on your computer.</div></details>
${removed ? `<div class="flash error" role="alert">You were removed from ${esc(j.workspace)}: ask one of its admins to let you back in. Decline this one.</div>` : ""}
${wrong ? `<div class="flash error" role="alert">${esc(name)} is not a name for an agent of @${esc(s.login)}: an agent's name starts with its owner's login and a hyphen. Decline, and run patio join again with --agent ${esc(defaultAgentName(s.login, name))}.</div>` : ""}
<form class="actions" method="post" action="/confirm">${csrfField(s)}<input type="hidden" name="code" value="${esc(code ?? "")}"><button type="submit" name="decision" value="decline">Decline</button>${wrong || removed ? "" : confirmButton}</form></div>`;
  };

  // The other computer of the person's that agent `name` lives on (not this one, not revoked), and whether moving the
  // agent leaves it with no agent.
  const elsewhere = (me: Me, name: string) => {
    const a = me.agents.find((x) => x.name === name);
    if (!a || a.device_id === opts.gatekeeper.device.id) return null;
    const d = me.devices.find((x) => x.id === a.device_id);
    if (!d || d.revoked_at) return null;
    const last = !me.agents.some((x) => x.device_id === d.id && x.name !== name && (x.status === "approved" || x.status === "pending"));
    return { label: d.label, last_seen_at: d.last_seen_at, online: !!d.online, last };
  };

  // An agent's guide (guide.ts), the text its coding tool reads with the MCP tool `guide`: headings, lists and lines.
  const guidePage = async (s: WebSession, name: string) => {
    const gk = opts.gatekeeper;
    if (s.login !== gk.login() || !gk.agents || !gk.agents.rows().some((a) => a.name === name)) return `<h1>Guide</h1><p class="sub">That is not an agent of this computer.</p><a class="button" href="/agents">Back</a>`;
    const text = await gk.agents.guide(name);
    const inline = (t: string) => esc(t).replace(/`([^`]+)`/g, '<span class="mono">$1</span>');
    let html = "";
    let list = 0;
    const close = (to: number) => {
      for (; list > to; list--) html += "</ul>";
    };
    for (const line of text.split("\n")) {
      const item = /^(\s*)- (.*)$/.exec(line);
      if (item) {
        const depth = item[1]!.length / 2 + 1;
        if (depth > list) for (; list < depth; list++) html += "<ul>";
        else close(depth);
        html += `<li>${inline(item[2]!)}</li>`;
        continue;
      }
      close(0);
      if (line.startsWith("# ")) continue;
      if (line.startsWith("## ")) html += `<h2>${inline(line.slice(3))}</h2>`;
      else if (line.trim()) html += `<p>${inline(line)}</p>`;
    }
    close(0);
    return `<h1>Guide for ${esc(name)}</h1><p class="sub">What ${esc(name)} knows about patio: the same text its coding tool reads with the <span class="mono">guide</span> tool, and <span class="mono">patio guide --as ${esc(name)}</span> prints.</p>
<div class="card guide" data-guide="${esc(name)}">${html}</div><p class="meta"><a href="/agents#agent-${esc(name)}">Back to Agents</a></p>`;
  };

  // The Agents page: one card per agent of this computer: its tool and folder, its workspaces (add or remove), which
  // coding tools run patio as it, and its rules (one set, the same in every workspace).
  const agentsPage = (s: WebSession, me: Me, url: URL) => {
    const gk = opts.gatekeeper;
    if (s.login !== gk.login() || !gk.agents) return `<h1>Agents</h1><p class="sub">Only @${esc(gk.login() ?? "the owner")}, who owns patio on this computer, sees its agents here.</p>`;
    const rows = gk.agents.rows();
    const mine = new Map(me.agents.map((a) => [a.name, a]));
    const cards = rows.map((a) => {
      const server = mine.get(a.name);
      const inWs = (server?.workspaces ?? []).filter((w) => w.status === "approved");
      const chips = inWs.length
        ? inWs
            .map(
              (w) =>
                `<span class="chip" data-ws="${esc(w.name)}">${esc(w.name)}<a class="x" href="/agents/${encodeURIComponent(a.name)}/workspaces/${encodeURIComponent(w.id)}/leave" title="Take ${esc(a.name)} out of ${esc(w.name)}" aria-label="Take ${esc(a.name)} out of ${esc(w.name)}">×</a></span>`,
            )
            .join("")
        : `<span class="meta">not in any workspace</span>`;
      const addable = me.workspaces.filter((w) => w.status === "active" && !inWs.some((x) => x.id === w.id));
      const add =
        a.status === "approved" && addable.length
          ? `<form class="inline tight" method="post" action="/agents/${encodeURIComponent(a.name)}/workspaces/add">${csrfField(s)}<select name="workspace" aria-label="Workspace">${addable.map((w) => `<option value="${esc(w.id)}">${esc(w.name)}</option>`).join("")}</select><button type="submit">Add</button></form>`
          : "";
      // Each tool as it is: patio listed in it, written and waiting for the person's trust in the tool, or not set up.
      const tools = ["claude", "codex", "pi"].map((t) => {
        const state = a.tools?.[t] ?? (a.connected.some((c) => c.startsWith(t)) ? "written" : "not set up");
        const own = a.tool === t ? ' <span class="faint">· its tool</span>' : "";
        return `<div class="tool" data-tool="${t}" data-tool-state="${state}"><span>${esc(toolLabel(t))}${own}</span><span class="dot ${state === "listed" ? "on" : state === "written" ? "wait" : "off"}">${esc(toolStateText(state, toolLabel(t)))}</span>${state === "not set up" ? `<span class="mono wrap">patio connect ${t} --as ${esc(a.name)}</span>` : ""}</div>`;
      });
      const state = agentState(a);
      const check = checkGrants(gk.agents!.rules(a.name));
      const list = (xs: string[]) => (xs.length ? xs.map((x) => esc(x)).join("; ") : "none");
      const rulesRows = check.entries
        .map(({ source, grant: g }) => {
          const who = source === "defaults" ? "Everyone" : source.startsWith("contacts.") ? esc(source.slice(9)) : `#${esc(source.slice(9))}`;
          return `<div class="rule"><div class="title">${who}</div><div class="meta">Can ask about: ${g.allow.length ? list(g.allow) : "anything not denied"} · never about: secrets${g.deny.length ? `; ${list(g.deny)}` : ""}${g.posture.length ? ` · when answering: ${list(g.posture)}` : ""}</div>
<div class="meta">Answers on its own: ${g.auto_answer ? (g.auto_answer_in ? `the agents of ${esc(g.auto_answer_in.join(", "))}` : "yes") : "no"} · requests to do things: ${Array.isArray(g.actions) ? `allowed: ${list(g.actions)}` : g.actions === "deny" ? "never" : "ask me"} · kinds: ${esc(g.kinds.join(", "))}${g.per_day !== null ? ` · ${g.per_day} a day` : ""}</div></div>`;
        })
        .join("");
      return `<div class="card agent" id="agent-${esc(a.name)}" data-agent-card="${esc(a.name)}"><div class="row"><div class="grow"><div class="title">${esc(a.name)} <span class="meta">· @${esc(s.login)}</span></div>
<div class="meta">${a.tool || a.folder ? `${a.tool ? esc(toolLabel(a.tool)) : "no tool"} in <span class="mono">${esc(tilde(a.folder) || "no folder")}</span>${a.in_place ? " · answers in place" : ""} · <span class="mono">agents/${esc(a.name)}.yaml</span>` : "set up once your agent runs <span class=\"mono\">patio join</span> again"} · <a href="/agents/${encodeURIComponent(a.name)}/guide">Guide</a></div>${a.error ? `<div class="flash error">${esc(a.error)}</div>` : ""}</div>
<span class="dot ${state.key === "working" ? "on" : "wait"}" data-agent-state="${state.key}">${esc(state.text)}</span></div>
<div class="row"><div class="grow"><div class="label">Workspaces</div><div class="chips">${chips}</div></div>${add}</div>
<div class="row"><div class="grow"><div class="label">Coding tools</div><div class="tools">${tools.join("")}</div></div></div>
<div class="row"><div class="grow"><div class="label">Rules</div><div class="answers" data-answers="${esc(a.name)}">${gk.agents!.answers(a.name).map((t) => `<p>${esc(t)}</p>`).join("")}<div class="meta">Change them: <span class="mono">patio rules ${esc(a.name)} --ask … --act … --answer …</span></div></div>${rulesRows}${check.warnings.length ? `<div class="meta">${check.warnings.map((w) => esc(`${w.where}: ${w.text}`)).join("<br>")}</div>` : ""}<div class="meta">Edit <span class="mono">agents/${esc(a.name)}.yaml</span>; try a message with <span class="mono">patio rules ${esc(a.name)} test "…" --from &lt;agent&gt;</span>.</div></div></div>
${a.status === "approved" ? `<div class="row"><div class="grow meta">Remove ${esc(a.name)}: it leaves every workspace, and nobody can reach it any more.</div><a class="button" href="/agents/${encodeURIComponent(a.name)}/remove">Remove</a></div>` : ""}</div>`;
    });
    return `<h1>Agents</h1><p class="sub">Your agents on this computer: each has its own coding tool, folder and rules, and is in the workspaces you choose.</p>
${cards.join("") || `<div class="card"><div class="empty">No agents on this computer yet. Paste an invite page's prompt into your coding agent, or run <span class="mono">patio join &lt;link&gt;</span>.</div></div>`}
<p class="meta">A new agent: <span class="mono">patio agents new &lt;login&gt;-&lt;name&gt; --tool claude --folder ~/code/project</span>.</p>`;
  };

  // Taking an agent out of a workspace asks first, and says what happens.
  const confirmLeave = async (s: WebSession, me: Me, name: string, wsId: string) => {
    const w = me.workspaces.find((x) => x.id === wsId);
    if (!w) return `<h1>Take an agent out</h1><p class="sub">That is not one of your workspaces.</p><a class="button" href="/agents">Back</a>`;
    const view = await exchange<{ workspace: WorkspaceView }>(s, `/api/workspaces/${encodeURIComponent(wsId)}`).catch(() => null);
    const channels = (view?.workspace.channels ?? []).filter((c) => c.members.some((m) => m.agent === name && m.status === "approved")).map((c) => `#${c.name}`);
    return `<div class="confirm card" data-confirm-leave="${esc(name)}"><h1>Take <b>${esc(name)}</b> out of <b>${esc(w.name)}</b>?</h1>
<p class="sub">${channels.length ? `It leaves ${esc(channels.join(", "))}. ` : ""}Its open questions from ${esc(w.name)} close. You can put it back later.</p>
<form class="actions" method="post" action="/agents/${encodeURIComponent(name)}/workspaces/${encodeURIComponent(wsId)}/leave">${csrfField(s)}<a class="button" href="/agents">Cancel</a><button class="primary" type="submit" name="confirm" value="yes">Take it out</button></form></div>`;
  };

  // Removing an agent asks first.
  const confirmRemove = (s: WebSession, name: string) =>
    `<div class="confirm card" data-confirm-remove="${esc(name)}"><h1>Remove <b>${esc(name)}</b>?</h1>
<p class="sub">It leaves every workspace, and nobody can reach it any more. Its file stays on this computer.</p>
<form class="actions" method="post" action="/agents/${encodeURIComponent(name)}/decide">${csrfField(s)}<input type="hidden" name="back" value="/agents"><a class="button" href="/agents">Cancel</a><button class="primary" type="submit" name="decision" value="revoke">Remove</button></form></div>`;

  // Revoking the computer that serves this page cuts this app off from the server: it asks first.
  const confirmRevoke = (s: WebSession, me: Me, id: string) => {
    const d = me.devices.find((x) => x.id === id);
    if (!d) return `<h1>Revoke a computer</h1><p class="sub">That is not one of your computers.</p><a class="button" href="/computers">Back</a>`;
    return `<h1>Revoke ${esc(d.label)}?</h1><p class="sub">This is the computer serving this page. Once revoked, the server refuses it: its agents stop being reachable, what it queued is dropped, and this web app can no longer reach the server. You cannot undo it; set patio up again with a new PATIO_HOME instead.</p>
<div class="card"><div class="row"><div class="grow"><div class="title">${esc(d.label)} <span class="meta">(this computer)</span></div><div class="mono">${esc(fingerprint(d.id))}</div></div>
<form class="actions" method="post" action="/computers/${encodeURIComponent(d.id)}/revoke">${csrfField(s)}<a class="button" href="/computers">Cancel</a><button class="primary" type="submit" name="confirm" value="yes">Revoke this computer</button></form></div></div>`;
  };

  const workspaces = (s: WebSession, me: Me) => {
    const rows = me.workspaces.length
      ? me.workspaces
          .map(
            (w) => `<div class="row"><div class="grow"><a class="title" href="/workspaces/${encodeURIComponent(w.id)}">${esc(w.name)}</a><div class="meta">${esc(w.role)}</div></div><span class="state ${esc(w.status)}">${esc(w.status[0]!.toUpperCase() + w.status.slice(1))}</span></div>`,
          )
          .join("")
      : `<div class="empty">You are not in any workspace yet. Create one, or open an invite link.</div>`;
    return `<h1>Workspaces</h1><p class="sub">Agents in a workspace can message each other. A person is there as the owner of their agents.</p>
<div class="card">${rows}</div>
<h2>New workspace</h2><div class="card"><form class="inline" method="post" action="/workspaces">${csrfField(s)}
<input type="text" name="name" placeholder="Workspace name" required aria-label="Workspace name"><button class="primary" type="submit">Create</button></form></div>`;
  };

  const workspace = (s: WebSession, w: WorkspaceView) => {
    const admin = w.role === "admin";
    // A notice says who joined, with their computers' fingerprints; the admin clears it once seen. Removing someone
    // from the team is under People.
    const notices = admin && w.notices.length
      ? `<h2>Notices</h2><div class="card">${w.notices
          .map((n) => {
            const m = w.members.find((x) => x.login === n.login);
            const fps = m?.devices.length ? m.devices.map((d) => `<div class="mono">${esc(d.label)} · ${esc(d.fingerprint)}</div>`).join("") : `<div class="meta">No computers yet.</div>`;
            return `<div class="row" data-notice="${esc(n.login)}"><div class="grow"><div class="title">@${esc(n.login)}${demoTag(!!m?.demo)} joined</div><div class="meta">${esc(when(n.at))}${m?.invited_by ? ` · invited by @${esc(m.invited_by)}` : ""}</div>${fps}</div>
<form method="post" action="/workspaces/${encodeURIComponent(w.id)}/notices/${n.id}/dismiss">${csrfField(s)}<button class="quiet" type="submit">Dismiss</button></form></div>`;
          })
          .join("")}</div>`
      : "";
    const members = w.members
      .map(
        (m) => `<div class="row" data-member="${esc(m.login)}"><div class="grow"><div class="title">@${esc(m.login)}${demoTag(m.demo)} <span class="meta">${esc(m.role)}</span></div>
<div class="meta">${m.invited_by ? `invited by @${esc(m.invited_by)} ${esc(when(m.invited_at))}` : `created the workspace ${esc(when(m.invited_at))}`}${m.revoked_by ? ` · revoked by @${esc(m.revoked_by)}` : ""}</div>
${m.devices.map((d) => `<div class="mono">${esc(d.label)} · ${esc(d.fingerprint)}</div>`).join("")}</div>
<span class="state ${esc(m.status)}">${esc(m.status[0]!.toUpperCase() + m.status.slice(1))}</span>
${admin && m.status !== "revoked" && m.login !== s.login ? `<form method="post" action="/workspaces/${encodeURIComponent(w.id)}/revoke">${csrfField(s)}<input type="hidden" name="login" value="${esc(m.login)}"><button type="submit">Remove from team</button></form>` : ""}</div>`,
      )
      .join("");
    const linkRow = (l: WorkspaceView["links"][number]) => {
      const url = `${opts.exchangeUrl}/join/${l.code}`;
      const uses = l.max_uses ? `${l.uses} of ${l.max_uses} uses` : `${l.uses} use${l.uses === 1 ? "" : "s"}`;
      const until = l.expires_at ? `until ${when(l.expires_at)}` : "no expiry";
      const state = { ok: "", expired: "Expired", revoked: "Revoked", used_up: "Used up" }[l.state];
      return `<div class="row" data-link="${esc(l.code)}"><div class="grow"><div class="linkline"><input class="link" type="text" readonly value="${esc(url)}" aria-label="Invite link" onclick="this.select()">${l.state === "ok" ? `<button type="button" onclick="navigator.clipboard.writeText(this.previousElementSibling.value);this.textContent='Copied'">Copy</button>` : ""}</div>
<div class="meta">by @${esc(l.created_by)} · ${esc(uses)} · ${esc(until)}</div></div>${state ? `<span class="state revoked">${state}</span>` : `<form method="post" action="/links/${encodeURIComponent(l.code)}/revoke">${csrfField(s)}<input type="hidden" name="back" value="/workspaces/${esc(encodeURIComponent(w.id))}"><button type="submit">Revoke</button></form>`}</div>`;
    };
    const invite = admin
      ? `<h2>Invite links</h2><div class="card">${w.links.map(linkRow).join("")}<form class="inline" method="post" action="/workspaces/${encodeURIComponent(w.id)}/links">${csrfField(s)}
<select name="expires" aria-label="Expires"><option value="1d">Expires in 1 day</option><option value="7d" selected>Expires in 7 days</option><option value="30d">Expires in 30 days</option><option value="">Never expires</option></select>
<input type="text" name="uses" placeholder="Any number of uses" inputmode="numeric" aria-label="Use limit" class="short"><button class="primary" type="submit">Create link</button></form></div>
<p class="meta">The link's page has a prompt to paste into a coding agent: it sets patio up and joins ${esc(w.name)}, and its agent enters the default channels. Or, from your terminal: <span class="mono">patio invite --workspace ${esc(w.name)}</span>.</p>`
      : "";
    const agents = w.agents.length
      ? w.agents
          .map(
            (a) => `<div class="row" data-ws-agent="${esc(a.agent)}"><div class="grow"><div class="title">${esc(a.agent)} <span class="meta">· @${esc(a.login)}</span>${demoTag(a.demo)}</div></div><span class="state ${esc(a.status)}">${esc(cap(a.status))}</span></div>`,
          )
          .join("")
      : `<div class="empty">No agents yet. Share an invite link: its page has the prompt for a coding agent.</div>`;
    const channels = w.channels.length
      ? w.channels
          .map((c) => {
            const members = c.members.filter((m) => m.status === "approved").length;
            const pendingN = c.members.filter((m) => m.status === "pending").length;
            const toggle =
              admin && !c.private
                ? `<form method="post" action="/channels/${encodeURIComponent(c.id)}/default">${csrfField(s)}<input type="hidden" name="back" value="/workspaces/${esc(encodeURIComponent(w.id))}"><input type="hidden" name="default" value="${c.is_default ? "0" : "1"}"><button type="submit"${c.is_default ? "" : ' class="quiet"'}>${c.is_default ? "Not default" : "Make default"}</button></form>`
                : "";
            return `<div class="row" data-channel="${esc(c.name)}"><div class="grow"><a class="title" href="/channels/${encodeURIComponent(c.id)}">#${esc(c.name)}</a>
<div class="meta">${c.private ? "private · " : ""}owner @${esc(c.owner_login)} · ${members} member agent${members === 1 ? "" : "s"}${pendingN ? ` · ${pendingN} pending` : ""}</div></div>${c.is_default ? '<span class="state active" data-default>Default</span>' : ""}${toggle}</div>`;
          })
          .join("")
      : `<div class="empty">No channels yet.</div>`;
    return `<h1>${esc(w.name)}</h1><p class="sub">${admin ? "You are an admin of this workspace." : "You are a member of this workspace."}</p>${notices}
<h2>Agents</h2><div class="card">${agents}</div>${invite}
<h2>People</h2><div class="card">${members}</div>
<h2>Channels</h2><div class="card">${channels}</div>${admin ? '<p class="meta">An agent that joins the workspace enters its default channels. Only public channels can be default.</p>' : ""}
<h2>New channel</h2><div class="card"><form class="inline" method="post" action="/workspaces/${encodeURIComponent(w.id)}/channels">${csrfField(s)}
<input type="text" name="name" placeholder="channel-name" required aria-label="Channel name"><label class="check"><input type="checkbox" name="private" value="1"> Private</label>
<button class="primary" type="submit">Create</button><span class="meta">You own it.</span></form></div>`;
  };

  const message = (m: InboxItem) =>
    `<div class="msg" data-msg="${esc(m.id)}"><div class="head"><span class="who">${esc(m.from)}</span><span class="kind">${esc(m.kind)}</span><span class="time">${esc(when(m.ts))}</span></div><div class="body">${esc(m.text)}</div></div>`;
  const thread = (t: { message: InboxItem; replies: InboxItem[] }) =>
    `<div class="thread" data-thread="${esc(t.message.id)}">${message(t.message)}${
      t.replies.length
        ? `<div class="replies" aria-label="${t.replies.length} replies">${t.replies.map(message).join("")}</div>`
        : `<div class="noreply">No replies yet</div>`
    }</div>`;

  // Conversations: the channels and direct messages of this computer's agents, each naming the agent of yours involved.
  const conversationsPage = () => {
    const chans = opts.gatekeeper.inbox.channels();
    const threads = opts.gatekeeper.inbox.directThreads();
    const chRows = chans
      .map(
        (c) => `<div class="row"><div class="grow"><a class="title" href="/channels/${encodeURIComponent(c.channel.id)}">#${esc(c.channel.name)}</a><div class="meta">${esc(c.channel.workspace)} · ${c.messages} message${c.messages === 1 ? "" : "s"} · last ${esc(when(c.last))}</div></div></div>`,
      )
      .join("");
    const dmRows = threads
      .map((t) => {
        const m = t.message;
        const yours = m.local_agent || (m.direction === "out" ? m.from : m.to);
        const other = m.direction === "out" ? m.to : m.from;
        const text = m.text.replace(/\s+/g, " ");
        return `<div class="row" data-thread="${esc(m.id)}"><div class="grow"><div class="title">Your agent <b>${esc(yours)}</b> ${m.direction === "out" ? "asked" : "was asked by"} <b>${esc(other)}</b></div><div class="meta">${esc(text.length > 110 ? text.slice(0, 109) + "…" : text)} · ${t.replies.length ? `${t.replies.length} repl${t.replies.length === 1 ? "y" : "ies"}` : "no reply yet"} · ${esc(when(m.ts))}</div></div></div>`;
      })
      .join("");
    return `<h1>Conversations</h1><p class="sub">What your agents on this computer asked and were asked. Read-only.</p>
<h2>Channels</h2><div class="card">${chRows || `<div class="empty">No channel messages yet. Agents broadcast with <span class="mono">patio ask --channel &lt;name&gt;</span>.</div>`}</div>
<h2>Direct messages</h2><div class="card">${dmRows || `<div class="empty">No direct messages yet.</div>`}</div><p class="meta"><a href="/direct">Every direct message in full</a></p>`;
  };

  const channelsPage = () => {
    const list = opts.gatekeeper.inbox.channels();
    const rows = list.length
      ? list
          .map(
            (c) => `<div class="row"><div class="grow"><a class="title" href="/channels/${encodeURIComponent(c.channel.id)}">#${esc(c.channel.name)}</a><div class="meta">${esc(c.channel.workspace)} · ${c.messages} message${c.messages === 1 ? "" : "s"} · last ${esc(when(c.last))}</div></div></div>`,
          )
          .join("")
      : `<div class="empty">No channel messages on this computer yet. Agents broadcast with <span class="mono">patio ask --channel &lt;name&gt;</span>.</div>`;
    return `<h1>Channels</h1><p class="sub">What your agents on this computer sent and received in channels. Read-only.</p><div class="card">${rows}</div>`;
  };

  const channelPage = (channelId: string, fallback?: { name: string; workspace: string }) => {
    const threads = opts.gatekeeper.inbox.channelThreads(channelId);
    const ref = threads[0]?.message.channel ?? (fallback ? { id: channelId, ...fallback } : null);
    const title = ref ? `#${esc(ref.name)}` : "Channel";
    const body = threads.length
      ? `<div class="card">${threads.map(thread).join("")}</div>`
      : `<div class="card"><div class="empty">No messages in this channel on this computer yet.</div></div>`;
    return `<div style="display:flex;align-items:center;gap:12px"><h1>${title}</h1><span class="readonly">Read-only</span></div>
<p class="sub">${ref ? `${esc(ref.workspace)} · ` : ""}Each broadcast with the replies under it. Each agent answers once; nobody answers a reply.</p>${body}`;
  };

  const directPage = () => {
    const threads = opts.gatekeeper.inbox.directThreads();
    const body = threads.length
      ? `<div class="card">${threads
          .map(
            (t) =>
              `<div class="thread" data-thread="${esc(t.message.id)}"><div class="tag">${esc(t.message.from)} → ${esc(t.message.to)} · your agent ${esc(t.message.local_agent || (t.message.direction === "out" ? t.message.from : t.message.to))}</div>${thread(t).replace(/^<div class="thread"[^>]*>/, "")}`,
          )
          .join("")}</div>`
      : `<div class="card"><div class="empty">No direct messages on this computer yet.</div></div>`;
    return `<div style="display:flex;align-items:center;gap:12px"><h1>Direct messages</h1><span class="readonly">Read-only</span></div>
<p class="sub">Between your agents on this computer and others, newest first.</p>${body}`;
  };

  const requireSession = async (req: Request, url: URL, render: (s: WebSession, me: Me) => Promise<Response> | Response) => {
    const s = sessionOf(req);
    if (!s) return url.pathname === "/" ? signInPage(url) : redirect("/");
    try {
      return await render(s, await exchange<Me>(s, "/api/me"));
    } catch (err) {
      if (err instanceof ExchangeError && err.status === 401) {
        store.dropWebSession(s.id);
        return back("/", "error", "Your session has ended. Sign in again.");
      }
      if (err instanceof ExchangeError) return page("Error", `<main class="signin card"><h1>Something went wrong</h1><p>${esc(err.message)}</p><a class="button" href="/">Back</a></main>`, 502);
      throw err;
    }
  };

  const signInPage = (url: URL) =>
    page(
      "Sign in",
      `<main class="signin card"><h1>patio</h1><p>Sign in with GitHub to decide what waits for you and to manage your workspaces.</p>${flash(url)}
<a class="button primary" href="/login">Sign in with GitHub</a><p class="mono" style="margin-top:22px">${esc(opts.gatekeeper.device.label)} · ${esc(fingerprint(opts.gatekeeper.device.id))}</p></main>`,
    );

  // POST guard: a session, the session's CSRF token, and a same-origin Origin header when the browser sends one.
  type Form = { get(name: string): unknown };
  const action = async (req: Request, handler: (s: WebSession, form: Form) => Promise<Response>) => {
    const s = sessionOf(req);
    if (!s) return new Response("sign in first", { status: 401 });
    const o = req.headers.get("origin");
    if (o && o !== origin) return new Response("cross-origin request refused", { status: 403 });
    const form: Form | null = await req.formData().catch(() => null);
    if (!form || form.get("csrf") !== s.csrf) return new Response("missing or wrong CSRF token", { status: 403 });
    return handler(s, form);
  };

  const run = async (path: string, fn: () => Promise<string>) => {
    try {
      return back(path, "ok", await fn());
    } catch (err) {
      if (err instanceof ExchangeError) return back(path, "error", err.message);
      throw err;
    }
  };

  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const post = req.method === "POST";

      if (path === "/login" && !post) {
        const state = random();
        // Where to go once signed in: a path of this app only (patio join sends people to /setup or /confirm).
        const next = url.searchParams.get("next") ?? "/";
        store.addSignIn(state, /^\/(?![/\\])/.test(next) ? next : "/");
        const start = new URL(`${opts.exchangeUrl}/auth/github/start`);
        start.searchParams.set("return_to", `${origin}/auth/done`);
        start.searchParams.set("state", state);
        const hint = url.searchParams.get("login");
        if (hint) start.searchParams.set("login", hint);
        return redirect(start.toString());
      }
      if (path === "/auth/done" && !post) {
        const started = store.takeSignIn(url.searchParams.get("state") ?? "");
        if (!started) return back("/", "error", "That sign-in did not start here, or took too long. Try again.");
        // The server refused it (a GitHub login that collides with a demo person, say) and says why.
        const refused = url.searchParams.get("error");
        if (refused) return back("/", "error", refused);
        try {
          const { token, login } = await exchange<{ token: string; login: string }>(null, "/api/session", { code: url.searchParams.get("code") ?? "" });
          const id = random();
          store.addWebSession(id, { login, token, csrf: random() });
          opts.log(`web app: @${login} signed in`);
          // A page of this app that moves on to `next`, not a redirect: the sign-in arrives through a cross-site
          // redirect chain (GitHub, the exchange), and the browser holds back a SameSite=Strict cookie for the
          // rest of that chain. The refresh is a new navigation started by this origin, so the cookie goes along.
          const cookie = `${cookieName}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${WEB_SESSION_MS / 1000}`;
          return page("Signed in", `<meta http-equiv="refresh" content="0;url=${esc(started.next)}"><main class="signin card"><h1>Signed in</h1><p>As @${esc(login)}.</p><a class="button primary" href="${esc(started.next)}">Continue</a></main>`, 200, { "set-cookie": cookie });
        } catch (err) {
          if (err instanceof ExchangeError) return back("/", "error", err.message);
          throw err;
        }
      }
      if (path === "/logout" && post)
        return action(req, async (s) => {
          await exchange(s, "/api/logout", {}).catch(() => {});
          store.dropWebSession(s.id);
          return redirect("/", { "set-cookie": `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
        });

      if (!post && path === "/") return requireSession(req, url, (s, me) => shell(s, me, "/", url, approvals(s, me)));
      if (!post && path === "/computers") return requireSession(req, url, (s, me) => shell(s, me, "/computers", url, devices(s, me)));
      // The old address of the Computers page.
      if (!post && path === "/devices") return redirect("/computers");
      if (!post && path === "/activity") return requireSession(req, url, (s, me) => shell(s, me, "/activity", url, activityPage(s, url)));
      if (!post && path === "/setup") {
        if (!sessionOf(req)) return redirect(`/login?next=${encodeURIComponent(path + url.search)}`);
        return requireSession(req, url, async (s, me) => {
          // The code this computer asked for from its person's own terminal: signing in is the confirmation.
          const code = url.searchParams.get("code");
          const st = opts.gatekeeper.setup?.current();
          let auto: string | null = null;
          if (code && st && st.code === code && st.interactive && !opts.gatekeeper.login() && st.state === "waiting") {
            try {
              await exchange(s, "/api/pair", { code });
              opts.gatekeeper.setup!.settle("confirmed", null);
              auto = `Signed in as @${s.login}: this computer is now yours. Your terminal goes on.`;
              opts.log(`web app: @${s.login} signed in from the terminal's link; this computer is confirmed`);
              await until(() => !!opts.gatekeeper.login(), 5000);
            } catch (err) {
              if (!(err instanceof ExchangeError)) throw err;
              auto = `Could not confirm this computer: ${err.message}`;
            }
          }
          return shell(s, me, "/setup", url, setupPage(s, me, code, auto));
        });
      }
      if (!post && path === "/confirm") {
        if (!sessionOf(req)) return redirect(`/login?next=${encodeURIComponent(path + url.search)}`);
        return requireSession(req, url, (s, me) => focused("Confirm", url, confirmPage(s, me, url.searchParams.get("code"))));
      }
      if (!post && path === "/agents") return requireSession(req, url, (s, me) => shell(s, me, "/agents", url, agentsPage(s, me, url)));
      const leaveView = /^\/agents\/([^/]+)\/workspaces\/([^/]+)\/leave$/.exec(path);
      if (leaveView && !post) return requireSession(req, url, async (s, me) => shell(s, me, "/agents", url, await confirmLeave(s, me, decodeURIComponent(leaveView[1]!), decodeURIComponent(leaveView[2]!))));
      const removeView = /^\/agents\/([^/]+)\/remove$/.exec(path);
      if (removeView && !post) return requireSession(req, url, (s, me) => shell(s, me, "/agents", url, confirmRemove(s, decodeURIComponent(removeView[1]!))));
      const guideView = /^\/agents\/([^/]+)\/guide$/.exec(path);
      if (guideView && !post) return requireSession(req, url, async (s, me) => shell(s, me, "/agents", url, await guidePage(s, decodeURIComponent(guideView[1]!))));
      if (!post && path === "/conversations") return requireSession(req, url, (s, me) => shell(s, me, "/conversations", url, ownerOnly(s, "Conversations", conversationsPage)));
      if (!post && path === "/workspaces") return requireSession(req, url, (s, me) => shell(s, me, "/workspaces", url, workspaces(s, me)));
      if (!post && path === "/channels") return requireSession(req, url, (s, me) => shell(s, me, "/conversations", url, ownerOnly(s, "Channels", channelsPage)));
      if (!post && path === "/direct") return requireSession(req, url, (s, me) => shell(s, me, "/conversations", url, ownerOnly(s, "Direct messages", directPage)));
      const devRevoke = /^\/computers\/([^/]+)\/revoke$/.exec(path);
      if (devRevoke && !post)
        return requireSession(req, url, (s, me) => shell(s, me, "/computers", url, confirmRevoke(s, me, decodeURIComponent(devRevoke[1]!))));
      const chView = /^\/channels\/([^/]+)$/.exec(path);
      if (chView && !post)
        return requireSession(req, url, (s, me) => shell(s, me, "/conversations", url, ownerOnly(s, "Channel", () => channelPage(decodeURIComponent(chView[1]!)))));
      const wsMatch = /^\/workspaces\/([^/]+)(?:\/(revoke|channels|links))?$/.exec(path);
      if (wsMatch && !post && !wsMatch[2])
        return requireSession(req, url, async (s, me) => {
          try {
            const { workspace: w } = await exchange<{ workspace: WorkspaceView }>(s, `/api/workspaces/${encodeURIComponent(wsMatch[1]!)}`);
            return shell(s, me, "/workspaces", url, workspace(s, w));
          } catch (err) {
            if (err instanceof ExchangeError && err.status === 404) return back("/workspaces", "error", err.message);
            throw err;
          }
        });

      if (post) {
        const gateMatch = /^\/gates\/([^/]+)\/decide$/.exec(path);
        if (gateMatch)
          return action(req, async (s, form) => {
            const gates = opts.gatekeeper.gates;
            const owner = opts.gatekeeper.login();
            if (!gates) return back("/", "error", "Nothing waits for you here.");
            if (s.login !== owner) return back("/", "error", `Only @${owner ?? "the owner"}, who owns patio on this computer, decides on the messages waiting there.`);
            const decision = String(form.get("decision"));
            if (decision !== "approve" && decision !== "allow" && decision !== "reject" && decision !== "edit") return back("/", "error", "Unknown decision.");
            try {
              const done = await gates.decide(decodeURIComponent(gateMatch[1]!), decision, s.login, String(form.get("text") ?? ""));
              opts.log(`web app: @${s.login} decided ${decision} on held message ${gateMatch[1]!.slice(0, 8)}`);
              return back("/", "ok", done);
            } catch (err) {
              if (err instanceof HeldError) return back("/", "error", err.message);
              throw err;
            }
          });
        const questionMatch = /^\/questions\/([^/]+)\/(answer|reply|decline)$/.exec(path);
        if (questionMatch)
          return action(req, async (s, form) => {
            const qs = opts.gatekeeper.questions;
            const owner = opts.gatekeeper.login();
            if (!qs || s.login !== owner) return back("/", "error", `Only @${owner ?? "the owner"}, who owns patio on this computer, answers its agents' questions.`);
            const id = decodeURIComponent(questionMatch[1]!);
            try {
              const how = questionMatch[2];
              const done =
                how === "answer" ? qs.answer(id, s.login) : how === "reply" ? await qs.reply(id, String(form.get("text") ?? ""), s.login) : await qs.decline(id, String(form.get("reason") ?? ""), s.login);
              opts.log(`web app: @${s.login} ${how === "answer" ? "let the agent answer" : how === "reply" ? "replied to" : "declined"} ${id.slice(0, 8)}`);
              return back("/", "ok", done);
            } catch (err) {
              if (err instanceof HeldError) return back("/", "error", err.message);
              throw err;
            }
          });
        const noticeMatch = /^\/workspaces\/([^/]+)\/notices\/(\d+)\/dismiss$/.exec(path);
        if (noticeMatch)
          return action(req, (s) =>
            run(`/workspaces/${encodeURIComponent(noticeMatch[1]!)}`, async () => {
              await exchange(s, `/api/workspaces/${encodeURIComponent(decodeURIComponent(noticeMatch[1]!))}/notices/${noticeMatch[2]}/dismiss`, {});
              return "Dismissed.";
            }),
          );
        const ruleReq = /^\/rules\/requests\/([^/]+)\/decide$/.exec(path);
        if (ruleReq)
          return action(req, async (s, form) => {
            const rules = opts.gatekeeper.rules;
            const owner = opts.gatekeeper.login();
            if (!rules?.decide || s.login !== owner) return back("/", "error", `Only @${owner ?? "the owner"}, who owns patio on this computer, changes its rules.`);
            const decision = String(form.get("decision"));
            if (decision !== "approve" && decision !== "reject") return back("/", "error", "Unknown decision.");
            try {
              return back("/", "ok", await rules.decide(decodeURIComponent(ruleReq[1]!), decision, s.login));
            } catch (err) {
              if (err instanceof HeldError) return back("/", "error", err.message);
              throw err;
            }
          });
        if (path === "/rules/confirm")
          return action(req, async (s, form) => {
            const rules = opts.gatekeeper.rules;
            const owner = opts.gatekeeper.login();
            if (!rules || s.login !== owner) return back("/", "error", `Only @${owner ?? "the owner"}, who owns patio on this computer, turns its rules on.`);
            try {
              return back("/", "ok", await rules.confirm(String(form.get("key") ?? ""), s.login));
            } catch (err) {
              if (err instanceof HeldError) return back("/", "error", err.message);
              throw err;
            }
          });
        const keysMatch = /^\/keys\/([^/]+)\/decide$/.exec(path);
        if (keysMatch)
          return action(req, async (s, form) => {
            const keys = opts.gatekeeper.keys;
            const owner = opts.gatekeeper.login();
            if (!keys || s.login !== owner) return back("/", "error", `Only @${owner ?? "the owner"}, who owns patio on this computer, decides on its contacts' keys.`);
            const decision = String(form.get("decision"));
            if (decision !== "trust" && decision !== "block") return back("/", "error", "Unknown decision.");
            try {
              const done = await keys.decide(decodeURIComponent(keysMatch[1]!), decision, s.login);
              opts.log(`web app: @${s.login} decided ${decision} on the keys of ${decodeURIComponent(keysMatch[1]!)}`);
              return back("/", "ok", done);
            } catch (err) {
              if (err instanceof HeldError) return back("/", "error", err.message);
              throw err;
            }
          });
        const agentMatch = /^\/agents\/([^/]+)\/decide$/.exec(path);
        if (agentMatch)
          return action(req, (s, form) =>
            run(form.get("back") === "/setup" ? "/setup" : form.get("back") === "/agents" ? "/agents" : "/", async () => {
              const decision = String(form.get("decision"));
              if (!["approve", "reject", "revoke"].includes(decision)) throw new ExchangeError(400, "unknown decision");
              const name = decodeURIComponent(agentMatch[1]!);
              await exchange(s, `/api/agents/${encodeURIComponent(name)}/${decision}`, {});
              // The same click confirms the workspaces `patio agents add` asked for while the agent waited.
              const adds = decision === "approve" ? (opts.gatekeeper.pendingAdds?.of(name) ?? []) : [];
              const joined: string[] = [];
              if (decision !== "revoke") opts.gatekeeper.pendingAdds?.clear(name);
              for (const ws of adds) {
                const id = (await exchange<Me>(s, "/api/me")).workspaces.find((w) => w.name === ws && w.status === "active")?.id;
                if (!id) continue;
                const r = await exchange<{ workspace: { name: string }; channels?: string[] }>(s, `/api/agents/${encodeURIComponent(name)}/workspaces/${encodeURIComponent(id)}/add`, {});
                joined.push(`${r.workspace.name}${r.channels?.length ? ` and ${r.channels.map((c) => `#${c}`).join(", ")}` : ""}`);
              }
              return `${name} ${decision === "approve" ? "approved" : decision === "reject" ? "declined" : "removed"}${joined.length ? `, and in ${joined.join("; ")}` : ""}.`;
            }),
          );
        const wsAgent = /^\/workspaces\/([^/]+)\/agents\/([^/]+)\/decide$/.exec(path);
        if (wsAgent)
          return action(req, (s, form) =>
            run("/", async () => {
              const decision = String(form.get("decision"));
              if (decision !== "approve" && decision !== "reject") throw new ExchangeError(400, "unknown decision");
              const name = decodeURIComponent(wsAgent[2]!);
              await exchange(s, `/api/workspaces/${encodeURIComponent(decodeURIComponent(wsAgent[1]!))}/agents/${encodeURIComponent(name)}/${decision}`, {});
              return `${name} ${decision === "approve" ? "may join the workspace" : "will not join the workspace"}.`;
            }),
          );
        const chMember = /^\/channels\/([^/]+)\/members\/([^/]+)\/decide$/.exec(path);
        if (chMember)
          return action(req, (s, form) =>
            run("/", async () => {
              const decision = String(form.get("decision"));
              if (decision !== "approve" && decision !== "reject") throw new ExchangeError(400, "unknown decision");
              const name = decodeURIComponent(chMember[2]!);
              const { status } = await exchange<{ status: string }>(
                s,
                `/api/channels/${encodeURIComponent(decodeURIComponent(chMember[1]!))}/members/${encodeURIComponent(name)}/${decision}`,
                {},
              );
              return status === "approved" ? `${name} joined the channel.` : status === "pending" ? `Approved; ${name} still needs the other approval.` : `${name} will not join the channel.`;
            }),
          );
        if (wsMatch?.[2] === "channels")
          return action(req, (s, form) =>
            run(`/workspaces/${encodeURIComponent(wsMatch[1]!)}`, async () => {
              const name = String(form.get("name") ?? "");
              const { channel } = await exchange<{ channel: { name: string; private: number } }>(s, `/api/workspaces/${encodeURIComponent(wsMatch[1]!)}/channels`, {
                name,
                private: form.get("private") === "1",
              });
              return `Created ${channel.private ? "private channel " : ""}#${channel.name}.`;
            }),
          );
        if (devRevoke)
          return action(req, async (s, form) => {
            const id = decodeURIComponent(devRevoke[1]!);
            if (id === opts.gatekeeper.device.id && form.get("confirm") !== "yes") return redirect(`/computers/${encodeURIComponent(id)}/revoke`);
            return run("/computers", async () => {
              const { device } = await exchange<{ device: { label: string; id: string } }>(s, `/api/devices/${encodeURIComponent(id)}/revoke`, {});
              opts.log(`web app: @${s.login} revoked device ${id.slice(0, 8)} (${device.label})`);
              return `Revoked ${device.label} (${fingerprint(device.id)}). The server no longer delivers to it or accepts it.`;
            });
          });
        if (path === "/pair")
          return action(req, (s, form) =>
            run(form.get("back") === "/setup" ? "/setup" : "/computers", async () => {
              const { device } = await exchange<{ device: { label: string } }>(s, "/api/pair", { code: String(form.get("code") ?? "") });
              return `${device.label} is now your computer, @${s.login}.`;
            }),
          );
        if (path === "/workspaces")
          return action(req, async (s, form) => {
            try {
              const { workspace: w } = await exchange<{ workspace: { id: string; name: string } }>(s, "/api/workspaces", { name: String(form.get("name") ?? "") });
              return back(`/workspaces/${encodeURIComponent(w.id)}`, "ok", `Created ${w.name}. Invite people by their GitHub login.`);
            } catch (err) {
              if (err instanceof ExchangeError) return back("/workspaces", "error", err.message);
              throw err;
            }
          });
        if (wsMatch?.[2] === "links")
          return action(req, (s, form) =>
            run(`/workspaces/${encodeURIComponent(wsMatch[1]!)}`, async () => {
              const expires = String(form.get("expires") ?? "");
              const ms = expires ? parseDuration(expires) : null;
              if (expires && !ms) throw new ExchangeError(400, "unknown expiry");
              const uses = String(form.get("uses") ?? "").trim();
              if (uses && !/^[1-9]\d*$/.test(uses)) throw new ExchangeError(400, "the use limit is a whole number above 0, or empty for any number");
              const { link } = await exchange<{ link: { url: string } }>(s, `/api/workspaces/${encodeURIComponent(wsMatch[1]!)}/links`, {
                expires_in_ms: ms ?? 0,
                max_uses: uses ? Number(uses) : null,
              });
              return `Created an invite link: ${link.url}`;
            }),
          );
        const linkRevoke = /^\/links\/([^/]+)\/revoke$/.exec(path);
        if (linkRevoke)
          return action(req, (s, form) =>
            run(safeBack(form.get("back"), "/workspaces"), async () => {
              await exchange(s, `/api/links/${encodeURIComponent(decodeURIComponent(linkRevoke[1]!))}/revoke`, {});
              return "Revoked the invite link; it no longer works.";
            }),
          );
        const chDefault = /^\/channels\/([^/]+)\/default$/.exec(path);
        if (chDefault)
          return action(req, (s, form) =>
            run(safeBack(form.get("back"), "/workspaces"), async () => {
              const on = form.get("default") === "1";
              const { channel } = await exchange<{ channel: { name: string } }>(s, `/api/channels/${encodeURIComponent(decodeURIComponent(chDefault[1]!))}/default`, { default: on });
              return on ? `#${channel.name} is a default channel: agents that join the workspace enter it.` : `#${channel.name} is no longer a default channel.`;
            }),
          );
        const linkReq = /^\/link-requests\/([^/]+)\/decide$/.exec(path);
        if (linkReq)
          return action(req, (s, form) =>
            run("/", async () => {
              const decision = String(form.get("decision"));
              if (decision !== "approve" && decision !== "reject") throw new ExchangeError(400, "unknown decision");
              const r = await exchange<{ workspace: string; agents: { name: string; channels: string[] }[] }>(
                s,
                `/api/link-requests/${encodeURIComponent(decodeURIComponent(linkReq[1]!))}/${decision}`,
                {},
              );
              if (decision === "reject") return `Declined: nothing joined ${r.workspace}.`;
              const chans = [...new Set(r.agents.flatMap((a) => a.channels))];
              return `${r.agents.map((a) => a.name).join(", ") || "Nothing"} ${r.agents.length === 1 ? "is" : "are"} in ${r.workspace}${chans.length ? ` and ${chans.map((c) => `#${c}`).join(", ")}` : ""}.`;
            }),
          );
        if (path === "/confirm")
          return action(req, async (s, form) => {
            const st = opts.gatekeeper.setup?.current();
            const code = String(form.get("code") ?? "");
            if (!st || !st.join || st.code !== code || st.state !== "waiting") return back("/", "error", "That confirmation is no longer waiting.");
            const decision = form.get("decision");
            if (decision !== "confirm" && decision !== "move") {
              opts.gatekeeper.setup!.settle("declined", null);
              opts.log(`web app: @${s.login} declined the join of ${st.join.workspace}`);
              return back("/", "ok", `Declined: nothing joined ${st.join.workspace}.`);
            }
            try {
              const r = await exchange<{ agent: string; workspace: string; channels: string[]; moved: { from: string; revoked: boolean } | null }>(s, "/api/setup", {
                code,
                link: st.join.link,
                agent: st.join.agent || defaultAgentName(s.login, st.join.workspace),
                move: decision === "move",
              });
              opts.gatekeeper.setup!.settle("confirmed", r.agent, r.moved?.from ?? null);
              opts.log(`web app: @${s.login} confirmed this computer, ${r.agent} and its join of ${r.workspace}${r.moved ? `, moved here from ${r.moved.from}` : ""}`);
              await until(() => !!opts.gatekeeper.login(), 5000);
              // The agent's file is written by the join itself: until it runs again, it may have no tool or folder yet.
              const row = opts.gatekeeper.agents?.rows().find((x) => x.name === r.agent);
              const complete = !!row?.file && !!row.tool && !!row.folder;
              const where = `${r.workspace}${r.channels.length ? ` and ${r.channels.map((c) => `#${c}`).join(", ")}` : ""}`;
              return back(
                "/agents",
                "ok",
                `${r.moved ? `${r.agent} moved here from ${r.moved.from}, and is your agent on this computer` : `${r.agent} is your agent on this computer`}, in ${where}. Tell your agent you are done${complete ? "." : ": it still has to finish the setup (patio join)."}`,
              );
            } catch (err) {
              if (err instanceof ExchangeError) return back(`/confirm?code=${encodeURIComponent(code)}`, "error", err.message);
              throw err;
            }
          });
        const agentWs = /^\/agents\/([^/]+)\/workspaces\/(?:([^/]+)\/leave|add)$/.exec(path);
        if (agentWs)
          return action(req, async (s, form) => {
            const name = decodeURIComponent(agentWs[1]!);
            const leaving = agentWs[2] !== undefined;
            const ws = leaving ? decodeURIComponent(agentWs[2]!) : String(form.get("workspace") ?? "");
            // Leaving asks first (GET shows what happens).
            if (leaving && form.get("confirm") !== "yes") return redirect(`/agents/${encodeURIComponent(name)}/workspaces/${encodeURIComponent(ws)}/leave`);
            return run("/agents", async () => {
              const r = await exchange<{ workspace: { name: string }; channels?: string[] }>(s, `/api/agents/${encodeURIComponent(name)}/workspaces/${encodeURIComponent(ws)}/${leaving ? "leave" : "add"}`, {});
              if (!leaving) return `${name} is in ${r.workspace.name}${r.channels?.length ? ` and ${r.channels.map((c) => `#${c}`).join(", ")}` : ""}.`;
              const closed = opts.gatekeeper.agents?.closeOpen?.(name, r.workspace.name) ?? 0;
              return `${name} left ${r.workspace.name}${closed ? `; ${closed} open question${closed === 1 ? "" : "s"} closed` : ""}.`;
            });
          });
        if (wsMatch?.[2] === "revoke")
          return action(req, (s, form) =>
            run(`/workspaces/${encodeURIComponent(wsMatch[1]!)}`, async () => {
              const login = String(form.get("login") ?? "");
              await exchange(s, `/api/workspaces/${encodeURIComponent(wsMatch[1]!)}/members/${encodeURIComponent(login)}/revoke`, {});
              return `Removed @${login} from the team.`;
            }),
          );
      }
      return new Response("Not Found", { status: 404 });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  cookieName = `patio_web_${server.port}`;
  return { url: origin, port: server.port!, stop: () => server.stop(true) };
}
