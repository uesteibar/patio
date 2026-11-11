// just verify [--live]: doctor, check, every scenario, mcp-probe and browser-check (plus the live smokes with
// --live), each through its just recipe. Writes .verify/<timestamp>-<short-rev>/{summary.md,manifest.json,logs/}.
// Exit 1 when any required step fails.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { collectDoctor } from "./doctor";
import { gitState } from "./lib/git";
import { REPO, VERIFY_DIR } from "./lib/paths";
import type { Label } from "./lib/scenario";
import { SCENARIOS } from "./scenario";

export type Step = {
  name: string;
  cmd: string[];
  label: Label;
  required: boolean;
  // Lets a step use what an earlier step printed (mcp-probe needs the id `just up` printed).
  argsFrom?: (prev: Map<string, StepResult>) => string[] | null;
};

export type StepResult = {
  name: string;
  command: string;
  label: Label;
  required: boolean;
  exit_code: number | null;
  duration_ms: number;
  ok: boolean;
  log: string;
  stdout_tail: string;
  evidence: string[];
  skipped?: string;
};

// Pulls evidence paths (transcripts, screenshots, reports) out of a step's JSON or text output.
function evidenceIn(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/"(transcript|screenshot|dir)":\s*"([^"]+)"/g)) found.add(m[2]!);
  for (const m of text.matchAll(/(?:transcript|report) (\/\S+)/g)) found.add(m[1]!);
  return [...found];
}

