// Shared gate for live smokes: an explicit --yes-live flag and budget left, checked before anything runs.
import { budgetLeft, readBudget, type BudgetKind } from "./budget";
import { BUDGET_FILE } from "./paths";

export const EXIT_FAIL = 1;
export const EXIT_NO_KEY = 2;
export const EXIT_NO_FLAG = 4;
export const EXIT_BUDGET_SPENT = 5;

export async function liveGate(name: string, kind: BudgetKind, needed: number, argv = process.argv.slice(2)) {
  if (!argv.includes("--yes-live")) {
    console.error(`${name} makes paid live calls. Re-run with --yes-live to confirm.`);
    process.exit(EXIT_NO_FLAG);
  }
  const left = budgetLeft(await readBudget(), kind);
  if (left < needed) {
    console.error(`${name}: ${kind} budget spent (${left} left, ${needed} needed). See ${BUDGET_FILE} and docs/poc/execution.md.`);
    process.exit(EXIT_BUDGET_SPENT);
  }
  return left;
}
