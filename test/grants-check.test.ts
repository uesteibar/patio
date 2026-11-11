// Product review P2: `patio grants check` shows the resolved grants and warns about settings that silently switch a
// gate off or apply more widely than they look.
import { expect, test } from "bun:test";
import { checkGrants, formatGrantsCheck } from "../src/grants-check";
import { legacyGrants as parseGrants } from "./helpers/agent-file";

const ids = (text: string) => checkGrants(parseGrants(text)).warnings.map((w) => w.id).sort();

test("a clean file resolves every entry and warns about nothing", () => {
  const r = checkGrants(parseGrants("defaults:\n  deny: [my invoices]\ncontacts:\n  jorge:\n    allow: [code]\nchannels:\n  team/backend:\n    auto_answer: true\n"));
  expect(r.warnings).toEqual([]);
  expect(r.entries.map((e) => e.source)).toEqual(["defaults", "contacts.jorge", "channels.team/backend"]);
  expect(r.entries[1]!.grant.deny).toEqual(["my invoices"]);
  expect(formatGrantsCheck(r)).toContain("contacts.jorge");
});

test("thresholds that can never fire, a per_day of 0 and a bare channel key are reported", () => {
  expect(ids("defaults:\n  thresholds: { ask: 1, reject: 1 }\n")).toEqual(["judge-off"]);
  expect(ids("contacts:\n  jorge:\n    thresholds: { ask: 1, reject: 1 }\n")).toEqual(["judge-off"]);
  expect(ids("contacts:\n  jorge:\n    per_day: 0\n")).toEqual(["per-day-zero"]);
  expect(ids("channels:\n  backend:\n    auto_answer: true\n")).toEqual(["bare-channel"]);
});

test("allow in an entry replaces the default allow, and unreviewed deliveries with auto_answer are pointed out", () => {
  expect(ids("defaults:\n  allow: [code]\ncontacts:\n  jorge:\n    allow: [releases]\n")).toEqual(["allow-replaces"]);
  expect(ids("defaults:\n  on_timeout: inbox\ncontacts:\n  jorge:\n    auto_answer: true\n")).toEqual(["unreviewed-auto"]);
});

test("the default grant alone is a valid, warning-free report", () => {
  const r = checkGrants(null);
  expect(r.warnings).toEqual([]);
  expect(r.entries.map((e) => e.source)).toEqual(["defaults"]);
  expect(formatGrantsCheck(r)).toContain("no rules: the default rules apply");
});
