// Isolated patio instances: a fake GitHub provider, one exchange configured for it and one gatekeeper
// (daemon) per agent, all real processes, each agent with its own PATIO_HOME and device keys, and the
// exchange's database, all under .dev/instances/<id>/. Nothing here reads or writes ~/.patio.
//
// `up` onboards every agent the way a human would: sign in with (fake) GitHub in the gatekeeper's web app,
// pair the gatekeeper with a code, ask for the agent identity and approve it in the web app, then join a shared
// workspace with an invite link from the person's terminal (created by the first agent's owner, who makes the link),
// and any channels named in the spec (created by the workspace's admin, public). Each agent's file
// (agents/<handle>.yaml) holds its tool, folder and rules.
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { socketPath } from "../../src/config";
import { HANDLE_RE } from "../../src/protocol";
import { INSTANCES_DIR, PATIO_CLI, REPO } from "./paths";
import { WebClient } from "./webclient";
import { gitState } from "./git";
import type { FakeJevFixture } from "../../test/fakes/fake-jev";
import { agentFileText, type AgentFileSpec } from "../../test/helpers/agent-file";

// The gates always run, and each message gets a prompt-injection check, so every instance runs a fake Jev
// (a test double) unless told not to. This fixture lets everything through.
export const BENIGN_JEV: FakeJevFixture = { default: { type: "noul", noul: 0.02 }, answers: { allow: { type: "noul", noul: 0.98 } } };
export const FAKE_JEV_KEY = "fake-jev-key";

export type AgentSpec = {
  // The agent identity (also its directory name).
  handle: string;
  // The owner's GitHub login at the fake provider (alice, bob, carol, dave, jorge, unai). Defaults to handle.
  login?: string;
  // Workspace to join, created by the first agent that names it. Defaults to "team"; null joins none.
  workspace?: string | null;
  // false: leave the gatekeeper signed out, unpaired and without an identity.
  onboard?: boolean;
  // Channels of its workspace to join (created as public channels by the workspace admin if missing).
  channels?: string[];
  // Which tool answers for the agent, and where, in the old agent.yaml shape (agent, cwd, model, effort, in_place),
  // written to its file (agents/<handle>.yaml) before the daemon starts. A function gets the agent's directory,
  // whose parent is the instance root.
  agentConfig?: string | ((agentDir: string) => string | Promise<string>);
  // Extra environment for this agent's daemon only (and so for the agents it starts), e.g. CODEX_CONFIG.
  env?: Record<string, string>;
  // The agent's rules, in the old rules.yaml shape (defaults, contacts, channels), written to its file.
  grants?: string;
  // More agents of the same person on the same computer: each with its own file, registered by the owner and put in
  // the same workspace.
  extra?: { name: string; file: AgentFileSpec | ((agentDir: string) => AgentFileSpec | Promise<AgentFileSpec>) }[];
};

// The old agent.yaml shape as an agent's file: agent is the tool, cwd the folder.
export function agentConfigSpec(text: string): AgentFileSpec {
  const raw = ((Bun.YAML.parse(text) ?? {}) as Record<string, unknown>);
  if (raw.workspaces || raw.channels) throw new Error("an agent's tool and folder have no per-workspace or per-channel overrides any more");
  const out: AgentFileSpec = {};
  if (raw.agent !== undefined) out.tool = String(raw.agent);
  if (raw.cwd !== undefined) out.folder = String(raw.cwd);
  if (raw.model !== undefined) out.model = String(raw.model);
  if (raw.effort !== undefined) out.effort = String(raw.effort);
  if (raw.in_place !== undefined) out.in_place = raw.in_place === true;
  return out;
}

export type ProcEntry = { pid: number; pgid: number; start: string | null; log: string };

export type AgentEntry = ProcEntry & {
  handle: string;
  login: string;
  workspace: string | null;
  dir: string;
  home: string;
  socket: string;
  web_url: string;
  env_keys: string[];
};

