import { expect, test } from "bun:test";
import { EXIT_NOT_READY } from "../../scripts/doctor";
import { REPO } from "../../scripts/lib/paths";
import { PROCESS_MS } from "../helpers/timeouts";

const doctor = async (env: Record<string, string>) => {
  const proc = Bun.spawn([process.execPath, "scripts/doctor.ts"], {
    cwd: REPO,
    env: { ...process.env, PATIO_NO_NOTIFY: "1", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  return { code: await proc.exited, report: JSON.parse(out) };
};

test("doctor exits with a distinct code when a deterministic prerequisite is missing", async () => {
  const { code, report } = await doctor({ PATIO_CHROMIUM: "/nonexistent/chromium" });
  expect(code).toBe(EXIT_NOT_READY);
  expect(report.ready_for_deterministic_checks).toBe(false);
  expect(report.checks.chromium.ok).toBe(false);
}, PROCESS_MS);

test("doctor never prints a secret value", async () => {
  const dir = await Bun.$`mktemp -d`.text();
  await Bun.write(`${dir.trim()}/secrets.env`, "TYPESAFE_API_KEY=sk-do-not-print\n");
  const proc = Bun.spawn([process.execPath, "scripts/doctor.ts"], {
    cwd: REPO,
    env: { ...process.env, PATIO_POC_ENV_FILE: `${dir.trim()}/secrets.env` },
    stdout: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  expect(out).not.toContain("sk-do-not-print");
  expect(JSON.parse(out).checks.typesafe_api_key.present).toBe(true);
}, PROCESS_MS);
