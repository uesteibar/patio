// The agents' files ($PATIO_HOME/agents/<name>.yaml, agent-file.ts), reloaded while patio runs. The directory is
// watched, and each file is read again before each use, so an edit applies to the very next message. A valid edit
// becomes the new version. An invalid edit, or a file that disappears, keeps the last valid version and records the
// error, which the patio log, `patio status` and a banner in the web app show until the file is fixed. It never
// falls back to no rules: an agent without a file has the default rules, and a file removed later keeps the last
// version it had.
//
// At start an invalid file still stops patio, since there is no last valid version to keep. A file that appears
// later invalid is reported, and its agent keeps the default rules until it is fixed.
import { existsSync, mkdirSync, readdirSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { AGENTS_DIR, agentFileName, parseAgentFile, validName, type AgentFile } from "./agent-file";

export type ConfigError = { message: string; at: number };

export type Watched<T> = {
  name: string;
  file: string;
  // The last valid version; null for a file that was never valid.
  value: T | null;
  // 1 at the first valid read, then one more for each valid change.
  version: number;
  // The first 12 hex characters of the SHA-256 of the valid text.
  hash: string | null;
  loaded_at: number;
  error: ConfigError | null;
};

// What `patio status` and the web app show of one file, without its contents.
export type ConfigSummary = Omit<Watched<unknown>, "value"> & { agent: string };

const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 12);
const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : null);

function tracked(file: string, agent: string, log: (line: string) => void, clock: () => number, strict: boolean) {
  const name = agentFileName(agent);
  const named = (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    return message.startsWith(`${name}:`) ? message : `${name}: ${message}`;
  };
  let text = read(file);
  const w: Watched<AgentFile> = { name, file, value: null, version: 0, hash: null, loaded_at: clock(), error: null };
  try {
    if (text !== null) {
      w.value = parseAgentFile(text, agent);
      w.version = 1;
      w.hash = sha(text);
    }
  } catch (err) {
    if (strict) throw new Error(named(err));
    w.error = { message: named(err), at: clock() };
    log(w.error.message);
  }
  const refresh = () => {
    const now = read(file);
    if (now === text) return;
    text = now;
    if (now === null) {
      w.error = { message: `${name} was removed; keeping the last valid version${w.version ? ` (v${w.version})` : ""}. Restart patio (patio up) to forget it.`, at: clock() };
      log(w.error.message);
      return;
    }
    try {
      w.value = parseAgentFile(now, agent);
    } catch (err) {
      w.error = { message: named(err), at: clock() };
      log(`${w.error.message}; keeping the last valid version${w.version ? ` (v${w.version}, ${w.hash})` : ": the default rules"}`);
      return;
    }
    w.version++;
    w.hash = sha(now);
    w.loaded_at = clock();
    w.error = null;
    log(`${name} reloaded: v${w.version} (${w.hash})`);
  };
  return { w, refresh };
}

export function loadLiveConfig(home: string, opts: { log?: (line: string) => void; clock?: () => number; pollMs?: number } = {}) {
  const log = opts.log ?? (() => {});
  const clock = opts.clock ?? Date.now;
  const dir = join(home, AGENTS_DIR);
  const files = new Map<string, ReturnType<typeof tracked>>();
  const scan = (strict: boolean) => {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".yaml")) continue;
      const agent = f.slice(0, -5);
      if (!validName(agent) || files.has(agent)) continue;
      files.set(agent, tracked(join(dir, f), agent, log, clock, strict));
    }
  };
  scan(true);
  const refresh = () => {
    scan(false);
    for (const t of files.values()) t.refresh();
  };
  let watcher: FSWatcher | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  return {
    // The agent's last valid file, or null when it has none (default rules, no tool).
    agent(name: string): AgentFile | null {
      refresh();
      return files.get(name)?.w.value ?? null;
    },
    // The agents that have a file on this computer.
    names(): string[] {
      refresh();
      return [...files.keys()].sort();
    },
    refresh,
    summary(): ConfigSummary[] {
      refresh();
      return [...files.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([agent, { w: { value: _v, ...rest } }]) => ({ ...rest, agent }));
    },
    errors(): ConfigError[] {
      refresh();
      return [...files.values()].map((t) => t.w.error).filter((e): e is ConfigError => !!e);
    },
    // Watches the agents' directory (editors often replace a file rather than write it), with a slow poll as a fallback.
    watch() {
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        watcher = watch(dir, () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(refresh, 100);
        });
      } catch {}
      poll = setInterval(refresh, opts.pollMs ?? 2000);
    },
    stop() {
      watcher?.close();
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
    },
  };
}

export type LiveConfig = ReturnType<typeof loadLiveConfig>;
