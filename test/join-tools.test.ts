// `patio join <link> --connect` sets up every coding tool it finds and proves each one lists patio. The scenario runs
// the real CLI with no terminal on a fresh home, with stand-ins for Claude Code and Pi on PATH (test/helpers/cli.ts):
// started from "Pi", the join detects Pi from its process chain, configures both tools in the agent's folder, installs
// the answer service, and exits 12 with each tool's step while the tools still need the person's trust; once they
// trust the folder, the same join exits 0. Nothing detected and no terminal: it stops with the command to run with
// --tool; in a terminal it asks once.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { daemon } from "../src/local";
import type { Config } from "../src/config";
import { fakeTools, runCli, ttyCli } from "./helpers/cli";
import { startWorld, WebClient, type World } from "./helpers/world";
import { PROCESS_MS } from "./helpers/timeouts";

let world: World;
let link: string;
const started: string[] = [];

beforeAll(async () => {
  process.env.PATIO_NO_NOTIFY = "1";
  world = await startWorld({ extraUsers: ["pia", "tess", "nora", "ola", "tom"] });
  const unai = await world.person("unai", { team: false });
  const created = await unai.web.post("/workspaces", { name: "orbit" });
  const wsId = decodeURIComponent(created.location!.pathname.split("/").pop()!);
  const code = await world.inviteLink(unai.web, wsId);
  await world.joinByLink(unai, code);
  link = `${world.exchangeUrl}/join/${code}`;
}, PROCESS_MS);

afterAll(async () => {
  for (const home of started) {
    const pidFile = join(home, "patio.pid");
    if (!existsSync(pidFile)) continue;
    try {
      process.kill(Number(readFileSync(pidFile, "utf8").trim()), "SIGTERM");
    } catch {}
  }
  await world.stop();
}, PROCESS_MS);

// A fresh person with stand-ins for these coding tools; PATH has no real coding tool.
async function fresh(name: string, tools: ("claude" | "codex" | "pi")[]) {
  const root = await mkdtemp(join(world.dir, `${name}-`));
  const home = join(root, ".patio");
  const folder = join(root, "code", "orbit");
  await mkdir(folder, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: folder });
  started.push(home);
  const fake = await fakeTools(join(root, "bin"), tools);
  const env = {
    PATH: fake.path,
    HOME: root,
    PATIO_HOME: home,
    PATIO_WEB_PORT: "0",
    PATIO_NO_NOTIFY: "1",
    // The answer preflight starts real ACP adapters; test/answer-env.test.ts covers it with the fake one.
    PATIO_NO_PREFLIGHT: "1",
    PATIO_DEVICE_NAME: `${name}-laptop`,
    TYPESAFE_API_KEY: "world-key",
    PATIO_JEV_URL: world.jev.url,
  };
  const cfg: Config = { home, handle: "", relay: `ws://127.0.0.1:${world.port}`, socket: join(home, "daemon.sock") };
  const calls = () => (existsSync(fake.log) ? readFileSync(fake.log, "utf8").trim().split("\n") : []);
  return { root, home, folder, env, cfg, fake, calls };
}

// Signs in as `login` and clicks Confirm on the one screen the join's link opens.
const confirm = (login: string) => async (line: string) => {
  const m = /^Confirm in your browser: (http:\/\/127\.0\.0\.1:\d+)\/confirm\?code=([\w-]+)$/.exec(line);
  if (!m) return;
  const web = new WebClient(m[1]!);
  await web.signIn(login);
  await web.post("/confirm", { code: m[2]!, decision: "confirm" });
};

