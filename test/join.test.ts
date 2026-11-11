// `patio join <link>`, the one setup command, run as a real CLI process on a fresh home, against the fake GitHub:
// from an agent (no TTY) it prints one link and waits; the person signs in and confirms the computer, the agent and the
// join on one screen. From the person's own terminal only the sign-in is needed. Run again, it changes nothing. A later
// agent of a signed-in person waits for one card; a name without the owner's login is refused.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { daemon } from "../src/local";
import type { Config } from "../src/config";
import { fakeTools, runCli, ttyCli } from "./helpers/cli";
import { startWorld, until, WebClient, type Person, type World } from "./helpers/world";
import { PROCESS_MS } from "./helpers/timeouts";

let world: World;
let link: string;
let wsId: string;
let unai: Person;
const started: string[] = [];

beforeAll(async () => {
  process.env.PATIO_NO_NOTIFY = "1";
  world = await startWorld({ extraUsers: ["ines", "olga", "kim"] });
  unai = await world.person("unai", { team: false });
  const created = await unai.web.post("/workspaces", { name: "orbit" });
  wsId = decodeURIComponent(created.location!.pathname.split("/").pop()!);
  const general = await world.channel(unai.web, wsId, "general");
  await unai.web.post(`/channels/${general}/default`, { default: "1", back: `/workspaces/${wsId}` });
  const code = await world.inviteLink(unai.web, wsId);
  await world.joinByLink(unai, code);
  link = `${world.exchangeUrl}/join/${code}`;
}, PROCESS_MS);

afterAll(async () => {
  // The background patio each run started.
  for (const home of started) {
    const pid = Number(readFileSync(join(home, "patio.pid"), "utf8").trim());
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  await world.stop();
}, PROCESS_MS);

// A fresh person: a PATIO_HOME, a HOME of their own (nothing global is touched), and a project folder.
async function fresh(name: string) {
  const root = await mkdtemp(join(world.dir, `${name}-`));
  const home = join(root, ".patio");
  const folder = join(root, "code", "orbit");
  await mkdir(folder, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: folder });
  started.push(home);
  // No coding tool on PATH, and a stand-in service manager: the join's answer service is written under this HOME.
  const fake = await fakeTools(join(root, "bin"), []);
  const env = {
    PATH: fake.path,
    HOME: root,
    PATIO_HOME: home,
    PATIO_WEB_PORT: "0",
    PATIO_NO_NOTIFY: "1",
    // The answer preflight starts real ACP adapters; test/answer-env.test.ts covers it with the fake one.
    PATIO_NO_PREFLIGHT: "1",
    PATIO_DEVICE_NAME: `${name}-laptop`,
    // Its gates use the world's fake Jev (the server has no judge here).
    TYPESAFE_API_KEY: "world-key",
    PATIO_JEV_URL: world.jev.url,
  };
  const cfg: Config = { home, handle: "", relay: `ws://127.0.0.1:${world.port}`, socket: join(home, "daemon.sock") };
  return { root, home, folder, env, cfg };
}

// Every join here gives the three answers as flags, with the defaults (test/join-answers.test.ts covers asking them).
const ANSWERS = ["--ask", "requests", "--act", "ask-human", "--answer", "no"];
const run = (args: string[], env: Record<string, string>, onLine?: (line: string) => Promise<void> | void) => runCli([...args, ...ANSWERS], env, onLine);
const tty = (args: string[], env: Record<string, string>, onLine?: (line: string) => Promise<void> | void) => ttyCli([...args, ...ANSWERS], env, onLine);

