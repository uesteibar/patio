// `patio connect <tool> --as <agent> [--user]`: adds patio to a coding tool's MCP servers as that agent, so a session
// of the tool runs `patio mcp --as <agent>` and every call acts as that agent.
//
// By default the entry is scoped to the agent's folder, in the file each tool documents for a project:
//   Claude Code  <folder>/.mcp.json            { "mcpServers": { "patio": { "type": "stdio", "command", "args" } } }
//   Codex        <folder>/.codex/config.toml   [mcp_servers.patio] command = …, args = […] (a trusted project)
//   Pi           <folder>/.pi/mcp.json         { "mcpServers": { "patio": { "command", "args" } } } (a trusted project)
// so opening the tool in ~/code/orbit is unai-orbit there. Other keys of those files are kept. With --user, the entry
// is user-wide (named patio-<agent>), added with the tool's own command: `claude mcp add --scope user`, `codex mcp
// add`, `pi mcp add`. Nothing global is touched without --user. The plan is shown before anything is written.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";

export const CONNECT_TOOLS = ["claude", "codex", "pi"] as const;
export type ConnectTool = (typeof CONNECT_TOOLS)[number];
export const isConnectTool = (t: string): t is ConnectTool => (CONNECT_TOOLS as readonly string[]).includes(t);

// The entry's name: `patio` in a folder (one agent per folder), `patio-<agent>` user-wide.
export const entryName = (agent: string, user: boolean) => (user ? `patio-${agent}` : "patio");

export type ConnectPlan =
  | { tool: ConnectTool; scope: "folder"; file: string; text: string; replaces: boolean; say: string }
  | { tool: ConnectTool; scope: "user"; commands: string[][]; say: string };

const PROJECT_FILES: Record<ConnectTool, string> = { claude: ".mcp.json", codex: ".codex/config.toml", pi: ".pi/mcp.json" };

const toml = (v: string) => JSON.stringify(v);

// Drops the [mcp_servers.<name>] table (and its sub-tables) from a TOML text; keeps everything else as it was.
function dropTomlTable(text: string, name: string): { text: string; found: boolean } {
  const lines = text.split("\n");
  const out: string[] = [];
  let skipping = false;
  let found = false;
  const head = new RegExp(`^\\s*\\[mcp_servers\\.(?:"${name}"|${name})(?:\\.[^\\]]+)?\\]\\s*$`);
  for (const line of lines) {
    if (/^\s*\[/.test(line)) skipping = head.test(line);
    if (skipping) {
      found = true;
      continue;
    }
    out.push(line);
  }
  return { text: out.join("\n").replace(/\n{3,}/g, "\n\n"), found };
}

function jsonEntry(file: string, name: string, entry: unknown): { text: string; replaces: boolean } {
  let doc: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`${file} is not valid JSON (${(err as Error).message}); fix it, or add patio by hand`);
    }
  }
  const servers = (doc.mcpServers && typeof doc.mcpServers === "object" ? doc.mcpServers : {}) as Record<string, unknown>;
  const replaces = Object.hasOwn(servers, name);
  return { text: JSON.stringify({ ...doc, mcpServers: { ...servers, [name]: entry } }, null, 2) + "\n", replaces };
}

// What `connect` would do. `patio`: the patio command line (the binary, or bun and cli.ts).
export function planConnect(o: { tool: ConnectTool; agent: string; folder: string; user?: boolean; patio: string[] }): ConnectPlan {
  const [command, ...pre] = o.patio;
  const args = [...pre, "mcp", "--as", o.agent];
  const name = entryName(o.agent, !!o.user);
  if (o.user) {
    const line = [command!, ...args];
    const commands =
      o.tool === "claude"
        ? [["claude", "mcp", "remove", "--scope", "user", name], ["claude", "mcp", "add", "--scope", "user", name, "--", ...line]]
        : o.tool === "codex"
          ? [["codex", "mcp", "remove", name], ["codex", "mcp", "add", name, "--", ...line]]
          : [["pi", "mcp", "add", name, "--", ...line]];
    return { tool: o.tool, scope: "user", commands, say: `add the user-wide MCP server ${name} to ${o.tool}: ${line.join(" ")}` };
  }
  const file = join(o.folder, PROJECT_FILES[o.tool]);
  if (o.tool === "codex") {
    const before = existsSync(file) ? readFileSync(file, "utf8") : "";
    const { text, found } = dropTomlTable(before, name);
    const table = `[mcp_servers.${name}]\ncommand = ${toml(command!)}\nargs = [${args.map(toml).join(", ")}]\n`;
    const kept = text.trim();
    return { tool: o.tool, scope: "folder", file, text: `${kept ? `${kept}\n\n` : ""}${table}`, replaces: found, say: `write [mcp_servers.${name}] in ${file}` };
  }
  const entry = o.tool === "claude" ? { type: "stdio", command, args, env: {} } : { command, args };
  const { text, replaces } = jsonEntry(file, name, entry);
  return { tool: o.tool, scope: "folder", file, text, replaces, say: `write mcpServers.${name} in ${file}` };
}

