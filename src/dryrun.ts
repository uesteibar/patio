// `patio rules test`: one gate run as a dry run in patio on this computer, with its rules and its judge. The gatekeeper
// sends nothing, stores nothing and writes no audit line; Jev is asked as the real gate would ask it (so it
// costs one Jev request, unless a structured rule or a data check decides first).
import type { GateDecision } from "./gates";
import type { Grant } from "./grants";
import type { Kind } from "./protocol";

// `as`: whose rules (an agent of this computer).
export type DryRunInput = { text: string; as?: string; from?: string; to?: string; channel?: string; kind?: Kind; outgoing?: boolean };

export type DryRun = {
  direction: "in" | "out";
  grant: Grant;
  // Input gate only: the structured rules, before Jev.
  checks: { kind: { kind: Kind; allowed: boolean }; per_day: { count: number; limit: number | null } } | null;
  decision: GateDecision;
};

// 0: delivered or sent; 7: held for the owner; 8: rejected or blocked (the exit codes of ask and reply).
export const dryRunExit = (r: DryRun) => (r.decision.verdict === "deliver" || r.decision.verdict === "send" ? 0 : r.decision.verdict === "ask-human" ? 7 : 8);

const list = (xs: string[]) => (xs.length ? xs.map((x) => JSON.stringify(x)).join(", ") : "none");

export function formatDryRun(r: DryRun): string {
  const g = r.grant;
  const d = r.decision;
  const out = [
    `${r.direction === "in" ? "your rules (incoming)" : "your rules (outgoing)"}, dry run: nothing is sent, stored or logged`,
    `rules: ${g.source}`,
    `  kinds ${g.kinds.join(", ")}; per_day ${g.per_day ?? "no limit"}; on_doubt ${g.on_doubt}; thresholds reject ${g.thresholds.reject}, ask ${g.thresholds.ask}`,
    `  allow ${list(g.allow)}; deny ${list(g.deny)}; posture ${list(g.posture)}; actions ${Array.isArray(g.actions) ? list(g.actions) : g.actions}; auto_answer ${g.auto_answer}`,
  ];
  if (r.checks) {
    out.push("structured checks:");
    out.push(`  kind ${r.checks.kind.kind}: ${r.checks.kind.allowed ? "allowed" : "not allowed"}`);
    out.push(`  per day: ${r.checks.per_day.count} of ${r.checks.per_day.limit ?? "no limit"} today`);
  }
  if (r.direction === "out") out.push(`data checks: ${d.dlp.length ? d.dlp.map((f) => `${f.what} (${f.sample})`).join(", ") : "nothing found"}`);
  if (!d.jev) out.push("the judge: not asked");
  else if ("error" in d.jev) out.push(`the judge: ${d.jev.error}`);
  else {
    out.push(`the judge (${d.jev.ms} ms): probability of yes, then the risk it counts as`);
    for (const s of d.scores) out.push(`  ${s.p.toFixed(2)}  ${s.label}${s.risk !== s.p ? `  (risk ${s.risk.toFixed(2)})` : ""}`);
  }
  if (d.action?.requested) out.push(`action: requested; policy ${d.action.policy}${d.action.allowed ? `; allowed: ${d.action.allowed}` : ""}`);
  out.push(`verdict: ${d.verdict === "ask-human" ? "waits for you (ask-human)" : d.verdict}${d.reason ? ` (${d.reason}; rule ${d.rule})` : d.rule ? ` (rule ${d.rule})` : ""}`);
  return out.join("\n");
}