test("from an agent on a fresh home: it waits, the person confirms on one screen, the agent is in the workspace and #general", async () => {
  const p = await fresh("ines");
  let screen = "";
  const r = await run(["join", link, "--tool", "claude", "--folder", p.folder], p.env, async (line) => {
    const m = /^Confirm in your browser: (http:\/\/127\.0\.0\.1:\d+)\/confirm\?code=([\w-]+)$/.exec(line);
    if (!m) return;
    const web = new WebClient(m[1]!);
    await web.signIn("ines");
    screen = await (await web.get(`/confirm?code=${m[2]}`)).text();
    const done = await web.post("/confirm", { code: m[2]!, decision: "confirm" });
    // Its file is written by the join itself once the name is known: until then, the setup is not called finished.
    expect(done.ok).toBe("ines-orbit is your agent on this computer, in orbit and #general. Tell your agent you are done: it still has to finish the setup (patio join).");
  });
  expect(r.code).toBe(0);
  // One screen: the agent (with its tool and folder) and the workspace; Confirm covers the computer, the agent and the join.
  // The folder as the person writes it: ~ for the HOME patio runs with.
  expect(screen).toContain(`Your agent <b>ines-orbit</b> (Claude Code in <span class="mono">~/code/orbit</span>) wants to join <b>orbit</b>`);
  expect(screen).toContain(">Confirm</button>");
  expect(screen).toContain(">Decline</button>");
  // The three answers are on the one screen: the Confirm click covers them too.
  expect(screen).toContain("<p>What orbit may ask ines-orbit: questions and small requests.</p><p>Changing files for them: only when you approve.</p><p>Answering orbit on its own: no.</p>");
  expect(r.out).toContain("✓ patio: started on this computer");
  expect(r.out).toContain("✓ signed in as @ines, and confirmed this computer");
  // Paths as the person writes them: ~ for their home.
  expect(r.out).toContain(`✓ agent ines-orbit: Claude Code in ~/code/orbit (~/.patio/agents/ines-orbit.yaml)`);
  // The invite names the workspace's agents and their owners.
  expect(r.out).toContain("· invite: @unai invited you to orbit: unai-");
  // The one ending, in a fixed shape a prompt keys on.
  expect(r.out).toMatch(/patio is ready: ines-orbit is in orbit\.\nNext: start a new Claude Code session in this folder\.\nTry: ask unai-\d+ a question about their work\.\nWhat needs you: http:\/\/127\.0\.0\.1:\d+\n/);
  // Its file is written, and the server puts it in the workspace and its default channel.
  const file = readFileSync(join(p.home, "agents", "ines-orbit.yaml"), "utf8");
  expect(file).toContain('tool: "claude"');
  expect(file).toContain(`folder: ${JSON.stringify(p.folder)}`);
  const s = await daemon.status(p.cfg);
  expect(s.agents.find((a) => a.name === "ines-orbit")).toMatchObject({ status: "approved", workspaces: ["orbit"], tool: "claude", folder: p.folder });
  // Already a member of #general: joining it again is a no-op that says so.
  const channel = await daemon.join({ ...p.cfg, handle: "ines-orbit" }, { as: "ines-orbit", channel: "orbit/general" });
  expect(channel.status).toBe("approved");
  // Nothing global was touched: no file in the person's HOME but patio's own.
  expect(existsSync(join(p.root, ".claude.json"))).toBe(false);

  // Running it again converges: nothing changes, exit 0.
  const before = statSync(join(p.home, "agents", "ines-orbit.yaml")).mtimeMs;
  const again = await run(["join", link, "--tool", "claude", "--folder", p.folder], p.env);
  expect(again.code).toBe(0);
  expect(again.out).not.toContain("✓");
  // The same ending when nothing changed.
  expect(again.out).toContain("patio is ready: ines-orbit is in orbit.\nNext: start a new Claude Code session in this folder.");
  expect(statSync(join(p.home, "agents", "ines-orbit.yaml")).mtimeMs).toBe(before);
}, PROCESS_MS);