export type Run = (cmd: string[]) => { code: number; out: string };
const runSync: Run = (cmd) => {
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: (p.stdout.toString() + p.stderr.toString()).trim() };
};

// Carries the plan out. A user-wide entry needs the tool installed; a removal that finds nothing is fine.
export async function applyConnect(plan: ConnectPlan, run: Run = runSync): Promise<void> {
  if (plan.scope === "folder") {
    await mkdir(dirname(plan.file), { recursive: true });
    await writeFile(plan.file, plan.text);
    return;
  }
  for (const cmd of plan.commands) {
    const r = run(cmd);
    if (r.code !== 0 && cmd[2] !== "remove") throw new Error(`${cmd.join(" ")} failed: ${r.out || `exit ${r.code}`}`);
  }
}

// Which tools run patio as `agent`: in its folder, or user-wide. For `patio agents`, `patio status` and the web app.
export function connectedTools(agent: string, folder: string | null | undefined, userHome = homedir()): string[] {
  const out: string[] = [];
  const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : "");
  const asAgent = (text: string) => text.includes(`"--as"`) && text.includes(`"${agent}"`);
  const jsonServer = (file: string, name: string) => {
    try {
      const s = (JSON.parse(read(file) || "{}") as { mcpServers?: Record<string, { args?: string[] }> }).mcpServers?.[name];
      return !!s && JSON.stringify(s.args ?? []).includes(`"--as","${agent}"`);
    } catch {
      return false;
    }
  };
  const codexTable = (file: string, name: string) => {
    const t = read(file);
    const at = t.search(new RegExp(`^\\[mcp_servers\\.(?:"${name}"|${name})\\]`, "m"));
    if (at < 0) return false;
    const rest = t.slice(at).split(/\n(?=\[)/)[0]!;
    return asAgent(rest);
  };
  if (folder) {
    if (jsonServer(join(folder, ".mcp.json"), "patio")) out.push("claude");
    if (codexTable(join(folder, ".codex/config.toml"), "patio")) out.push("codex");
    if (jsonServer(join(folder, ".pi/mcp.json"), "patio")) out.push("pi");
  }
  const user = entryName(agent, true);
  if (jsonServer(join(userHome, ".claude.json"), user)) out.push("claude (user)");
  if (codexTable(join(userHome, ".codex/config.toml"), user)) out.push("codex (user)");
  if (jsonServer(join(userHome, ".pi/agent/mcp.json"), user)) out.push("pi (user)");
  return out;
}

// ---- does the tool really list patio? -------------------------------------------------------------------------------
// After writing, `patio join` asks each tool with its own listing command, run in the agent's folder, and reads the
// answer (formats checked against Claude Code 2.1.318, Codex 0.166.0 and Pi 1.4.0 on 9 Nov 2026):
//   Claude Code  `claude mcp list`        "patio: <command> - ✔ Connected", "- ⏸ Pending approval (run `claude` to
//                                          approve)", "- ✘ Failed to connect — …"; a server you turned off is not listed
//   Codex        `codex mcp list --json`  [{ name, enabled, … }]: a project's servers are listed only once you trust
//                                          the project, and Codex says nothing else about it
//   Pi           `pi mcp list --json`     { servers: [{ name, scope, state: "connected", … }], note: "<file> is ignored
//                                          because the project is not trusted. Start pi in the project to trust it." }
// A trust or approval step still pending is a failure, with the step in the tool's words: the person does it, and the
// same join run again passes.
export type ToolCheck = { tool: ConnectTool; ok: true; said: string } | { tool: ConnectTool; ok: false; step: string; said: string };

export const LIST_COMMANDS: Record<ConnectTool, string[]> = { claude: ["claude", "mcp", "list"], codex: ["codex", "mcp", "list", "--json"], pi: ["pi", "mcp", "list", "--json"] };

const firstLine = (t: string) => t.trim().split("\n").find((l) => l.trim()) ?? "";

