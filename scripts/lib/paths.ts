// Locations shared by the dev-environment scripts. Nothing here touches ~/.patio.
import { dirname, join, resolve } from "node:path";

export const REPO = resolve(import.meta.dir, "../..");
export const DEV_DIR = join(REPO, ".dev");
export const INSTANCES_DIR = join(DEV_DIR, "instances");
export const SANDBOX_DIR = join(DEV_DIR, "sandbox");
// PATIO_POC_BUDGET_FILE overrides it for tests.
export const BUDGET_FILE = process.env.PATIO_POC_BUDGET_FILE ?? join(DEV_DIR, "budget.json");
export const VERIFY_DIR = join(REPO, ".verify");
export const PATIO_CLI = join(REPO, "src/cli.ts");
// Secrets live in the main checkout's .env: the parent of the git common dir. `just worktree` copies it into each worktree;
// bunfig.toml keeps Bun from loading it, so only live recipes read it, from here. PATIO_POC_ENV_FILE overrides it for tests.
function resolveSecretsFile(): string {
  if (process.env.PATIO_POC_ENV_FILE) return resolve(process.env.PATIO_POC_ENV_FILE);
  const git = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: REPO });
  const commonDir = git.stdout.toString().trim();
  if (git.exitCode !== 0 || !commonDir) throw new Error("cannot resolve the main checkout: git rev-parse --git-common-dir failed");
  return join(dirname(commonDir), ".env");
}
export const SECRETS_FILE = resolveSecretsFile();
