// Increment 15, part E: day 2. `patio update` installs the latest patio from the computer's server and restarts patio
// and the answer service; `patio uninstall` stops them, takes the agents out of their workspaces, revokes the computer,
// and removes the project entries patio wrote and their exclude lines. `patio rules <unknown agent>` fails. The MCP
// tools who (offline agents too) and status (read-only).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Config } from "../src/config";
import { daemon } from "../src/local";
import { openDirectory } from "../src/directory";
import { alive, socketOwner } from "../src/lock";
import { loadOrCreateDevice } from "../src/crypto";
import { signedHeaders } from "../src/judge";
import { CLI, fakeTools, runCli, ttyCli } from "./helpers/cli";
import { startWorld, until, WebClient, type Person, type World } from "./helpers/world";
import { PROCESS_MS } from "./helpers/timeouts";

let world: World;
let link: string;
let unai: Person;
const started: string[] = [];

beforeAll(async () => {
  process.env.PATIO_NO_NOTIFY = "1";
  world = await startWorld({ extraUsers: ["uma", "upa", "ula"] });
  unai = await world.person("unai", { team: false });
  const created = await unai.web.post("/workspaces", { name: "orbit" });
  const wsId = decodeURIComponent(created.location!.pathname.split("/").pop()!);
  const code = await world.inviteLink(unai.web, wsId);
  await world.joinByLink(unai, code);
  link = `${world.exchangeUrl}/join/${code}`;
}, PROCESS_MS);
afterAll(async () => {
  for (const home of started) {
    const f = join(home, "patio.pid");
    // A patio without the lock has no pid file: found by its socket.
    const pid = existsSync(f) ? Number(readFileSync(f, "utf8")) : socketOwner(join(home, "daemon.sock"));
    if (pid)
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
  }
  await world.stop();
}, PROCESS_MS);

// A person who joined from their own terminal: patio runs in the background, in a process of its own.
async function joined(login: string, extra: Record<string, string> = {}) {
  const root = await mkdtemp(join(world.dir, `${login}-`));
  const home = join(root, ".patio");
  const folder = join(root, "code", "orbit");
  await mkdir(folder, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: folder });
  started.push(home);
  const fake = await fakeTools(join(root, "bin"), ["claude"]);
  const env = { PATH: fake.path, HOME: root, PATIO_HOME: home, PATIO_WEB_PORT: "0", PATIO_NO_NOTIFY: "1", PATIO_NO_PREFLIGHT: "1", PATIO_DEVICE_NAME: `${login}-laptop`, TYPESAFE_API_KEY: "world-key", PATIO_JEV_URL: world.jev.url, ...extra };
  // A server of the team's in the project file already: it stays.
  await writeFile(join(folder, ".mcp.json"), JSON.stringify({ mcpServers: { linear: { command: "linear-mcp" } } }));
  const r = await ttyCli(["join", link, "--folder", folder, "--tool", "claude", "--connect", "--no-open", "--ask", "requests", "--act", "ask-human", "--answer", "no"], env, async (line) => {
    const m = /Sign in with GitHub to confirm this computer: (http:\/\/127\.0\.0\.1:\d+)(\/setup\?code=[\w-]+)/.exec(line);
    if (!m) return;
    const web = new WebClient(m[1]!);
    await web.signIn(login);
    await web.get(m[2]!);
  });
  const cfg: Config = { home, handle: "", relay: `ws://127.0.0.1:${world.port}`, socket: join(home, "daemon.sock") };
  return { root, home, folder, env, cfg, fake, join: r, unit: join(root, ".config", "systemd", "user", "patio-watch.service") };
}

test("patio uninstall: asks first; then the service, the workspaces, this computer, patio and the project entries go", async () => {
  const p = await joined("uma");
  expect(p.join.out).toContain("✓ git: .mcp.json stays out of your repository (listed in .git/info/exclude)");
  const exclude = join(p.folder, ".git", "info", "exclude");
  expect(readFileSync(exclude, "utf8")).toContain("/.mcp.json");
  expect(existsSync(p.unit)).toBe(true);
  const pid = Number(readFileSync(join(p.home, "patio.pid"), "utf8"));
  const device = (await daemon.status(p.cfg)).device;

  // From no terminal, it needs --yes; nothing changes.
  const refused = await runCli(["uninstall"], p.env);
  expect(refused.code).toBe(1);
  expect(refused.out).toContain("patio uninstall takes patio off this computer for good: run it in your own terminal, or add --yes");
  expect(alive(pid)).toBe(true);

  const r = await runCli(["uninstall", "--yes", "--binary"], p.env);
  expect(r.code).toBe(0);
  expect(r.out).toContain("✓ answer service: stopped and removed");
  expect(r.out).toContain("✓ uma-orbit: out of orbit");
  expect(r.out).toMatch(/✓ this computer \(uma-laptop\): revoked at the server; its keys are refused from now on/);
  expect(r.out).toContain(`✓ patio: stopped (pid ${pid})`);
  expect(r.out).toContain("✓ uma-orbit: patio removed from .mcp.json in ~/code/orbit, and from .git/info/exclude");
  expect(r.out).toContain("· binary: this patio runs from source; nothing to remove");
  expect(r.out).toContain("patio is off this computer. Your agents' files and their history stay in ~/.patio");
  // What it did is true.
  expect(existsSync(p.unit)).toBe(false);
  expect(p.fake.log && readFileSync(p.fake.log, "utf8")).toContain("systemctl --user disable --now patio-watch.service");
  expect(alive(pid)).toBe(false);
  expect(JSON.parse(readFileSync(join(p.folder, ".mcp.json"), "utf8"))).toEqual({ mcpServers: { linear: { command: "linear-mcp" } } });
  expect(readFileSync(exclude, "utf8")).not.toContain("/.mcp.json");
  // Its agent is no longer in orbit, and the server refuses this computer now.
  const roster = (await daemon.who(unai.cfg)).members.map((m) => m.agent);
  expect(roster).not.toContain("uma-orbit");
  const dir = openDirectory(world.dbPath);
  try {
    expect(dir.device(device)?.revoked_at).toBeGreaterThan(0);
  } finally {
    dir.db.close();
  }
}, PROCESS_MS);