test("started from Pi with Claude Code and Pi installed: both configured, both kept out of git; only Pi, the agent's own tool, blocks (exit 12) until it lists patio", async () => {
  const p = await fresh("pia", ["claude", "pi"]);
  const args = ["join", link, "--folder", p.folder, "--connect", "--ask", "requests", "--act", "ask-human", "--answer", "no"];
  const viaPi = { prefix: [join(p.fake.dir, "pi")], cwd: p.folder };

  const first = await runCli(args, p.env, confirm("pia"), viaPi);
  expect(first.out).toContain("· tool: Pi (detected from the running process)");
  expect(first.out).toContain("✓ signed in as @pia, and confirmed this computer");
  // Its file: the detected tool answers for it.
  const file = readFileSync(join(p.home, "agents", "pia-orbit.yaml"), "utf8");
  expect(file).toContain('tool: "pi"');
  expect(file).toContain("auto_answer: false");
  // Every tool installed, configured in the agent's folder; nothing global.
  expect(first.out).toContain(`· connect: Claude Code, Pi (every coding tool found), as pia-orbit in ~/code/orbit`);
  expect(JSON.parse(readFileSync(join(p.folder, ".mcp.json"), "utf8")).mcpServers.patio.args.slice(-3)).toEqual(["mcp", "--as", "pia-orbit"]);
  expect(JSON.parse(readFileSync(join(p.folder, ".pi", "mcp.json"), "utf8")).mcpServers.patio.args.slice(-3)).toEqual(["mcp", "--as", "pia-orbit"]);
  expect(existsSync(join(p.root, ".claude.json"))).toBe(false);
  expect(existsSync(join(p.root, ".pi"))).toBe(false);
  // The project files stay out of the team's repository: listed in .git/info/exclude, with one line that says so.
  expect(first.out).toContain("✓ git: .mcp.json and .pi/mcp.json stay out of your repository (listed in .git/info/exclude)");
  const exclude = readFileSync(join(p.folder, ".git", "info", "exclude"), "utf8");
  expect(exclude).toContain("\n/.mcp.json\n/.pi/mcp.json\n");
  const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: p.folder }).stdout.toString();
  expect(status).toBe("");
  // Each tool's own listing command, in the folder: both still wait for the person.
  expect(p.calls()).toContain("claude mcp list");
  expect(p.calls()).toContain("pi mcp list --json");
  // Only the agent's own tool blocks; the other one is said, and waits for nobody.
  expect(first.out).toContain("· Claude Code: written; trust this folder in Claude Code to use patio there");
  expect(first.out).not.toContain("! Claude Code");
  expect(first.out).toContain(`! Pi: start pi in ~/code/orbit once and accept the trust prompt, then run this command again`);
  expect(first.out).toContain(`(Pi says: ~/code/orbit/.pi/mcp.json is ignored because the project is not trusted. Start pi in the project to trust it.)`);
  expect(first.out).toContain("not finished: pia-orbit is in orbit, but Pi does not list patio yet. Do the step above, then run the same patio join again.");
  expect(first.out).not.toContain("patio is ready");
  expect(first.code).toBe(12);
  // The answer service, installed once, and no contact's auto-answer turned on.
  const unit = join(p.root, ".config", "systemd", "user", "patio-watch.service");
  expect(readFileSync(unit, "utf8")).toContain(" watch --answer\n");
  expect(first.out).toContain(`✓ answering: the service will answer for your agents (~/.config/systemd/user/patio-watch.service)`);
  expect(p.calls().filter((c) => c === "systemctl --user enable patio-watch.service")).toHaveLength(1);
  const s = await daemon.status(p.cfg);
  expect(s.agents.find((a) => a.name === "pia-orbit")).toMatchObject({ status: "approved", workspaces: ["orbit"], tool: "pi" });
  expect(s.pending.rules).toBe(0);

  // Pi trusted: the join passes, although Claude Code still waits for the person's trust.
  await p.fake.trust(p.root, "pi", p.folder);
  const second = await runCli(args, p.env, undefined, viaPi);
  expect(second.out).toContain("· Pi: lists patio");
  expect(second.out).toContain("· Claude Code: written; trust this folder in Claude Code to use patio there");
  expect(second.out).toContain("· git: .mcp.json and .pi/mcp.json stay out of your repository (.git/info/exclude)");
  expect(second.out).toContain("patio is ready: pia-orbit is in orbit.\nNext: start a new Pi session in this folder.");
  expect(second.code).toBe(0);

  // Both trusted: the same join passes, and changes nothing else.
  await p.fake.trust(p.root, "claude", p.folder);
  const third = await runCli(args, p.env, undefined, viaPi);
  expect(third.out).toContain("· Claude Code: lists patio");
  expect(third.out).toContain("· Pi: lists patio");
  expect(third.out).toContain("· answering: the service will answer for your agents");
  expect(third.out).not.toContain("✓");
  expect(third.out).toContain("patio is ready: pia-orbit is in orbit.");
  expect(third.code).toBe(0);
  // The service was installed by the first join only.
  expect(p.calls().filter((c) => c.startsWith("systemctl --user enable"))).toHaveLength(1);
  expect(readFileSync(join(p.home, "agents", "pia-orbit.yaml"), "utf8")).toBe(file);
  // --tool on a later run does not rewrite the agent's file: it says so.
  const flagged = await runCli([...args, "--tool", "claude"], p.env, undefined, viaPi);
  expect(flagged.out).toContain("· tool: Claude Code (from --tool)");
  expect(flagged.out).toContain(`  note: pia-orbit's file says Pi answers for it; patio keeps that (edit ~/.patio/agents/pia-orbit.yaml to change it)`);
  expect(flagged.code).toBe(0);
  expect(readFileSync(join(p.home, "agents", "pia-orbit.yaml"), "utf8")).toBe(file);
}, PROCESS_MS);