// Reads the listing command's output (stdout, then stderr) for the folder's patio entry.
export function readListing(tool: ConnectTool, folder: string, out: string, err = ""): ToolCheck {
  const again = "then run this command again";
  if (tool === "claude") {
    const line = out.split("\n").find((l) => /^patio: /.test(l));
    if (!line) return { tool, ok: false, said: firstLine(out) || firstLine(err), step: `start claude in ${folder}, and turn the patio server on with /mcp (claude mcp list does not show it), ${again}` };
    const state = line.slice(line.lastIndexOf(" - ") + 3).trim();
    if (/Connected/.test(state) && !/Failed/.test(state)) return { tool, ok: true, said: state };
    if (/Pending approval|approve|trust/i.test(state)) return { tool, ok: false, said: state, step: `start claude in ${folder} once, trust the folder and approve the patio MCP server, ${again}` };
    return { tool, ok: false, said: state, step: `Claude Code cannot start patio there; run \`patio mcp\` by hand in ${folder} to see why, fix it, ${again}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    return { tool, ok: false, said: firstLine(err) || firstLine(out) || "no output", step: `\`${LIST_COMMANDS[tool].join(" ")}\` did not answer in ${folder}; run it there to see why, ${again}` };
  }
  if (tool === "codex") {
    const entry = (Array.isArray(parsed) ? parsed : []).find((s: { name?: string }) => s?.name === "patio") as { enabled?: boolean; disabled_reason?: string | null } | undefined;
    if (!entry) return { tool, ok: false, said: "codex mcp list does not show patio", step: `start codex in ${folder} once and trust the folder (Codex reads a project's .codex/config.toml only then), ${again}` };
    if (entry.enabled === false) return { tool, ok: false, said: `patio is disabled${entry.disabled_reason ? `: ${entry.disabled_reason}` : ""}`, step: `turn the patio server on in ${join(folder, ".codex/config.toml")}, ${again}` };
    return { tool, ok: true, said: "enabled" };
  }
  const doc = (parsed ?? {}) as { servers?: { name?: string; scope?: string; state?: string; error?: string }[]; note?: string };
  const entry = (doc.servers ?? []).find((s) => s.name === "patio");
  if (!entry) {
    if (doc.note && /not trusted/i.test(doc.note)) return { tool, ok: false, said: doc.note, step: `start pi in ${folder} once and accept the trust prompt, ${again}` };
    return { tool, ok: false, said: doc.note ?? "pi mcp list does not show patio", step: `check ${join(folder, ".pi/mcp.json")}, ${again}` };
  }
  if (entry.state === "connected") return { tool, ok: true, said: "connected" };
  return { tool, ok: false, said: `${entry.state ?? "not connected"}${entry.error ? `: ${entry.error}` : ""}`, step: `Pi cannot start patio there; run \`patio mcp\` by hand in ${folder} to see why, fix it, ${again}` };
}

// Runs the tool's listing command in the folder. A tool that is not on PATH cannot be checked: that is a failure too.
// `env`: the environment it runs with (this process's by default).
export function checkTool(tool: ConnectTool, folder: string, env?: Record<string, string | undefined>): ToolCheck {
  const [cmd, ...args] = LIST_COMMANDS[tool];
  const bin = Bun.which(cmd!, env?.PATH ? { PATH: env.PATH } : undefined);
  if (!bin) return { tool, ok: false, said: `${cmd} is not on PATH`, step: `install it or put \`${cmd}\` on PATH (or remove ${PROJECT_FILES[tool]} from ${folder}), then run this command again` };
  const p = Bun.spawnSync([bin, ...args], { cwd: folder, stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: 90_000, ...(env ? { env } : {}) });
  return readListing(tool, folder, p.stdout.toString(), p.stderr.toString());
}

// ---- keeping the project files out of the team's repository -----------------------------------------------------------
// The project files hold this computer's patio command and the agent's name: they are the person's, not the team's.
// `patio join` lists the ones it wrote in .git/info/exclude (local to this clone, never committed), unless git already
// tracks one: then it changes nothing for that file and says so. `patio uninstall` removes the lines again.
export const projectFile = (tool: ConnectTool) => PROJECT_FILES[tool];
const EXCLUDE_MARK = "# patio: this computer's project files (patio uninstall removes these lines)";

const git = (folder: string, args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd: folder, stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim() };
};

// The repository's top and its exclude file, or null outside a git repository.
function repoOf(folder: string): { top: string; exclude: string } | null {
  if (!existsSync(folder)) return null;
  const top = git(folder, ["rev-parse", "--show-toplevel"]);
  if (!top.ok || !top.out) return null;
  const ex = git(folder, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]);
  return ex.ok && ex.out ? { top: top.out, exclude: ex.out } : null;
}

