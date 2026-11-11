// `patio rules check`: the rules as the gates resolve them, one block per entry (defaults, each contact, each
// channel), and warnings about settings that are valid but silently do less or more than they look. It reads the
// file; no gatekeeper, no Jev, nothing is sent. Exit 0 without warnings, 1 with them (product review P2).
import { grantFor, GATED_KINDS, type Grant, type Grants } from "./grants";

export type GrantsWarning = { id: "judge-off" | "per-day-zero" | "bare-channel" | "allow-replaces" | "unreviewed-auto"; where: string; text: string };
export type GrantsCheck = { file: boolean; entries: { source: string; grant: Grant }[]; warnings: GrantsWarning[] };

export function checkGrants(grants: Grants | null): GrantsCheck {
  const g = grants ?? { defaults: {}, contacts: {}, channels: {} };
  const entries = [
    { source: "defaults", grant: grantFor(g, { contact: "someone-else" }) },
    ...Object.keys(g.contacts).map((name) => ({ source: `contacts.${name}`, grant: grantFor(g, { contact: name }) })),
    ...Object.keys(g.channels).map((key) => {
      const [workspace, name] = key.includes("/") ? key.split("/", 2) : ["", key];
      return { source: `channels.${key}`, grant: grantFor(g, { channel: { id: key, name: name!, workspace: workspace! } }) };
    }),
  ];
  const warnings: GrantsWarning[] = [];
  for (const { source, grant } of entries) {
    const raw = source === "defaults" ? g.defaults : source.startsWith("contacts.") ? g.contacts[source.slice(9)]! : g.channels[source.slice(9)]!;
    if (grant.thresholds.ask >= 1)
      warnings.push({ id: "judge-off", where: source, text: `thresholds.ask is ${grant.thresholds.ask}: no question to the judge can ever reach it, so injection, topics and posture never wait for you nor are rejected here; only kinds, per_day and the data checks apply` });
    if (grant.per_day === 0) warnings.push({ id: "per-day-zero", where: source, text: "per_day is 0: every message is rejected as over the daily limit" });
    if (source.startsWith("channels.") && !source.slice(9).includes("/"))
      warnings.push({ id: "bare-channel", where: source, text: `a bare channel name matches #${source.slice(9)} in every workspace; write <workspace>/${source.slice(9)} to mean one` });
    if (source !== "defaults" && raw.allow && g.defaults.allow?.length)
      warnings.push({ id: "allow-replaces", where: source, text: `allow replaces the default allow (deny and posture add to the defaults; allow does not): the default topics ${JSON.stringify(g.defaults.allow)} do not apply here` });
    if (grant.on_timeout === "inbox" && grant.auto_answer)
      warnings.push({ id: "unreviewed-auto", where: source, text: "on_timeout is inbox and auto_answer is on: a message waiting for you that nobody reviews in time reaches the inbox marked not reviewed; watch --answer skips those, so answer them by hand or with patio answer <id>" });
  }
  return { file: grants !== null, entries, warnings };
}

const list = (xs: string[]) => (xs.length ? xs.map((x) => JSON.stringify(x)).join(", ") : "none");

export function formatGrantsCheck(r: GrantsCheck): string {
  const out = [r.file ? "as patio applies them:" : "no rules: the default rules apply to every contact and channel:"];
  for (const { source, grant: g } of r.entries) {
    out.push(`${source}`);
    out.push(`  kinds ${g.kinds.length === GATED_KINDS.length ? "all" : g.kinds.join(", ")}; per_day ${g.per_day ?? "no limit"}; on_doubt ${g.on_doubt}; thresholds reject ${g.thresholds.reject}, ask ${g.thresholds.ask}`);
    out.push(`  allow ${list(g.allow)}; deny ${list(g.deny)} (and the always-on secrets topic); posture ${list(g.posture)}`);
    out.push(`  actions ${Array.isArray(g.actions) ? list(g.actions) : g.actions}; auto_answer ${g.auto_answer}; hold_timeout ${Math.round(g.hold_timeout_ms / 60_000)} min, then ${g.on_timeout}`);
  }
  out.push(r.warnings.length ? `${r.warnings.length} warning${r.warnings.length === 1 ? "" : "s"}:` : "no warnings");
  for (const w of r.warnings) out.push(`  ${w.where}: ${w.text}`);
  return out.join("\n");
}
