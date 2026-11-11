// Budget for live (paid) calls. Limits come from docs/poc/execution.md.
// A live smoke spends budget BEFORE it calls out, so a crash cannot give a free retry.
import { mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { BUDGET_FILE } from "./paths";

// Claude Code, Pi and Hermes responder runs (increment 8): one total cap each, no daily cap.
export const RESPONDER_KINDS = ["claude_acp", "pi_acp", "hermes_acp"] as const;
export type ResponderKind = (typeof RESPONDER_KINDS)[number];
export type BudgetKind = "codex_acp" | "jev" | ResponderKind;

export type Budget = {
  limits: {
    codex_acp_per_day: number;
    // Cap for the period in which the dev environment is being built. Remove or raise once that is over.
    codex_acp_build_total: number | null;
    jev_per_day: number;
    claude_acp_total: number;
    pi_acp_total: number;
    hermes_acp_total: number;
  };
  codex_acp: { build_used: number; days: Record<string, number> };
  jev: { days: Record<string, number> };
  responders: Record<ResponderKind, { used: number; days: Record<string, number> }>;
};

export const DEFAULT_BUDGET: Budget = {
  limits: { codex_acp_per_day: 20, codex_acp_build_total: 20, jev_per_day: 300, claude_acp_total: 15, pi_acp_total: 15, hermes_acp_total: 15 },
  codex_acp: { build_used: 0, days: {} },
  jev: { days: {} },
  responders: { claude_acp: { used: 0, days: {} }, pi_acp: { used: 0, days: {} }, hermes_acp: { used: 0, days: {} } },
};

const isResponder = (kind: BudgetKind): kind is ResponderKind => (RESPONDER_KINDS as readonly string[]).includes(kind);

export class BudgetSpent extends Error {}

export const dayOf = (now = new Date()) => now.toISOString().slice(0, 10);

export async function readBudget(file = BUDGET_FILE): Promise<Budget> {
  const f = Bun.file(file);
  if (!(await f.exists())) return structuredClone(DEFAULT_BUDGET);
  const raw = (await f.json()) as Partial<Budget>;
  return {
    limits: { ...DEFAULT_BUDGET.limits, ...raw.limits },
    codex_acp: { ...DEFAULT_BUDGET.codex_acp, ...raw.codex_acp },
    jev: { ...DEFAULT_BUDGET.jev, ...raw.jev },
    responders: Object.fromEntries(
      RESPONDER_KINDS.map((k) => [k, { ...DEFAULT_BUDGET.responders[k], ...raw.responders?.[k] }]),
    ) as Budget["responders"],
  };
}

async function writeBudget(budget: Budget, file: string) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await Bun.write(tmp, JSON.stringify(budget, null, 2) + "\n");
  await rename(tmp, file);
}

export function budgetLeft(budget: Budget, kind: BudgetKind, now = new Date()): number {
  const day = dayOf(now);
  if (isResponder(kind)) return Math.max(0, budget.limits[`${kind}_total`] - budget.responders[kind].used);
  if (kind === "jev") return Math.max(0, budget.limits.jev_per_day - (budget.jev.days[day] ?? 0));
  const today = Math.max(0, budget.limits.codex_acp_per_day - (budget.codex_acp.days[day] ?? 0));
  const cap = budget.limits.codex_acp_build_total;
  return cap === null ? today : Math.min(today, Math.max(0, cap - budget.codex_acp.build_used));
}

// Reserves `count` units. Throws BudgetSpent, without changing anything, when not enough is left.
export async function spend(kind: BudgetKind, count = 1, file = BUDGET_FILE, now = new Date()): Promise<number> {
  const budget = await readBudget(file);
  const left = budgetLeft(budget, kind, now);
  if (left < count) throw new BudgetSpent(`${kind} budget spent: ${left} left, ${count} needed (see ${file})`);
  const day = dayOf(now);
  if (isResponder(kind)) {
    const r = budget.responders[kind];
    r.used += count;
    r.days[day] = (r.days[day] ?? 0) + count;
  } else if (kind === "jev") budget.jev.days[day] = (budget.jev.days[day] ?? 0) + count;
  else {
    budget.codex_acp.days[day] = (budget.codex_acp.days[day] ?? 0) + count;
    budget.codex_acp.build_used += count;
  }
  await writeBudget(budget, file);
  return budgetLeft(budget, kind, now);
}
