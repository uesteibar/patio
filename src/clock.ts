// The time that expiries use: held messages that time out, messages that outlive their TTL at the exchange or in
// a gatekeeper's outbox. In tests and scenarios PATIO_TEST_CLOCK names a file that holds an offset in milliseconds,
// added to the real clock, so a scenario moves time forward instead of sleeping. Nothing else reads it.
import { readFileSync } from "node:fs";

export type Clock = () => number;

export function clockFromEnv(env = process.env): Clock {
  const file = env.PATIO_TEST_CLOCK;
  if (!file) return Date.now;
  return () => {
    let offset = 0;
    try {
      offset = Number(readFileSync(file, "utf8").trim()) || 0;
    } catch {}
    return Date.now() + offset;
  };
}

// How often the gatekeeper and the exchange look for what expired (PATIO_SWEEP_MS, default 30 s).
export const sweepMs = (env = process.env) => Math.max(50, Number(env.PATIO_SWEEP_MS ?? 30_000) || 30_000);

const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

// "90s", "30m", "24h", "7d": a positive whole number and a unit. Returns milliseconds, or null when it is not one.
export function parseDuration(text: unknown): number | null {
  const m = typeof text === "string" ? /^\s*(\d+)\s*([smhd])\s*$/.exec(text) : null;
  if (!m || Number(m[1]) <= 0) return null;
  return Number(m[1]) * UNITS[m[2]!]!;
}

export function formatDuration(ms: number): string {
  for (const [unit, size] of [["d", 86_400_000], ["h", 3_600_000], ["m", 60_000]] as const) if (ms % size === 0) return `${ms / size}${unit}`;
  return `${Math.round(ms / 1000)}s`;
}

// How long the exchange keeps an undelivered message, and a gatekeeper a queued one (PATIO_MESSAGE_TTL, default 7d).
export const messageTtlMs = (env = process.env) => parseDuration(env.PATIO_MESSAGE_TTL ?? "7d") ?? 7 * 86_400_000;

// When something was last seen, for a person: "just now", "5 minutes ago", "3 hours ago", "2 days ago".
export function ago(ms: number | null, now = Date.now()): string {
  if (!ms) return "never";
  const d = Math.max(0, now - ms);
  const n = (unit: number, word: string) => `${Math.floor(d / unit)} ${word}${Math.floor(d / unit) === 1 ? "" : "s"} ago`;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return n(60_000, "minute");
  if (d < 86_400_000) return n(3_600_000, "hour");
  return n(86_400_000, "day");
}
