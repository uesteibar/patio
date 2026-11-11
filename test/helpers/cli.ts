// The real CLI as a process, the way a coding agent runs it (no terminal) or the person does (a pseudo-terminal), and
// stand-ins for the coding tools and the service manager on PATH.
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const CLI = join(import.meta.dir, "../../src/cli.ts");

type OnLine = (line: string) => Promise<void> | void;

// `prefix`: run the CLI as a child of these (a stand-in tool, say), so its process chain has them.
export async function runCli(args: string[], env: Record<string, string>, onLine?: OnLine, o: { prefix?: string[]; cwd?: string } = {}) {
  const proc = Bun.spawn([...(o.prefix ?? []), process.execPath, CLI, ...args], { env, cwd: o.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: 60_000 });
  let out = "";
  const lines: Promise<void>[] = [];
  const read = async (stream: ReadableStream<Uint8Array>) => {
    let pending = "";
    for await (const chunk of stream) {
      const text = new TextDecoder().decode(chunk);
      out += text;
      pending += text;
      const parts = pending.split("\n");
      pending = parts.pop()!;
      for (const l of parts) lines.push(Promise.resolve(onLine?.(l)));
    }
  };
  await Promise.all([read(proc.stdout), read(proc.stderr)]);
  const code = await proc.exited;
  await Promise.all(lines);
  return { code, out };
}

// In a pseudo-terminal. `onData` sees the output so far and may answer through `write`.
export async function ttyCli(args: string[], env: Record<string, string>, onLine?: OnLine, o: { prefix?: string[]; onData?: (out: string, write: (text: string) => void) => void } = {}) {
  let out = "";
  let pending = "";
  const lines: Promise<void>[] = [];
  let write: (text: string) => void = () => {};
  const proc = Bun.spawn([...(o.prefix ?? []), process.execPath, CLI, ...args], {
    env: { ...env, TERM: "dumb" },
    timeout: 60_000,
    terminal: {
      cols: 200,
      rows: 50,
      data: (_t, data) => {
        const text = new TextDecoder().decode(data).replace(/\r/g, "");
        out += text;
        pending += text;
        o.onData?.(out, write);
        const parts = pending.split("\n");
        pending = parts.pop()!;
        for (const l of parts) lines.push(Promise.resolve(onLine?.(l)));
      },
    },
  });
  write = (text) => proc.terminal?.write(text);
  const code = await proc.exited;
  await Bun.sleep(50);
  await Promise.all(lines);
  proc.terminal?.close();
  return { code, out };
}

// A directory of stand-ins: `systemctl` and `launchctl` that log their arguments to calls.log (so a join never touches
// the real service manager), and the coding tools asked for. Each tool answers its MCP listing command the way the
// real one does (connect.ts readListing) for the folder it runs in: pending until $HOME/<tool>-trust lists the
// folder (the person's trust or approval), then connected. Run with other arguments, it runs them as a child, so a
// command started through it has the tool in its process chain.
export async function fakeTools(dir: string, tools: ("claude" | "codex" | "pi")[]) {
  await mkdir(dir, { recursive: true });
  const log = join(dir, "calls.log");
  const script = (body: string) => `#!/bin/sh\necho "$(basename "$0") $*" >> ${JSON.stringify(log)}\n${body}\n`;
  const trusted = (tool: string) => `grep -qxF "$PWD" "$HOME/${tool}-trust" 2>/dev/null`;
  const bodies: Record<string, string> = {
    systemctl: "exit 0",
    launchctl: "exit 0",
    claude: `if [ "$1 $2" = "mcp list" ]; then
  echo "Checking MCP server health…"; echo
  if ! grep -q '"patio"' .mcp.json 2>/dev/null; then echo "No MCP servers configured. Use \\\`claude mcp add\\\` to add a server."; exit 0; fi
  if ${trusted("claude")}; then echo "patio: patio mcp - ✔ Connected"; else echo "patio: patio mcp - ⏸ Pending approval (run \\\`claude\\\` to approve)"; fi
  exit 0
fi
"$@"`,
    codex: `if [ "$1 $2" = "mcp list" ]; then
  if grep -q 'mcp_servers.patio' .codex/config.toml 2>/dev/null && ${trusted("codex")}; then echo '[{"name":"patio","enabled":true,"disabled_reason":null}]'; else echo '[]'; fi
  exit 0
fi
"$@"`,
    pi: `if [ "$1 $2" = "mcp list" ]; then
  if ! grep -q '"patio"' .pi/mcp.json 2>/dev/null; then echo '{"servers":[],"errors":[]}'; exit 0; fi
  if ${trusted("pi")}; then echo '{"servers":[{"name":"patio","scope":"project","state":"connected","tools":["who"]}],"errors":[]}'; exit 0; fi
  echo "{\\"servers\\":[],\\"errors\\":[],\\"note\\":\\"$PWD/.pi/mcp.json is ignored because the project is not trusted. Start pi in the project to trust it.\\"}"
  exit 0
fi
"$@"`,
    // Neither a shell nor a tool: a command started through it has no tool in its process chain.
    term: '"$@"',
  };
  for (const name of ["systemctl", "launchctl", "term", ...tools]) {
    await writeFile(join(dir, name), script(bodies[name]!));
    await chmod(join(dir, name), 0o755);
  }
  // PATH: the stand-ins, Bun, and the system's own tools (git, sh), never the real coding tools.
  const path = [dir, dirname(process.execPath), "/usr/bin", "/bin"].join(":");
  return { dir, log, path, trust: async (home: string, tool: string, folder: string) => writeFile(join(home, `${tool}-trust`), `${folder}\n`, { flag: "a" }) };
}
