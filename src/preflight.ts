// The answer path's preflight: does the agent's own tool start for the answer service, in the service's own
// environment? `patio join` runs it once the service is installed, and `patio status` again: the ACP adapter starts
// (initialize, and a session in the agent's folder with its model and effort), the tool behind it is found and logged
// in. No prompt, so no model call and nothing spent. A failure says the command, its exit code and its last stderr
// lines (acp.ts startFailure).
//
// The last result of each check (this one, and each tool's listing of patio) is kept in $PATIO_HOME/checks.json, so
// the web app and `patio status` say what is true without running a tool on every page.
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { handshake } from "./acp";
import { prepareRunner, resolveAgent, type AgentChoice } from "./agents";
import { toolLabel } from "./agent-file";
import type { Config } from "./config";
import { serviceSpec } from "./service";
import type { Which } from "./toolpath";

// The environment the answer service runs with: what launchd and systemd give every service (HOME, USER, LOGNAME),
// and what the unit adds (PATIO_HOME, PATH, PATIO_TOOL_*).
export function serviceRunEnv(cfg: Config, o: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; which?: Which } = {}): Record<string, string> {
  const spec = serviceSpec(cfg, { answer: true, platform: o.platform, env: o.env, which: o.which });
  const user = process.env.USER ?? userInfo().username;
  return { HOME: process.env.HOME ?? homedir(), USER: user, LOGNAME: user, ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}), ...spec.env };
}

export type PreflightResult = { ok: true; said: string } | { ok: false; reason: string };

export async function preflight(agent: string, file: AgentChoice, env: Record<string, string>, o: { timeoutMs?: number; log?: (l: string) => void } = {}): Promise<PreflightResult> {
  const r = resolveAgent(agent, file, {}, env);
  if ("error" in r) return { ok: false, reason: r.error };
  if (!existsSync(r.cwd)) return { ok: false, reason: `${agent}'s folder ${r.cwd} does not exist` };
  prepareRunner(env.PATIO_HOME, env);
  try {
    const h = await handshake({
      command: r.command,
      cwd: r.cwd,
      sessionCwd: r.sessionCwd,
      env: r.env,
      baseEnv: env,
      model: r.model,
      effort: r.effort,
      startTimeoutMs: Math.max(r.startTimeoutMs, 120_000),
      loggedIn: r.loggedIn,
      loginHint: r.loginHint,
      timeoutMs: o.timeoutMs ?? 5 * 60_000,
      log: o.log,
    });
    if (!h.logged_in) return { ok: false, reason: r.loginHint ?? `${toolLabel(file.tool)} is not logged in` };
    return { ok: true, said: `${h.agent?.name ?? r.command.join(" ")} started in ${r.cwd}` };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

// ---- the last results -------------------------------------------------------------------------------------------------

export type ToolRecord = { ok: boolean; said: string; step?: string; at: number };
export type Checks = { preflight: Record<string, { ok: boolean; reason?: string; at: number }>; tools: Record<string, Record<string, ToolRecord>> };

const FILE = "checks.json";

export function readChecks(home: string): Checks {
  try {
    const c = JSON.parse(readFileSync(join(home, FILE), "utf8")) as Partial<Checks>;
    return { preflight: c.preflight ?? {}, tools: c.tools ?? {} };
  } catch {
    return { preflight: {}, tools: {} };
  }
}

export async function recordChecks(home: string, update: (c: Checks) => void) {
  if (!existsSync(home)) return;
  const c = readChecks(home);
  update(c);
  await writeFile(join(home, FILE), JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
}

// Whether a preflight should run here: tests and scenarios turn it off (PATIO_NO_PREFLIGHT=1, or PATIO_NO_SERVICE=1).
export const preflightOff = (env = process.env) => env.PATIO_NO_PREFLIGHT === "1" || env.PATIO_NO_SERVICE === "1";
