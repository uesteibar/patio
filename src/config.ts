import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type Config = {
  home: string;
  // The agent a command or the MCP server acts as: --as, else PATIO_AGENT. Optional when the computer hosts one agent.
  handle: string;
  relay: string;
  socket: string;
};

export function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : resolve(path);
}

// Everything comes from the environment so two people can run side by side on one machine.
export function loadConfig(env = process.env): Config {
  const home = expandHome(env.PATIO_HOME ?? "~/.patio");
  return {
    home,
    handle: env.PATIO_AGENT ?? "",
    // PATIO_RELAY, else the server `patio join` remembered in $PATIO_HOME/exchange, else the local default.
    relay: env.PATIO_RELAY || rememberedExchange(home) || "ws://127.0.0.1:7777",
    socket: socketPath(home, env),
  };
}

// Unix socket paths are capped at about 104 bytes on macOS, so a long home falls back to a per-user
// runtime directory (macOS's tmpdir is already per user). The daemon checks who owns that directory.
export function socketPath(home: string, env = process.env): string {
  const inHome = join(home, "daemon.sock");
  if (Buffer.byteLength(inHome) < 100) return inHome;
  const hash = new Bun.CryptoHasher("sha256").update(home).digest("hex").slice(0, 16);
  const runtime = env.XDG_RUNTIME_DIR ?? tmpdir();
  return join(runtime, `patio-${process.getuid?.() ?? "user"}`, `${hash}.sock`);
}

// The server `patio join` uses for a link that names none: PATIO_SERVER overrides it.
export const DEFAULT_SERVER = "https://patio.example.com";

export function rememberedExchange(home: string): string | null {
  const file = join(home, "exchange");
  return existsSync(file) ? readFileSync(file, "utf8").trim() || null : null;
}

// A path as a person writes it: ~ for their home (HOME), in what patio prints.
export function tilde(path: string | null | undefined): string {
  const home = process.env.HOME;
  if (!path) return "";
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}
