// The three answers a person gives when an agent joins a workspace (docs/design/rules-at-join.md), and the rules they
// become. They are the whole vocabulary of the join; everything else in the rules stays as it was.
//
//   --ask     questions | requests | anything   rules.kinds: [question]; [question, request]; all four (plus report
//                                               and heads-up)
//   --act     ask-human | deny                  rules.actions: only these two; a list of allowed actions is never
//                                               the join's to write
//   --answer  yes | no                          rules.auto_answer_in gets the workspace being joined, or loses it
//
// The secrets rule (deny credentials, secrets, API keys, tokens and passwords) is written when it is missing and never
// removed. allow, deny (the rest of it) and posture are not touched. A value outside these is refused, naming the cap
// and the values accepted, and the file is left as it was. The file records the workspaces whose join asked
// (asked_in), so the same join run again asks nothing.
import { parseAgentFile, type AgentFile } from "./agent-file";
import { DEFAULT_KINDS, GATED_KINDS, SECRETS_TOPIC, type Grants } from "./grants";
import type { Kind } from "./protocol";

export const ASK = ["requests", "questions", "anything"] as const;
export const ACT = ["ask-human", "deny"] as const;
export const ANSWER = ["no", "yes"] as const;
export type Ask = (typeof ASK)[number];
export type Act = (typeof ACT)[number];
export type Answer = (typeof ANSWER)[number];
export type Answers = { ask: Ask; act: Act; answer: Answer };

// The defaults, in the order the questions name them.
export const DEFAULT_ANSWERS: Answers = { ask: "requests", act: "ask-human", answer: "no" };

export const ASK_KINDS: Record<Ask, Kind[]> = { questions: ["question"], requests: ["question", "request"], anything: [...GATED_KINDS] };
// In the person's words (the design's).
export const ASK_WORDS: Record<Ask, string> = { requests: "questions and small requests", questions: "only questions", anything: "anything they like" };
export const ACT_WORDS: Record<Act, string> = { "ask-human": "only when you approve", deny: "never" };

// An answer outside the table: the message names the cap and the values accepted.
export class CapError extends Error {}

// The flags as given, checked against the caps. Missing ones stay missing.
export function checkAnswers(f: { ask?: string; act?: string; answer?: string }, workspace: string): Partial<Answers> {
  const out: Partial<Answers> = {};
  if (f.ask !== undefined) {
    if (!(ASK as readonly string[]).includes(f.ask))
      throw new CapError(`--ask ${f.ask}: what others may ask is one of questions, requests or anything (the join sets only these kinds; other kinds go in the agent's file by hand)`);
    out.ask = f.ask as Ask;
  }
  if (f.act !== undefined) {
    if (!(ACT as readonly string[]).includes(f.act))
      throw new CapError(`--act ${f.act}: changing files for them is ask-human (only when you approve) or deny (never); the join never writes a list of allowed actions (write one in the agent's file, and turn it on in the web app)`);
    out.act = f.act as Act;
  }
  if (f.answer !== undefined) {
    if (!(ANSWER as readonly string[]).includes(f.answer))
      throw new CapError(`--answer ${f.answer}: yes or no, for ${workspace} only (the join turns on answering on its own only for the workspace it joins)`);
    out.answer = f.answer as Answer;
  }
  return out;
}

// What a file says, in the three answers' terms: null when it says something the answers cannot (set by hand).
export function answersOf(rules: Grants): { ask: Ask | null; act: Act | null; answerIn: string[] } {
  const kinds = rules.defaults.kinds ?? DEFAULT_KINDS;
  const same = (a: Kind[], b: Kind[]) => a.length === b.length && a.every((k) => b.includes(k));
  const ask = ASK.find((a) => same(kinds, ASK_KINDS[a])) ?? null;
  const actions = rules.defaults.actions ?? "ask-human";
  const act = typeof actions === "string" ? actions : null;
  return { ask, act, answerIn: rules.defaults.auto_answer_in ?? [] };
}

