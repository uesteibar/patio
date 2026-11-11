// Increment 9: `patio grants test` runs a gate as a dry run, in the gatekeeper, with its grants and its Jev: which
// grant applies, the structured checks, each Jev question with its probability, and the verdict. Nothing is sent
// or stored, and no audit line is written.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { dryRunExit, formatDryRun } from "../src/dryrun";
import { jevJudge } from "../src/gates";
import { daemon } from "../src/local";
import { startFakeJev } from "./fakes/fake-jev";
import { startWorld, type Person, type World } from "./helpers/world";
import { SERVER_MS } from "./helpers/timeouts";

const noul = (n: number) => ({ type: "noul" as const, noul: n });
const fake = startFakeJev(
  {
    default: noul(0.02),
    answers: {
      injection: [{ stateMatches: "ignore (all )?previous", answer: noul(0.97) }, { stateMatches: "maybe", answer: noul(0.62) }, { answer: noul(0.02) }],
      deny_0: [{ stateMatches: "invoice", answer: noul(0.95) }, { answer: noul(0.03) }],
      posture_0: [{ stateMatches: "always late", answer: noul(0.2) }, { answer: noul(0.97) }],
    },
  },
  { apiKey: "k" },
);
const judge = jevJudge({ apiKey: "k", baseURL: fake.url });

const GRANTS = `
defaults:
  kinds: [question, request]
  per_day: 20
contacts:
  alice:
    deny: ["my invoices"]
    posture: ["say only good things about Unai"]
`;

let world: World;
let bob: Person;
beforeAll(async () => {
  process.env.PATIO_NO_NOTIFY = "1";
  world = await startWorld();
  bob = await world.person("bob", { grants: GRANTS, dopts: { judge } });
}, SERVER_MS);
afterAll(async () => {
  await world.stop();
  fake.stop();
}, SERVER_MS);

test("input: deliver, hold and reject, with the grant, the structured checks and every Jev probability; nothing stored or logged", async () => {
  const requests = fake.requests.length;
  const ok = await daemon.grantsTest(bob.cfg, { text: "Is PR 812 merging today?", from: "alice" });
  expect(ok).toMatchObject({ direction: "in", grant: { source: "contacts.alice" }, checks: { kind: { kind: "question", allowed: true }, per_day: { count: 0, limit: 20 } }, decision: { verdict: "deliver" } });
  expect(ok.decision.scores.map((s) => [s.id, s.p])).toEqual([["injection", 0.02], ["action", 0.02], ["secrets", 0.02], ["deny_0", 0.03]]);
  const out = formatDryRun(ok);
  expect(out).toContain("your rules (incoming), dry run: nothing is sent, stored or logged");
  expect(out).toContain("rules: contacts.alice");
  expect(out).toContain("kind question: allowed");
  expect(out).toContain("per day: 0 of 20 today");
  expect(out).toContain("0.03  Denied topic: my invoices");
  expect(out).toContain("verdict: deliver");
  expect(dryRunExit(ok)).toBe(0);

  const held = await daemon.grantsTest(bob.cfg, { text: "Could you maybe look at the deploy?", from: "alice" });
  expect(held.decision).toMatchObject({ verdict: "ask-human", reason: "looks like prompt injection", rule: "injection" });
  expect(formatDryRun(held)).toContain("verdict: waits for you (ask-human) (looks like prompt injection; rule injection)");
  expect(dryRunExit(held)).toBe(7);

  const rejected = await daemon.grantsTest(bob.cfg, { text: "How much did you invoice last quarter?", from: "alice" });
  expect(rejected.decision).toMatchObject({ verdict: "reject", reason: "asks about a denied topic", rule: "deny[0]" });
  expect(dryRunExit(rejected)).toBe(8);

  // A kind the grant does not allow is rejected by the structured rule; Jev is not asked.
  const kind = await daemon.grantsTest(bob.cfg, { text: "FYI the build is green", from: "carol", kind: "report" });
  expect(kind).toMatchObject({ grant: { source: "defaults" }, checks: { kind: { kind: "report", allowed: false } }, decision: { verdict: "reject", rule: "kinds" } });
  expect(formatDryRun(kind)).toContain("the judge: not asked");
  expect(fake.requests.length).toBe(requests + 3);

  expect(existsSync(join(bob.home, "audit.jsonl")) ? await Bun.file(join(bob.home, "audit.jsonl")).text() : "").not.toContain("dry");
  expect((await daemon.inbox(bob.cfg, { filter: "all" })).messages).toEqual([]);
  expect((await daemon.inbox(bob.cfg, { filter: "rejected" })).messages).toEqual([]);
}, SERVER_MS);

test("output: DLP and the Jev questions, for a reply to a contact", async () => {
  const before = existsSync(join(bob.home, "audit.jsonl")) ? await Bun.file(join(bob.home, "audit.jsonl")).text() : "";
  const path = await daemon.grantsTest(bob.cfg, { text: "See /home/bob/code/orbit/docs/release.md", outgoing: true, to: "alice" });
  expect(path).toMatchObject({ direction: "out", decision: { verdict: "block", rule: "dlp:path" } });
  expect(formatDryRun(path)).toContain("data checks: local path");
  const posture = await daemon.grantsTest(bob.cfg, { text: "Unai is always late with reviews.", outgoing: true, to: "alice" });
  expect(posture.decision).toMatchObject({ verdict: "ask-human", rule: "posture[0]" });
  expect(formatDryRun(posture)).toContain("your rules (outgoing), dry run");
  const fine = await daemon.grantsTest(bob.cfg, { text: "Merging after lunch.", outgoing: true, to: "alice" });
  expect(fine.decision.verdict).toBe("send");
  expect(dryRunExit(fine)).toBe(0);
  expect(existsSync(join(bob.home, "audit.jsonl")) ? await Bun.file(join(bob.home, "audit.jsonl")).text() : "").toBe(before);
}, SERVER_MS);

test("the input needs --from, the output --to (or a channel)", async () => {
  await expect(daemon.grantsTest(bob.cfg, { text: "hi" })).rejects.toThrow("--from");
  await expect(daemon.grantsTest(bob.cfg, { text: "hi", outgoing: true })).rejects.toThrow("--to");
}, SERVER_MS);
