// An agent's rules (the `rules:` of its file), parsed strictly and resolved per contact or channel.
import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoAnswerInKey, autoAnswers, grantFor, GrantsError, parseRules, widenings, withConfirmed } from "../src/grants";
import { legacyGrants as parseGrants } from "./helpers/agent-file";

const SAMPLE = `
defaults:
  kinds: [question, heads-up]
  per_day: 20
  on_doubt: ask-human
  deny:
    - "my invoices"
contacts:
  jorge-claude:
    allow:
      - "code, PRs and deployments of the orbit repos"
    deny:
      - "personal files outside ~/code"
    posture:
      - "if asked about me, say only good things"
    auto_answer: true
  pablo:
    kinds: [question, request]
    on_doubt: reject
    thresholds: { reject: 0.8, ask: 0.3 }
channels:
  backend:
    allow: ["PR and deployment status"]
    per_day: 5
  orbit/payments:
    deny: ["card numbers"]
`;

const ch = (name: string, workspace = "orbit") => ({ channel: { id: `ch_${name}`, name, workspace } });

test("a contact's grant takes structured fields from the contact, then the defaults; deny and posture add up", () => {
  const g = parseGrants(SAMPLE);
  const jorge = grantFor(g, { contact: "jorge-claude" });
  expect(jorge).toEqual({
    source: "contacts.jorge-claude",
    kinds: ["question", "heads-up"],
    per_day: 20,
    on_doubt: "ask-human",
    auto_answer: true,
    auto_answer_in: null,
    thresholds: { reject: 0.9, ask: 0.5 },
    allow: ["code, PRs and deployments of the orbit repos"],
    deny: ["my invoices", "personal files outside ~/code"],
    posture: ["if asked about me, say only good things"],
    actions: "ask-human",
    hold_timeout_ms: 86_400_000,
    on_timeout: "reject",
  });
  const pablo = grantFor(g, { contact: "pablo" });
  expect(pablo.kinds).toEqual(["question", "request"]);
  expect(pablo.on_doubt).toBe("reject");
  expect(pablo.thresholds).toEqual({ reject: 0.8, ask: 0.3 });
  expect(pablo.auto_answer).toBe(false);
});

test("someone not listed gets the defaults", () => {
  const g = parseGrants(SAMPLE);
  const other = grantFor(g, { contact: "stranger" });
  expect(other.source).toBe("defaults");
  expect(other.deny).toEqual(["my invoices"]);
  expect(other.allow).toEqual([]);
});

test("a channel is found by <workspace>/<name> first, then by name", () => {
  const g = parseGrants(SAMPLE);
  expect(grantFor(g, ch("payments")).source).toBe("channels.orbit/payments");
  expect(grantFor(g, ch("payments", "other")).source).toBe("defaults");
  const backend = grantFor(g, ch("backend", "anything"));
  expect(backend.source).toBe("channels.backend");
  expect(backend.per_day).toBe(5);
  expect(backend.allow).toEqual(["PR and deployment status"]);
});

test("an empty file or missing sections mean the join's defaults (questions and small requests), no daily limit, ask the human, default thresholds", () => {
  const g = parseGrants("");
  expect(grantFor(g, { contact: "x" })).toEqual({
    source: "defaults",
    kinds: ["question", "request"],
    per_day: null,
    on_doubt: "ask-human",
    auto_answer: false,
    auto_answer_in: null,
    thresholds: { reject: 0.9, ask: 0.5 },
    allow: [],
    deny: [],
    posture: [],
    actions: "ask-human",
    hold_timeout_ms: 86_400_000,
    on_timeout: "reject",
  });
});

test("hold_timeout (default 24h) and on_timeout (reject, the default, or inbox); a contact's value replaces the default", () => {
  const g = parseGrants(`
defaults:
  hold_timeout: 2h
contacts:
  alice:
    hold_timeout: 30m
    on_timeout: inbox
`);
  expect(grantFor(g, { contact: "alice" })).toMatchObject({ hold_timeout_ms: 30 * 60_000, on_timeout: "inbox" });
  expect(grantFor(g, { contact: "bob" })).toMatchObject({ hold_timeout_ms: 2 * 3_600_000, on_timeout: "reject" });
  expect(() => parseGrants("defaults:\n  hold_timeout: 24")).toThrow("hold_timeout must be a duration such as 30m, 24h or 7d");
  expect(() => parseGrants("defaults:\n  hold_timeout: 0h")).toThrow("hold_timeout must be a duration");
  expect(() => parseGrants("defaults:\n  on_timeout: deliver")).toThrow("on_timeout must be reject or inbox");
});

