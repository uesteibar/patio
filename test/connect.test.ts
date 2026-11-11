// `patio connect <tool> --as <agent>`: the MCP entry each tool documents, scoped to the agent's folder (golden files),
// keeping what else the file holds; nothing global without --user, and with --user the tool's own command.
import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyConnect, connectedTools, planConnect, readListing } from "../src/connect";
import { writeAgentFile } from "./helpers/agent-file";

const PATIO = ["/usr/local/bin/patio"];
const golden = (name: string) => readFile(join(import.meta.dir, "golden", "connect", name), "utf8");
const folder = async () => {
  const dir = await mkdtemp(join(tmpdir(), "patio-connect-"));
  // What a project already has: another MCP server, and an old patio entry for Codex.
  await writeFile(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { sentry: { type: "http", url: "https://mcp.sentry.dev/mcp" } } }, null, 2));
  await mkdir(join(dir, ".codex"));
  await writeFile(join(dir, ".codex", "config.toml"), 'model = "gpt-6"\n\n[mcp_servers.patio]\ncommand = "old"\nargs = []\n\n[mcp_servers.docs]\nurl = "https://example.com/mcp"\n');
  return dir;
};

test("the entry for Claude Code, Codex and Pi in the agent's folder matches the golden files, keeping the rest", async () => {
  const dir = await folder();
  for (const [tool, file, gold] of [
    ["claude", ".mcp.json", "claude.mcp.json"],
    ["codex", ".codex/config.toml", "codex.config.toml"],
    ["pi", ".pi/mcp.json", "pi.mcp.json"],
  ] as const) {
    const plan = planConnect({ tool, agent: "unai-orbit", folder: dir, patio: PATIO });
    expect(plan.scope).toBe("folder");
    await applyConnect(plan, () => {
      throw new Error("a folder entry runs no command");
    });
    expect(await readFile(join(dir, file), "utf8"), tool).toBe(await golden(gold));
  }
  expect(connectedTools("unai-orbit", dir, dir)).toEqual(["claude", "codex", "pi"]);
  expect(connectedTools("unai-side", dir, dir)).toEqual([]);
  // Connecting again changes nothing.
  const again = planConnect({ tool: "codex", agent: "unai-orbit", folder: dir, patio: PATIO });
  expect(again.scope === "folder" && again.text).toBe(await golden("codex.config.toml"));
});

test("--user adds a user-wide entry with the tool's own command; without it nothing outside the folder is written", async () => {
  const plan = planConnect({ tool: "claude", agent: "unai-orbit", folder: "/x", user: true, patio: PATIO });
  expect(plan).toMatchObject({
    scope: "user",
    commands: [
      ["claude", "mcp", "remove", "--scope", "user", "patio-unai-orbit"],
      ["claude", "mcp", "add", "--scope", "user", "patio-unai-orbit", "--", "/usr/local/bin/patio", "mcp", "--as", "unai-orbit"],
    ],
  });
  expect(planConnect({ tool: "codex", agent: "a", folder: "/x", user: true, patio: PATIO })).toMatchObject({ commands: [["codex", "mcp", "remove", "patio-a"], ["codex", "mcp", "add", "patio-a", "--", "/usr/local/bin/patio", "mcp", "--as", "a"]] });
  expect(planConnect({ tool: "pi", agent: "a", folder: "/x", user: true, patio: PATIO })).toMatchObject({ commands: [["pi", "mcp", "add", "patio-a", "--", "/usr/local/bin/patio", "mcp", "--as", "a"]] });

  // The real CLI, with a HOME of its own: it writes in the agent's folder only. With --user it runs the tool's command.
  const root = await mkdtemp(join(tmpdir(), "patio-connect-cli-"));
  const home = join(root, ".patio");
  const project = join(root, "code", "orbit");
  await mkdir(project, { recursive: true });
  await writeAgentFile(home, "unai-orbit", { tool: "claude", folder: project });
  const bin = join(root, "bin");
  await mkdir(bin);
  for (const t of ["claude", "codex", "pi"]) {
    await writeFile(join(bin, t), `#!/bin/sh\necho "$0 $*" >> ${JSON.stringify(join(root, "calls.log"))}\n`);
    await chmod(join(bin, t), 0o755);
  }
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: root, PATIO_HOME: home };
  const cli = (args: string[]) => Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], { env, stdout: "pipe", stderr: "pipe" });
  // Bun itself may create ~/.bun (its cache) under a fresh HOME; patio writes nothing there.
  const listing = () => readdirSync(root).filter((f) => f !== ".bun").sort();
  const before = listing();
  const r = cli(["connect", "claude", "--as", "unai-orbit"]);
  expect(r.exitCode).toBe(0);
  expect(r.stdout.toString()).toContain(`Claude Code runs patio as unai-orbit: write mcpServers.patio in ${join(project, ".mcp.json")}`);
  expect(r.stdout.toString()).toContain('"--as",\n        "unai-orbit"');
  expect(JSON.parse(await readFile(join(project, ".mcp.json"), "utf8")).mcpServers.patio.args).toEqual([join(import.meta.dir, "../src/cli.ts"), "mcp", "--as", "unai-orbit"]);
  expect(listing()).toEqual(before);
  expect(existsSync(join(root, "calls.log"))).toBe(false);
  // --dry-run shows and writes nothing; --user runs the tool's own command.
  expect(cli(["connect", "pi", "--as", "unai-orbit", "--dry-run"]).exitCode).toBe(0);
  expect(existsSync(join(project, ".pi"))).toBe(false);
  expect(cli(["connect", "codex", "--as", "unai-orbit", "--user"]).exitCode).toBe(0);
  const calls = await readFile(join(root, "calls.log"), "utf8");
  expect(calls).toContain(`${join(bin, "codex")} mcp add patio-unai-orbit -- ${process.execPath} ${join(import.meta.dir, "../src/cli.ts")} mcp --as unai-orbit`);
  // An unknown agent or tool is refused.
  expect(cli(["connect", "hermes", "--as", "unai-orbit"]).stderr.toString()).toContain("patio connects claude, codex, pi");
});

