// Which coding tool runs this command. No agent can know which tool it runs in, so `patio join` finds out itself, and
// the invite page's prompt never asks:
//
//   1. parent: the process chain. Walk this process's ancestors, skip shells and shims (sh, bash, zsh, env, mise, npx,
//      bun, node, sudo, timeout…), and the first one left decides: claude, codex or pi. It does not depend on any
//      tool's environment. /proc/<pid>/comm and /proc/<pid>/stat on Linux, `ps -o ppid=,comm=` elsewhere (macOS shows
//      the command as invoked, a path or a name: its last part counts).
//   2. env: the markers each tool exports to the commands it runs (MARKERS below), when the chain says nothing (an
//      ancestor hidden by a sandbox, or a tool started through a launcher).
//   3. flag: `--tool` wins over both, only when given.
//
// Nothing detected: the join configures every tool installed, and asks (or is told with --tool) which one answers.
import { existsSync, readFileSync } from "node:fs";
import { CONNECT_TOOLS, type ConnectTool } from "./connect";

export type DetectHow = "parent" | "env" | "flag";
export type Detected = { tool: string; how: DetectHow };

// Shells and launchers between a tool and this process; they say nothing about which tool it is.
export const SHIMS = new Set(["sh", "bash", "zsh", "dash", "fish", "env", "mise", "npx", "bunx", "bun", "node", "sudo", "timeout", "direnv", "nohup", "nice", "stdbuf", "xargs", "patio"]);

// The environment each tool sets for the commands it runs, verified on 9 Nov 2026 (Linux; the variables are set by
// each tool's process, so they are the same on macOS):
//   - Claude Code 2.1.318: `claude mcp list` in a project whose .mcp.json starts a server that writes `env` to a file:
//     CLAUDECODE=1, CLAUDE_CODE_ENTRYPOINT=sdk-cli, CLAUDE_CODE_SESSION_ID, AI_AGENT=claude-code_2-1-319_harness.
//   - Pi 1.4.0: the same with `pi mcp list` (AI_AGENT=pi, PI_CODING_AGENT=true), and `env` in Pi's own bash tool in a
//     live session (AI_AGENT=pi, PI_CODING_AGENT=true, PI_SESSION_ID).
//   - Codex 0.166.0: `codex sandbox -- sh -c env`, a command run in the sandbox Codex runs its shell commands in:
//     CODEX_SANDBOX_NETWORK_DISABLED=1, and no parent chain (the sandbox has a process namespace of its own).
// AI_AGENT names the innermost tool (Claude Code and Pi each set it for their children), so it wins over the others,
// which a tool started from another tool inherits. Codex's own markers outside its sandbox (CODEX_THREAD_ID, say) are
// in its binary but were not observed without a model run, so they are not used.
type Marker = { tool: ConnectTool; test: (env: NodeJS.ProcessEnv) => boolean };
export const MARKERS: Marker[] = [
  { tool: "claude", test: (e) => e.CLAUDECODE === "1" || !!e.CLAUDE_CODE_ENTRYPOINT },
  { tool: "pi", test: (e) => e.PI_CODING_AGENT === "true" },
  { tool: "codex", test: (e) => e.CODEX_SANDBOX_NETWORK_DISABLED === "1" },
];

export function fromEnv(env: NodeJS.ProcessEnv): ConnectTool | null {
  const ai = env.AI_AGENT ?? "";
  if (ai.startsWith("claude-code")) return "claude";
  if (ai === "pi") return "pi";
  const hits = MARKERS.filter((m) => m.test(env)).map((m) => m.tool);
  // Two tools' markers and no AI_AGENT: one started the other, and nothing says which is closer.
  return hits.length === 1 ? hits[0]! : null;
}

const toolName = (comm: string): string => {
  const base = comm.trim().split("/").pop()!.replace(/^-/, "");
  return base.toLowerCase();
};

// The first ancestor that is not a shell or a shim, if it is one of the tools.
export function fromAncestors(names: string[]): ConnectTool | null {
  for (const raw of names) {
    const name = toolName(raw);
    if (SHIMS.has(name)) continue;
    return (CONNECT_TOOLS as readonly string[]).includes(name) ? (name as ConnectTool) : null;
  }
  return null;
}

// The names of this process's ancestors, its parent first.
export function ancestors(pid = process.ppid, max = 32): string[] {
  const out: string[] = [];
  const linux = existsSync("/proc/self/stat");
  for (let i = 0; i < max && pid > 1; i++) {
    try {
      if (linux) {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        out.push(readFileSync(`/proc/${pid}/comm`, "utf8").trim());
        pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      } else {
        const r = Bun.spawnSync(["ps", "-o", "ppid=,comm=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
        const m = /^\s*(\d+)\s+(.*)$/.exec(r.stdout.toString().trim());
        if (!m) break;
        out.push(m[2]!);
        pid = Number(m[1]);
      }
    } catch {
      break;
    }
  }
  return out;
}

export function detectTool(o: { flag?: string; env?: NodeJS.ProcessEnv; ancestors?: () => string[] } = {}): Detected | null {
  if (o.flag) return { tool: o.flag, how: "flag" };
  const parent = fromAncestors((o.ancestors ?? ancestors)());
  if (parent) return { tool: parent, how: "parent" };
  const env = fromEnv(o.env ?? process.env);
  return env ? { tool: env, how: "env" } : null;
}

// The coding tools patio connects that are on PATH, in a fixed order.
export const installedTools = (which: (cmd: string) => string | null = Bun.which): ConnectTool[] => CONNECT_TOOLS.filter((t) => !!which(t));

export const HOW: Record<DetectHow, string> = {
  parent: "detected from the running process",
  env: "detected from the environment it sets",
  flag: "from --tool",
};
