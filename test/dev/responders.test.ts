// The responder matrix recipe (just responders): what counts as a pass. A missing login is a skip, not a failure;
// any file change or wrong answer fails the row.
import { expect, test } from "bun:test";
import { factsHold, QUESTIONS, rowOk, SKIPPED_LOGIN, type Answer, type Row } from "../../scripts/responders";
import { PROCESS_MS } from "../helpers/timeouts";

const hs = { agent: null, logged_in: true, session: true, model: "haiku", effort: "low", mode: "default", modes: [], initialize_ms: 1, session_ms: 2, ms: 3 };
const answer = (over: Partial<Answer> = {}): Answer => ({ question: "q", via: "answer", result: "answered", input: "deliver", output: "send", reply: "r", correct: true, model: null, tools: 1, tool_lines: [], seconds: 1, error: null, ...over });
const row = (over: Partial<Row> = {}): Row => ({ responder: "claude", handshake: hs, handshake_error: null, skipped: null, answers: QUESTIONS.map(() => answer()), file_changes: [], ...over });

test("a row passes only with every answer correct and no file change", () => {
  expect(rowOk(row())).toBe(true);
  expect(rowOk(row({ file_changes: ["added NOTES.md"] }))).toBe(false);
  expect(rowOk(row({ answers: [answer(), answer({ correct: false, error: "expected facts missing" })] }))).toBe(false);
  expect(rowOk(row({ answers: [answer()] }))).toBe(false);
}, PROCESS_MS);

test("Hermes without a login is a skip that passes when its handshake worked; a failed handshake fails", () => {
  expect(rowOk(row({ responder: "hermes-docker", skipped: SKIPPED_LOGIN, answers: [], handshake: { ...hs, logged_in: false } }))).toBe(true);
  expect(rowOk(row({ responder: "hermes-docker", handshake: null, handshake_error: "the agent did not start within 120 s", answers: [] }))).toBe(false);
}, PROCESS_MS);

test("the expected facts: the schema answer names the new table and column; the follow-up says 5 minutes", () => {
  const [schema, follow] = QUESTIONS;
  expect(factsHold("PR 812 adds notifications.channel and a notification_preferences table.", schema.facts)).toBe(true);
  expect(factsHold("PR 812 adds a notification_preferences table.", schema.facts)).toBe(false);
  expect(factsHold("Batched every 5 minutes, per docs/release-notes.md.", follow.facts)).toBe(true);
  expect(factsHold("every five-minute window", follow.facts)).toBe(true);
  expect(factsHold("Batched every 15 minutes.", follow.facts)).toBe(false);
  expect(factsHold(null, follow.facts)).toBe(false);
}, PROCESS_MS);
