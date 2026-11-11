// just probe-tools: the real Claude Code, Codex and Pi installed on this machine, against what `patio join` relies on.
// No model runs and nothing global changes: every tool runs with a HOME (and CODEX_HOME, PI_CODING_AGENT_DIR) of its
// own under .dev/probe-tools/<timestamp>/, in a fresh git project.
//
//   1. listing: patio writes its entry in the project (planConnect), and checkTool reads each tool's own listing
//      command. Before the person trusts the project, each must be a pending step; then the probe records the trust
//      decision the way each tool stores it when the person accepts its prompt, in that isolated HOME only (Claude
//      Code: hasTrustDialogAccepted and enabledMcpjsonServers; Codex: trust_level = "trusted"; Pi: trust.json), and
//      each must list patio.
//   2. detection: Claude Code and Pi start an MCP server (`claude mcp list`, `pi mcp list`) that runs detectTool and
//      prints the variables each tool sets; Codex runs the same under `codex sandbox`. Each must detect its own tool.
//
// Writes a JSON report to .verify/probe-tools-<timestamp>.json. Exit 0 when every installed tool behaves as expected;
// a tool that is not installed is skipped.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyConnect, checkTool, CONNECT_TOOLS, planConnect, type ConnectTool } from "../src/connect";
import { DEV_DIR, REPO, VERIFY_DIR } from "./lib/paths";

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const root = join(DEV_DIR, "probe-tools", stamp);
const home = join(root, "home");
const project = join(root, "project");
const dumps = join(root, "dumps");
await mkdir(home, { recursive: true });
await mkdir(project, { recursive: true });
await mkdir(dumps, { recursive: true });
Bun.spawnSync(["git", "init", "-q"], { cwd: project });

// Every tool, and everything they start, sees only the isolated homes, and none of the variables a coding tool this
// probe may run under sets (as if each tool were started from a plain terminal).
const own = { HOME: home, CODEX_HOME: join(home, ".codex"), PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), PATIO_HOME: join(root, ".patio"), PATIO_NO_NOTIFY: "1" };
const env: Record<string, string> = { ...own };
for (const [k, v] of Object.entries(process.env))
  if (v !== undefined && !/^(AI_AGENT|CLAUDECODE|CLAUDE_CODE_|CLAUDE_CONFIG_DIR|PI_|CODEX_|PATIO_|TYPESAFE_)/.test(k) && !(k in own)) env[k] = v;
await mkdir(own.CODEX_HOME, { recursive: true });
await mkdir(own.PI_CODING_AGENT_DIR, { recursive: true });

const installed = CONNECT_TOOLS.filter((t) => Bun.which(t));
const version = (t: string) => Bun.spawnSync([t, "--version"], { env, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim().split("\n")[0];
const report: Record<string, unknown> = { at: new Date().toISOString(), root, installed: Object.fromEntries(installed.map((t) => [t, version(t)])) };
const checks: { name: string; ok: boolean; detail?: unknown }[] = [];
const expect = (name: string, ok: boolean, detail?: unknown) => checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) });

// ---- 1. listing, before and after the person's trust ---------------------------------------------------------------
const patio = [process.execPath, join(REPO, "src/cli.ts")];
for (const t of installed) await applyConnect(planConnect({ tool: t, agent: "probe-x", folder: project, patio }));
const before = Object.fromEntries(installed.map((t) => [t, checkTool(t, project, env)]));
for (const t of installed) expect(`${t}: before trust, a pending step`, !before[t]!.ok, before[t]);