export type Manifest = {
  id: string;
  root: string;
  created_at: string;
  revision: string;
  dirty: boolean;
  github: ProcEntry & { port: number; url: string; client_id: string; client_secret: string };
  // `judge`: the exchange's own judge (judge.ts) is the instance's fake Jev.
  exchange: ProcEntry & { port: number; url: string; db: string; judge?: boolean };
  // The instance's fake Jev; null when the instance runs without one (live recipes, or "Jev is down").
  jev: (ProcEntry & { port: number; url: string; fixture: string; requests: string }) | null;
  agents: Record<string, AgentEntry>;
  // `link`: an invite link's code, which every agent joins with.
  workspaces: Record<string, { id: string; admin: string; link: string; channels?: Record<string, string> }>;
  // Agents beyond each entry's own (spec `extra`), by name: the entry (computer) that hosts them.
  extra?: Record<string, string>;
  stopped_at?: string;
};

export class IsolationError extends Error {}

// A home must sit inside its instance root, and never be ~/.patio (or inside it).
export function assertSafeHome(home: string, instanceRoot: string) {
  const abs = resolve(home);
  const userHome = resolve(homedir(), ".patio");
  if (abs === userHome || abs.startsWith(userHome + sep)) throw new IsolationError(`refusing ${abs}: that is the user's ~/.patio`);
  const rel = relative(resolve(instanceRoot), abs);
  if (!rel || rel.startsWith("..") || resolve(instanceRoot, rel) !== abs)
    throw new IsolationError(`refusing PATIO_HOME ${abs}: it is outside the instance root ${instanceRoot}`);
}

// Inherited variables an instance never sees: a developer's own patio settings (PATIO_HOME=~/.patio, say),
// GitHub OAuth secrets and the TypeSafe (Jev) key. Live recipes pass the Jev key explicitly to one agent.
export const inherited = (drop: (k: string) => boolean = () => false) => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("PATIO_") && !k.startsWith("TYPESAFE_") && !drop(k)) env[k] = v;
  return env;
};

// Environment for a patio process run as `agent`.
export function agentEnv(m: Manifest, agent: AgentEntry, extra: Record<string, string> = {}): Record<string, string> {
  assertSafeHome(agent.home, m.root);
  const env = inherited();
  return {
    ...env,
    ...(m.jev ? { TYPESAFE_API_KEY: FAKE_JEV_KEY, PATIO_JEV_URL: m.jev.url } : {}),
    ...extra,
    PATIO_HOME: agent.home,
    // The entry's agent, unless the call names another (an extra agent) or none ("").
    PATIO_AGENT: extra.PATIO_AGENT ?? agent.handle,
    PATIO_RELAY: m.exchange.url,
    // A restart may keep its web app's port (a browser's session cookie then still applies).
    PATIO_WEB_PORT: extra.PATIO_WEB_PORT ?? "0",
    PATIO_DEVICE_NAME: `${agent.handle}-gatekeeper`,
    PATIO_NO_NOTIFY: "1",
    // patio join never installs the answer service from an instance: it would replace the computer's own.
    PATIO_NO_SERVICE: "1",
    ...clockEnv(m),
  };
}

// Every process of an instance reads the same test clock (an offset in ms in <root>/clock, 0 until a scenario moves
// it forward), and looks for what expired every 200 ms instead of every 30 s.
export const clockFile = (m: Manifest) => join(m.root, "clock");
const clockEnv = (m: Manifest) => ({ PATIO_TEST_CLOCK: clockFile(m), PATIO_SWEEP_MS: "200" });

// Moves the instance's clock forward by `ms` (expiries see it; nothing sleeps).
export async function advanceClock(m: Manifest, ms: number) {
  const file = clockFile(m);
  const now = existsSync(file) ? Number(readFileSync(file, "utf8").trim()) || 0 : 0;
  await writeFile(file, String(now + ms));
}

