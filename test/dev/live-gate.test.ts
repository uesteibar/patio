import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dayOf } from "../../scripts/lib/budget";
import { EXIT_BUDGET_SPENT, EXIT_NO_FLAG, EXIT_NO_KEY } from "../../scripts/lib/live";
import { REPO } from "../../scripts/lib/paths";
import { PROCESS_MS } from "../helpers/timeouts";

// These runs never reach the network: each one stops at a gate before any call is made.
async function smoke(script: string, args: string[], env: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, `scripts/${script}`, ...args], { cwd: REPO, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  return { code: await proc.exited, stderr };
}

const dir = await mkdtemp(join(tmpdir(), "patio-gate-"));
const spentBudget = join(dir, "spent.json");
await Bun.write(spentBudget, JSON.stringify({ jev: { days: { [dayOf()]: 300 } }, codex_acp: { build_used: 20, days: {} } }));
const freshBudget = join(dir, "fresh.json");

test("live smokes refuse to run without --yes-live", async () => {
  for (const s of ["smoke-acp.ts", "smoke-jev.ts", "smoke-gates.ts"]) expect((await smoke(s, [], { PATIO_POC_BUDGET_FILE: freshBudget })).code).toBe(EXIT_NO_FLAG);
}, PROCESS_MS);

test("live smokes refuse to run when the budget is spent", async () => {
  for (const s of ["smoke-acp.ts", "smoke-jev.ts", "smoke-gates.ts"]) {
    const r = await smoke(s, ["--yes-live"], { PATIO_POC_BUDGET_FILE: spentBudget });
    expect(r.code).toBe(EXIT_BUDGET_SPENT);
    expect(r.stderr).toContain("budget spent");
  }
}, PROCESS_MS);

test("smoke-jev and smoke-gates exit 2 with a clear message when the key is absent, and spend nothing", async () => {
  for (const s of ["smoke-jev.ts", "smoke-gates.ts"]) {
    const r = await smoke(s, ["--yes-live"], { PATIO_POC_BUDGET_FILE: freshBudget, PATIO_POC_ENV_FILE: join(dir, "missing.env") });
    expect(r.code).toBe(EXIT_NO_KEY);
    expect(r.stderr).toContain("TYPESAFE_API_KEY is absent");
    expect(await Bun.file(freshBudget).exists()).toBe(false);
  }
}, PROCESS_MS);

test("smoke-github needs --yes-live, and exits 2 with a clear message when the OAuth app credentials are absent", async () => {
  expect((await smoke("smoke-github.ts", [], {})).code).toBe(EXIT_NO_FLAG);
  const r = await smoke("smoke-github.ts", ["--yes-live"], { PATIO_POC_ENV_FILE: join(dir, "missing.env") });
  expect(r.code).toBe(EXIT_NO_KEY);
  expect(r.stderr).toContain("GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET absent");
}, PROCESS_MS);
