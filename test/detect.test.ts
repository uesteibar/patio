// Which coding tool runs `patio join`: the process chain first, then the environment each tool sets, and --tool over
// both when given. Nothing found: null, and the join configures every tool installed.
import { expect, test } from "bun:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectTool, fromEnv, installedTools } from "../src/detect";

const none = () => [];

test("the parent process chain: shells and shims in between are skipped, the first other ancestor decides", () => {
  // patio run as `mise exec -- bun cli.ts` from Pi's bash tool, Pi itself started from a terminal.
  expect(detectTool({ env: {}, ancestors: () => ["bun", "mise", "bash", "pi", "zsh", "tmux: server"] })).toEqual({ tool: "pi", how: "parent" });
  expect(detectTool({ env: {}, ancestors: () => ["bash", "claude"] })).toEqual({ tool: "claude", how: "parent" });
  // macOS: `ps -o comm=` shows the command as invoked, a path or a login shell's "-zsh".
  expect(detectTool({ env: {}, ancestors: () => ["-zsh", "timeout", "/Users/user/.codex/packages/standalone/current/bin/codex"] })).toEqual({ tool: "codex", how: "parent" });
  // The first ancestor that is neither a shim nor a tool ends the walk: a terminal multiplexer started from Pi is not Pi.
  expect(detectTool({ env: {}, ancestors: () => ["bash", "tmux: server", "pi"] })).toBeNull();
  // The chain wins over the environment (a Pi started from Claude Code inherits Claude's markers).
  expect(detectTool({ env: { CLAUDECODE: "1" }, ancestors: () => ["bash", "pi"] })).toEqual({ tool: "pi", how: "parent" });
});

test("the environment each tool sets, when the chain says nothing; AI_AGENT names the innermost tool", () => {
  const env = (e: NodeJS.ProcessEnv) => detectTool({ env: e, ancestors: none });
  expect(env({ CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli" })).toEqual({ tool: "claude", how: "env" });
  expect(env({ PI_CODING_AGENT: "true" })).toEqual({ tool: "pi", how: "env" });
  // Codex's sandbox hides the chain (a process namespace of its own) and sets this.
  expect(env({ CODEX_SANDBOX_NETWORK_DISABLED: "1" })).toEqual({ tool: "codex", how: "env" });
  expect(fromEnv({ AI_AGENT: "claude-code_2-1-319_harness", PI_CODING_AGENT: "true" })).toBe("claude");
  expect(fromEnv({ AI_AGENT: "pi", CLAUDECODE: "1" })).toBe("pi");
  // Two tools' markers and no AI_AGENT: nothing says which one is closer.
  expect(fromEnv({ CLAUDECODE: "1", PI_CODING_AGENT: "true" })).toBeNull();
});

test("--tool wins over detection, only when given", () => {
  expect(detectTool({ flag: "codex", env: { PI_CODING_AGENT: "true" }, ancestors: () => ["bash", "pi"] })).toEqual({ tool: "codex", how: "flag" });
  expect(detectTool({ flag: "hermes-docker", env: {}, ancestors: none })).toEqual({ tool: "hermes-docker", how: "flag" });
});

test("nothing found: null, and the tools installed are the ones on PATH, in a fixed order", () => {
  expect(detectTool({ env: { HOME: "/x", SHELL: "/bin/zsh" }, ancestors: () => ["zsh", "login", "Terminal"] })).toBeNull();
  expect(installedTools((t) => (t === "pi" || t === "claude" ? `/bin/${t}` : null))).toEqual(["claude", "pi"]);
  expect(installedTools(() => null)).toEqual([]);
});

test("the real process chain: patio run by a tool through a shell is that tool", async () => {
  // A stand-in named codex that runs its arguments as a child, the way a tool runs a command.
  const dir = await mkdtemp(join(tmpdir(), "patio-detect-"));
  const codex = join(dir, "codex");
  await writeFile(codex, '#!/bin/sh\n/bin/sh -c "$*"\n');
  await chmod(codex, 0o755);
  const probe = `${process.execPath} -e 'import { detectTool } from "${join(import.meta.dir, "../src/detect.ts")}"; console.log(JSON.stringify(detectTool({ env: {} })))'`;
  const r = Bun.spawnSync([codex, probe], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH! } });
  expect(r.stderr.toString()).toBe("");
  expect(JSON.parse(r.stdout.toString())).toEqual({ tool: "codex", how: "parent" });
});
