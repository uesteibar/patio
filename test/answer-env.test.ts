// Increment 15, part A: the answer service answers in its own environment. A launchd or systemd unit has a minimal
// PATH, without mise or other shims: the ACP adapters run through patio itself (`<patio> x <package>`), the coding tools
// are resolved to absolute paths at join time, and a tool that fails says the command, its exit code and its last
// stderr lines. The answer runs here as the service runs it: `patio watch --once --answer` with only the service's
// environment, and nothing of this shell's PATH.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { prepareRunner, presetAgent, runner, setRunner } from "../src/agents";
import { startFailure } from "../src/acp";
import { daemon, waitForReply } from "../src/local";
import { preflight, serviceRunEnv } from "../src/preflight";
import { isShim, resolveTool, serviceEnvironment } from "../src/toolpath";
import { CLI } from "./helpers/cli";
import { startWorld, until, type Person, type World } from "./helpers/world";
import { PROCESS_MS } from "./helpers/timeouts";

const FAKE = join(import.meta.dir, "fakes/fake-acp-agent.ts");
let world: World;
let alice: Person;
let bob: Person;
let fixture: string;
let failing: string;
let repo: string;

beforeAll(async () => {
  process.env.PATIO_NO_NOTIFY = "1";
  world = await startWorld();
  alice = await world.person("alice");
  const dir = await mkdtemp(join(world.dir, "bob-"));
  repo = join(dir, "repo");
  await mkdir(repo, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
  Bun.spawnSync(["git", "-c", "user.email=b@x", "-c", "user.name=b", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
  fixture = join(dir, "fixture.json");
  await writeFile(fixture, JSON.stringify({ reply: "the deploy is green" }));
  failing = join(dir, "broken-acp");
  await writeFile(failing, "#!/bin/sh\necho 'starting the adapter' >&2\necho 'error: pi: command not found' >&2\nexit 3\n");
  await chmod(failing, 0o755);
  bob = await world.person("bob", { home: join(dir, ".patio"), grants: "defaults:\n  auto_answer: true\n", file: { tool: `${process.execPath} ${FAKE} --fixture ${fixture}`, folder: repo } });
}, PROCESS_MS);

afterAll(async () => {
  await world.stop();
}, PROCESS_MS);

test("the presets start their ACP adapter through patio itself (Bun as `x`), never through bunx on PATH", () => {
  for (const [tool, pkg] of [
    ["codex", "@agentclientprotocol/codex-acp@2.5.0"],
    ["claude", "@agentclientprotocol/claude-agent-acp@0.101.0"],
    ["pi", "pi-acp@0.0.34"],
  ] as const) {
    const p = presetAgent(tool, "/srv/repo");
    expect(p.command).toEqual([process.execPath, "x", pkg]);
    // Bun runs Bun's `x` as it is: nothing to add.
    expect("BUN_BE_BUN" in p.env).toBe(false);
  }
  expect(runner("/usr/local/bin/patio")).toEqual(["/usr/local/bin/patio", "x"]);
  // pi-acp starts the `pi` the join resolved, from the service's environment.
  expect(presetAgent("pi", "/srv/repo", { base: { PATIO_TOOL_PI: "/opt/pi/bin/pi" } }).env.PI_ACP_PI_COMMAND).toBe("/opt/pi/bin/pi");
  expect("PI_ACP_PI_COMMAND" in presetAgent("pi", "/srv/repo", { base: {} }).env).toBe(false);
});

test("a compiled patio acts as Bun for the adapter (BUN_BE_BUN=1), and starts Pi through a wrapper that drops it", async () => {
  const home = await mkdtemp(join(world.dir, "compiled-"));
  setRunner("/usr/local/bin/patio", true);
  try {
    const base = { PATIO_HOME: home, PATIO_TOOL_PI: "/opt/pi/bin/pi", PATIO_TOOL_CODEX: "/opt/codex/bin/codex" };
    const pi = presetAgent("pi", "/srv/repo", { base });
    expect(pi.command).toEqual(["/usr/local/bin/patio", "x", "pi-acp@0.0.34"]);
    expect(pi.env).toMatchObject({ BUN_BE_BUN: "1", PI_ACP_PI_COMMAND: join(home, "bin", "pi") });
    // Codex's adapter starts the codex the join found, not its own through patio.
    expect(presetAgent("codex", "/srv/repo", { base }).env).toMatchObject({ BUN_BE_BUN: "1", CODEX_PATH: "/opt/codex/bin/codex" });
    expect(presetAgent("claude", "/srv/repo", { base }).env).toEqual({ BUN_BE_BUN: "1" });
    prepareRunner(home, base);
    const wrapper = readFileSync(join(home, "bin", "pi"), "utf8");
    expect(wrapper).toContain("unset BUN_BE_BUN\nexec \"/opt/pi/bin/pi\" \"$@\"\n");
    // Run: the variable does not reach what it starts.
    const probe = join(home, "env-probe");
    await writeFile(probe, "#!/bin/sh\necho \"BUN_BE_BUN=${BUN_BE_BUN:-unset}\"\n");
    await chmod(probe, 0o755);
    prepareRunner(home, { PATIO_TOOL_PI: probe });
    const out = Bun.spawnSync([join(home, "bin", "pi")], { env: { BUN_BE_BUN: "1", PATH: "/usr/bin:/bin" }, stdout: "pipe" }).stdout.toString();
    expect(out.trim()).toBe("BUN_BE_BUN=unset");
  } finally {
    setRunner(process.execPath, false);
  }
  expect(existsSync(join(home, "bin", "pi"))).toBe(true);
});

test("the service's PATH holds each tool's own folder and the system's, never a shim folder; pi is written as an absolute path", () => {
  const found: Record<string, string> = {
    claude: "/home/u/.local/bin/claude",
    codex: "/home/u/.local/share/mise/shims/codex",
    pi: "/opt/pi/bin/pi",
    node: "/home/u/.local/share/mise/installs/node/24/bin/node",
    git: "/usr/bin/git",
  };
  const env = serviceEnvironment({ platform: "darwin", which: (c) => found[c] ?? null });
  expect(env.PATH).toBe("/home/u/.local/bin:/opt/pi/bin:/home/u/.local/share/mise/installs/node/24/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  expect(env.PATH).not.toContain("shims");
  expect(env.PATIO_TOOL_PI).toBe("/opt/pi/bin/pi");
  expect(isShim("/home/u/.local/share/mise/shims/bun")).toBe(true);
  // A shim with no mise to resolve it is left out, rather than written as a command that fails in a service.
  expect(resolveTool("codex", { which: (c) => found[c] ?? null })).toBeNull();
  expect(serviceEnvironment({ platform: "linux", which: () => null })).toEqual({ PATH: "/usr/local/bin:/usr/bin:/bin" });
});

test("the service answers from a minimal PATH: watch --once --answer with only the service's environment", async () => {
  const sent = await daemon.send(alice.cfg, { to: bob.agent, kind: "question", text: "Is the staging deploy green?" });
  await until("bob has it", async () => (await daemon.inbox(bob.cfg)).messages.some((m) => m.id === sent.id));
  // Exactly what launchd or systemd gives the unit: HOME, USER, LOGNAME and the unit's own variables. No tool is on
  // this machine's PATH for the test: only the system's folders.
  const env: Record<string, string> = { ...serviceRunEnv(bob.cfg, { which: () => null }), PATIO_NO_NOTIFY: "1" };
  expect(env.PATH).toBe(process.platform === "darwin" ? "/usr/bin:/bin:/usr/sbin:/sbin" : "/usr/local/bin:/usr/bin:/bin");
  const proc = Bun.spawn([process.execPath, CLI, "watch", "--once", "--answer"], { env, cwd: "/", stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  expect(await proc.exited).toBe(0);
  expect(JSON.parse(out.trim())).toMatchObject({ id: sent.id, result: "answered" });
  expect(err).not.toContain("aborted");
  expect((await waitForReply(alice.cfg, sent.convo, 10))?.text).toBe("the deploy is green");
}, PROCESS_MS);

test("a tool that fails says the command, its exit code and its last stderr lines, never 'The operation was aborted'", async () => {
  const said = startFailure({ command: ["/usr/bin/bun", "x", "pi-acp@0.0.34"], code: 1, stderr: ["", "Resolving dependencies", "error: pi: command not found"] });
  expect(said).toBe("`/usr/bin/bun x pi-acp@0.0.34` exited with code 1; its last lines: Resolving dependencies | error: pi: command not found");
  expect(startFailure({ command: ["bunx", "pi-acp"], code: null, stderr: [], error: Object.assign(new Error("spawn bunx ENOENT"), { code: "ENOENT" }) })).toBe("`bunx` was not found");

  const r = await preflight("bob-x", { tool: failing, folder: repo }, serviceRunEnv(bob.cfg, { which: () => null }));
  expect(r).toEqual({ ok: false, reason: `\`${failing}\` exited with code 3; its last lines: starting the adapter | error: pi: command not found` });
  const ok = await preflight("bob-x", { tool: `${process.execPath} ${FAKE} --fixture ${fixture}`, folder: repo }, serviceRunEnv(bob.cfg, { which: () => null }));
  expect(ok.ok).toBe(true);

  // The same failure, through the answer: the message is marked failed with the reason.
  const sent = await daemon.send(alice.cfg, { to: bob.agent, kind: "question", text: "And production?" });
  await until("bob has it", async () => (await daemon.inbox(bob.cfg)).messages.some((m) => m.id === sent.id));
  const proc = Bun.spawn([process.execPath, CLI, "answer", sent.id, "--tool", failing, "--folder", repo], { env: { ...serviceRunEnv(bob.cfg, { which: () => null }), PATIO_NO_NOTIFY: "1" }, stdout: "pipe", stderr: "pipe" });
  const err = await new Response(proc.stderr).text();
  expect(await proc.exited).toBe(10);
  expect(err).toContain(`the agent failed: \`${failing}\` exited with code 3; its last lines: starting the adapter | error: pi: command not found; the message is marked failed`);
  expect(err).not.toContain("aborted");
}, PROCESS_MS);