export async function runSteps(steps: Step[], logDir: string, env: Record<string, string | undefined> = process.env): Promise<StepResult[]> {
  await mkdir(logDir, { recursive: true });
  const results = new Map<string, StepResult>();
  let n = 0;
  for (const step of steps) {
    n++;
    const extra = step.argsFrom ? step.argsFrom(results) : [];
    const cmd = [...step.cmd, ...(extra ?? [])];
    const log = join(logDir, `${String(n).padStart(2, "0")}-${step.name.replace(/[^\w-]+/g, "_")}.log`);
    const base = { name: step.name, command: cmd.join(" "), label: step.label, required: step.required, log };
    if (extra === null) {
      const r: StepResult = { ...base, exit_code: null, duration_ms: 0, ok: false, stdout_tail: "", evidence: [], skipped: "a step it depends on failed" };
      results.set(step.name, r);
      await writeFile(log, `skipped: ${r.skipped}\n`);
      continue;
    }
    const started = Date.now();
    const proc = Bun.spawn(cmd, { cwd: REPO, env: { ...env, PATIO_NO_NOTIFY: "1" } as Record<string, string>, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    await writeFile(log, `$ ${base.command}\nexit ${code}\n\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
    const r: StepResult = {
      ...base,
      exit_code: code,
      duration_ms: Date.now() - started,
      ok: code === 0,
      stdout_tail: stdout.trim().split("\n").slice(-1)[0] ?? "",
      evidence: evidenceIn(stdout + "\n" + stderr),
    };
    results.set(step.name, r);
    console.error(`${r.ok ? "ok  " : "FAIL"} ${step.name} (${r.duration_ms} ms, exit ${code})`);
  }
  return [...results.values()];
}

export const overallOk = (results: StepResult[]) => results.filter((r) => r.required).every((r) => r.ok);

export function verifySteps(live: boolean): Step[] {
  const just = (...args: string[]) => ["just", ...args];
  const steps: Step[] = [
    { name: "doctor", cmd: just("doctor"), label: "deterministic", required: true },
    { name: "check", cmd: just("check"), label: "deterministic", required: true },
    ...SCENARIOS.map((s): Step => ({ name: `scenario ${s.name}`, cmd: just("scenario", s.name), label: s.label, required: true })),
    { name: "mcp-probe: up", cmd: just("up", "alice", "bob"), label: "deterministic", required: true },
    {
      name: "mcp-probe",
      cmd: just("mcp-probe"),
      label: "deterministic",
      required: true,
      argsFrom: (prev) => {
        const r = prev.get("mcp-probe: up");
        return r?.ok ? [r.stdout_tail, "alice"] : null;
      },
    },
    {
      name: "mcp-probe: down",
      cmd: just("down"),
      label: "deterministic",
      required: true,
      argsFrom: (prev) => {
        const r = prev.get("mcp-probe: up");
        return r?.ok ? [r.stdout_tail] : null;
      },
    },
    { name: "browser-check", cmd: just("browser-check"), label: "deterministic", required: true },
    { name: "browser-join", cmd: just("browser-join"), label: "deterministic", required: true },
    { name: "browser-channels", cmd: just("browser-channels"), label: "deterministic", required: true },
    { name: "browser-gates", cmd: just("browser-gates"), label: "deterministic", required: true },
    { name: "browser-keys", cmd: just("browser-keys"), label: "deterministic", required: true },
    { name: "browser-activity", cmd: just("browser-activity"), label: "deterministic", required: true },
    { name: "browser-invites", cmd: just("browser-invites"), label: "deterministic", required: true },
    // The actions harness with test doubles, so the live recipe keeps working between live runs.
    { name: "actions --fake", cmd: just("actions", "--fake"), label: "deterministic", required: true },
    // The responder matrix with the fake ACP agent in place of each preset (Hermes's missing login included).
    { name: "responders --fake", cmd: just("responders", "--fake"), label: "deterministic", required: true },
  ];
  if (live)
    steps.push(
      { name: "smoke-acp", cmd: just("smoke-acp", "--yes-live"), label: "live", required: true },
      { name: "smoke-jev", cmd: just("smoke-jev", "--yes-live"), label: "live", required: true },
      { name: "smoke-gates", cmd: just("smoke-gates", "--yes-live"), label: "live", required: true },
      { name: "rules-live", cmd: just("rules-live", "--yes-live"), label: "live", required: true },
    );
  return steps;
}

function summary(m: Record<string, any>, results: StepResult[]): string {
  const rel = (p: string) => (p.startsWith(REPO + "/") ? p.slice(REPO.length + 1) : p);
  const row = (r: StepResult) =>
    `| ${r.name} | ${r.label} | ${r.required ? "yes" : "no"} | ${r.exit_code ?? "-"} | ${(r.duration_ms / 1000).toFixed(1)} s | ${r.skipped ? "SKIPPED" : r.ok ? "pass" : "FAIL"} |`;
  const versions = Object.entries(m.versions as Record<string, unknown>).map(([k, v]) => `| ${k} | ${v ?? "missing"} |`);
  return [
    `# Verification ${m.ok ? "PASS" : "FAIL"}`,
    "",
    `Revision \`${m.revision}\`${m.dirty ? " (dirty: uncommitted changes)" : ""}, ${m.started_at}, ${m.live ? "with live smokes" : "deterministic only (no --live)"}.`,
    "",
    "| Step | Label | Required | Exit | Duration | Result |",
    "|---|---|---|---|---|---|",
    ...results.map(row),
    "",
    "## Evidence",
    "",
    ...results.flatMap((r) => [`- ${r.name}: log \`${rel(r.log)}\``, ...r.evidence.map((e) => `  - \`${rel(e)}\``)]),
    "",
    "## Versions",
    "",
    "| Dependency | Version |",
    "|---|---|",
    ...versions,
    "",
    m.live ? "Live results come from paid services and count against `.dev/budget.json`." : "No live smoke ran: nothing here is live evidence. Fakes (fake ACP agent, fake Jev) are test doubles.",
    "",
  ].join("\n");
}

if (import.meta.main) {
  const live = process.argv.includes("--live");
  const git = await gitState();
  const startedAt = new Date();
  const dir = join(VERIFY_DIR, `${startedAt.toISOString().replace(/[:.]/g, "-")}-${git.short}`);
  const doctor = await collectDoctor();
  const c = doctor.checks;
  const versions = {
    bun: c.bun.version,
    just: c.just.version,
    mise: c.mise.version,
    chromium: c.chromium.version,
    codex: c.codex.version,
    ...c.dependencies.installed,
  };
  const results = await runSteps(verifySteps(live), join(dir, "logs"));
  const ok = overallOk(results);
  const manifest = {
    ok,
    live,
    revision: git.revision,
    dirty: git.dirty,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    versions,
    results,
  };
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(join(dir, "summary.md"), summary(manifest, results));
  console.error(`\n${ok ? "PASS" : "FAIL"}: ${join(dir, "summary.md")}`);
  console.log(join(dir, "summary.md"));
  process.exit(ok ? 0 : 1);
}
