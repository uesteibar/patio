// One patio per home: `patio up` holds $PATIO_HOME/patio.pid, created exclusively with its pid, for as long as it runs.
// A second start on the same home finds a live pid there and stops ("patio is already running (pid N)"); a pid that is
// no longer running is a stale lock, taken over. `patio join` reuses the running patio instead of starting another.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readlinkSync, unlinkSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";

export const LOCK_FILE = "patio.pid";

export class AlreadyRunning extends Error {
  constructor(readonly pid: number) {
    super(`patio is already running (pid ${pid})`);
  }
}

export function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const readPid = (file: string) => {
  try {
    return Number(readFileSync(file, "utf8").trim());
  } catch {
    return 0;
  }
};

// The pid of another live patio holding this home, or null.
export function lockHolder(home: string): number | null {
  const pid = readPid(join(home, LOCK_FILE));
  return pid && pid !== process.pid && alive(pid) ? pid : null;
}

// Takes the lock for this process, or throws AlreadyRunning. Returns the release.
export function acquireLock(home: string): () => void {
  const file = join(home, LOCK_FILE);
  for (let i = 0; i < 5; i++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return () => {
        if (readPid(file) === process.pid) unlinkSync(file);
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const pid = readPid(file);
      if (pid && pid !== process.pid && alive(pid)) throw new AlreadyRunning(pid);
      // Stale (its process is gone), or this process's own: taken over.
      try {
        unlinkSync(file);
      } catch {}
    }
  }
  throw new Error(`could not take the lock ${file}`);
}

export const lockExists = (home: string) => existsSync(join(home, LOCK_FILE));

// The process listening on patio's socket, other than this one: how patio uninstall finds a patio that holds no lock
// (one from before the lock, or one whose pid file is gone). Linux reads /proc; elsewhere (macOS) it asks lsof.
export function socketOwner(socket: string, o: { platform?: NodeJS.Platform; lsof?: () => string | null } = {}): number | null {
  const path = resolve(socket);
  if ((o.platform ?? process.platform) === "linux" && existsSync("/proc/net/unix")) return procSocketOwner(path);
  const out = (o.lsof ?? runLsof)();
  return out === null ? null : lsofSocketOwner(out, path);
}

function procSocketOwner(path: string): number | null {
  const inodes = new Set(
    readFileSync("/proc/net/unix", "utf8")
      .split("\n")
      .slice(1)
      .map((l) => l.trim().split(/\s+/))
      .filter((f) => f.length >= 8 && f.slice(7).join(" ") === path)
      .map((f) => f[6]!),
  );
  if (!inodes.size) return null;
  for (const entry of readdirSync("/proc")) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`));
        if (m && inodes.has(m[1]!)) return pid;
      } catch {}
    }
  }
  return null;
}

const runLsof = (): string | null => {
  if (!Bun.which("lsof")) return null;
  const p = Bun.spawnSync(["lsof", "-n", "-U", "-F", "pn"], { stdout: "pipe", stderr: "ignore" });
  return p.stdout.toString();
};

// `lsof -U -F pn`: a "p<pid>" line, then an "n<name>" line for each of its Unix sockets.
export function lsofSocketOwner(out: string, path: string): number | null {
  let pid = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && line.slice(1) === path && pid && pid !== process.pid) return pid;
  }
  return null;
}
