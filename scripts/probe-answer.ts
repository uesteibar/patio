// just probe-answer: the answer service's path with the real ACP adapters on this machine, started the way the
// launchd or systemd service starts them: from a minimal PATH, through patio itself (`<patio> x <package>`, never bunx
// on PATH). For each of Claude Code, Codex and Pi that is installed, two environments:
//   1. service: what `patio join` writes into the service (toolpath.ts: each tool's own folder and the system's);
//   2. system:  the system's folders only, plus PATIO_TOOL_PI (the absolute pi the join resolved).
// Each runs the join's preflight (preflight.ts): initialize, and a session in a fresh git project with the preset's
// model and effort. No prompt: no model call, nothing spent. The first run downloads the adapters from npm.
// `--patio <binary>`: through a compiled patio (`just build`) instead of the Bun running this script.
// Writes a JSON report to .verify/probe-answer-<timestamp>.json. Exit 0 when every installed tool starts in both.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setRunner } from "../src/agents";
import { preflight, serviceRunEnv } from "../src/preflight";
import { serviceEnvironment } from "../src/toolpath";
import { DEV_DIR, VERIFY_DIR } from "./lib/paths";

// --patio <binary>: run the adapters through a compiled patio (just build), as a person's computer does.
const at = process.argv.indexOf("--patio");
const compiled = at > 0 ? process.argv[at + 1]! : null;
if (compiled) setRunner(compiled, true);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const root = join(DEV_DIR, "probe-answer", stamp);
const project = join(root, "project");
await mkdir(project, { recursive: true });
Bun.spawnSync(["git", "init", "-q"], { cwd: project });
const cfg = { home: join(root, ".patio"), handle: "", relay: "ws://127.0.0.1:1", socket: join(root, ".patio", "daemon.sock") };
await mkdir(cfg.home, { recursive: true });

const service = serviceRunEnv(cfg);
const system: Record<string, string> = { ...service, PATH: serviceEnvironment({ which: () => null }).PATH! };
const tools = (["claude", "codex", "pi"] as const).filter((t) => Bun.which(t));
const results: { tool: string; env: string; path: string; ok: boolean; said: string; ms: number }[] = [];
for (const tool of tools)
  for (const [name, env] of [
    ["service", service],
    ["system", system],
  ] as const) {
    const t0 = Date.now();
    const r = await preflight(`probe-${tool}`, { tool, folder: project }, env);
    results.push({ tool, env: name, path: env.PATH!, ok: r.ok, said: r.ok ? r.said : r.reason, ms: Date.now() - t0 });
    console.error(`${r.ok ? "ok  " : "FAIL"} ${tool} (${name} PATH=${env.PATH}) ${r.ok ? r.said : r.reason} [${Date.now() - t0} ms]`);
  }
const report = { at: new Date().toISOString(), runner: compiled ?? process.execPath, compiled: !!compiled, pi: service.PATIO_TOOL_PI ?? null, results, skipped: ["claude", "codex", "pi"].filter((t) => !tools.includes(t as never)) };
await mkdir(VERIFY_DIR, { recursive: true });
const out = join(VERIFY_DIR, `probe-answer-${stamp}.json`);
await writeFile(out, JSON.stringify(report, null, 2) + "\n");
console.log(out);
process.exit(results.every((r) => r.ok) ? 0 : 1);
