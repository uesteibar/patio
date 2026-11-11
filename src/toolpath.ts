// The answer service's own environment. A launchd agent or a systemd user unit starts with a minimal PATH, without
// mise, asdf or other shims, so what `patio watch --answer` needs is resolved once, at `patio join` (or `patio service
// install`), from the person's own shell, and written into the service:
//
//   PATH            the folders of each coding tool's command (claude, codex, pi), of node, git and mise, then the
//                   system's own folders. A shim folder is never written: a shim resolves through its own config at
//                   run time, which a service does not have (`mise which <tool>` gives the real binary instead).
//   PATIO_TOOL_PI   the absolute path of `pi`, for pi-acp (PI_ACP_PI_COMMAND), and of `codex` (PATIO_TOOL_CODEX),
//   PATIO_TOOL_CODEX  which a compiled patio gives codex-acp (CODEX_PATH). Claude Code's adapter brings its own binary.
//
// The ACP adapters themselves run through patio (agents.ts runner), so they need nothing on PATH.
import { dirname, isAbsolute } from "node:path";

export type Which = (cmd: string) => string | null;

// Folders of shims, which resolve a version from the current folder's config and fail elsewhere.
const SHIM_DIR = /\/(?:mise|rtx|asdf|\.asdf)\/shims$|\/\.local\/share\/mise\/shims$|\/\.proto\/shims$/;
export const isShim = (path: string) => SHIM_DIR.test(dirname(path));

const SYSTEM_PATH: Record<string, string[]> = {
  darwin: ["/usr/bin", "/bin", "/usr/sbin", "/sbin"],
  linux: ["/usr/local/bin", "/usr/bin", "/bin"],
};

// A command on the person's PATH, as an absolute path a service can run: a mise shim becomes the binary it stands for.
export function resolveTool(cmd: string, o: { path?: string; cwd?: string; which?: Which } = {}): string | null {
  const which: Which = o.which ?? ((c) => Bun.which(c, { PATH: o.path ?? process.env.PATH ?? "" }));
  const found = which(cmd);
  if (!found) return null;
  if (!isShim(found)) return found;
  const mise = which("mise");
  if (!mise) return null;
  const r = Bun.spawnSync([mise, "which", cmd], { cwd: o.cwd, stdout: "pipe", stderr: "ignore", env: { ...process.env, PATH: o.path ?? process.env.PATH ?? "" } });
  const real = r.exitCode === 0 ? r.stdout.toString().trim() : "";
  return real && isAbsolute(real) && !isShim(real) ? real : null;
}

export const TOOL_COMMANDS = ["claude", "codex", "pi"] as const;

// PATH and PATIO_TOOL_* for the answer service.
export function serviceEnvironment(o: { path?: string; platform?: NodeJS.Platform; which?: Which; cwd?: string } = {}): Record<string, string> {
  const platform = o.platform ?? process.platform;
  const resolved = Object.fromEntries([...TOOL_COMMANDS, "node", "git", "mise"].map((c) => [c, resolveTool(c, o)]));
  const dirs = Object.values(resolved)
    .filter((p): p is string => !!p)
    .map(dirname);
  const path = [...new Set([...dirs, ...(SYSTEM_PATH[platform] ?? SYSTEM_PATH.linux!)])].join(":");
  return { PATH: path, ...(resolved.codex ? { PATIO_TOOL_CODEX: resolved.codex } : {}), ...(resolved.pi ? { PATIO_TOOL_PI: resolved.pi } : {}) };
}