// Increment 16: on Unai's Mac, an older patio (no lock, no pid file) was running; uninstall printed "unknown endpoint",
// exited 0 and revoked nothing. Now it revokes with this computer's own key at the server and finds patio by its socket.
test("patio uninstall with a patio that holds no lock: it finds it by its socket, revokes this computer, exits 0, and the agent's name is free", async () => {
  const p = await joined("ula", { PATIO_TEST_NO_LOCK: "1" });
  expect(p.join.out).toContain("✓ agent ula-orbit: in orbit");
  expect(existsSync(join(p.home, "patio.pid"))).toBe(false);
  const device = (await daemon.status(p.cfg)).device;

  const r = await runCli(["uninstall", "--yes"], p.env);
  expect(r.out).not.toContain("unknown endpoint");
  expect(r.code).toBe(0);
  expect(r.out).toContain("✓ ula-orbit: out of orbit");
  expect(r.out).toContain("✓ this computer (ula-laptop): revoked at the server; its keys are refused from now on");
  expect(r.out).toMatch(/✓ patio: stopped \(pid \d+, found by its socket\)/);
  // patio no longer answers on its socket.
  await until("patio to be gone", async () => !(await daemon.status(p.cfg).catch(() => null)));
  const dir = openDirectory(world.dbPath);
  try {
    expect(dir.device(device)?.revoked_at).toBeGreaterThan(0);
  } finally {
    dir.db.close();
  }
  // A new computer of Ula's takes the name.
  const next = await world.gatekeeper();
  await world.onboard(next, "ula", "ula-orbit");
  expect(next.d.agents().find((a) => a.name === "ula-orbit")?.status).toBe("approved");
  await next.stop();

  // Run again: the server says it is revoked already, and that is fine.
  const again = await runCli(["uninstall", "--yes"], p.env);
  expect(again.code).toBe(0);
  expect(again.out).toContain("· this computer (ula-laptop): already revoked at the server");
  expect(again.out).toContain("· patio: not running");
}, PROCESS_MS);

test("patio uninstall when the server refuses or cannot be reached: the reason, the next step, and a non-zero exit", async () => {
  const root = await mkdtemp(join(world.dir, "refused-"));
  const home = join(root, ".patio");
  await mkdir(home, { recursive: true, mode: 0o700 });
  await loadOrCreateDevice(home);
  const env = { PATH: process.env.PATH!, HOME: root, PATIO_HOME: home, PATIO_NO_NOTIFY: "1" };
  const answers: Response[] = [
    Response.json({ error: "unknown endpoint" }, { status: 404 }),
    Response.json({ error: "the request is too old or too new: check this computer's clock" }, { status: 401 }),
  ];
  const server = Bun.serve({ port: 0, fetch: () => answers.shift() ?? new Response("no", { status: 500 }) });
  try {
    await writeFile(join(home, "exchange"), `ws://127.0.0.1:${server.port}\n`);
    // A server from before increment 16: no route for it.
    const old = await runCli(["uninstall", "--yes"], env);
    expect(old.code).toBe(1);
    expect(old.out).not.toContain("unknown endpoint");
    expect(old.out).toContain(`! this computer: the server at http://127.0.0.1:${server.port} cannot revoke it from here (it runs an older patio). Revoke it on the Computers page of patio's web app on another of your computers, or ask the server's operator to update it`);
    expect(old.out).toContain("patio is not fully off this computer: see the lines marked ! above.");
    // The server refuses, with its reason.
    const refused = await runCli(["uninstall", "--yes"], env);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("! this computer: the server refused to revoke it: the request is too old or too new: check this computer's clock. Fix that, then run patio uninstall again");
  } finally {
    server.stop(true);
  }
  // No server there at all.
  await writeFile(join(home, "exchange"), `ws://127.0.0.1:${server.port}\n`);
  const down = await runCli(["uninstall", "--yes"], env);
  expect(down.code).toBe(1);
  expect(down.out).toContain(`! this computer: the server at http://127.0.0.1:${server.port} is not reachable, so this computer is still in your workspaces. Run patio uninstall again once it is reachable`);
}, PROCESS_MS);

