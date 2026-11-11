// `bun run build` makes single binaries; the server serves /install.sh and them (--dist); install.sh puts the binary in
// ~/.local/bin/patio, checked against the SHA-256 the server publishes beside it. The compiled binary also runs what
// patio starts by itself: the background patio that `patio join` starts, and `patio mcp`.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startExchange } from "../src/exchange";
import { daemon } from "../src/local";
import { startWorld, WebClient, type World } from "./helpers/world";
import { PROCESS_MS } from "./helpers/timeouts";

const platform = `${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const supported = ["darwin-arm64", "darwin-x64", "linux-x64"].includes(platform);
let dist: string;
let world: World;
const homes: string[] = [];

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "patio-dist-"));
  if (!supported) return;
  const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "../scripts/build.ts"), "--out", dist, "--only", platform], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`build failed: ${r.stderr.toString()}`);
  world = await startWorld({ extraUsers: ["ines"] });
}, PROCESS_MS);
afterAll(async () => {
  for (const home of homes) {
    const pid = existsSync(join(home, "patio.pid")) ? Number(readFileSync(join(home, "patio.pid"), "utf8")) : 0;
    if (pid) process.kill(pid, "SIGTERM");
  }
  await world?.stop();
}, PROCESS_MS);

test.skipIf(!supported)("install.sh from the server installs the binary into a temporary HOME, checks its SHA-256 and prints the version", async () => {
  const server = startExchange({ port: 0, db: ":memory:", log: () => {}, judge: null, dist });
  try {
    const home = await mkdtemp(join(tmpdir(), "patio-install-home-"));
    // Asynchronous: the server runs in this process.
    const install = async () => {
      const p = Bun.spawn(["sh", "-c", `curl -fsSL ${server.url}/install.sh | sh`], { env: { PATH: process.env.PATH!, HOME: home }, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      return { exitCode: await p.exited, stdout, stderr };
    };
    const r = await install();
    expect(r.stderr).toContain("is not in your PATH");
    expect(r.exitCode).toBe(0);
    const out = r.stdout;
    expect(out).toContain(`installed ${join(home, ".local/bin/patio")} (${platform}, sha256 `);
    expect(out).toMatch(/patio \d+\.\d+\.\d+ \([0-9a-f]+/);
    const v = Bun.spawnSync([join(home, ".local/bin/patio"), "--version"], { stdout: "pipe" });
    expect(v.stdout.toString()).toStartWith("patio ");

    // A binary that does not match its published SHA-256 is not installed.
    await writeFile(join(dist, `patio-${platform}.sha256`), `${"0".repeat(64)}  patio-${platform}\n`);
    const bad = await install();
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain("does not match its SHA-256");
    // Without builds, the server says so.
    const bare = startExchange({ port: 0, db: ":memory:", log: () => {}, judge: null });
    expect(await (await fetch(`${bare.url}/install.sh`)).text()).toContain("this server has no builds to install");
    // Only the built binaries and their SHA-256 are served from the directory.
    expect((await fetch(`${server.url}/dist/patio-windows-x64`)).status).toBe(404);
    expect((await fetch(`${server.url}/dist/..%2F..%2Fetc%2Fpasswd`)).status).not.toBe(200);
    bare.stop();
  } finally {
    server.stop();
  }
}, PROCESS_MS);

test.skipIf(!supported)("the compiled binary starts patio in the background (patio join) and serves MCP as an agent", async () => {
  const bin = join(await mkdtemp(join(tmpdir(), "patio-bin-")), "patio");
  await cp(join(dist, `patio-${platform}`), bin);
  const unai = await world.person("unai", { team: false });
  const ws = decodeURIComponent((await unai.web.post("/workspaces", { name: "orbit" })).location!.pathname.split("/").pop()!);
  const code = await world.inviteLink(unai.web, ws);
  const root = await mkdtemp(join(world.dir, "ines-"));
  const home = join(root, ".patio");
  const folder = join(root, "code");
  await mkdir(folder, { recursive: true });
  homes.push(home);
  const env = { PATH: process.env.PATH!, HOME: root, PATIO_HOME: home, PATIO_WEB_PORT: "0", PATIO_NO_NOTIFY: "1", PATIO_NO_SERVICE: "1", TYPESAFE_API_KEY: "world-key", PATIO_JEV_URL: world.jev.url };
  const proc = Bun.spawn([bin, "join", `${world.exchangeUrl}/join/${code}`, "--tool", "codex", "--folder", folder, "--ask", "requests", "--act", "ask-human", "--answer", "no"], { env, stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: 60_000 });
  let out = "";
  for await (const chunk of proc.stdout) {
    out += new TextDecoder().decode(chunk);
    const m = /Confirm in your browser: (http:\/\/127\.0\.0\.1:\d+)\/confirm\?code=([\w-]+)/.exec(out);
    if (m && !out.includes("confirmed:")) {
      out += "confirmed:\n";
      const web = new WebClient(m[1]!);
      await web.signIn("ines");
      await web.post("/confirm", { code: m[2]!, decision: "confirm" });
    }
  }
  expect(await proc.exited).toBe(0);
  expect(out).toContain("patio is ready: ines-orbit is in orbit.");
  // The background patio is the binary itself.
  const pid = Number(readFileSync(join(home, "patio.pid"), "utf8"));
  expect(readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0]).toBe(bin);
  expect((await daemon.status({ home, handle: "", relay: "", socket: join(home, "daemon.sock") })).agents[0]).toMatchObject({ name: "ines-orbit", workspaces: ["orbit"] });

  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: bin, args: ["mcp", "--as", "ines-orbit"], env }));
  const who = (await client.callTool({ name: "whoami", arguments: {} })) as { content: { text: string }[] };
  expect(JSON.parse(who.content[0]!.text)).toEqual({ agent: "ines-orbit" });
  await client.close();
}, PROCESS_MS);