// Short ids keep the daemon socket path inside the home (Unix socket paths are capped near 100 bytes).
function newId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const day = `${String(d.getUTCFullYear()).slice(2)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
  return `${day}-${crypto.randomUUID().slice(0, 4)}`;
}

// Process start time (Linux /proc), so `down` never signals a recycled PID.
export function procStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// True only when the PID is still the process this manifest started.
export function stillOurs(p: ProcEntry): boolean {
  if (!alive(p.pid)) return false;
  if (p.start !== null) return procStart(p.pid) === p.start;
  // No /proc (macOS): fall back to the command line.
  const ps = Bun.spawnSync(["ps", "-o", "command=", "-p", String(p.pid)]);
  return ps.stdout.toString().includes(PATIO_CLI);
}

function spawnPatio(args: string[], env: Record<string, string>, log: string, cwd: string, append = false, script = PATIO_CLI): ProcEntry {
  // On a restart the log keeps what the previous process wrote.
  const fd = openSync(log, append ? "a" : "w");
  const proc = Bun.spawn([process.execPath, script, ...args], {
    cwd,
    env,
    stdin: "ignore",
    stdout: fd,
    stderr: fd,
    // Own process group: `down` can stop the daemon together with any agent it started.
    detached: true,
  });
  proc.unref();
  closeSync(fd);
  return { pid: proc.pid, pgid: proc.pid, start: procStart(proc.pid), log };
}

async function waitFor<T>(what: string, fn: () => Promise<T | null> | T | null, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== null && v !== undefined) return v;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

export const manifestPath = (root: string) => join(root, "manifest.json");

export async function readManifest(id: string, instancesDir = INSTANCES_DIR): Promise<Manifest> {
  if (!/^[\w-]+$/.test(id)) throw new Error(`bad instance id ${id}`);
  const file = manifestPath(join(instancesDir, id));
  if (!existsSync(file)) throw new Error(`no instance ${id} under ${instancesDir}`);
  const m = (await Bun.file(file).json()) as Manifest;
  // A manifest that was moved or edited to point elsewhere is refused.
  if (resolve(m.root) !== resolve(instancesDir, id)) throw new IsolationError(`manifest root ${m.root} is not ${resolve(instancesDir, id)}`);
  for (const a of Object.values(m.agents)) assertSafeHome(a.home, m.root);
  return m;
}

async function writeManifest(m: Manifest) {
  await writeFile(manifestPath(m.root), JSON.stringify(m, null, 2) + "\n");
}

// `jev`: the fake Jev's fixture (default BENIGN_JEV), or null for no Jev at all. `serverJudge`: the exchange judges
// with that fake Jev too (judge.ts), for agents without a key of their own.
export async function up(agents: AgentSpec[], opts: { instancesDir?: string; jev?: FakeJevFixture | null; serverJudge?: boolean } = {}): Promise<Manifest> {
  if (!agents.length) throw new Error("name at least one agent");
  const handles = agents.map((a) => a.handle);
  for (const h of handles) if (!HANDLE_RE.test(h)) throw new Error(`invalid handle ${h}`);
  if (new Set(handles).size !== handles.length) throw new Error("agent handles must be unique");

  const instancesDir = opts.instancesDir ?? INSTANCES_DIR;
  await mkdir(instancesDir, { recursive: true });
  let id = newId();
  while (existsSync(join(instancesDir, id))) id = newId();
  const root = join(await realpath(instancesDir), id);
  await mkdir(root, { mode: 0o700 });

  const git = await gitState();
  const baseEnv = inherited();

  const m: Manifest = {
    id,
    root,
    created_at: new Date().toISOString(),
    revision: git.revision,
    dirty: git.dirty,
    github: {
      pid: 0, pgid: 0, start: null, log: join(root, "github.log"), port: 0, url: "",
      client_id: `patio-instance-${id}`, client_secret: crypto.randomUUID(),
    },
    exchange: { pid: 0, pgid: 0, start: null, log: join(root, "exchange.log"), port: 0, url: "", db: join(root, "exchange.db"), judge: !!opts.serverJudge },
    jev: null,
    agents: {},
    workspaces: {},
  };
  const envs = new Map<string, Record<string, string> | undefined>();

  try {
    for (const spec of agents) {
      const dir = join(root, spec.handle);
      const home = dir;
      assertSafeHome(home, root);
      await mkdir(home, { recursive: true, mode: 0o700 });
      if (spec.agentConfig || spec.grants !== undefined) {
        const text = spec.agentConfig ? (typeof spec.agentConfig === "function" ? await spec.agentConfig(dir) : spec.agentConfig) : "";
        await mkdir(join(home, "agents"), { recursive: true, mode: 0o700 });
        await writeFile(join(home, "agents", `${spec.handle}.yaml`), agentFileText({ ...agentConfigSpec(text), rules: spec.grants }));
      }
      for (const x of spec.extra ?? []) {
        const file = typeof x.file === "function" ? await x.file(dir) : x.file;
        await mkdir(join(home, "agents"), { recursive: true, mode: 0o700 });
        await writeFile(join(home, "agents", `${x.name}.yaml`), agentFileText(file));
        (m.extra ??= {})[x.name] = spec.handle;
      }
      envs.set(spec.handle, spec.env);
      m.agents[spec.handle] = {
        handle: spec.handle,
        login: spec.login ?? spec.handle,
        workspace: spec.workspace === undefined ? "team" : spec.workspace,
        dir,
        home,
        socket: socketPath(home, baseEnv),
        web_url: "",
        env_keys: Object.keys(spec.env ?? {}),
        pid: 0,
        pgid: 0,
        start: null,
        log: join(root, `${spec.handle}.daemon.log`),
      };
    }
    // Port 0: the OS picks a free port, which each process prints and we read back.
    await spawnGitHub(m);
    const fixture = opts.jev === undefined ? BENIGN_JEV : opts.jev;
    if (fixture) await spawnJev(m, fixture);
    await spawnExchange(m, 0);
    for (const entry of Object.values(m.agents)) {
      Object.assign(entry, spawnPatio(["up"], agentEnv(m, entry, envs.get(entry.handle)), entry.log, root));
      await writeManifest(m);
    }
    for (const entry of Object.values(m.agents)) await waitConnected(entry);
    for (const spec of agents) if (spec.onboard !== false) await onboard(m, m.agents[spec.handle]!);
    // The owner turns on, in the web app, what their agents' rules widen (auto_answer, allowed actions), as a person would.
    for (const spec of agents) if (spec.onboard !== false) for (const x of spec.extra ?? []) await local(m.agents[spec.handle]!, "/register", { name: x.name, interactive: true });
    for (const spec of agents) if (spec.onboard !== false && (spec.grants !== undefined || spec.extra?.length)) await turnOnRules(m, m.agents[spec.handle]!);
    for (const spec of agents)
      if (spec.onboard !== false && m.agents[spec.handle]!.workspace) await joinWorkspace(m, m.agents[spec.handle]!, [spec.handle, ...(spec.extra ?? []).map((x) => x.name)]);
    for (const spec of agents) for (const c of spec.channels ?? []) await joinChannel(m, m.agents[spec.handle]!, c);
    await writeManifest(m);
    return m;
  } catch (err) {
    await stop(m).catch(() => {});
    throw err;
  }
}

const cleanEnv = () => inherited((k) => k.startsWith("GITHUB_"));

async function spawnGitHub(m: Manifest) {
  const args = ["--client-id", m.github.client_id, "--client-secret", m.github.client_secret];
  Object.assign(m.github, spawnPatio(args, cleanEnv(), m.github.log, m.root, false, join(REPO, "test/fakes/fake-github.ts")));
  await writeManifest(m);
  m.github.port = await waitFor("the fake GitHub to listen", () => {
    const text = existsSync(m.github.log) ? readFileSync(m.github.log, "utf8") : "";
    const found = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(text)?.[1];
    if (!found && !alive(m.github.pid)) throw new Error(`fake GitHub exited: ${text.trim()}`);
    return found ? Number(found) : null;
  });
  m.github.url = `http://127.0.0.1:${m.github.port}`;
  await writeManifest(m);
}