test("a project file the team's repository already tracks is left as it is, with a warning that names it", async () => {
  const p = await fresh("tom", ["claude"]);
  await Bun.write(join(p.folder, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
  Bun.spawnSync(["git", "add", ".mcp.json"], { cwd: p.folder });
  Bun.spawnSync(["git", "-c", "user.email=t@x", "-c", "user.name=t", "commit", "-q", "-m", "team mcp"], { cwd: p.folder });
  const r = await runCli(["join", link, "--folder", p.folder, "--connect", "--tool", "claude", "--ask", "requests", "--act", "ask-human", "--answer", "no"], p.env, confirm("tom"));
  expect(r.out).toContain("  warning: .mcp.json is tracked in this repository: patio's entry in it (tom-orbit, and a path on this computer) reaches your team when you commit it. patio left it as it is.");
  expect(existsSync(join(p.folder, ".git", "info", "exclude")) ? readFileSync(join(p.folder, ".git", "info", "exclude"), "utf8") : "").not.toContain("/.mcp.json");
}, PROCESS_MS);

test("nothing detected and no terminal: it stops before anything is written, with the command to run with --tool", async () => {
  const p = await fresh("tess", ["claude", "pi"]);
  const r = await runCli(["join", link, "--folder", p.folder, "--connect", "--no-wait"], p.env, undefined, { prefix: [join(p.fake.dir, "term")] });
  expect(r.out).toContain("· tool: none detected; installed: Claude Code, Pi");
  expect(r.out).toContain(`patio could not tell which coding tool runs this command. Run it again with the tool that answers for your agent (claude, pi):\n  patio join ${link} --folder ${p.folder} --connect --no-wait --tool claude`);
  expect(r.code).toBe(1);
  expect(existsSync(join(p.home, "agents", "tess-orbit.yaml"))).toBe(false);
  expect(r.out).not.toContain("Confirm in");
  // --tool, given: it goes on to the link.
  const flagged = await runCli(["join", link, "--folder", p.folder, "--connect", "--no-wait", "--tool", "claude", "--ask", "requests", "--act", "ask-human", "--answer", "no"], p.env, undefined, { prefix: [join(p.fake.dir, "term")] });
  expect(flagged.out).toContain("· tool: Claude Code (from --tool)");
  expect(flagged.code).toBe(5);
}, PROCESS_MS);

test("nothing detected, in the person's terminal: it asks once, from the tools installed, the first as the default", async () => {
  const p = await fresh("nora", ["codex", "pi"]);
  let answered = false;
  const r = await ttyCli(
    ["join", link, "--folder", p.folder, "--no-open", "--ask", "requests", "--act", "ask-human", "--answer", "no"],
    p.env,
    async (line) => {
      const m = /Sign in with GitHub to confirm this computer: (http:\/\/127\.0\.0\.1:\d+)(\/setup\?code=[\w-]+)/.exec(line);
      if (!m) return;
      const web = new WebClient(m[1]!);
      await web.signIn("nora");
      await web.get(m[2]!);
    },
    {
      prefix: [join(p.fake.dir, "term")],
      onData: (out, write) => {
        if (answered || !out.includes("Which coding tool answers for your agent? (codex, pi) [codex] ")) return;
        answered = true;
        write("pi\r");
      },
    },
  );
  expect(answered).toBe(true);
  expect(r.code).toBe(0);
  expect(readFileSync(join(p.home, "agents", "nora-orbit.yaml"), "utf8")).toContain('tool: "pi"');
}, PROCESS_MS);

test("the join checks the answer path in the service's own environment: `· answering: checked`, or a `!` step with the reason", async () => {
  const p = await fresh("ola", []);
  const env = { ...p.env, PATIO_NO_PREFLIGHT: "" };
  const fixture = join(p.root, "fixture.json");
  await Bun.write(fixture, JSON.stringify({ reply: "ok" }));
  const tool = `${process.execPath} ${join(import.meta.dir, "fakes/fake-acp-agent.ts")} --fixture ${fixture}`;
  const args = ["join", link, "--folder", p.folder, "--tool", tool, "--ask", "requests", "--act", "ask-human", "--answer", "no"];
  const r = await runCli(args, env, confirm("ola"));
  expect(r.out).toContain("· answering: checked");
  expect(r.code).toBe(0);
  const checks = JSON.parse(readFileSync(join(p.home, "checks.json"), "utf8"));
  expect(checks.preflight["ola-orbit"]).toMatchObject({ ok: true });

  // The tool in the agent's file breaks: the same join says why, as a step for the person, and exits 12.
  const broken = join(p.root, "broken-acp");
  await Bun.write(broken, "#!/bin/sh\necho 'cannot find pi' >&2\nexit 4\n");
  Bun.spawnSync(["chmod", "+x", broken]);
  const file = join(p.home, "agents", "ola-orbit.yaml");
  await Bun.write(file, readFileSync(file, "utf8").replace(/^tool: .*$/m, `tool: ${JSON.stringify(broken)}`));
  const again = await runCli(args, env);
  expect(again.out).toContain(`! answering: ${broken} does not start for the answer service: \`${broken}\` exited with code 4; its last lines: cannot find pi`);
  expect(again.code).toBe(12);
}, PROCESS_MS);
