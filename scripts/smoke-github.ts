// just smoke-github --yes-live: a real GitHub OAuth sign-in. Needs GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET
// in the main checkout's .env (exit 2 when absent). Starts an exchange configured for github.com on a fixed
// port and a gatekeeper, prints the web app address, and waits for a human to sign in there in a browser.
// Passes when the exchange learns a GitHub login and the web app shows it signed in.
//
// The GitHub OAuth app's callback URL must be http://127.0.0.1:<port>/auth/github/callback, with <port> from
// PATIO_SMOKE_GITHUB_PORT (default 7781). GitHub also accepts loopback redirects on other ports, but using
// the registered port avoids depending on that.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../src/config";
import { startDaemon } from "../src/daemon";
import { startExchange } from "../src/exchange";
import { gitState } from "./lib/git";
import { EXIT_FAIL, EXIT_NO_FLAG, EXIT_NO_KEY } from "./lib/live";
import { INSTANCES_DIR, SECRETS_FILE, VERIFY_DIR } from "./lib/paths";
import { readSecret } from "./lib/secrets";

if (import.meta.main) {
  if (!process.argv.includes("--yes-live")) {
    console.error("smoke-github signs in with the real GitHub. Re-run with --yes-live to confirm.");
    process.exit(EXIT_NO_FLAG);
  }
  const clientId = await readSecret("GITHUB_CLIENT_ID");
  const clientSecret = await readSecret("GITHUB_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    const missing = [!clientId && "GITHUB_CLIENT_ID", !clientSecret && "GITHUB_CLIENT_SECRET"].filter(Boolean).join(" and ");
    console.error(`smoke-github: ${missing} absent from ${SECRETS_FILE}. Create a GitHub OAuth app (Unai's step) and add them there. Nothing was started.`);
    process.exit(EXIT_NO_KEY);
  }
  const port = Number(process.env.PATIO_SMOKE_GITHUB_PORT ?? 7781);
  const timeoutMs = Number(process.env.PATIO_SMOKE_GITHUB_TIMEOUT ?? 300) * 1000;
  const root = join(INSTANCES_DIR, `smoke-github-${Date.now()}`);
  await mkdir(join(root, "gk"), { recursive: true, mode: 0o700 });
  process.env.PATIO_NO_NOTIFY = "1";

  let signedIn: string | null = null;
  const log: string[] = [];
  const exchange = startExchange({
    port,
    db: join(root, "exchange.db"),
    github: { clientId, clientSecret, webUrl: "https://github.com", apiUrl: "https://api.github.com" },
    log: (line) => {
      log.push(line);
      const m = /^@(\S+) signed in with GitHub/.exec(line);
      if (m) signedIn = m[1]!;
    },
  });
  const cfg: Config = { home: join(root, "gk"), handle: "", relay: `ws://127.0.0.1:${port}`, socket: join(root, "gk", "daemon.sock") };
  const gk = await startDaemon(cfg, { log: (line) => log.push(`[gatekeeper] ${line}`) });
  console.error(`Open ${gk.webUrl} in a browser on this machine and sign in with GitHub (waiting ${timeoutMs / 1000} s).`);
  console.error(`The OAuth app's callback URL must be http://127.0.0.1:${port}/auth/github/callback.`);

  const started = Date.now();
  while (!signedIn && Date.now() - started < timeoutMs) await Bun.sleep(500);
  const ok = !!signedIn;
  await gk.stop();
  exchange.stop(true);

  const git = await gitState();
  const report = {
    ok,
    label: "live",
    revision: git.revision,
    dirty: git.dirty,
    at: new Date().toISOString(),
    github_login: signedIn,
    seconds_waited: Math.round((Date.now() - started) / 1000),
    // The exchange log lines; they hold no tokens (the exchange never logs or keeps the GitHub token).
    log,
  };
  await mkdir(join(VERIFY_DIR, "live"), { recursive: true });
  const file = join(VERIFY_DIR, "live", `github-${report.at.replace(/[:.]/g, "-")}.json`);
  await Bun.write(file, JSON.stringify(report, null, 2) + "\n");
  console.error(`${ok ? "PASS" : "FAIL"} smoke-github${ok ? ` (@${signedIn})` : ": nobody signed in before the timeout"}; report ${file}`);
  console.log(JSON.stringify({ ok, github_login: signedIn, report: file }, null, 2));
  process.exit(ok ? 0 : EXIT_FAIL);
}