const trust: Record<ConnectTool, () => Promise<void>> = {
  claude: async () => {
    const file = join(home, ".claude.json");
    const doc = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    doc.projects = { ...(doc.projects ?? {}), [project]: { ...(doc.projects?.[project] ?? {}), hasTrustDialogAccepted: true } };
    await writeFile(file, JSON.stringify(doc, null, 2));
    await mkdir(join(project, ".claude"), { recursive: true });
    await writeFile(join(project, ".claude", "settings.local.json"), JSON.stringify({ enabledMcpjsonServers: ["patio"] }));
  },
  codex: async () => {
    const file = join(own.CODEX_HOME, "config.toml");
    await writeFile(file, `${existsSync(file) ? readFileSync(file, "utf8") : ""}\n[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n`);
  },
  pi: async () => writeFile(join(own.PI_CODING_AGENT_DIR, "trust.json"), JSON.stringify({ [project]: true })),
};
for (const t of installed) await trust[t]();
const after = Object.fromEntries(installed.map((t) => [t, checkTool(t, project, env)]));
for (const t of installed) expect(`${t}: after trust, lists patio`, after[t]!.ok, after[t]);
report.listing = { before, after };

// ---- 2. detection, from inside each tool ----------------------------------------------------------------------------
const probe = (name: string) =>
  `${process.execPath} -e 'import { detectTool } from ${JSON.stringify(join(REPO, "src/detect.ts"))}; const e = process.env; ` +
  `console.log(JSON.stringify({ detected: detectTool(), markers: Object.fromEntries(Object.entries(e).filter(([k]) => /^(AI_AGENT|CLAUDECODE|CLAUDE_CODE_[A-Z_]+|PI_[A-Z_]+|CODEX_[A-Z_]+)$/.test(k) && !/(KEY|TOKEN|SECRET)/.test(k)).map(([k, v]) => [k, /SESSION|THREAD/.test(k) ? "…" : v])) }))' > ${JSON.stringify(join(dumps, `${name}.json`))}`;
const detectProject = join(root, "detect");
await mkdir(join(detectProject, ".pi"), { recursive: true });
await mkdir(join(detectProject, ".claude"), { recursive: true });
Bun.spawnSync(["git", "init", "-q"], { cwd: detectProject });
const server = (name: string) => ({ command: "/bin/sh", args: ["-c", `${probe(name)}; cat > /dev/null`] });
await writeFile(join(detectProject, ".mcp.json"), JSON.stringify({ mcpServers: { probe: { type: "stdio", ...server("claude"), env: {} } } }));
await writeFile(join(detectProject, ".claude", "settings.local.json"), JSON.stringify({ enabledMcpjsonServers: ["probe"] }));
await writeFile(join(detectProject, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { probe: server("pi") } }));
if (installed.includes("claude")) {
  const file = join(home, ".claude.json");
  const doc = JSON.parse(readFileSync(file, "utf8"));
  doc.projects[detectProject] = { hasTrustDialogAccepted: true };
  await writeFile(file, JSON.stringify(doc, null, 2));
}
if (installed.includes("pi")) await writeFile(join(own.PI_CODING_AGENT_DIR, "trust.json"), JSON.stringify({ [project]: true, [detectProject]: true }));
const detection: Record<string, unknown> = {};
for (const t of installed) {
  const cmd = t === "codex" ? ["codex", "sandbox", "--", "/bin/sh", "-c", probe("codex").replace(/ > .*$/, "")] : [t, "mcp", "list"];
  const r = Bun.spawnSync(cmd, { cwd: detectProject, env, stdout: "pipe", stderr: "pipe", timeout: 90_000 });
  const raw = t === "codex" ? r.stdout.toString().trim().split("\n").at(-1) : existsSync(join(dumps, `${t}.json`)) ? readFileSync(join(dumps, `${t}.json`), "utf8") : "";
  let seen: { detected: { tool: string; how: string } | null; markers: Record<string, string> } | null = null;
  try {
    seen = JSON.parse(raw ?? "");
  } catch {}
  detection[t] = { command: cmd.slice(0, 3).join(" "), seen, ...(seen ? {} : { stderr: r.stderr.toString().slice(-400) }) };
  expect(`${t}: a command it runs detects ${t}`, seen?.detected?.tool === t, seen);
}
report.detection = detection;
report.checks = checks;
report.ok = checks.every((c) => c.ok);

await mkdir(VERIFY_DIR, { recursive: true });
const out = join(VERIFY_DIR, `probe-tools-${stamp}.json`);
await writeFile(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ok: report.ok, report: out, installed: report.installed, checks }, null, 2));
process.exit(report.ok ? 0 : 1);