// What each tool's listing command printed in a project patio wrote (9 Nov 2026: Claude Code 2.1.318, Codex 0.166.0,
// Pi 1.4.0, each with a HOME of its own), before and after the person's trust or approval.
const BIN = "/usr/local/bin/patio mcp --as unai-orbit";
const LISTINGS = {
  claudePending: `Checking MCP server health…\n\npatio: ${BIN} - ⏸ Pending approval (run \`claude\` to approve)\n`,
  claudeOk: `Checking MCP server health…\n\npatio: ${BIN} - ✔ Connected\n`,
  claudeBroken: `Checking MCP server health…\n\npatio: ${BIN} - ✘ Failed to connect — CONNECTION_CLOSED: Connection closed\n`,
  claudeNone: "No MCP servers configured. Use `claude mcp add` to add a server.\n",
  codexNone: "[]\n",
  codexOk: JSON.stringify([{ name: "patio", enabled: true, disabled_reason: null, transport: { type: "stdio", command: "/usr/local/bin/patio", args: ["mcp", "--as", "unai-orbit"] }, auth_status: "unsupported" }], null, 2),
  piUntrusted: JSON.stringify({ servers: [], errors: [], note: "/w/orbit/.pi/mcp.json is ignored because the project is not trusted. Start pi in the project to trust it." }, null, 2),
  piOk: JSON.stringify({ servers: [{ name: "patio", scope: "project", source: "/w/orbit/.pi/mcp.json", enabled: true, exposure: "codemode", transport: BIN, state: "connected", tools: ["who", "ask"] }], errors: [] }, null, 2),
};

test("the listing each tool prints: connected passes; a pending trust or approval fails with the step, in the tool's words", () => {
  const f = "/w/orbit";
  expect(readListing("claude", f, LISTINGS.claudeOk)).toEqual({ tool: "claude", ok: true, said: "✔ Connected" });
  expect(readListing("claude", f, LISTINGS.claudePending)).toEqual({
    tool: "claude",
    ok: false,
    said: "⏸ Pending approval (run `claude` to approve)",
    step: "start claude in /w/orbit once, trust the folder and approve the patio MCP server, then run this command again",
  });
  expect(readListing("claude", f, LISTINGS.claudeBroken)).toMatchObject({ ok: false, said: "✘ Failed to connect — CONNECTION_CLOSED: Connection closed" });
  expect(readListing("claude", f, LISTINGS.claudeNone)).toMatchObject({ ok: false, step: expect.stringContaining("/mcp") });
  expect(readListing("codex", f, LISTINGS.codexOk)).toEqual({ tool: "codex", ok: true, said: "enabled" });
  expect(readListing("codex", f, LISTINGS.codexNone)).toMatchObject({ ok: false, step: "start codex in /w/orbit once and trust the folder (Codex reads a project's .codex/config.toml only then), then run this command again" });
  expect(readListing("pi", f, LISTINGS.piOk)).toEqual({ tool: "pi", ok: true, said: "connected" });
  expect(readListing("pi", f, LISTINGS.piUntrusted)).toEqual({
    tool: "pi",
    ok: false,
    said: "/w/orbit/.pi/mcp.json is ignored because the project is not trusted. Start pi in the project to trust it.",
    step: "start pi in /w/orbit once and accept the trust prompt, then run this command again",
  });
  expect(readListing("pi", f, "", "boom")).toMatchObject({ ok: false, said: "boom" });
});
