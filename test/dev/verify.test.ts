import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overallOk, runSteps, verifySteps } from "../../scripts/verify";

test("a failing required step fails verification, an optional one does not, and dependants are skipped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "patio-verify-"));
  const results = await runSteps(
    [
      { name: "good", cmd: ["true"], label: "deterministic", required: true },
      { name: "optional bad", cmd: ["false"], label: "live", required: false },
      { name: "producer", cmd: ["false"], label: "deterministic", required: true },
      { name: "consumer", cmd: ["echo"], label: "deterministic", required: true, argsFrom: (p) => (p.get("producer")?.ok ? ["x"] : null) },
    ],
    dir,
  );
  expect(results.map((r) => [r.name, r.ok, r.exit_code])).toEqual([
    ["good", true, 0],
    ["optional bad", false, 1],
    ["producer", false, 1],
    ["consumer", false, null],
  ]);
  expect(results[3]!.skipped).toBeDefined();
  expect(overallOk(results)).toBe(false);
  expect(overallOk(results.slice(0, 2))).toBe(true);
});

test("live smokes are only part of verification with --live", () => {
  const names = (live: boolean) => verifySteps(live).map((s) => s.name);
  expect(names(false).some((n) => n.startsWith("smoke"))).toBe(false);
  expect(verifySteps(true).filter((s) => s.label === "live").map((s) => s.name)).toEqual(["smoke-acp", "smoke-jev", "smoke-gates", "rules-live"]);
  expect(verifySteps(true).find((s) => s.name === "smoke-acp")?.cmd).toContain("--yes-live");
});