// The answers a file holds for a workspace, where they fit the three (else the defaults).
export function answersFor(rules: Grants, workspace: string): Answers {
  const a = answersOf(rules);
  return { ask: a.ask ?? DEFAULT_ANSWERS.ask, act: a.act ?? DEFAULT_ANSWERS.act, answer: a.answerIn.includes(workspace) ? "yes" : "no" };
}

// ---- widening -----------------------------------------------------------------------------------------------------
// Each answer orders from narrow to wide. A change that widens, made outside the join's first answers and not from the
// person's own terminal, waits for the person in the web app (a card); a change that narrows applies at once.
const RANK = {
  ask: { questions: 0, requests: 1, anything: 2 } as Record<Ask, number>,
  act: { deny: 0, "ask-human": 1 } as Record<Act, number>,
  answer: { no: 0, yes: 1 } as Record<Answer, number>,
};

// What applies now (narrowing, or the same) and what widens.
export function splitWidening(current: Answers, wanted: Partial<Answers>): { now: Answers; wider: Partial<Answers> } {
  const now = { ...current };
  const wider: Partial<Answers> = {};
  for (const k of ["ask", "act", "answer"] as const) {
    const w = wanted[k];
    if (w === undefined) continue;
    if ((RANK[k] as Record<string, number>)[w]! > (RANK[k] as Record<string, number>)[current[k]]!) (wider as Record<string, string>)[k] = w;
    else (now as Record<string, string>)[k] = w;
  }
  return { now, wider };
}

// The card's sentences for a widening: "unai-orbit wants to answer orbit on its own".
export function wideningSentences(agent: string, workspace: string, wider: Partial<Answers>): string[] {
  const out: string[] = [];
  if (wider.ask) out.push(`${agent} wants others to ask it ${ASK_WORDS[wider.ask]}`);
  if (wider.act) out.push(`${agent} wants to change files for them when you approve`);
  if (wider.answer === "yes") out.push(`${agent} wants to answer ${workspace} on its own`);
  return out;
}

export const answerFlags = (a: Answers) => `--ask ${a.ask} --act ${a.act} --answer ${a.answer}`;

// The three questions with their defaults in words, and the flag each answer is: for the person's agent to ask, and
// never a line with a|b|c that a model could run as it is.
export function questionLines(workspace: string, d: Answers = DEFAULT_ANSWERS): string[] {
  const others = <T extends string>(values: readonly T[], words: Record<T, string>, flag: string, def: T) =>
    values.filter((v) => v !== def).map((v) => `${words[v]} (${flag} ${v})`).join(", ");
  return [
    `  1. What may ${workspace} ask your agent? default: ${ASK_WORDS[d.ask]} (--ask ${d.ask}); or ${others(ASK, ASK_WORDS, "--ask", d.ask)}`,
    `  2. May it change files for them? default: ${ACT_WORDS[d.act]} (--act ${d.act}); or ${others(ACT, ACT_WORDS, "--act", d.act)}`,
    `  3. Should it answer ${workspace} on its own? default: ${d.answer} (--answer ${d.answer}); or ${d.answer === "no" ? "yes (--answer yes)" : "no (--answer no)"}`,
  ];
}

// The answers in one line each, in the person's words.
export const answerLines = (a: Answers, workspace: string) => [
  `  what ${workspace} may ask: ${ASK_WORDS[a.ask]}`,
  `  changing files for them: ${ACT_WORDS[a.act]}`,
  `  answering ${workspace} on its own: ${a.answer}`,
];