test("a later agent of a signed-in person, from an agent: one card in the web app, then it is in; --no-wait stops at the link", async () => {
  const p = await fresh("olga");
  // First agent, from the person's terminal: only the sign-in.
  const first = await tty(["join", link, "--tool", "codex", "--folder", p.folder, "--no-open"], p.env, async (line) => {
    const m = /Sign in with GitHub to confirm this computer: (http:\/\/127\.0\.0\.1:\d+)(\/setup\?code=[\w-]+)/.exec(line);
    if (!m) return;
    const web = new WebClient(m[1]!);
    await web.signIn("olga");
    expect(await (await web.get(m[2]!)).text()).toContain("Signed in as @olga: this computer is now yours.");
  });
  expect(first.code).toBe(0);
  expect(first.out).toContain("✓ agent olga-orbit: in orbit and #general");
  expect(first.out).not.toContain("Confirm in");

  // A second agent, from an agent: it stops at the card (exit 5); after one click, the same command finishes.
  const side = join(p.root, "code", "side");
  await mkdir(side, { recursive: true });
  const waiting = await run(["join", link, "--agent", "olga-side", "--tool", "pi", "--folder", side, "--no-wait"], p.env);
  expect(waiting.code).toBe(5);
  const url = /Confirm in your web app: (http:\/\/127\.0\.0\.1:\d+)/.exec(waiting.out)![1]!;
  expect(waiting.out).toContain("one card there: olga-side wants to join orbit, with your three answers.");
  const web = new WebClient(url);
  await web.signIn("olga");
  const cards = await (await web.get("/")).text();
  expect(cards).toContain("<b>olga-side</b> <span class=\"meta\">(Pi in <span class=\"mono path\">~/code/side</span>)");
  const action = /action="(\/link-requests\/[^"]+\/decide)"/.exec(cards)![1]!;
  expect((await web.post(action, { decision: "approve" })).ok).toBe("olga-side is in orbit and #general.");
  const done = await run(["join", link, "--agent", "olga-side", "--tool", "pi", "--folder", side, "--no-wait"], p.env);
  expect(done.code).toBe(0);
  expect(done.out).toContain("· agent olga-side: in orbit");
  const s = await daemon.status(p.cfg);
  expect(s.agents.map((a) => [a.name, a.tool, a.workspaces])).toEqual([
    ["olga-orbit", "codex", ["orbit"]],
    ["olga-side", "pi", ["orbit"]],
  ]);

  // A name without the owner's login is refused, with a name to use.
  const wrong = await run(["join", link, "--agent", "pablo-side", "--tool", "pi", "--folder", side], p.env);
  expect(wrong.code).toBe(1);
  expect(wrong.out).toContain("pablo-side is not a name for an agent of @olga: an agent's name starts with its owner's login and a hyphen; try olga-pablo-side");
  expect(existsSync(join(p.home, "agents", "pablo-side.yaml"))).toBe(false);
}, PROCESS_MS);

test("a person removed from the workspace sees the refusal on the one screen, and no Confirm button", async () => {
  // Kim was in orbit, and an admin removed her.
  const kim = await world.person("kim", { team: false });
  await world.joinByLink(kim, link.split("/").pop()!);
  const revoked = await unai.web.post(`/workspaces/${wsId}/revoke`, { login: "kim" });
  expect(revoked.ok).toBe("Removed @kim from the team.");
  await kim.stop();
  // On a new computer, her coding agent runs the join from the invite page's prompt.
  const p = await fresh("kim");
  const r = await run(["join", link, "--tool", "claude", "--folder", p.folder, "--no-wait"], p.env);
  expect(r.code).toBe(5);
  const m = /Confirm in your browser: (http:\/\/127\.0\.0\.1:\d+)(\/confirm\?code=[\w-]+)/.exec(r.out)!;
  const web = new WebClient(m[1]!);
  await web.signIn("kim");
  const screen = await (await web.get(m[2]!)).text();
  expect(screen).toContain("You were removed from orbit: ask one of its admins to let you back in. Decline this one.");
  expect(screen).toContain(">Decline</button>");
  expect(screen).not.toContain(">Confirm</button>");
}, PROCESS_MS);
