// Increment 16: moving to a new computer. On Unai's Mac, the next join's Confirm failed with "uesteibar-orbit lives on
// another of your computers", with no way out on that screen. Now the confirmation screen says which computer and when
// it was last seen, and offers one action, Move; a join from the person's terminal asks there. The old computer loses
// that agent (and is revoked only when it has no agent left). The join's ending says what teammates will see, and a
// teammate's key change card names the owner and the new computer.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../src/config";
import { openDirectory } from "../src/directory";
import { daemon } from "../src/local";
import { pickTeammate } from "../src/join";
import { fakeTools, runCli, ttyCli } from "./helpers/cli";
import { startWorld, until, WebClient, type Person, type World } from "./helpers/world";
import { PROCESS_MS } from "./helpers/timeouts";

let world: World;
let link: string;
let code: string;
let unai: Person;
const started: string[] = [];

beforeAll(async () => {
  process.env.PATIO_NO_NOTIFY = "1";
  world = await startWorld({ extraUsers: ["ines", "olga", "pia"] });
  unai = await world.person("unai", { team: false });
  const created = await unai.web.post("/workspaces", { name: "orbit" });
  const wsId = decodeURIComponent(created.location!.pathname.split("/").pop()!);
  code = await world.inviteLink(unai.web, wsId);
  await world.joinByLink(unai, code);
  link = `${world.exchangeUrl}/join/${code}`;
}, PROCESS_MS);

afterAll(async () => {
  for (const home of started) {
    const f = join(home, "patio.pid");
    if (existsSync(f))
      try {
        process.kill(Number(readFileSync(f, "utf8")), "SIGTERM");
      } catch {}
  }
  await world.stop();
}, PROCESS_MS);

async function computer(name: string) {
  const root = await mkdtemp(join(world.dir, `${name}-`));
  const home = join(root, ".patio");
  const folder = join(root, "code", "orbit");
  await mkdir(folder, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: folder });
  started.push(home);
  const fake = await fakeTools(join(root, "bin"), []);
  const env = { PATH: fake.path, HOME: root, PATIO_HOME: home, PATIO_WEB_PORT: "0", PATIO_NO_NOTIFY: "1", PATIO_NO_PREFLIGHT: "1", PATIO_DEVICE_NAME: name, TYPESAFE_API_KEY: "world-key", PATIO_JEV_URL: world.jev.url };
  const cfg: Config = { home, handle: "", relay: `ws://127.0.0.1:${world.port}`, socket: join(home, "daemon.sock") };
  return { root, home, folder, env, cfg };
}

const ANSWERS = ["--ask", "requests", "--act", "ask-human", "--answer", "no"];
const MOVED_LINE = "Your teammates' patio will ask them to trust this computer's new keys before your messages reach them.";

// The join as a coding agent runs it: the person opens the link, signs in, sees the screen and clicks `decision`.
async function agentJoin(p: Awaited<ReturnType<typeof computer>>, login: string, decision: string, seen: (screen: string, res: { ok?: string | null; error?: string | null }) => void) {
  return runCli(["join", link, "--tool", "claude", "--folder", p.folder, ...ANSWERS], p.env, async (line) => {
    const m = /^Confirm in your browser: (http:\/\/127\.0\.0\.1:\d+)\/confirm\?code=([\w-]+)$/.exec(line);
    if (!m) return;
    const web = new WebClient(m[1]!);
    await web.signIn(login);
    const screen = await (await web.get(`/confirm?code=${m[2]}`)).text();
    seen(screen, await web.post("/confirm", { code: m[2]!, decision }));
  });
}

test("a join on a second computer for an agent of the first: Move on the one screen, then a teammate's card names the owner and the new computer", async () => {
  // Pablo's agent in orbit (a teammate), and Ines's first computer.
  const pablo = await world.person("pia", { team: false });
  await world.joinByLink(pablo, code);
  const laptop = await computer("ines-laptop");
  const first = await agentJoin(laptop, "ines", "confirm", () => {});
  expect(first.code).toBe(0);
  // Pablo's patio pins ines-orbit's keys on first contact.
  const hello = await daemon.send(pablo.cfg, { to: "ines-orbit", kind: "question", text: "Which branch has the fix?" });
  expect(hello.status).toBe("delivered");
  const laptopDevice = (await daemon.status(laptop.cfg)).device;
  // The laptop is off when she sets up the new computer.
  process.kill(Number(readFileSync(join(laptop.home, "patio.pid"), "utf8")), "SIGTERM");
  await until("the laptop's patio to stop", async () => !(await daemon.status(laptop.cfg).catch(() => null)));

  // Her new computer: the same agent.
  const mac = await computer("ines-mac");
  let screen = "";
  let moved: { ok?: string | null; error?: string | null } = {};
  const r = await agentJoin(mac, "ines", "move", (s, res) => {
    screen = s;
    moved = res;
  });
  expect(screen).toContain("<b>ines-orbit</b> lives on your other computer <b>ines-laptop</b> (last seen just now).");
  expect(screen).toContain(">Move ines-orbit to this computer</button>");
  expect(screen).not.toContain(">Confirm</button>");
  // Its only agent moves, so the laptop is revoked too.
  expect(screen).toContain("ines-laptop has no other agent, so it is revoked too.");
  expect(moved.ok).toContain("ines-orbit moved here from ines-laptop, and is your agent on this computer, in orbit.");
  expect(r.code).toBe(0);
  expect(r.out).toContain(`patio is ready: ines-orbit is in orbit.\nNext: start a new Claude Code session in this folder.\n${MOVED_LINE}\nTry:`);
  const s = await daemon.status(mac.cfg);
  expect(s.agents.find((a) => a.name === "ines-orbit")).toMatchObject({ status: "approved", workspaces: ["orbit"] });
  const dir = openDirectory(world.dbPath);
  try {
    expect(dir.agent("ines-orbit")?.device_id).toBe(s.device);
    expect(dir.device(laptopDevice)?.revoked_at).toBeGreaterThan(0);
  } finally {
    dir.db.close();
  }

  // Pablo writes again: his patio holds it for the new keys, and the card says whose agent and which computer.
  const again = await daemon.send(pablo.cfg, { to: "ines-orbit", kind: "question", text: "And the tests?" });
  expect(again.status).toBe("held");
  const page = await (await pablo.web.get("/")).text();
  expect(page).toContain(`data-keys="ines-orbit"`);
  expect(page).toContain("The server now gives other keys for <b>ines-orbit</b>, an agent of @ines, now on the computer <b>ines-mac</b>");
}, PROCESS_MS);

