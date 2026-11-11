// The three answers of the join and the rules they become: each flag's mapping, the caps with their refusals, the
// secrets rule written when missing and never removed, and nothing else in the file changed.
import { expect, test } from "bun:test";
import { newAgentText, parseAgentFile } from "../src/agent-file";
import { answerSentences, answersOf, applyAnswers, CapError, checkAnswers } from "../src/answers";
import { SECRETS_TOPIC } from "../src/grants";
import { agentFileText } from "./helpers/agent-file";

const template = newAgentText({ name: "unai-orbit", tool: "pi", folder: "/srv/orbit" });
const apply = (text: string, a: { ask: "questions" | "requests" | "anything"; act: "ask-human" | "deny"; answer: "yes" | "no" }, ws = "orbit") => {
  const out = applyAnswers(text, "unai-orbit", a, ws);
  return { text: out, file: parseAgentFile(out, "unai-orbit") };
};

test("each flag becomes its rule: --ask the kinds, --act the actions, --answer the workspace in auto_answer_in", () => {
  expect(apply(template, { ask: "questions", act: "deny", answer: "no" }).file.rules.defaults).toMatchObject({ kinds: ["question"], actions: "deny" });
  expect(apply(template, { ask: "requests", act: "ask-human", answer: "no" }).file.rules.defaults).toMatchObject({ kinds: ["question", "request"], actions: "ask-human" });
  const yes = apply(template, { ask: "anything", act: "ask-human", answer: "yes" });
  expect(yes.file.rules.defaults).toMatchObject({ kinds: ["question", "report", "heads-up", "request"], auto_answer_in: ["orbit"] });
  expect(yes.file.asked_in).toEqual(["orbit"]);
  // The file keeps its comments: the lines are edited in place.
  expect(yes.text).toContain("# rules: what other people's agents may ask this agent");
  expect(yes.text).toContain("  auto_answer_in: [orbit]");
  expect(yes.text).toContain("asked_in: [orbit]");
  // Another workspace's yes adds to the list; its no takes only that workspace out.
  const side = apply(yes.text, { ask: "anything", act: "ask-human", answer: "yes" }, "side");
  expect(side.file.rules.defaults.auto_answer_in).toEqual(["orbit", "side"]);
  expect(side.file.asked_in).toEqual(["orbit", "side"]);
  const no = apply(side.text, { ask: "anything", act: "ask-human", answer: "no" }, "orbit");
  expect(no.file.rules.defaults.auto_answer_in).toEqual(["side"]);
  expect(apply(no.text, { ask: "anything", act: "ask-human", answer: "no" }, "side").file.rules.defaults.auto_answer_in).toBeUndefined();
});

test("nothing else changes: allow, deny, posture, contacts, channels and the rest stay; a file in another shape is rewritten whole", () => {
  const text = agentFileText({
    tool: "codex",
    folder: "/srv/x",
    rules: 'defaults:\n  deny: ["salaries"]\n  allow: ["PRs"]\n  posture: ["be brief"]\n  per_day: 9\ncontacts:\n  pablo-x:\n    kinds: [question]\nchannels:\n  orbit/backend:\n    allow: ["deploys"]\n',
  });
  const before = parseAgentFile(text, "unai-orbit");
  const { file } = apply(text, { ask: "questions", act: "ask-human", answer: "yes" });
  expect(file.rules.defaults).toEqual({ ...before.rules.defaults, kinds: ["question"], actions: "ask-human", auto_answer_in: ["orbit"], deny: [SECRETS_TOPIC, "salaries"] });
  expect(file.rules.contacts).toEqual(before.rules.contacts);
  expect(file.rules.channels).toEqual(before.rules.channels);
  expect([file.tool, file.folder]).toEqual(["codex", "/srv/x"]);
});

test("the secrets rule is written when missing, and never removed", () => {
  const without = "tool: pi\nfolder: /srv/x\nrules:\n  deny:\n    - salaries\n";
  const once = apply(without, { ask: "requests", act: "ask-human", answer: "no" });
  expect(once.file.rules.defaults.deny).toEqual([SECRETS_TOPIC, "salaries"]);
  // Already there (the template has it): left as it is, once.
  const twice = apply(once.text, { ask: "anything", act: "deny", answer: "no" });
  expect(twice.file.rules.defaults.deny).toEqual([SECRETS_TOPIC, "salaries"]);
  expect(apply(template, { ask: "anything", act: "deny", answer: "no" }).file.rules.defaults.deny).toEqual([SECRETS_TOPIC]);
});

test("the caps: a value outside the table is refused, naming the cap and the values accepted", () => {
  expect(checkAnswers({ ask: "requests", act: "deny", answer: "yes" }, "orbit")).toEqual({ ask: "requests", act: "deny", answer: "yes" });
  expect(checkAnswers({}, "orbit")).toEqual({});
  const refused = (f: Record<string, string>) => {
    try {
      checkAnswers(f, "orbit");
    } catch (err) {
      expect(err).toBeInstanceOf(CapError);
      return (err as Error).message;
    }
    throw new Error("not refused");
  };
  expect(refused({ ask: "gossip" })).toBe("--ask gossip: what others may ask is one of questions, requests or anything (the join sets only these kinds; other kinds go in the agent's file by hand)");
  expect(refused({ act: "run the test suite" })).toBe(
    "--act run the test suite: changing files for them is ask-human (only when you approve) or deny (never); the join never writes a list of allowed actions (write one in the agent's file, and turn it on in the web app)",
  );
  expect(refused({ answer: "side" })).toBe("--answer side: yes or no, for orbit only (the join turns on answering on its own only for the workspace it joins)");
});

test("the file in the answers' terms, and the three sentences", () => {
  const { file } = apply(template, { ask: "requests", act: "ask-human", answer: "yes" });
  expect(answersOf(file.rules)).toEqual({ ask: "requests", act: "ask-human", answerIn: ["orbit"] });
  expect(answerSentences("unai-orbit", file.rules)).toEqual([
    "Others may ask unai-orbit questions and small requests; never for secrets.",
    "unai-orbit changes files for them only when you approve.",
    "unai-orbit answers the agents of orbit on its own.",
  ]);
  expect(answerSentences("unai-orbit", file.rules, () => false)[2]).toBe("unai-orbit answers the agents of orbit on its own once you turn that on in the web app.");
  const strict = apply(template, { ask: "questions", act: "deny", answer: "no" }).file;
  expect(answerSentences("unai-orbit", strict.rules)).toEqual([
    "Others may ask unai-orbit only questions; never for secrets.",
    "unai-orbit never changes files for them.",
    "unai-orbit does not answer a workspace on its own: the rest waits for you.",
  ]);
  // Set by hand beyond the answers: said as the file has it.
  const hand = parseAgentFile('rules:\n  kinds: [question, report]\n  actions: ["run the tests"]\n', "unai-orbit");
  expect(answersOf(hand.rules)).toEqual({ ask: null, act: null, answerIn: [] });
  expect(answerSentences("unai-orbit", hand.rules).slice(0, 2)).toEqual([
    "Others may send unai-orbit: question, report (set in its file); never for secrets.",
    "unai-orbit may do what its file allows (run the tests), once you turn that on; anything else waits for you.",
  ]);
});
