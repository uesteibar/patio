// Which coding tool answers for an agent, and in which folder: the agent's file ($PATIO_HOME/agents/<name>.yaml,
// agent-file.ts), used by `patio answer` and `patio watch --answer` (patio itself never starts an agent). The command
// flags (--tool, --folder, --in-place) win over the file.
//
// A preset names a responder: its command, and the cheapest model at low effort. The model and effort are set
// for the session only (through the agent's ACP session options, or CODEX_CONFIG for Codex); nothing is written
// to the agent's own global configuration.
import type * as acp from "@agentclientprotocol/sdk";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandHome } from "./config";

export const HERMES_IMAGE = "patio-hermes-test:local";
export const HERMES_VOLUME = "patio-hermes-test-home";
export const HERMES_LOGIN_DOC = "docs/research/hermes-docker-probe.md";

// Hermes advertises its "configure a provider" terminal login always, and its runtime credentials as a second
// auth method only when a provider resolves with a key. Without them a prompt cannot reach any model.
export function hermesLoggedIn(init: acp.InitializeResponse): boolean {
  return (init.authMethods ?? []).some((m) => !("type" in m) || (m as { type?: string }).type !== "terminal");
}

export type Preset = {
  command: (cwd: string) => string[];
  model: string | null;
  effort: string | null;
  // Extra environment for the agent process; undefined removes a variable.
  // `base`: the environment the agent starts from (the answer service's, or this process's).
  env?: (o: { model: string | null; effort: string | null; base: NodeJS.ProcessEnv }) => Record<string, string | undefined>;
  // The working directory as the agent sees it, when it differs (inside a container).
  sessionCwd?: string;
  // How long initialize and session/new may take.
  startTimeoutMs?: number;
  // Checked on the handshake, before any prompt: false means the agent cannot answer until its owner logs in.
  loggedIn?: (init: acp.InitializeResponse) => boolean;
  loginHint?: string;
};

// The ACP adapters run through patio itself, so they need nothing on PATH (a launchd or systemd service has a minimal
// PATH, without mise or other shims): `<patio> x <package>` is `bunx <package>`. In source mode patio is the Bun binary
// (process.execPath). A compiled patio is Bun too, and BUN_BE_BUN=1 makes it act as Bun; a package whose script asks
// for node gets Bun as node when node is not on PATH.
//
// BUN_BE_BUN reaches what the adapter starts, and a coding tool that is itself a compiled Bun program (Pi) would act as
// Bun with it: in a compiled patio, pi-acp starts Pi through $PATIO_HOME/bin/pi, which drops it (prepareRunner).
// Claude Code ignores it; Codex's adapter starts the codex the join resolved (CODEX_PATH), else its own.
let RUNNER = { exec: process.execPath, compiled: !/\.[cm]?[jt]s$/.test(Bun.main) };
// The probe (scripts/probe-answer.ts) runs the adapters through a compiled patio binary.
export const setRunner = (exec: string, compiled: boolean) => void (RUNNER = { exec, compiled });
export const runner = (exec = RUNNER.exec) => [exec, "x"];
export const runnerEnv = (): Record<string, string> => (RUNNER.compiled ? { BUN_BE_BUN: "1" } : {});
export const runnerCompiled = () => RUNNER.compiled;

// What a compiled runner needs before an adapter starts: $PATIO_HOME/bin/pi, which starts Pi without BUN_BE_BUN.
export function prepareRunner(home: string | undefined, base: NodeJS.ProcessEnv = process.env) {
  if (!RUNNER.compiled || !home) return;
  const target = base.PATIO_TOOL_PI || "pi";
  const dir = join(home, "bin");
  const file = join(dir, "pi");
  const text = `#!/bin/sh\n# Written by patio: starts Pi for the answer service without BUN_BE_BUN (which makes a compiled Bun program act as Bun).\nunset BUN_BE_BUN\nexec ${JSON.stringify(target)} "$@"\n`;
  if (existsSync(file) && readFileSync(file, "utf8") === text) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, text, { mode: 0o755 });
  chmodSync(file, 0o755);
}