async function spawnJev(m: Manifest, fixture: FakeJevFixture) {
  const file = join(m.root, "jev.fixture.json");
  await writeFile(file, JSON.stringify(fixture, null, 2));
  const jev = { pid: 0, pgid: 0, start: null, log: join(m.root, "jev.log"), port: 0, url: "", fixture: file, requests: join(m.root, "jev.requests.jsonl") };
  const args = ["--fixture", file, "--log", jev.requests, "--api-key", FAKE_JEV_KEY];
  m.jev = Object.assign(jev, spawnPatio(args, cleanEnv(), jev.log, m.root, false, join(REPO, "test/fakes/fake-jev.ts")));
  await writeManifest(m);
  m.jev.port = await waitFor("the fake Jev to listen", () => {
    const text = existsSync(jev.log) ? readFileSync(jev.log, "utf8") : "";
    const found = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(text)?.[1];
    if (!found && !alive(jev.pid)) throw new Error(`fake Jev exited: ${text.trim()}`);
    return found ? Number(found) : null;
  });
  m.jev.url = `http://127.0.0.1:${m.jev.port}`;
  await writeManifest(m);
}

// The requests the instance's fake Jev received, oldest first.
export function jevRequests(m: Manifest): any[] {
  if (!m.jev || !existsSync(m.jev.requests)) return [];
  return readFileSync(m.jev.requests, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function spawnExchange(m: Manifest, port: number) {
  const env = cleanEnv();
  env.GITHUB_CLIENT_ID = m.github.client_id;
  env.GITHUB_CLIENT_SECRET = m.github.client_secret;
  env.PATIO_GITHUB_WEB_URL = m.github.url;
  env.PATIO_GITHUB_API_URL = `${m.github.url}/api`;
  env.PATIO_NO_NOTIFY = "1";
  if (m.exchange.judge && m.jev) Object.assign(env, { TYPESAFE_API_KEY: FAKE_JEV_KEY, PATIO_JEV_URL: m.jev.url });
  Object.assign(env, clockEnv(m));
  const before = existsSync(m.exchange.log) ? readFileSync(m.exchange.log, "utf8").length : 0;
  const args = ["exchange", "--port", String(port), "--host", "127.0.0.1", "--db", m.exchange.db];
  Object.assign(m.exchange, spawnPatio(args, env, m.exchange.log, m.root, true));
  await writeManifest(m);
  m.exchange.port = await waitFor("the exchange to listen", () => {
    const text = existsSync(m.exchange.log) ? readFileSync(m.exchange.log, "utf8").slice(before) : "";
    const found = /listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(text)?.[1];
    if (!found && !alive(m.exchange.pid)) throw new Error(`exchange exited: ${text.trim()}`);
    return found ? Number(found) : null;
  });
  m.exchange.url = `ws://127.0.0.1:${m.exchange.port}`;
  await writeManifest(m);
}

type Status = { connected: boolean; unread: number; web_url: string; login: string | null; agents: { name: string; status: string }[] };

async function daemonStatus(entry: AgentEntry) {
  const res = await fetch("http://daemon/status", { unix: entry.socket } as RequestInit).catch(() => null);
  return res?.ok ? ((await res.json()) as Status) : null;
}

async function local<T>(entry: AgentEntry, path: string, body: unknown): Promise<T> {
  const res = await fetch(`http://daemon${path}`, { unix: entry.socket, method: "POST", body: JSON.stringify(body) } as RequestInit);
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(`${entry.handle}: ${path} failed: ${data.error}`);
  return data;
}

// A web app session for the agent's owner, on that agent's gatekeeper.
export async function webFor(m: Manifest, handle: string): Promise<WebClient> {
  const entry = m.agents[handle];
  if (!entry) throw new Error(`instance ${m.id} has no agent ${handle}`);
  const web = new WebClient(entry.web_url);
  await web.signIn(entry.login);
  return web;
}

// What a human does once per gatekeeper and agent: sign in, pair with the code, approve the identity.
export async function onboard(m: Manifest, entry: AgentEntry) {
  const web = await webFor(m, entry.handle);
  const { code } = await local<{ code: string }>(entry, "/pair", {});
  const paired = await web.post("/pair", { code });
  if (!paired.ok) throw new Error(`${entry.handle}: pairing failed: ${paired.error}`);
  await waitFor(`${entry.handle} to be paired`, async () => ((await daemonStatus(entry))?.login === entry.login ? true : null));
  await local(entry, "/register", { name: entry.handle });
  // (an agent's request: it waits for its person, who approves it in the web app)
  const approved = await web.post(`/agents/${entry.handle}/decide`, { decision: "approve" });
  if (!approved.ok) throw new Error(`${entry.handle}: approval failed: ${approved.error}`);
  await waitFor(`${entry.handle} to be approved`, async () =>
    (await daemonStatus(entry))?.agents.some((a) => a.name === entry.handle && a.status === "approved") ? true : null,
  );
}

// Every setting of an agent's rules that widens what others can do (auto_answer, a list of allowed actions) stays off until
// the owner turns it on in the web app.
export async function turnOnRules(m: Manifest, entry: AgentEntry) {
  const web = await webFor(m, entry.handle);
  const page = await (await web.get("/")).text();
  for (const [, raw] of page.matchAll(/data-rule="([^"]+)"/g)) {
    const key = raw!.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
    const res = await web.post("/rules/confirm", { key });
    if (!res.ok) throw new Error(`${entry.handle}: turning on ${key} failed: ${res.error}`);
  }
}

// The first agent naming a workspace has its owner create it, with an invite link; every agent joins with that link
// from its person's terminal (no confirmation).
async function joinWorkspace(m: Manifest, entry: AgentEntry, names: string[]) {
  const name = entry.workspace!;
  if (!m.workspaces[name]) {
    const web = await webFor(m, entry.handle);
    const res = await web.post("/workspaces", { name });
    if (!res.ok) throw new Error(`creating workspace ${name} failed: ${res.error}`);
    const id = decodeURIComponent(res.location!.pathname.split("/").pop()!);
    const link = await web.post(`/workspaces/${id}/links`, { expires: "" });
    const code = /\/join\/([\w-]+)/.exec(link.ok ?? "")?.[1];
    if (!code) throw new Error(`creating an invite link to ${name} failed: ${link.error}`);
    m.workspaces[name] = { id, admin: entry.handle, link: code };
    await writeManifest(m);
  }
  const joined = await local<{ status: string }>(entry, "/join-link", { code: m.workspaces[name]!.link, agents: names, interactive: true });
  if (joined.status !== "joined") throw new Error(`${entry.handle} joining ${name} failed: ${JSON.stringify(joined)}`);
}

// Creates the (public) channel in the agent's workspace if needed, then the agent asks and its owner approves.
export async function joinChannel(m: Manifest, entry: AgentEntry, name: string) {
  const ws = m.workspaces[entry.workspace ?? ""];
  if (!ws) throw new Error(`${entry.handle} is in no workspace, so it cannot join #${name}`);
  ws.channels ??= {};
  if (!ws.channels[name]) {
    const admin = await webFor(m, ws.admin);
    const res = await admin.post(`/workspaces/${ws.id}/channels`, { name });
    if (!res.ok && !res.error?.includes("already exists")) throw new Error(`creating #${name} failed: ${res.error}`);
    const page = await (await admin.get(`/workspaces/${ws.id}`)).text();
    ws.channels[name] = decodeURIComponent(new RegExp(`href="/channels/([^"]+)">#${name}<`).exec(page)![1]!);
    await writeManifest(m);
  }
  const asked = await local<{ status: string }>(entry, "/join", { as: entry.handle, channel: ws.channels[name] });
  if (asked.status === "approved") return;
  const res = await (await webFor(m, entry.handle)).post(`/channels/${ws.channels[name]}/members/${entry.handle}/decide`, { decision: "approve" });
  if (!res.ok) throw new Error(`approving ${entry.handle} in #${name} failed: ${res.error}`);
}

async function waitConnected(entry: AgentEntry, timeoutMs = 10_000) {
  await waitFor(
    `${entry.handle}'s daemon to connect`,
    async () => {
      const status = await daemonStatus(entry);
      if (!status && !alive(entry.pid)) throw new Error(`${entry.handle}'s daemon exited: ${readFileSync(entry.log, "utf8").trim()}`);
      if (status?.connected) entry.web_url = status.web_url;
      return status?.connected ? true : null;
    },
    timeoutMs,
  );
}

// Stops one agent's gatekeeper. Its home, keys and inbox stay.
export async function stopAgent(m: Manifest, handle: string) {
  const entry = m.agents[handle];
  if (!entry) throw new Error(`instance ${m.id} has no agent ${handle}`);
  await stopProcs([entry]);
  await writeManifest(m);
}

// Starts an agent's gatekeeper again on the same home and waits until it is connected (or, with `connected: false`,
// only until it answers on its socket: the exchange may be down).
export async function startAgent(m: Manifest, handle: string, env?: Record<string, string>, opts: { connected?: boolean } = {}) {
  const entry = m.agents[handle];
  if (!entry) throw new Error(`instance ${m.id} has no agent ${handle}`);
  if (stillOurs(entry)) throw new Error(`${handle}'s gatekeeper is already running`);
  Object.assign(entry, spawnPatio(["up"], agentEnv(m, entry, env), entry.log, m.root, true));
  await writeManifest(m);
  if (opts.connected === false) {
    await waitFor(`${handle}'s daemon to answer`, async () => {
      const status = await daemonStatus(entry);
      if (status) entry.web_url = status.web_url;
      return status ? true : null;
    });
    await writeManifest(m);
    return;
  }
  await waitConnected(entry);
  // Its web app comes back on a new port; its identity comes back from the exchange.
  await writeManifest(m);
}

// Stops the exchange (an outage); `startExchange` brings it back on the same port and database.
export async function stopExchange(m: Manifest) {
  await stopProcs([m.exchange]);
  await writeManifest(m);
}

export async function startExchange(m: Manifest) {
  await spawnExchange(m, m.exchange.port);
  for (const entry of Object.values(m.agents)) if (stillOurs(entry)) await waitConnected(entry);
}

// Stops the exchange and starts it again on the same port and database. Gatekeepers reconnect on their own.
export async function restartExchange(m: Manifest) {
  await stopProcs([m.exchange]);
  await spawnExchange(m, m.exchange.port);
  for (const entry of Object.values(m.agents)) if (stillOurs(entry)) await waitConnected(entry);
}

async function stopProcs(list: ProcEntry[], timeoutMs = 5000) {
  const procs = list.filter((p) => p.pid > 0);
  const stopped: number[] = [];
  const gone: number[] = [];
  const signal = (p: ProcEntry, sig: NodeJS.Signals) => {
    try {
      process.kill(p.pgid === p.pid ? -p.pgid : p.pid, sig);
    } catch {
      try {
        process.kill(p.pid, sig);
      } catch {}
    }
  };
  for (const p of procs) {
    if (stillOurs(p)) {
      signal(p, "SIGTERM");
      stopped.push(p.pid);
    } else gone.push(p.pid);
  }
  const deadline = Date.now() + timeoutMs;
  for (const p of procs.filter((p) => stopped.includes(p.pid))) {
    while (alive(p.pid) && Date.now() < deadline) await Bun.sleep(50);
    if (alive(p.pid) && procStart(p.pid) === p.start) signal(p, "SIGKILL");
  }
  return { stopped, already_gone: gone };
}

// Stops only the processes this manifest started (and the process groups they lead).
export async function stop(m: Manifest, timeoutMs = 5000): Promise<{ stopped: number[]; already_gone: number[] }> {
  const res = await stopProcs([...Object.values(m.agents), m.exchange, m.github, ...(m.jev ? [m.jev] : [])], timeoutMs);
  if (existsSync(manifestPath(m.root))) await writeManifest({ ...m, stopped_at: new Date().toISOString() });
  return res;
}

export async function down(id: string, instancesDir = INSTANCES_DIR) {
  return stop(await readManifest(id, instancesDir));
}

// Runs the real patio CLI as `agent` in instance `id`. Returns its exit code.
// `env`: extra environment for this call only (CODEX_CONFIG for `patio answer` in the live smoke, say).
// `agent` may be an extra agent (spec `extra`): it runs on its computer's entry, as itself (PATIO_AGENT).
export function cliCommand(m: Manifest, agent: string, args: string[], env: Record<string, string> = {}) {
  const host = m.extra?.[agent];
  const entry = m.agents[host ?? agent];
  if (!entry) throw new Error(`instance ${m.id} has no agent ${agent} (has: ${[...Object.keys(m.agents), ...Object.keys(m.extra ?? {})].join(", ")})`);
  return { cmd: [process.execPath, PATIO_CLI, ...args], env: agentEnv(m, entry, { ...(host ? { PATIO_AGENT: agent } : {}), ...env }), cwd: REPO };
}