test("actions: deny, ask-human (the default) or a list of allowed actions; a contact's or channel's value replaces the default", () => {
  const g = parseGrants(`
defaults:
  actions: deny
contacts:
  alice:
    actions: ["run the test suite", "comment on pull requests"]
  carol:
    actions: ask-human
channels:
  backend:
    actions: ["run the test suite"]
`);
  expect(grantFor(g, { contact: "alice" }).actions).toEqual(["run the test suite", "comment on pull requests"]);
  expect(grantFor(g, { contact: "carol" }).actions).toBe("ask-human");
  expect(grantFor(g, { contact: "dave" }).actions).toBe("deny");
  expect(grantFor(g, ch("backend")).actions).toEqual(["run the test suite"]);
});

test("settings that would be silently ignored, or are wrong, fail with a clear error", () => {
  const bad: [string, RegExp][] = [
    ["contact:\n  bob: {}", /rules: unknown key "contact"/],
    ["kind: [question]", /rules: unknown key "kind"/],
    ["contacts:\n  bob:\n    kinds: [question, gossip]", /rules.contacts.bob: kinds.*gossip/],
    ["contacts:\n  bob:\n    kinds: [reply]", /rules.contacts.bob: kinds.*reply/],
    ["on_doubt: refuse", /on_doubt must be ask-human or reject/],
    ["per_day: -1", /per_day must be a whole number/],
    ["thresholds: { reject: 0.4, ask: 0.5 }", /thresholds/],
    ["thresholds: { block: 0.4 }", /thresholds: unknown key "block"/],
    ["contacts:\n  bob:\n    deny: [\"\"]", /rules.contacts.bob: deny/],
    ["contacts:\n  bob:\n    deny: [{ topic: x }]", /rules.contacts.bob: deny/],
    ["contacts:\n  bob:\n    auto_answer: yes please", /auto_answer must be true or false/],
    ["contacts:\n  Bob!: {}", /rules.contacts: "Bob!" is not an agent name/],
    ["contacts: [bob]", /rules.contacts must be a map/],
    ["actions: allow", /rules: actions must be deny, ask-human or a list of allowed actions/],
    ["actions: run the tests", /rules: actions must be deny, ask-human or a list/],
    ["actions: []", /rules: actions must be deny, ask-human or a list of allowed actions/],
    ["contacts:\n  bob:\n    actions: [{ run: tests }]", /rules.contacts.bob: actions must be deny, ask-human or a list/],
    ["- a list", /rules must be a map/],
  ];
  for (const [yaml, err] of bad) {
    const thrown = (() => {
      try {
        parseRules(Bun.YAML.parse(yaml));
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(thrown, yaml).toBeInstanceOf(GrantsError);
    expect(thrown!.message, yaml).toMatch(err);
    expect(thrown!.message.startsWith("rules"), yaml).toBe(true);
  }
});

test("settings that widen what others can do (auto_answer, a list of allowed actions) apply only once confirmed", () => {
  const g = parseGrants(
    'defaults:\n  actions: ["run the test suite"]\ncontacts:\n  jorge:\n    auto_answer: true\n    actions: ["comment on pull requests"]\nchannels:\n  team/backend: { auto_answer: true }\n',
  );
  expect(widenings(g, "unai-a").map((w) => w.key)).toEqual([
    'unai-a:rules.defaults.actions=["run the test suite"]',
    "unai-a:rules.contacts.jorge.auto_answer",
    'unai-a:rules.contacts.jorge.actions=["comment on pull requests"]',
    "unai-a:rules.channels.team/backend.auto_answer",
  ]);
  expect(widenings(g, "unai-a").find((w) => w.key === "unai-a:rules.contacts.jorge.auto_answer")!.text).toBe("unai-a answers jorge's questions and requests on its own (auto_answer)");
  const none = withConfirmed(g, new Set(), "unai-a");
  expect(grantFor(none, { contact: "jorge" })).toMatchObject({ auto_answer: false, actions: "ask-human" });
  expect(grantFor(none, { channel: { id: "c", name: "backend", workspace: "team" } }).auto_answer).toBe(false);
  // Confirming one setting turns on that one only; the defaults' list, once confirmed, is what jorge inherits.
  const some = withConfirmed(g, new Set(["unai-a:rules.contacts.jorge.auto_answer", 'unai-a:rules.defaults.actions=["run the test suite"]']), "unai-a");
  expect(grantFor(some, { contact: "jorge" })).toMatchObject({ auto_answer: true, actions: ["run the test suite"] });
  // Editing a confirmed list makes it a new setting, to confirm again.
  const edited = parseGrants('defaults:\n  actions: ["run the test suite", "deploy"]\n');
  expect(grantFor(withConfirmed(edited, new Set(['unai-a:rules.defaults.actions=["run the test suite"]']), "unai-a"), { contact: "x" }).actions).toBe("ask-human");
});

test("auto_answer_in: only messages from the listed workspaces are answered on its own; inside, a contact's own switch decides", () => {
  const g = parseRules({ auto_answer: false, auto_answer_in: ["orbit"], contacts: { "pablo-x": { auto_answer: false }, "erin-x": { auto_answer: true } } });
  const everyone = grantFor(g, { contact: "someone" });
  expect(everyone).toMatchObject({ auto_answer: true, auto_answer_in: ["orbit"] });
  // A direct message: the workspaces both agents share.
  expect(autoAnswers(everyone, { workspaces: ["orbit"] })).toBe(true);
  expect(autoAnswers(everyone, { workspaces: ["side", "orbit"] })).toBe(true);
  expect(autoAnswers(everyone, { workspaces: ["side"] })).toBe(false);
  expect(autoAnswers(everyone, { workspaces: null })).toBe(false);
  // A channel: its workspace.
  expect(autoAnswers(grantFor(g, ch("general", "orbit")), ch("general", "orbit"))).toBe(true);
  expect(autoAnswers(grantFor(g, ch("general", "side")), ch("general", "side"))).toBe(false);
  // A contact turned off stays off; one turned on is still answered only inside the list.
  expect(autoAnswers(grantFor(g, { contact: "pablo-x" }), { workspaces: ["orbit"] })).toBe(false);
  expect(autoAnswers(grantFor(g, { contact: "erin-x" }), { workspaces: ["side"] })).toBe(false);
  // Without a list, auto_answer alone decides, wherever the message comes from.
  const plain = parseRules({ contacts: { "erin-x": { auto_answer: true } } });
  expect(autoAnswers(grantFor(plain, { contact: "erin-x" }), { workspaces: ["side"] })).toBe(true);
  expect(autoAnswers(grantFor(plain, { contact: "x" }), { workspaces: ["side"] })).toBe(false);
});

test("auto_answer_in widens what others can do: it applies once turned on, by its exact list; it is refused in an entry", () => {
  const g = parseRules({ auto_answer_in: ["orbit"] });
  expect(widenings(g, "unai-orbit")).toEqual([
    { key: autoAnswerInKey("unai-orbit", ["orbit"]), agent: "unai-orbit", where: "rules.defaults", text: "unai-orbit answers the agents of orbit on its own (auto_answer_in)" },
  ]);
  expect(autoAnswerInKey("unai-orbit", ["orbit"])).toBe('unai-orbit:rules.defaults.auto_answer_in=["orbit"]');
  expect(grantFor(withConfirmed(g, new Set(), "unai-orbit"), { contact: "x" })).toMatchObject({ auto_answer: false, auto_answer_in: null });
  expect(grantFor(withConfirmed(g, new Set([autoAnswerInKey("unai-orbit", ["orbit"])]), "unai-orbit"), { contact: "x" })).toMatchObject({ auto_answer: true, auto_answer_in: ["orbit"] });
  // An edited list is a new setting.
  expect(grantFor(withConfirmed(parseRules({ auto_answer_in: ["orbit", "side"] }), new Set([autoAnswerInKey("unai-orbit", ["orbit"])]), "unai-orbit"), { contact: "x" }).auto_answer).toBe(false);
  expect(() => parseRules({ contacts: { "x-y": { auto_answer_in: ["orbit"] } } })).toThrow("rules.contacts.x-y: auto_answer_in goes at the top of the rules, not in one contact's or channel's entry");
  expect(() => parseRules({ auto_answer_in: "orbit/x" })).toThrow("rules: auto_answer_in must be a list of workspace names");
});