// Pinned so a new adapter release cannot change behaviour under you.
export const PRESETS: Record<string, Preset> = {
  codex: {
    command: () => [...runner(), "@agentclientprotocol/codex-acp@2.5.0"],
    model: "gpt-6-luna",
    effort: "low",
    // codex-acp merges this JSON into each session's Codex config; ~/.codex is not touched.
    env: ({ model, effort, base }) => ({ ...runnerEnv(), ...(runnerCompiled() && base.PATIO_TOOL_CODEX ? { CODEX_PATH: base.PATIO_TOOL_CODEX } : {}), CODEX_CONFIG: JSON.stringify({ ...(model && { model }), ...(effort && { model_reasoning_effort: effort }) }) }),
  },
  claude: {
    command: () => [...runner(), "@agentclientprotocol/claude-agent-acp@0.101.0"],
    model: "haiku",
    effort: "low",
    env: () => runnerEnv(),
  },
  pi: {
    command: () => [...runner(), "pi-acp@0.0.34"],
    model: "anthropic/claude-haiku-5-5",
    effort: "low",
    // The owner's default Pi agent dir (~/.pi/agent), whatever the calling shell has set. pi-acp starts `pi`: the
    // absolute path the join resolved (PATIO_TOOL_PI, in the answer service's environment), else `pi` on PATH.
    env: ({ base }) => ({
      ...runnerEnv(),
      PI_CODING_AGENT_DIR: undefined,
      ...(runnerCompiled() ? { PI_ACP_PI_COMMAND: join(base.PATIO_HOME || join(homedir(), ".patio"), "bin", "pi") } : base.PATIO_TOOL_PI ? { PI_ACP_PI_COMMAND: base.PATIO_TOOL_PI } : {}),
    }),
  },
  // Hermes in Docker, apart from any real installation: its own HERMES_HOME in a volume, the working directory
  // mounted read-only. The model is the one picked with `hermes model` in the volume. The container's entrypoint
  // starts s6 and a gateway first, so `hermes acp` answers initialize only after 20 to 30 seconds.
  "hermes-docker": {
    command: (cwd) => ["docker", "run", "--rm", "-i", "-v", `${HERMES_VOLUME}:/opt/data`, "-v", `${cwd}:/work:ro`, HERMES_IMAGE, "hermes", "acp"],
    model: null,
    effort: "low",
    sessionCwd: "/work",
    startTimeoutMs: 120_000,
    loggedIn: hermesLoggedIn,
    loginHint: `Hermes in Docker is not logged in to a model provider: see ${HERMES_LOGIN_DOC}`,
  },
  gemini: { command: () => ["gemini", "--acp"], model: null, effort: null },
};

export const DEFAULT_START_TIMEOUT_MS = 60_000;

// What the agent's file (or the flags) say: the tool, its folder, and whether it answers in place.
export type AgentChoice = { tool?: string; folder?: string; model?: string; effort?: string; in_place?: boolean };

export type ResolvedAgent = {
  // The preset's name, or "command" for a command line.
  name: string;
  // The agent as configured (a preset name or a command line), to launch it again in another directory.
  agent: string;
  // Run in the configured directory itself rather than in a disposable git worktree of it.
  inPlace: boolean;
  command: string[];
  cwd: string;
  sessionCwd: string;
  model: string | null;
  effort: string | null;
  env: Record<string, string | undefined>;
  startTimeoutMs: number;
  loggedIn?: (init: acp.InitializeResponse) => boolean;
  loginHint?: string;
  source: string;
};

export function presetAgent(agent: string, cwd: string, over: { model?: string | null; effort?: string | null; base?: NodeJS.ProcessEnv } = {}): Omit<ResolvedAgent, "source" | "agent" | "inPlace"> {
  const p: Preset = Object.hasOwn(PRESETS, agent) ? PRESETS[agent]! : { command: () => agent.split(" ").filter(Boolean), model: null, effort: null };
  const model = over.model ?? p.model;
  const effort = over.effort ?? p.effort;
  return {
    name: Object.hasOwn(PRESETS, agent) ? agent : "command",
    command: p.command(cwd),
    cwd,
    sessionCwd: p.sessionCwd ?? cwd,
    model,
    effort,
    env: p.env?.({ model, effort, base: over.base ?? process.env }) ?? {},
    startTimeoutMs: p.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
    ...(p.loggedIn && { loggedIn: p.loggedIn, loginHint: p.loginHint }),
  };
}

export function resolveAgent(name: string, file: AgentChoice, flags: AgentChoice, base?: NodeJS.ProcessEnv): ResolvedAgent | { error: string } {
  const pick = <K extends keyof AgentChoice>(k: K) => flags[k] ?? file[k];
  const tool = pick("tool");
  const folder = pick("folder");
  if (!tool) return { error: `no tool for ${name}: set tool and folder in agents/${name}.yaml, or pass --tool and --folder` };
  if (!folder) return { error: `no folder for ${name}: set folder in agents/${name}.yaml, or pass --folder` };
  return {
    ...presetAgent(tool, expandHome(folder), { model: pick("model"), effort: pick("effort"), base }),
    agent: tool,
    inPlace: pick("in_place") ?? false,
    source: flags.tool && flags.folder ? "flags" : `agents/${name}.yaml`,
  };
}
