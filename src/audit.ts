// The audit log, $PATIO_HOME/audit.jsonl (mode 600): one JSON line per gate decision, owner decision, and
// `patio answer`'s working directory (what a disposable worktree discarded). Written by the gatekeeper and by
// `patio answer`; appends are small single writes, so lines from the two processes do not interleave.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type AuditEntry = Record<string, unknown> & { at: string; direction?: string; verdict?: string; rule?: string };

// Every line, oldest first; a line that does not parse is skipped.
export function readAudit(home: string): AuditEntry[] {
  const file = join(home, "audit.jsonl");
  if (!existsSync(file)) return [];
  const out: AuditEntry[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

export function appendAudit(home: string, entry: Record<string, unknown>) {
  appendFileSync(join(home, "audit.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 });
}
