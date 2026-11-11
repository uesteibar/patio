import { afterAll, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { agentEnv, assertSafeHome, cliCommand, down, IsolationError, readManifest, stillOurs, up, type Manifest } from "../../scripts/lib/instance";
import { PROCESS_MS } from "../helpers/timeouts";

const dir = await mkdtemp(join(tmpdir(), "patio-inst-"));
const started: Manifest[] = [];
afterAll(async () => {
  for (const m of started) await down(m.id, dir).catch(() => {});
}, PROCESS_MS);

async function patio(m: Manifest, agent: string, args: string[]) {
  const { cmd, env, cwd } = cliCommand(m, agent, args);
  const proc = Bun.spawn(cmd, { env, cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = [await new Response(proc.stdout).text(), await new Response(proc.stderr).text()];
  return { code: await proc.exited, out: out.trim(), err: err.trim() };
}

test("two instances run side by side and down stops only its own processes", async () => {
  const [a, b] = await Promise.all([up([{ handle: "alice" }, { handle: "bob" }], { instancesDir: dir }), up([{ handle: "alice" }], { instancesDir: dir })]);
  started.push(a, b);
  expect(a.exchange.port).not.toBe(b.exchange.port);
  expect(a.agents.alice!.home).not.toBe(b.agents.alice!.home);
  for (const m of [a, b]) for (const agent of Object.values(m.agents)) expect(agent.home.startsWith(m.root + "/")).toBe(true);

  expect((await patio(a, "alice", ["who"])).out).toBe("alice · @alice · yours\nbob · @bob · online · answered by @bob, may take hours");
  expect((await patio(b, "alice", ["who"])).out).toBe("alice · @alice · yours");

  // Each instance has its own fake GitHub client and its own exchange database.
  expect(a.github.client_secret).not.toBe(b.github.client_secret);
  expect(a.exchange.db).not.toBe(b.exchange.db);

  const res = await down(a.id, dir);
  expect(res.stopped.sort()).toEqual([a.github.pid, a.exchange.pid, a.jev!.pid, a.agents.alice!.pid, a.agents.bob!.pid].sort());
  expect(stillOurs(a.jev!)).toBe(false);
  expect(stillOurs(a.exchange)).toBe(false);
  expect(stillOurs(b.exchange)).toBe(true);
  expect((await patio(b, "alice", ["who"])).code).toBe(0);
}, PROCESS_MS);

test("an unknown recipient makes the real CLI exit 3", async () => {
  const m = await up([{ handle: "alice" }], { instancesDir: dir });
  started.push(m);
  expect(m.exchange.db.startsWith(m.root + "/")).toBe(true);
  const res = await patio(m, "alice", ["ask", "carol", "hello?"]);
  expect(res.code).toBe(3);
  expect(res.err).toContain("not an agent on the server");
}, PROCESS_MS);

test("homes outside the instance root, and ~/.patio, are refused", async () => {
  const root = join(dir, "x");
  expect(() => assertSafeHome(join(root, "alice"), root)).not.toThrow();
  expect(() => assertSafeHome(join(homedir(), ".patio"), root)).toThrow(IsolationError);
  expect(() => assertSafeHome(join(root, "../elsewhere"), root)).toThrow(IsolationError);
  expect(() => assertSafeHome(root, root)).toThrow(IsolationError);
}, PROCESS_MS);

test("a manifest edited to point a home elsewhere is refused before anything runs", async () => {
  const m = await up([{ handle: "alice" }], { instancesDir: dir });
  started.push(m);
  const file = join(m.root, "manifest.json");
  const edited = { ...m, agents: { alice: { ...m.agents.alice!, home: join(homedir(), ".patio") } } };
  await Bun.write(file, JSON.stringify(edited));
  expect(readManifest(m.id, dir)).rejects.toThrow(IsolationError);
  expect(() => cliCommand(edited, "alice", ["who"])).toThrow(IsolationError);
  await Bun.write(file, JSON.stringify(m));
}, PROCESS_MS);

test("inherited PATIO_* settings never reach an instance process", async () => {
  const m = await up([{ handle: "alice" }], { instancesDir: dir });
  started.push(m);
  process.env.PATIO_HOME = join(homedir(), ".patio");
  try {
    const { env } = cliCommand(m, "alice", ["who"]);
    expect(env.PATIO_HOME).toBe(m.agents.alice!.home);
    expect(env.PATIO_NO_NOTIFY).toBe("1");
  } finally {
    delete process.env.PATIO_HOME;
  }
}, PROCESS_MS);

test("an agent's gatekeeper and the exchange can be restarted inside an instance", async () => {
  const m = await up([{ handle: "alice" }, { handle: "bob" }], { instancesDir: dir });
  started.push(m);
  const { startAgent, stopAgent, restartExchange } = await import("../../scripts/lib/instance");
  const firstBob = m.agents.bob!.pid;
  await stopAgent(m, "bob");
  expect(stillOurs({ ...m.agents.bob!, pid: firstBob })).toBe(false);
  const queued = await patio(m, "alice", ["ask", "bob", "queued while you were away"]);
  expect(queued.code).toBe(0);
  expect(queued.err).toContain("queued");
  const port = m.exchange.port;
  await restartExchange(m);
  expect(m.exchange.port).toBe(port);
  await startAgent(m, "bob");
  const inbox = await patio(m, "bob", ["inbox"]);
  expect(inbox.out).toMatch(/alice\s+question\s+unread\s+queued while you were away/);
}, PROCESS_MS);

test("an inherited TYPESAFE_API_KEY never reaches an instance process; only an agent's own env passes one", () => {
  const root = join(dir, "keyless");
  const m = { root, exchange: { url: "ws://127.0.0.1:1" }, agents: { alice: { handle: "alice", home: join(root, "alice") } } } as unknown as Manifest;
  process.env.TYPESAFE_API_KEY = "inherited-key";
  try {
    expect(cliCommand(m, "alice", ["who"]).env.TYPESAFE_API_KEY).toBeUndefined();
    expect(agentEnv(m, m.agents.alice!).TYPESAFE_API_KEY).toBeUndefined();
    expect(agentEnv(m, m.agents.alice!, { TYPESAFE_API_KEY: "fake-jev-key" }).TYPESAFE_API_KEY).toBe("fake-jev-key");
  } finally {
    delete process.env.TYPESAFE_API_KEY;
  }
}, PROCESS_MS);