// The three sentences, for the Agents page, the guide and a join run again. `on(key)`: whether the owner turned that
// widening setting on (an auto_answer_in list waits for them until then).
export function answerSentences(agent: string, rules: Grants, on: (list: string[]) => boolean = () => true): [string, string, string] {
  const a = answersOf(rules);
  const ask = a.ask
    ? `Others may ask ${agent} ${a.ask === "anything" ? "anything they like" : a.ask === "questions" ? "only questions" : "questions and small requests"}; never for secrets.`
    : `Others may send ${agent}: ${(rules.defaults.kinds ?? DEFAULT_KINDS).join(", ")} (set in its file); never for secrets.`;
  const act =
    a.act === "deny"
      ? `${agent} never changes files for them.`
      : a.act === "ask-human"
        ? `${agent} changes files for them only when you approve.`
        : `${agent} may do what its file allows (${(rules.defaults.actions as string[]).join("; ")}), once you turn that on; anything else waits for you.`;
  const answer = a.answerIn.length
    ? `${agent} answers the agents of ${a.answerIn.join(", ")} on its own${on(a.answerIn) ? "" : " once you turn that on in the web app"}.`
    : `${agent} does not answer a workspace on its own: the rest waits for you.`;
  return [ask, act, answer];
}

// ---- writing the answers into the file -------------------------------------------------------------------------------

type Plan = { kinds: Kind[]; actions: Act; answerIn: string[]; deny: string[] | null; askedIn: string[]; answerAdded: boolean | null };

// `workspace` null: the answers of a new agent in no workspace yet (patio agents new): the third answer is kept as
// answer_added, for the workspaces `patio agents add` puts it in.
function planOf(file: AgentFile, a: Answers, workspace: string | null): Plan {
  const answerIn = (file.rules.defaults.auto_answer_in ?? []).filter((w) => w !== workspace);
  if (a.answer === "yes" && workspace) answerIn.push(workspace);
  const deny = file.rules.defaults.deny ?? [];
  const hasSecrets = deny.some((d) => d.toLowerCase() === SECRETS_TOPIC.toLowerCase());
  return {
    kinds: ASK_KINDS[a.ask],
    actions: a.act,
    answerIn,
    deny: hasSecrets ? null : [SECRETS_TOPIC, ...deny],
    askedIn: workspace ? [...new Set([...(file.asked_in ?? []), workspace])] : (file.asked_in ?? []),
    answerAdded: workspace ? (file.answer_added ?? null) : a.answer === "yes",
  };
}

const flow = (xs: string[]) => `[${xs.map((x) => (/^[\w-]+$/.test(x) ? x : JSON.stringify(x))).join(", ")}]`;

