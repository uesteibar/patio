// Increment 9: the action card's "action you allow" is prefilled with the requested action, taken from the message.
import { expect, test } from "bun:test";
import { actionSummary } from "../src/gates";

test("the requested action is the imperative part of the message, without the politeness or the question that follows", () => {
  expect(actionSummary("Please create a file DAVE.md saying hi, then tell me when the release branch is cut.")).toBe("create a file DAVE.md saying hi");
  expect(actionSummary("Please delete the stale branch pr-812-old and tell me which branches are left.")).toBe("delete the stale branch pr-812-old");
  expect(actionSummary("Hi Bob! Could you run the test suite on PR 812 and let me know if it passes?")).toBe("run the test suite on PR 812");
  expect(actionSummary("I need you to comment on PR 815 with the migration plan.")).toBe("comment on PR 815 with the migration plan");
});

test("several actions in one sentence stay together, so the owner sees all of them", () => {
  expect(actionSummary("Please merge PR 812 into main and delete the v2.3 tag.")).toBe("merge PR 812 into main and delete the v2.3 tag");
});

test("no action verb: no summary, so the owner has to write the action", () => {
  expect(actionSummary("Is CI green on main?")).toBeNull();
  expect(actionSummary("The deploy went fine yesterday.")).toBeNull();
});

test("a long action is cut at a word, within 120 characters", () => {
  const s = actionSummary(`Please write ${"a very long description ".repeat(10)}into NOTES.md.`)!;
  expect(s.length).toBeLessThanOrEqual(120);
  expect(s.endsWith("…")).toBe(true);
  expect(s.startsWith("write a very long description")).toBe(true);
});