// Lists `files` (relative to `folder`) in .git/info/exclude. Returns what it added, what was there, and what git tracks.
export async function excludeProjectFiles(folder: string, files: string[]): Promise<{ added: string[]; already: string[]; tracked: string[] } | null> {
  const repo = repoOf(folder);
  if (!repo) return null;
  const text = existsSync(repo.exclude) ? readFileSync(repo.exclude, "utf8") : "";
  const lines = text.split("\n");
  const out = { added: [] as string[], already: [] as string[], tracked: [] as string[] };
  const add: string[] = [];
  for (const f of files) {
    const rel = relative(repo.top, join(folder, f));
    if (git(repo.top, ["ls-files", "--error-unmatch", "--", rel]).ok) {
      out.tracked.push(f);
      continue;
    }
    const line = `/${rel}`;
    if (lines.includes(line)) out.already.push(f);
    else (add.push(line), out.added.push(f));
  }
  if (add.length) {
    await mkdir(dirname(repo.exclude), { recursive: true });
    const head = lines.includes(EXCLUDE_MARK) ? [] : [EXCLUDE_MARK];
    await writeFile(repo.exclude, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${[...head, ...add].join("\n")}\n`);
  }
  return out;
}

// Takes `files` (relative to `folder`) out of .git/info/exclude again; the mark goes once no patio line is left.
export async function unexcludeProjectFiles(folder: string, files: string[]): Promise<string[]> {
  const repo = repoOf(folder);
  if (!repo || !existsSync(repo.exclude)) return [];
  const drop = new Set(files.map((f) => `/${relative(repo.top, join(folder, f))}`));
  const lines = readFileSync(repo.exclude, "utf8").split("\n");
  const removed = lines.filter((l) => drop.has(l));
  if (!removed.length) return [];
  let kept = lines.filter((l) => !drop.has(l));
  const at = kept.indexOf(EXCLUDE_MARK);
  const ours = /(?:^|\/)(?:\.mcp\.json|\.codex\/config\.toml|\.pi\/mcp\.json)$/;
  if (at >= 0 && !kept.slice(at + 1).some((l) => l.startsWith("/") && ours.test(l))) kept = kept.filter((l) => l !== EXCLUDE_MARK);
  await writeFile(repo.exclude, kept.join("\n"));
  return removed.map((l) => l.slice(1));
}

// checkTool without blocking: for patio itself, which refreshes what the web app and patio status say.
export async function checkToolAsync(tool: ConnectTool, folder: string, env?: Record<string, string | undefined>): Promise<ToolCheck> {
  const [cmd, ...args] = LIST_COMMANDS[tool];
  const bin = Bun.which(cmd!, env?.PATH ? { PATH: env.PATH } : undefined);
  if (!bin) return { tool, ok: false, said: `${cmd} is not on PATH`, step: `install it or put \`${cmd}\` on PATH (or remove ${PROJECT_FILES[tool]} from ${folder}), then run this command again` };
  const p = Bun.spawn([bin, ...args], { cwd: folder, stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: 90_000, ...(env ? { env } : {}) });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  return readListing(tool, folder, out, err);
}

// What a person reads about one coding tool for one agent: patio is in its list, written and waiting for the
// person's trust in the tool, or not set up there.
export type ToolState = "listed" | "written" | "not set up";
export const toolStateText = (state: ToolState, label: string) => (state === "listed" ? "listed" : state === "written" ? `written, waits for your trust in ${label}` : "not set up");

// `patio uninstall`: takes the agent's patio entry out of the project files patio wrote in its folder. Other entries
// and keys stay; a file left with nothing but an empty list of servers goes. Returns the files it changed.
export async function removeProjectEntries(agent: string, folder: string): Promise<string[]> {
  const changed: string[] = [];
  const { rm } = await import("node:fs/promises");
  for (const tool of CONNECT_TOOLS) {
    const file = join(folder, PROJECT_FILES[tool]);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    if (tool === "codex") {
      const at = text.search(/^\[mcp_servers\.(?:"patio"|patio)\]/m);
      if (at < 0 || !text.slice(at).split(/\n(?=\[)/)[0]!.includes(`"${agent}"`)) continue;
      const { text: rest } = dropTomlTable(text, "patio");
      if (rest.trim()) await writeFile(file, `${rest.trim()}\n`);
      else await rm(file);
      changed.push(PROJECT_FILES[tool]);
      continue;
    }
    let doc: { mcpServers?: Record<string, { args?: string[] }> } & Record<string, unknown>;
    try {
      doc = JSON.parse(text);
    } catch {
      continue;
    }
    const entry = doc.mcpServers?.patio;
    if (!entry || !JSON.stringify(entry.args ?? []).includes(`"--as","${agent}"`)) continue;
    const { patio: _p, ...servers } = doc.mcpServers!;
    const { mcpServers: _m, ...others } = doc;
    if (!Object.keys(servers).length && !Object.keys(others).length) await rm(file);
    else await writeFile(file, JSON.stringify({ ...doc, mcpServers: servers }, null, 2) + "\n");
    changed.push(PROJECT_FILES[tool]);
  }
  return changed;
}
