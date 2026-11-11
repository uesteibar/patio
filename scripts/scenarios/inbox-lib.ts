// Helpers for scenarios that drive the inbox through the real CLI.
import type { CliResult } from "../lib/scenario";

export type InboxRow = { unread: boolean; id: string; convo: string; from: string; kind: string; state: string; text: string };

// Parses `patio inbox` (a header row, then "* <id8>  <from>  <kind>  <state>  <text>") or `patio inbox --json` (one
// message per line, with its conversation id). A channel message's text starts with "#<channel> · ".
export function parseInbox(res: CliResult): InboxRow[] {
  const lines = res.stdout.split("\n").filter((l) => l.trim());
  if (lines[0]?.trimStart().startsWith("{"))
    return lines.map((l) => {
      const m = JSON.parse(l) as { id: string; convo: string; from: string; kind: string; state: string; text: string; channel?: { name: string } | null };
      return { unread: m.state === "unread", id: m.id.slice(0, 8), convo: m.convo.slice(0, 8), from: m.from, kind: m.kind, state: m.state, text: `${m.channel ? `#${m.channel.name} · ` : ""}${m.text}` };
    });
  return lines
    .map((line) => /^(\*)?\s*(\S{8})\s{2,}(\S+)\s{2,}(\S+)\s{2,}(\S+(?: \(not reviewed\))?)\s{2,}(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => !!m && m[2] !== "ID")
    .map((m) => ({ unread: m[1] === "*", id: m[2]!, convo: "", from: m[3]!, kind: m[4]!, state: m[5]!, text: m[6]! }));
}
