// Increment 8: responder presets set the model and effort for the session, through the agent's ACP session
// options; an agent that is not logged in is reported before any prompt. Uses the fake ACP agent.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentNotLoggedIn, handshake, runAgent } from "../src/acp";
import { hermesLoggedIn } from "../src/agents";
import type { Fixture, LogEntry } from "./fakes/fake-acp-agent";
import { PROCESS_MS } from "./helpers/timeouts";

const FAKE = join(import.meta.dir, "fakes/fake-acp-agent.ts");

async function setup(fixture: Fixture) {
  const dir = await mkdtemp(join(tmpdir(), "patio-responders-"));
  const cwd = join(dir, "repo");
  await mkdir(cwd, { recursive: true });
  await writeFile(join(dir, "fixture.json"), JSON.stringify(fixture));
  const logFile = join(dir, "agent.jsonl");
  const command = [process.execPath, FAKE, "--fixture", join(dir, "fixture.json"), "--log", logFile];
  const events = async (): Promise<LogEntry[]> => (await readFile(logFile, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  const lines: string[] = [];
  return { cwd, command, events, lines, log: (l: string) => void lines.push(l) };
}

const OPTIONS = [
  { id: "model", category: "model", current: "default", options: ["default", "haiku", "sonnet"] },
  { id: "effort", category: "thought_level", current: "high", options: ["low", "medium", "high"] },
];

test("the preset's model and effort are set as session options before the prompt, and logged", async () => {
  const t = await setup({ configOptions: OPTIONS, steps: [{ id: "r", tool: "read", title: "Read README", permission: false }], reply: "ok" });
  const run = await runAgent({ command: t.command, cwd: t.cwd, prompt: "x", model: "haiku", effort: "low", log: t.log });
  expect(run).toMatchObject({ reply: "ok", model: "haiku", effort: "low", tools: 1 });
  const events = (await t.events()).map((e) => e.event === "set_config_option" ? `${e.configId}=${e.value}` : e.event);
  expect(events.indexOf("model=haiku")).toBeLessThan(events.indexOf("prompt"));
  expect(events.indexOf("effort=low")).toBeLessThan(events.indexOf("prompt"));
  expect(t.lines).toContain('model "haiku", effort "low"');
}, PROCESS_MS);

test("an option already at the wanted value is left alone (Codex gets its model from CODEX_CONFIG)", async () => {
  const t = await setup({ configOptions: [{ id: "model", category: "model", current: "gpt-6-luna", options: ["gpt-6-luna"] }], reply: "ok" });
  await runAgent({ command: t.command, cwd: t.cwd, prompt: "x", model: "gpt-6-luna", effort: null, log: t.log });
  expect((await t.events()).some((e) => e.event === "set_config_option")).toBe(false);
}, PROCESS_MS);

test("a model the agent does not offer fails before any prompt, so it never runs on another model", async () => {
  const t = await setup({ configOptions: OPTIONS, reply: "ok" });
  const err = await runAgent({ command: t.command, cwd: t.cwd, prompt: "x", model: "gpt-9", effort: "low" }).catch((e) => e as Error);
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toContain('model "gpt-9"');
  expect((err as Error).message).toContain("default, haiku, sonnet");
  expect((await t.events()).some((e) => e.event === "prompt")).toBe(false);
}, PROCESS_MS);

test("an agent without a model option runs on its own model, and the log says so", async () => {
  const t = await setup({ reply: "ok" });
  const run = await runAgent({ command: t.command, cwd: t.cwd, prompt: "x", model: "haiku", effort: "low", log: t.log });
  expect(run).toMatchObject({ reply: "ok", model: null, effort: null });
  expect(t.lines).toContain("model: the agent reports no model option; it uses its own configuration");
}, PROCESS_MS);

test("the session cwd can differ from the process cwd (a container sees the repo at /work); env is passed, undefined unsets", async () => {
  const t = await setup({ reply: "ok" });
  process.env.PATIO_FAKE_ENV = "from-parent";
  try {
    await runAgent({ command: t.command, cwd: t.cwd, sessionCwd: "/work", env: { PATIO_FAKE_ENV: undefined }, prompt: "x" });
    expect((await t.events()).find((e) => e.event === "session/new")).toMatchObject({ cwd: "/work", env: { PATIO_FAKE_ENV: null } });
    await runAgent({ command: t.command, cwd: t.cwd, env: { PATIO_FAKE_ENV: "set" }, prompt: "x" });
    expect((await t.events()).filter((e) => e.event === "session/new")[1]).toMatchObject({ env: { PATIO_FAKE_ENV: "set" } });
  } finally {
    delete process.env.PATIO_FAKE_ENV;
  }
}, PROCESS_MS);

const SETUP_ONLY = [{ id: "hermes-setup", name: "Configure Hermes provider", type: "terminal", args: ["--setup"] }] as Fixture["authMethods"];

test("an agent that is not logged in fails before the prompt with the login hint", async () => {
  const t = await setup({ authMethods: SETUP_ONLY, reply: "ok" });
  const err = await runAgent({ command: t.command, cwd: t.cwd, prompt: "x", loggedIn: hermesLoggedIn, loginHint: "see the probe doc" }).catch((e) => e);
  expect(err).toBeInstanceOf(AgentNotLoggedIn);
  expect((err as Error).message).toBe("not logged in: see the probe doc");
  expect((await t.events()).some((e) => e.event === "prompt")).toBe(false);
}, PROCESS_MS);

test("the handshake opens a session without a prompt and reports agent, login, model, effort and mode", async () => {
  const t = await setup({ authMethods: SETUP_ONLY, configOptions: OPTIONS, reply: "ok" });
  const h = await handshake({ command: t.command, cwd: t.cwd, model: "haiku", effort: "low", loggedIn: hermesLoggedIn });
  expect(h).toMatchObject({ session: true, logged_in: false, model: "haiku", effort: "low", mode: "default" });
  expect(h.initialize_ms).toBeGreaterThanOrEqual(0);
  expect((await t.events()).some((e) => e.event === "prompt")).toBe(false);
}, PROCESS_MS);

test("a start that takes longer than the start timeout fails clearly", async () => {
  const t = await setup({ startDelayMs: 2_000, reply: "ok" });
  const err = await runAgent({ command: t.command, cwd: t.cwd, prompt: "x", startTimeoutMs: 300 }).catch((e) => e as Error);
  expect((err as Error).message).toBe("the agent did not start within 0.3 s");
}, PROCESS_MS);