// Edits the lines of a commented YAML file in place, so the person's comments stay. Null when the file is not shaped
// for it (a flow map, say).
function editLines(text: string, plan: Plan): string | null {
  const lines = text.split("\n");
  const r = lines.findIndex((l) => /^rules:\s*(#.*)?$/.test(l));
  if (r < 0) return null;
  let end = r + 1;
  while (end < lines.length && (lines[end] === "" || /^[\s#]/.test(lines[end]!))) end++;
  const first = lines.slice(r + 1, end).find((l) => /^\s+[\w-]+:/.test(l));
  const indent = first ? /^(\s+)/.exec(first)![1]! : "  ";
  const keyLine = (key: string) => lines.findIndex((l, i) => i > r && i < end && l.startsWith(`${indent}${key}:`));
  const continuation = (at: number) => {
    let n = at + 1;
    while (n < end && lines[n]! !== "" && (lines[n]!.startsWith(`${indent} `) || lines[n]!.startsWith(`${indent}- `))) n++;
    return n - at - 1;
  };
  const set = (key: string, value: string | null) => {
    const at = keyLine(key);
    if (at >= 0) {
      const removed = continuation(at);
      if (value === null) lines.splice(at, 1 + removed), (end -= 1 + removed);
      else lines.splice(at, 1 + removed, `${indent}${key}: ${value}`), (end -= removed);
    } else if (value !== null) {
      lines.splice(r + 1, 0, `${indent}${key}: ${value}`);
      end++;
    }
  };
  set("kinds", flow(plan.kinds));
  set("actions", plan.actions);
  set("auto_answer_in", plan.answerIn.length ? flow(plan.answerIn) : null);
  if (plan.deny) set("deny", flow(plan.deny));
  const top = (key: string, value: string | null, comment: string) => {
    const at = lines.findIndex((l) => new RegExp(`^${key}:`).test(l));
    if (at >= 0) {
      if (value === null) lines.splice(at, 1);
      else lines[at] = `${key}: ${value}`;
      return;
    }
    if (value === null) return;
    while (lines.length && lines.at(-1) === "") lines.pop();
    lines.push(comment, `${key}: ${value}`, "");
  };
  if (plan.askedIn.length || lines.some((l) => /^asked_in:/.test(l)))
    top("asked_in", flow(plan.askedIn), "# asked_in: the workspaces whose join asked you the three questions (patio join, patio rules <agent>).");
  top("answer_added", plan.answerAdded === null ? null : String(plan.answerAdded), "# answer_added: your third answer to patio agents new: whether it answers on its own the workspaces patio agents add puts it in.");
  return lines.join("\n");
}

// The whole file again, from its parsed form (no comments survive), when the lines cannot be edited.
function rewrite(text: string, plan: Plan): string {
  const doc = ((Bun.YAML.parse(text) ?? {}) as Record<string, unknown>) ?? {};
  const rules = { ...((doc.rules ?? {}) as Record<string, unknown>) };
  rules.kinds = plan.kinds;
  rules.actions = plan.actions;
  if (plan.answerIn.length) rules.auto_answer_in = plan.answerIn;
  else delete rules.auto_answer_in;
  if (plan.deny) rules.deny = plan.deny;
  const head = text.split("\n").filter((l, i, all) => l.startsWith("#") && all.slice(0, i).every((x) => x.startsWith("#"))).join("\n");
  const { answer_added: _a, ...rest } = doc;
  return `${head ? `${head}\n` : ""}${JSON.stringify({ ...rest, rules, ...(plan.askedIn.length ? { asked_in: plan.askedIn } : {}), ...(plan.answerAdded === null ? {} : { answer_added: plan.answerAdded }) }, null, 2)}\n`;
}

// The file's text with the answers for `workspace`. Throws when the result would not be exactly the answers on top
// of what the file said (it never writes something else).
export function applyAnswers(text: string, name: string, a: Answers, workspace: string | null): string {
  const before = parseAgentFile(text, name);
  const plan = planOf(before, a, workspace);
  const expected = (f: AgentFile) => {
    const d = f.rules.defaults;
    const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
    const { kinds: _k, actions: _a, auto_answer_in: _i, deny: _d, ...rest } = d;
    const { kinds: _k2, actions: _a2, auto_answer_in: _i2, deny: _d2, ...restBefore } = before.rules.defaults;
    return (
      same(d.kinds, plan.kinds) &&
      d.actions === plan.actions &&
      same(d.auto_answer_in ?? [], plan.answerIn) &&
      same(d.deny ?? [], plan.deny ?? before.rules.defaults.deny ?? []) &&
      same(f.asked_in ?? [], plan.askedIn) &&
      (f.answer_added ?? null) === plan.answerAdded &&
      same(rest, restBefore) &&
      same(f.rules.contacts, before.rules.contacts) &&
      same(f.rules.channels, before.rules.channels) &&
      same([f.tool, f.folder, f.in_place, f.model, f.effort], [before.tool, before.folder, before.in_place, before.model, before.effort])
    );
  };
  const tryParse = (t: string | null) => {
    if (t === null) return false;
    try {
      return expected(parseAgentFile(t, name));
    } catch {
      return false;
    }
  };
  const edited = editLines(text, plan);
  if (tryParse(edited)) return edited!;
  const whole = rewrite(text, plan);
  if (tryParse(whole)) return whole;
  throw new Error(`could not write the answers into agents/${name}.yaml; edit it by hand`);
}

// What an asker is told about an agent: whether it answers on its own, or its owner does (and it may take hours).
export const answersSay = (agent: string, answers: "self" | "owner", owner?: string | null) =>
  answers === "self" ? `${agent} answers on its own` : `${agent} is answered by @${owner || "its owner"}, may take hours`;
