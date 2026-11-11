// `patio status`: one screen that says whether patio on this computer works, and what needs the owner: you, this
// computer, the server, then a table of agents. patio builds the report (its /status route); this module decides
// what needs attention and prints it.
import type { ConfigSummary } from "./live-config";
import { tilde } from "./config";
import type { AgentStatus } from "./protocol";
import { toolLabel } from "./agent-file";
import { CONNECT_TOOLS, isConnectTool, toolStateText, type ToolState } from "./connect";

// One agent of this computer: the server's word and its file.
export type AgentRow = {
  name: string;
  // "not registered": it has a file here but the server does not know it yet (patio agents add, patio join).
  status: AgentStatus | "not registered";
  workspaces: string[];
  tool: string | null;
  folder: string | null;
  in_place: boolean;
  file: boolean;
  // The file's error: patio keeps its last valid version.
  error: string | null;
  // The coding tools that run patio as this agent: "claude", "codex (user)"…
  connected: string[];
  // Each coding tool patio connects, for this agent: patio listed in it, written and waiting for the person's trust, or
  // not set up (from the last check, $PATIO_HOME/checks.json).
  tools?: Record<string, ToolState>;
  // Its file records the three answers for one of its workspaces (or patio agents new asked them).
  answered?: boolean;
};

// What is true of one agent, in a person's words. No "Ready": an agent works only once it is in a workspace, with its
// three answers, and its own coding tool lists patio.
export function agentState(a: AgentRow): { key: "working" | "waiting" | "no-workspace" | "answers" | "not-connected"; text: string } {
  if (a.status === "pending") return { key: "waiting", text: "Waits for your confirmation" };
  if (a.status !== "approved" && a.status !== "not registered") return { key: "waiting", text: a.status[0]!.toUpperCase() + a.status.slice(1) };
  if (!a.workspaces.length) return { key: "no-workspace", text: "Not in a workspace" };
  if (a.answered === false) return { key: "answers", text: "Waits for your three answers" };
  if (a.tool && isConnectTool(a.tool) && a.tools && a.tools[a.tool] !== "listed") return { key: "not-connected", text: `Not connected to ${toolLabel(a.tool)}` };
  return { key: "working", text: "Working" };
}

export type StatusReport = {
  connected: boolean;
  relay: string;
  device: string;
  label: string;
  // The GitHub login this computer is signed in as (the owner who signs in to its web app).
  login: string | null;
  revoked: boolean;
  agents: AgentRow[];
  web_url: string;
  unread: number;
  files: ConfigSummary[];
  // Who judges the gates' questions: Jev with this computer's own key, or the server's judge (which forwards to Jev).
  judge: { kind: "local" } | { kind: "server"; url: string } | { kind: "none" };
  // What waits for the owner in the web app. `rules`: settings in an agent's file that widen what others can do,
  // waiting to be turned on.
  pending: { held_in: number; held_out: number; keys: number; identities: number; rules: number; questions: number; rule_requests: number };
  inbox: Record<"unread" | "read" | "claimed" | "failed" | "answered" | "dismissed" | "rejected", number>;
  outbox: number;
  // A first run in progress (patio join <link>): waiting for the person's sign-in or confirmation.
  // `moved`: confirmed with Move, from this other computer of the person's.
  setup: { state: "waiting" | "confirmed" | "declined"; agent: string | null; url: string; moved?: string | null } | null;
};

