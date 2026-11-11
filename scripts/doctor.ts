// Read-only report of every prerequisite, as JSON. Exit 0 when the deterministic checks can run,
// EXIT_NOT_READY otherwise. Live prerequisites (Codex login, Jev key) are reported but never fail it.
// Secrets are only checked for presence; no value is read into the output.
import { join } from "node:path";
import { budgetLeft, readBudget } from "./lib/budget";
import { findChromium } from "./lib/browser";
import { BUDGET_FILE, REPO, SECRETS_FILE } from "./lib/paths";
import { run, versionOf } from "./lib/proc";
import { secretPresence } from "./lib/secrets";

export const EXIT_NOT_READY = 10;

async function pkgVersion(name: string): Promise<string | null> {
  const f = Bun.file(join(REPO, "node_modules", name, "package.json"));
  return (await f.exists()) ? ((await f.json()) as { version: string }).version : null;
}

export async function collectDoctor() {
  const pinned = /bun\s*=\s*"([^"]+)"/.exec(await Bun.file(join(REPO, "mise.toml")).text())?.[1] ?? null;
  const [just, mise, codexVersion, codexLogin, hostPlaywright] = await Promise.all([
    versionOf(["just", "--version"]),
    versionOf(["mise", "--version"]),
    versionOf(["codex", "--version"]),
    run(["codex", "login", "status"]),
    versionOf(["playwright", "--version"]),
  ]);
  const chromiumPath = findChromium();
  const chromiumVersion = chromiumPath ? await versionOf([chromiumPath, "--version"]) : null;
  const deps = {
    "@agentclientprotocol/sdk": await pkgVersion("@agentclientprotocol/sdk"),
    "@modelcontextprotocol/sdk": await pkgVersion("@modelcontextprotocol/sdk"),
    "@typesafe-ai/sdk": await pkgVersion("@typesafe-ai/sdk"),
    "playwright-core": await pkgVersion("playwright-core"),
  };
  const budget = await readBudget();
  const jevKey = await secretPresence("TYPESAFE_API_KEY");
  const ghId = await secretPresence("GITHUB_CLIENT_ID");
  const ghSecret = await secretPresence("GITHUB_CLIENT_SECRET");

  const checks = {
    bun: { ok: Bun.version === pinned, version: Bun.version, pinned },
    just: { ok: !!just, version: just },
    mise: { ok: !!mise, version: mise },
    dependencies: { ok: Object.values(deps).every(Boolean), installed: deps },
    chromium: { ok: !!chromiumVersion, path: chromiumPath, version: chromiumVersion },
    playwright: { ok: !!deps["playwright-core"], project: deps["playwright-core"], host_cli: hostPlaywright },
    // Live prerequisites: informational.
    codex: {
      installed: !!codexVersion,
      version: codexVersion,
      login: codexLogin.code === 0 ? "logged-in" : "not-logged-in",
      detail: codexLogin.code === 0 ? (codexLogin.stdout || codexLogin.stderr).split("\n")[0] : null,
    },
    typesafe_api_key: { ...jevKey, file: SECRETS_FILE },
    github_oauth_app: { client_id_present: ghId.present, client_secret_present: ghSecret.present, file: SECRETS_FILE },
    budget: {
      file: BUDGET_FILE,
      codex_acp_left: budgetLeft(budget, "codex_acp"),
      jev_left: budgetLeft(budget, "jev"),
      limits: budget.limits,
      codex_acp_build_used: budget.codex_acp.build_used,
    },
  };
  const required = [checks.bun, checks.just, checks.mise, checks.dependencies, checks.chromium, checks.playwright];
  const ready = required.every((c) => c.ok);
  return {
    ready_for_deterministic_checks: ready,
    ready_for_live_acp: ready && checks.codex.login === "logged-in" && checks.budget.codex_acp_left > 0,
    ready_for_live_jev: ready && jevKey.present && checks.budget.jev_left > 0,
    ready_for_live_github: ready && ghId.present && ghSecret.present,
    checks,
  };
}

if (import.meta.main) {
  const report = await collectDoctor();
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ready_for_deterministic_checks ? 0 : EXIT_NOT_READY);
}
