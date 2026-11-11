// Increment 15, part A: one patio per home. `patio up` holds $PATIO_HOME/patio.pid with its pid; a second start on the
// same home exits with "patio is already running (pid N)"; a lock whose process is gone is taken over; and the join
// reuses the patio that runs instead of starting another.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acquireLock, AlreadyRunning, lockHolder, lsofSocketOwner, socketOwner } from "../src/lock";
import { startBackground } from "../src/join";
import type { Config } from "../src/config";
import { CLI } from "./helpers/cli";
import { startWorld, until, type World } from "./helpers/world";
import { PROCESS_MS } from "./helpers/timeouts";

let world: World;
beforeAll(async () => {
  world = await startWorld();
}, PROCESS_MS);
afterAll(async () => {
  await world.stop();
}, PROCESS_MS);

const up = (home: string) =>
  Bun.spawn([process.execPath, CLI, "up"], {
    env: { PATH: process.env.PATH!, HOME: home, PATIO_HOME: home, PATIO_RELAY: `ws://127.0.0.1:${world.port}`, PATIO_WEB_PORT: "0", PATIO_NO_NOTIFY: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });

test("a live pid in the lock stops a second start; a dead one is taken over", async () => {
  const home = await mkdtemp(join(world.dir, "lock-"));
  const other = Bun.spawn(["sleep", "30"]);
  await writeFile(join(home, "patio.pid"), `${other.pid}\n`);
  expect(lockHolder(home)).toBe(other.pid);
  expect(() => acquireLock(home)).toThrow(new AlreadyRunning(other.pid));
  other.kill();
  await other.exited;
  // Stale: its process is gone.
  const release = acquireLock(home);
  expect(readFileSync(join(home, "patio.pid"), "utf8")).toBe(`${process.pid}\n`);
  release();
  expect(existsSync(join(home, "patio.pid"))).toBe(false);
});

test("patio up twice on one home: the second exits with the first one's pid; the join reuses the first", async () => {
  const home = await mkdtemp(join(world.dir, "up-"));
  const first = up(home);
  const cfg: Config = { home, handle: "", relay: `ws://127.0.0.1:${world.port}`, socket: join(home, "daemon.sock") };
  await until("the first patio holds the lock", () => lockHolder(home) === first.pid);
  const second = up(home);
  const err = await new Response(second.stderr).text();
  expect(await second.exited).toBe(1);
  expect(err.trim()).toBe(`patio is already running (pid ${first.pid})`);
  // The join's start: the running one answers, nothing new is started.
  const r = await startBackground(cfg, `ws://127.0.0.1:${world.port}`);
  expect(r).toMatchObject({ pid: first.pid, reused: true });
  first.kill("SIGTERM");
  await first.exited;
  // Stopped cleanly: the lock is gone.
  expect(existsSync(join(home, "patio.pid"))).toBe(false);
}, PROCESS_MS);

// Increment 16: patio uninstall finds a patio that holds no lock by its socket: /proc on Linux, lsof on macOS.
test("the owner of patio's socket, from lsof's output (macOS); none when nobody listens on it", () => {
  const out = ["p101", "n/tmp/other.sock", "p202", "n->0x1234", "n/Users/u/.patio/daemon.sock", ""].join("\n");
  expect(lsofSocketOwner(out, "/Users/u/.patio/daemon.sock")).toBe(202);
  expect(lsofSocketOwner(out, "/Users/u/.patio/none.sock")).toBeNull();
  expect(socketOwner("/Users/u/.patio/daemon.sock", { platform: "darwin", lsof: () => out })).toBe(202);
  expect(socketOwner("/Users/u/.patio/daemon.sock", { platform: "darwin", lsof: () => null })).toBeNull();
  expect(socketOwner(join(world.dir, "nobody.sock"))).toBeNull();
});