export type Status = StatusReport & { healthy: boolean; attention: string[] };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function attention(s: StatusReport): string[] {
  const out: string[] = [];
  if (s.revoked) out.push("this computer was revoked: set patio up again with a new PATIO_HOME (patio join <link>) to continue");
  else if (!s.connected) out.push(`not connected to the server at ${s.relay}${s.outbox ? ` (${plural(s.outbox, "message")} wait in the outbox)` : ""}`);
  if (!s.login) out.push("not signed in: patio join <link> signs you in");
  else if (!s.agents.some((a) => a.status === "approved")) out.push("no agent yet: patio join <link> --agent <name> sets one up");
  for (const a of s.agents) {
    if (a.error) out.push(`${a.error} (patio keeps the last valid version; fix the file, it is reloaded on save)`);
    if (a.status === "approved" && !a.workspaces.length) out.push(`${a.name} is not in any workspace: patio agents add ${a.name} <workspace>, or patio join <link> --agent ${a.name}`);
    if (a.status === "approved" && !a.file) out.push(`${a.name} has no file: patio agents new ${a.name} --tool <tool> --folder <dir> writes one`);
  }
  if (s.judge.kind === "none") out.push("no judge: every message waits for you");
  if (s.pending.questions) out.push(`${plural(s.pending.questions, "question")} ${s.pending.questions === 1 ? "waits" : "wait"} for you in the web app: ${s.web_url}`);
  if (s.pending.rule_requests) out.push(`${plural(s.pending.rule_requests, "change")} of your agents' rules ${s.pending.rule_requests === 1 ? "waits" : "wait"} for you in the web app: ${s.web_url}`);
  const held = s.pending.held_in + s.pending.held_out;
  if (held) out.push(`${plural(held, "message")} ${held === 1 ? "waits" : "wait"} for you in the web app: ${s.web_url}`);
  if (s.pending.keys) out.push(`${plural(s.pending.keys, "contact")} changed keys: trust or block them in the web app`);
  if (s.pending.identities) out.push(`${plural(s.pending.identities, "agent")} ${s.pending.identities === 1 ? "waits" : "wait"} for your confirmation in the web app`);
  if (s.pending.rules) out.push(`${plural(s.pending.rules, "setting")} in your agents' rules ${s.pending.rules === 1 ? "widens" : "widen"} what others can do (auto_answer, actions) and ${s.pending.rules === 1 ? "stays" : "stay"} off until you turn ${s.pending.rules === 1 ? "it" : "them"} on in the web app: ${s.web_url}`);
  if (s.inbox.failed) out.push(`${plural(s.inbox.failed, "message")} in the inbox failed: see patio inbox`);
  return out;
}

export function withAttention(s: StatusReport): Status {
  const a = attention(s);
  return { ...s, healthy: a.length === 0, attention: a };
}

const fp = (id: string) => id.match(/.{1,4}/g)!.join(" ");

// A plain table: columns padded to their widest cell.
export function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join("  ").trimEnd()).join("\n");
}

export function agentsTable(agents: AgentRow[], label: string): string {
  if (!agents.length) return "no agents on this computer yet: patio join <link> sets one up";
  return table([
    ["AGENT", "STATE", "TOOL", "FOLDER", "WORKSPACES", "CODING TOOLS", "COMPUTER"],
    ...agents.map((a) => [
      a.name,
      agentState(a).text,
      a.tool ? toolLabel(a.tool) : "-",
      `${tilde(a.folder) || "-"}${a.in_place ? " (in place)" : ""}`,
      a.workspaces.join(", ") || "none",
      a.tools ? CONNECT_TOOLS.map((t) => `${toolLabel(t)}: ${toolStateText(a.tools![t] ?? "not set up", toolLabel(t))}`).join("; ") : a.connected.join(", ") || "none",
      label,
    ]),
  ]);
}

// `patio agents`: an agent whose own coding tool has no patio entry in its folder (nor user-wide), so a session of
// that tool there is not the agent; with the command that fixes it.
export function connectWarnings(agents: AgentRow[]): string[] {
  return agents
    .filter((a) => a.tool && ["claude", "codex", "pi"].includes(a.tool) && a.folder && !a.connected.some((c) => c.split(" ")[0] === a.tool))
    .map((a) => `${a.name}: ${toolLabel(a.tool!)} in ${a.folder} has no patio entry, so a ${toolLabel(a.tool!)} session there is not ${a.name}: patio connect ${a.tool} --as ${a.name}`);
}

export function formatStatus(s: Status): string {
  const i = s.inbox;
  const p = s.pending;
  return [
    `you: ${s.login ? `@${s.login}` : "not signed in (patio join <link>)"}`,
    `this computer: ${s.label} (${fp(s.device)})${s.revoked ? " REVOKED" : ""}; web app ${s.web_url}`,
    `server: ${s.relay} (${s.connected ? "connected" : "not connected"}); judge: ${s.judge.kind === "local" ? "this computer's key (TYPESAFE_API_KEY)" : s.judge.kind === "server" ? `the server's (${s.judge.url}/judge)` : "none: every message waits for you"}`,
    `waiting for you: ${plural(p.questions, "question")}, ${p.held_in} incoming and ${p.held_out} outgoing messages, ${p.keys} changed keys, ${p.identities} agents, ${p.rules + p.rule_requests} rules to confirm`,
    `inbox: ${i.unread} unread, ${i.read} read, ${i.claimed} claimed, ${i.failed} failed; ${i.answered} answered, ${i.dismissed} dismissed, ${i.rejected} rejected; outbox: ${s.outbox} queued`,
    "",
    agentsTable(s.agents, s.label),
    "",
    s.healthy ? "status: healthy" : ["status: needs attention", ...s.attention.map((a) => `  - ${a}`)].join("\n"),
  ].join("\n");
}