test("the server revokes a computer only on a request signed with that computer's key, and each request once", async () => {
  const p = await world.person("uma", { team: false });
  const keys = await loadOrCreateDevice(p.home);
  const stranger = await loadOrCreateDevice(await mkdtemp(join(world.dir, "stranger-")));
  const post = (headers: Record<string, string>, body = "{}") => fetch(`${world.exchangeUrl}/revoke-self`, { method: "POST", headers, body });
  // Signed by another key, in this computer's name.
  const forged = signedHeaders(stranger, "revoke-self", "{}");
  expect((await post({ ...forged, "x-patio-device": keys.id })).status).toBe(401);
  // Signed for something else.
  expect((await post(signedHeaders(keys, "judge", "{}"))).status).toBe(401);
  expect(p.d.isConnected()).toBe(true);
  const real = signedHeaders(keys, "revoke-self", "{}");
  expect(await (await post(real)).json()).toEqual({ state: "revoked", label: expect.any(String), left: [] });
  expect(((await (await post(real)).json()) as { error: string }).error).toBe("this request was already used");
  // Its live connection is closed: the server refuses it from now on.
  await until("the revoked computer to be disconnected", () => !p.d.isConnected());
}, PROCESS_MS);

test("patio update: the latest install.sh from the computer's server, then patio and the answer service restart", async () => {
  const p = await joined("upa");
  const pid = Number(readFileSync(join(p.home, "patio.pid"), "utf8"));
  const marker = join(p.root, "installed");
  const install = Bun.serve({ port: 0, fetch: (req) => (new URL(req.url).pathname === "/install.sh" ? new Response(`#!/bin/sh\necho installed > ${JSON.stringify(marker)}\necho "patio 9.9.9 in ~/.local/bin"\n`) : new Response("no", { status: 404 })) });
  try {
    // The computer's server, as patio join remembered it, serves install.sh.
    await writeFile(join(p.home, "exchange"), `ws://127.0.0.1:${install.port}\n`);
    const r = await runCli(["update"], p.env);
    expect(r.code).toBe(0);
    expect(readFileSync(marker, "utf8").trim()).toBe("installed");
    expect(r.out).toContain(`✓ installed the latest patio from http://127.0.0.1:${install.port} (patio 9.9.9 in ~/.local/bin)`);
    expect(r.out).toMatch(/✓ patio: restarted \(pid \d+\)/);
    expect(r.out).toContain("✓ answer service: restarted");
    expect(readFileSync(p.fake.log, "utf8")).toContain("systemctl --user restart patio-watch.service");
    const now = Number(readFileSync(join(p.home, "patio.pid"), "utf8"));
    expect(now).not.toBe(pid);
    expect(alive(pid)).toBe(false);
    await until("patio answers again", async () => !!(await daemon.status(p.cfg).catch(() => null))?.connected);
  } finally {
    install.stop(true);
  }
}, PROCESS_MS);

test("patio rules <unknown agent> fails: no agent named nobody on this computer", async () => {
  const r = await runCli(["rules", "nobody"], { PATH: process.env.PATH!, HOME: unai.home, PATIO_HOME: unai.home, PATIO_NO_NOTIFY: "1" });
  expect(r.code).toBe(1);
  expect(r.out.trim()).toBe("no agent named nobody on this computer (patio agents)");
}, PROCESS_MS);

test("MCP: status is read-only and says what waits for the owner; who lists offline agents; channels lists the workspaces' channels", async () => {
  const other = await world.person("upa", { team: false });
  await world.joinByLink(other, link.split("/").pop()!);
  await other.stop();
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp", "--as", unai.agent], env: { PATH: process.env.PATH!, HOME: unai.home, PATIO_HOME: unai.home, PATIO_NO_NOTIFY: "1" }, stderr: "pipe" });
  const client = new Client({ name: "lifecycle-test", version: "0" });
  await client.connect(transport);
  try {
    const textOf = (r: unknown) => ((r as { content: { text: string }[] }).content ?? []).map((c) => c.text).join("");
    const tools = (await client.listTools()).tools;
    for (const t of tools) expect(t.description!.split(/(?<=\.) /).length, t.name).toBeLessThanOrEqual(3);
    const status = JSON.parse(textOf(await client.callTool({ name: "status", arguments: {} })));
    expect(status).toMatchObject({ running: true, connected: true, agent: unai.agent, owner: "unai", waiting_for_owner: { questions: 0, messages: 0 } });
    const who = JSON.parse(textOf(await client.callTool({ name: "who", arguments: {} }))) as { agent: string; online: boolean; owner: string; answers?: string }[];
    expect(who.find((w) => w.agent === other.agent)).toMatchObject({ online: false, owner: "upa", answers: "answered by @upa, may take hours" });
    const channels = JSON.parse(textOf(await client.callTool({ name: "channels", arguments: {} })));
    expect(Array.isArray(channels)).toBe(true);
  } finally {
    await client.close();
  }
}, PROCESS_MS);
