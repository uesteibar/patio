import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stillOurs } from "../../scripts/lib/instance";
import { plaintextMarker, runScenario, type Scenario } from "../../scripts/lib/scenario";
import { PROCESS_MS } from "../helpers/timeouts";

const dir = await mkdtemp(join(tmpdir(), "patio-scn-"));

test("a failed expectation fails the scenario, still writes the transcript, and stops the instance", async () => {
  let relay: Parameters<typeof stillOurs>[0] | undefined;
  const s: Scenario = {
    name: "wrong-expectation",
    description: "expects someone who is not online",
    label: "deterministic",
    agents: () => [{ handle: "alice" }],
    async run(t) {
      relay = t.m.exchange;
      const who = await t.cli("alice", ["who"]);
      t.expect("bob is online", who.stdout.includes("bob"), who.stdout);
    },
  };
  const r = await runScenario(s, { instancesDir: dir });
  expect(r.ok).toBe(false);
  expect(r.checks).toEqual([{ name: "bob is online", ok: false, detail: "alice · @alice · yours" }]);
  expect(await Bun.file(r.transcript).text()).toContain("# Scenario wrong-expectation (deterministic): FAIL");
  expect(existsSync(join(dir, r.instance, "result.json"))).toBe(true);
  expect(stillOurs(relay!)).toBe(false);
}, PROCESS_MS);

test("a scenario with no expectations does not pass", async () => {
  const r = await runScenario({ name: "empty", description: "", label: "deterministic", agents: () => [{ handle: "alice" }], run: async () => {} }, { instancesDir: dir });
  expect(r.ok).toBe(false);
}, PROCESS_MS);

test("a plaintext scan refuses short probes, which match hex ids and ciphertext by chance", async () => {
  let thrown: unknown;
  const s: Scenario = {
    name: "short-probe",
    description: "",
    label: "deterministic",
    agents: () => [{ handle: "alice" }],
    async run(t) {
      try {
        t.scanExchangeDb(["812"]);
      } catch (err) {
        thrown = err;
      }
      t.expect("a marker of 16+ characters is accepted", t.scanExchangeDb([plaintextMarker()]).length === 0);
    },
  };
  const r = await runScenario(s, { instancesDir: dir });
  expect((thrown as Error).message).toContain('plaintext probes must be distinctive markers of 16+ characters, not "812"');
  expect(r.ok).toBe(true);
  expect(plaintextMarker("QTEXT")).toMatch(/^QTEXT-[0-9a-f]{24}$/);
}, PROCESS_MS);
