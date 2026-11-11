import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { budgetLeft, BudgetSpent, readBudget, spend } from "../../scripts/lib/budget";
import { parseEnvFile, secretPresence } from "../../scripts/lib/secrets";

const tmp = async () => join(await mkdtemp(join(tmpdir(), "patio-budget-")), "budget.json");
const noon = new Date("2026-11-08T12:00:00Z");

test("a spend is persisted and reduces what is left", async () => {
  const file = await tmp();
  expect(budgetLeft(await readBudget(file), "jev", noon)).toBe(300);
  expect(await spend("jev", 2, file, noon)).toBe(298);
  expect(budgetLeft(await readBudget(file), "jev", noon)).toBe(298);
});

test("the build-phase cap (20 runs in total) stops codex runs even when the daily limit has room", async () => {
  const file = await tmp();
  const nextDay = new Date("2026-11-09T12:00:00Z");
  for (let i = 0; i < 12; i++) await spend("codex_acp", 1, file, noon);
  for (let i = 0; i < 8; i++) await spend("codex_acp", 1, file, nextDay);
  const err = await spend("codex_acp", 1, file, nextDay).catch((e) => e);
  expect(err).toBeInstanceOf(BudgetSpent);
  expect((await readBudget(file)).codex_acp.build_used).toBe(20);
});

test("a refused spend changes nothing, and the daily counter resets on a new day", async () => {
  const file = await tmp();
  await Bun.write(file, JSON.stringify({ limits: { jev_per_day: 2, codex_acp_build_total: null } }));
  await spend("jev", 2, file, noon);
  expect(spend("jev", 1, file, noon)).rejects.toBeInstanceOf(BudgetSpent);
  expect((await readBudget(file)).jev.days["2026-11-08"]).toBe(2);
  expect(budgetLeft(await readBudget(file), "jev", new Date("2026-11-09T01:00:00Z"))).toBe(2);
});

test("Claude Code, Pi and Hermes runs have their own total caps (15 each for batch 2), apart from Codex", async () => {
  const file = await tmp();
  expect(budgetLeft(await readBudget(file), "claude_acp", noon)).toBe(15);
  await Bun.write(file, JSON.stringify({ limits: { pi_acp_total: 2 } }));
  await spend("pi_acp", 2, file, noon);
  expect(spend("pi_acp", 1, file, noon)).rejects.toBeInstanceOf(BudgetSpent);
  expect(budgetLeft(await readBudget(file), "pi_acp", new Date("2026-11-09T12:00:00Z"))).toBe(0);
  expect(budgetLeft(await readBudget(file), "hermes_acp", noon)).toBe(15);
  expect(budgetLeft(await readBudget(file), "codex_acp", noon)).toBe(20);
  expect((await readBudget(file)).responders.pi_acp).toEqual({ used: 2, days: { "2026-11-08": 2 } });
});

test("secret presence is reported without the value", async () => {
  const dir = await mkdtemp(join(tmpdir(), "patio-secrets-"));
  const file = join(dir, "secrets.env");
  await Bun.write(file, "# comment\nOTHER=1\nexport TYPESAFE_API_KEY='sk-secret'\nEMPTY=\n");
  expect(parseEnvFile(await Bun.file(file).text()).TYPESAFE_API_KEY).toBe("sk-secret");
  const found = await secretPresence("TYPESAFE_API_KEY", file);
  expect(found).toEqual({ file_exists: true, present: true });
  expect(JSON.stringify(found)).not.toContain("sk-secret");
  expect(await secretPresence("EMPTY", file)).toEqual({ file_exists: true, present: false });
  expect(await secretPresence("X", join(dir, "missing.env"))).toEqual({ file_exists: false, present: false });
});

test("by default the secrets file is the main checkout's .env, outside this worktree", async () => {
  const { SECRETS_FILE, REPO } = await import("../../scripts/lib/paths");
  expect(SECRETS_FILE.endsWith("/.env")).toBe(true);
  expect(SECRETS_FILE.startsWith(REPO)).toBe(false);
});
