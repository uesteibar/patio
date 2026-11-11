// The Activity page in sentences: each line of the audit log ($PATIO_HOME/audit.jsonl) as a person says it. "unai-orbit
// asked pablo. Sent." / "pablo asked unai-orbit. Waits for you." / "Waits for you: it contains an email address." The
// rule names and probabilities stay behind Details.
import type { AuditEntry } from "./audit";
import { CATEGORIES } from "./gates";

// What happened to an incoming message since: for "Waits for you" or "Answered".
export type Fate = "waits" | "answered" | "declined" | "dismissed" | "delivered";

const verb = (kind: unknown, to: string) =>
  kind === "question"
    ? `asked ${to}`
    : kind === "request"
      ? `sent ${to} a request`
      : kind === "report"
        ? `sent ${to} a report`
        : kind === "heads-up"
          ? `sent ${to} a heads-up`
          : kind === "reply"
            ? `answered ${to}`
            : `wrote to ${to}`;

const an = (what: string) => (/^[aeiou]/i.test(what) ? `an ${what}` : `a ${what}`);

// A rule's reason as a clause: "it contains an email address", "it looks like prompt injection".
export function because(e: AuditEntry): string {
  const reason = typeof e.reason === "string" ? e.reason : "";
  const found = Array.isArray(e.dlp) ? (e.dlp as { what?: string }[]).map((d) => d.what).filter(Boolean) : [];
  if (found.length && (reason === CATEGORIES.personal || reason === CATEGORIES.secret || reason === CATEGORIES.path)) return `it contains ${an(found[0]!)}`;
  const clauses: Record<string, string> = {
    [CATEGORIES.kind]: "it is not a kind your rules let in",
    [CATEGORIES.per_day]: "the daily limit is reached",
    [CATEGORIES.injection]: "it looks like prompt injection",
    [CATEGORIES.action]: "it asks for an action",
    [CATEGORIES.deny_in]: "it asks about a denied topic",
    [CATEGORIES.allow]: "it is outside the allowed topics",
    [CATEGORIES.deny_out]: "it reveals a denied topic",
    [CATEGORIES.posture]: "it does not follow your posture",
    [CATEGORIES.secret]: "it contains a secret or a token",
    [CATEGORIES.path]: "it contains a local file path",
    [CATEGORIES.personal]: "it contains personal data",
    [CATEGORIES.jev]: "the check could not run",
    [CATEGORIES.timeout]: "nobody reviewed it in time",
    "the contact's keys changed": `${e.direction === "out" ? String(e.to ?? "their") : String(e.from ?? "their")}'s keys changed`,
  };
  return clauses[reason] ?? (reason || "your rules doubted it");
}

const by = (e: AuditEntry) => (typeof e.by === "string" && e.by.startsWith("@") ? "You" : null);

// The sentence for one line of the log; `fate`: what became of an incoming message since.
export function activitySentence(e: AuditEntry, fate?: Fate | null): string {
  const from = String(e.from ?? "someone");
  const to = e.channel ? `#${String(e.channel).split("/").pop()}` : String(e.to ?? "someone");
  const what = `${from} ${verb(e.kind, to)}.`;
  const v = String(e.verdict ?? "");
  if (e.rule === "workdir") {
    const discarded = Array.isArray(e.discarded) ? (e.discarded as string[]) : null;
    return v === "in-place"
      ? `${String(e.to ?? "Your agent")} answered ${from} in its folder itself.`
      : `${String(e.to ?? "Your agent")} answered ${from} in a disposable copy of its folder; ${discarded?.length ? `it changed ${discarded.join(", ")}, thrown away` : "it changed nothing"}.`;
  }
  if (e.rule === "owner") {
    const you = by(e) ?? "You";
    const outcome: Record<string, string> = {
      approved: e.direction === "in" ? `${you} let it in.` : `${you} sent it.`,
      "approved-with-edit": `${you} sent it, as you edited it.`,
      "approved-with-action": `${you} let it in, with the action: ${String(e.allowed_action ?? "")}.`,
      rejected: e.direction === "in" ? `${you} declined it.` : `${you} did not send it.`,
      "let-agent-answer": `${you} let ${String(e.to ?? "your agent")} answer it.`,
      replied: `${you} replied, as ${String(e.to ?? "your agent")}.`,
      declined: `${you} declined it.`,
    };
    return `${what} ${outcome[v] ?? `${you} decided: ${v}.`}`;
  }
  if (e.rule === "recipient") return `${what} ${String(e.to ?? "Your agent")} declined it.`;
  if (e.rule === "keys") {
    if (v === "trusted") return `You trusted ${from}'s new keys.`;
    if (v === "blocked") return `You blocked ${from}'s new keys.`;
    if (v === "dropped") return `${what} Not let in: it comes from keys you blocked.`;
  }
  const outcome = (() => {
    switch (v) {
      case "deliver":
        return fate === "waits" ? "Waits for you." : fate === "answered" ? "Answered." : fate === "declined" ? "Declined." : fate === "dismissed" ? "Closed." : "Delivered.";
      case "send":
      case "sent":
        return e.rule === "outbox" ? "Sent, once the server was reachable." : "Sent.";
      case "ask-human":
      case "held":
        return `Waits for you: ${because(e)}.`;
      case "reject":
        return `Not let in: ${because(e)}.`;
      case "block":
        return `Not sent: ${because(e)}.`;
      case "not-sent":
        return `Not sent: ${typeof e.reason === "string" ? e.reason : "the server refused it"}.`;
      case "queued":
        return "Waits to be sent: the server is not reachable.";
      case "failed":
        return `Not sent: ${typeof e.reason === "string" ? e.reason : "it failed"}.`;
      case "cancelled":
        return "You took it back before it was sent.";
      case "expired":
        return `Not delivered: ${typeof e.reason === "string" ? e.reason : "it expired"}.`;
      case "rejected":
        return e.rule === "timeout" ? "Not let in: nobody reviewed it in time." : `Not let in: ${because(e)}.`;
      case "delivered-unreviewed":
        return "Delivered, marked not reviewed: nobody reviewed it in time.";
      default:
        return v ? `${v}.` : "";
    }
  })();
  return `${what} ${outcome}`.trim();
}

// How sure a yes-or-no check was, for the bar: 0.5 is not sure at all, 0 and 1 are sure.
export const sureness = (p: number) => Math.max(p, 1 - p);