test("the same case from the person's terminal: it asks there; the old computer keeps its other agent and is not revoked", async () => {
  // Olga's first computer, with two agents.
  const first = await world.person("olga", { agent: "olga-orbit", team: false });
  await world.joinByLink(first, code);
  await daemon.register(first.cfg, "olga-side", true);
  const oldDevice = (await daemon.status(first.cfg)).device;
  const oldLabel = (await daemon.status(first.cfg)).label;

  const p = await computer("olga-mac");
  const asked: string[] = [];
  const r = await ttyCli(
    ["join", link, "--tool", "claude", "--folder", p.folder, "--no-open", ...ANSWERS],
    p.env,
    async (line) => {
      const m = /Sign in with GitHub to confirm this computer: (http:\/\/127\.0\.0\.1:\d+)(\/setup\?code=[\w-]+)/.exec(line);
      if (!m) return;
      const web = new WebClient(m[1]!);
      await web.signIn("olga");
      await web.get(m[2]!);
    },
    {
      onData: (out, write) => {
        const last = out.slice(out.lastIndexOf("\n") + 1);
        if (/Move it to this computer\? \[y\/N\] $/.test(last) && !asked.length) {
          asked.push(last);
          write("y\r");
        }
      },
    },
  );
  expect(asked[0]).toMatch(new RegExp(`^olga-orbit lives on your other computer ${oldLabel} \\(online now\\)\\. Move it to this computer\\? \\[y/N\\] $`));
  expect(r.out).toContain(`✓ agent olga-orbit: moved here from ${oldLabel}, in orbit`);
  expect(r.out).toContain(MOVED_LINE);
  expect(r.code).toBe(0);
  const dir = openDirectory(world.dbPath);
  try {
    expect(dir.agent("olga-orbit")?.device_id).toBe((await daemon.status(p.cfg)).device);
    expect(dir.device(oldDevice)?.revoked_at).toBeNull();
    expect(dir.agent("olga-side")?.device_id).toBe(oldDevice);
  } finally {
    dir.db.close();
  }
  // The old computer hears it: olga-orbit is no longer its agent.
  await until("the old computer to lose olga-orbit", () => !first.d.agents().some((a) => a.name === "olga-orbit"));

  // From a coding agent on the signed-in new computer, for olga-side (still on the old one): it stops and says how.
  const fromAgent = await runCli(["join", link, "--agent", "olga-side", "--tool", "claude", "--folder", p.folder, ...ANSWERS], p.env);
  expect(fromAgent.code).toBe(1);
  expect(fromAgent.out).toContain(`olga-side lives on your other computer ${oldLabel} (online now). To move it to this computer, run the same patio join in your own terminal and answer yes; or give this computer's agent another name with --agent.`);
}, PROCESS_MS);

// Increment 16: `Try:` suggested erin-orbit, an offline demo agent, on Unai's Mac.
test("Try: an online agent of the workspace (the inviter's first), else the inviter's agent; never an offline one when one is online", () => {
  const roster = [
    { agent: "erin-orbit", owner: "erin", answers: "self" as const },
    { agent: "unai-orbit", owner: "unai", answers: "owner" as const },
    { agent: "pablo-orbit", owner: "pablo", answers: "owner" as const },
    { agent: "rosa-orbit", owner: "rosa", answers: "self" as const },
    { agent: "ines-orbit", owner: "ines", answers: "self" as const },
  ];
  // Erin's demo agent is offline; Pablo's is online.
  expect(pickTeammate(roster, ["pablo-orbit"], "ines", "unai")).toBe("pablo-orbit");
  // Online, one that answers on its own comes before one that waits for its person.
  expect(pickTeammate(roster, ["pablo-orbit", "rosa-orbit"], "ines", "unai")).toBe("rosa-orbit");
  // The inviter's agent, when it is online, comes first.
  expect(pickTeammate(roster, ["pablo-orbit", "rosa-orbit", "unai-orbit"], "ines", "unai")).toBe("unai-orbit");
  // Nobody online: the inviter's agent.
  expect(pickTeammate(roster, [], "ines", "unai")).toBe("unai-orbit");
  // Never one's own agent.
  expect(pickTeammate(roster, ["ines-orbit"], "ines", "unai")).toBe("unai-orbit");
  expect(pickTeammate([{ agent: "ines-orbit", owner: "ines" }], ["ines-orbit"], "ines", "unai")).toBeNull();
});
