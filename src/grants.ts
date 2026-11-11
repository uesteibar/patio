// An agent's rules (grants, in the code): what each contact (an agent) and each channel may ask of that agent and
// learn from it. They live in the agent's file, $PATIO_HOME/agents/<name>.yaml (agent-file.ts), under `rules:`. One
// set of rules per agent: a workspace cannot change them.
//
//   rules:     { kinds, per_day, on_doubt, thresholds, auto_answer, allow, deny, posture, actions, …,
//                auto_answer_in: [<workspace>, …],
//                contacts: { <agent name>: { …same fields… } },
//                channels: { <channel> or <workspace>/<channel>: { …same fields… } } }
//
// Answering on its own (`patio watch --answer`): `auto_answer` says it for everyone (the defaults), a contact or a
// channel. `auto_answer_in`, at the top of the rules only, lists workspaces: the agent answers the agents of those
// workspaces on its own (the join's third question writes it). When the list is present it decides, in this order:
//   1. a message from outside the listed workspaces (a channel's workspace, or for a direct message the workspaces
//      both agents share) is never answered on its own, whatever any auto_answer says;
//   2. inside them, a contact's or a channel's own auto_answer decides for it (false turns one contact off);
//   3. otherwise it is answered on its own: the list replaces the defaults' auto_answer.
// Without the list, auto_answer alone decides, as before. Both widen what others can do, so each applies only once
// the owner turned it on (the web app, or their answer to the join's question).
//
// Structured fields (kinds, per_day, on_doubt, thresholds, auto_answer) are applied by code. Natural-language
// fields (allow, deny, posture) become Jev questions in the gates (gates.ts). A contact's or channel's entry
// overrides the defaults field by field, except deny and posture, which add to the defaults: a default deny
// can never be relaxed for one contact.
//
// `actions` says what happens when a message asks the agent to do something beyond answering (change files, run
// commands, send messages, call services): `deny` rejects it, `ask-human` (the default) holds it for the owner,
// and a list of allowed actions in natural language delivers it when it asks for one of them and nothing else
// (each entry is one more Jev question) and holds it otherwise. Write each entry as what the agent would do:
// "run the test suite", "comment on pull requests".
//
// Without rules the default rules apply (the gates always run): the join's defaults, questions and small requests,
// changing files only when the owner approves, nothing answered on its own. A file with a mistake fails loudly: a setting that
// would be silently ignored is worse than no setting. patio reloads the file when it changes and keeps the last
// valid version when an edit is invalid (live-config.ts).
import { parseDuration } from "./clock";
import { HANDLE_RE, type ChannelRef, type Kind } from "./protocol";

export type OnDoubt = "ask-human" | "reject";
export type OnTimeout = "reject" | "inbox";
export type ActionsPolicy = "deny" | "ask-human" | string[];
export type Thresholds = { reject: number; ask: number };

export type GrantEntry = {
  kinds?: Kind[];
  per_day?: number;
  on_doubt?: OnDoubt;
  thresholds?: Partial<Thresholds>;
  // `patio watch --answer` may answer it on its own.
  auto_answer?: boolean;
  // At the top of the rules only: the workspaces whose agents it answers on its own (see above).
  auto_answer_in?: string[];
  allow?: string[];
  deny?: string[];
  posture?: string[];
  actions?: ActionsPolicy;
  // How long a message the gates held waits for the owner ("24h"), and what then: reject it ("not reviewed in
  // time"), or deliver it to the inbox marked "not reviewed". A held outgoing message is not sent.
  hold_timeout?: string;
  on_timeout?: OnTimeout;
};

export type Grants = { defaults: GrantEntry; contacts: Record<string, GrantEntry>; channels: Record<string, GrantEntry> };

// A grant resolved for one contact or channel. `source` names where it came from, e.g. "contacts.jorge-claude".
export type Grant = {
  source: string;
  kinds: Kind[];
  per_day: number | null;
  on_doubt: OnDoubt;
  // Whether it is answered on its own, before auto_answer_in (autoAnswers below).
  auto_answer: boolean;
  // The workspaces it answers on its own; null: no list, auto_answer alone decides.
  auto_answer_in: string[] | null;
  thresholds: Thresholds;
  allow: string[];
  deny: string[];
  posture: string[];
  actions: ActionsPolicy;
  hold_timeout_ms: number;
  on_timeout: OnTimeout;
};

export const GATED_KINDS: Kind[] = ["question", "report", "heads-up", "request"];
// Without kinds in the rules (or without a file): the join's default answer, "questions and small requests".
export const DEFAULT_KINDS: Kind[] = ["question", "request"];
// Denied by every grant in both gates (gates.ts asks it as its own question); listing it in an agent's rules, as a new
// agent's file does, does not ask it twice.
export const SECRETS_TOPIC = "credentials, secrets, API keys, tokens and passwords";
export const DEFAULT_THRESHOLDS: Thresholds = { reject: 0.9, ask: 0.5 };
export const DEFAULT_HOLD_TIMEOUT = "24h";

export class GrantsError extends Error {}

const FIELDS = ["kinds", "per_day", "on_doubt", "thresholds", "auto_answer", "allow", "deny", "posture", "actions", "hold_timeout", "on_timeout"];
const isMap = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const RULE_RE = /^[^\r\n]{1,300}$/;
const CHANNEL_KEY_RE = /^(?:[\w.-]{1,100}\/)?[\w-]{1,100}$/;
const WORKSPACE_RE = /^[^\r\n/]{1,60}$/;

function entry(where: string, raw: unknown): GrantEntry {
  if (raw === null || raw === undefined) return {};
  if (!isMap(raw)) throw new GrantsError(`${where} must be a map of settings`);
  for (const key of Object.keys(raw)) {
    if (key === "auto_answer_in") throw new GrantsError(`${where}: auto_answer_in goes at the top of the rules, not in one contact's or channel's entry`);
    if (!FIELDS.includes(key)) throw new GrantsError(`${where}: unknown key "${key}"; use ${FIELDS.join(", ")}`);
  }
  const e: GrantEntry = {};
  if (raw.kinds !== undefined) {
    const kinds = Array.isArray(raw.kinds) ? raw.kinds : [raw.kinds];
    const wrong = kinds.filter((k) => !GATED_KINDS.includes(k as Kind));
    if (wrong.length || !kinds.length)
      throw new GrantsError(`${where}: kinds must list some of ${GATED_KINDS.join(", ")} (got ${wrong.join(", ") || "none"}); replies are never gated by kind`);
    e.kinds = kinds as Kind[];
  }
  if (raw.per_day !== undefined) {
    if (!Number.isInteger(raw.per_day) || (raw.per_day as number) < 0) throw new GrantsError(`${where}: per_day must be a whole number, 0 or more`);
    e.per_day = raw.per_day as number;
  }
  if (raw.on_doubt !== undefined) {
    if (raw.on_doubt !== "ask-human" && raw.on_doubt !== "reject") throw new GrantsError(`${where}: on_doubt must be ask-human or reject`);
    e.on_doubt = raw.on_doubt;
  }
  if (raw.thresholds !== undefined) {
    if (!isMap(raw.thresholds)) throw new GrantsError(`${where}: thresholds must be a map with reject and ask`);
    for (const key of Object.keys(raw.thresholds)) if (key !== "reject" && key !== "ask") throw new GrantsError(`${where}: thresholds: unknown key "${key}"; use reject and ask`);
    for (const [k, v] of Object.entries(raw.thresholds))
      if (typeof v !== "number" || v <= 0 || v > 1) throw new GrantsError(`${where}: thresholds.${k} must be a probability above 0 and at most 1`);
    e.thresholds = raw.thresholds as Partial<Thresholds>;
  }
  if (raw.auto_answer !== undefined) {
    if (typeof raw.auto_answer !== "boolean") throw new GrantsError(`${where}: auto_answer must be true or false`);
    e.auto_answer = raw.auto_answer;
  }
  for (const key of ["allow", "deny", "posture"] as const) {
    if (raw[key] === undefined) continue;
    const list = Array.isArray(raw[key]) ? raw[key] : [raw[key]];
    if (list.some((r) => typeof r !== "string" || !RULE_RE.test(r.trim())))
      throw new GrantsError(`${where}: ${key} must be a list of single-line texts of at most 300 characters`);
    e[key] = list.map((r) => (r as string).trim());
  }
  if (raw.actions !== undefined) {
    const a = raw.actions;
    // A single word is a policy, never an allowed action: `actions: allow` is a mistake, not an action named "allow".
    if (a === "deny" || a === "ask-human") e.actions = a;
    else if (Array.isArray(a) && a.length && a.every((r) => typeof r === "string" && RULE_RE.test(r.trim()))) e.actions = a.map((r) => (r as string).trim());
    else throw new GrantsError(`${where}: actions must be deny, ask-human or a list of allowed actions (single-line texts of at most 300 characters)`);
  }
  if (raw.hold_timeout !== undefined) {
    if (parseDuration(raw.hold_timeout) === null) throw new GrantsError(`${where}: hold_timeout must be a duration such as 30m, 24h or 7d`);
    e.hold_timeout = String(raw.hold_timeout).trim();
  }
  if (raw.on_timeout !== undefined) {
    if (raw.on_timeout !== "reject" && raw.on_timeout !== "inbox") throw new GrantsError(`${where}: on_timeout must be reject or inbox`);
    e.on_timeout = raw.on_timeout;
  }
  return e;
}

function section(name: string, raw: unknown, keyRe: RegExp, what: string): Record<string, GrantEntry> {
  if (raw === null || raw === undefined) return {};
  if (!isMap(raw)) throw new GrantsError(`${name} must be a map keyed by ${what}`);
  const out: Record<string, GrantEntry> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!keyRe.test(key)) throw new GrantsError(`${name}: "${key}" is not ${what === "agent name" ? "an agent name" : `a ${what}`}`);
    out[key] = entry(`${name}.${key}`, value);
  }
  return out;
}

// The rules inside an agent's file (agent-file.ts): the defaults' fields at the top level, plus `contacts` and
// `channels`. `where` prefixes every error ("rules").
export function parseRules(raw: unknown, where = "rules"): Grants {
  if (raw === null || raw === undefined) raw = {};
  if (!isMap(raw)) throw new GrantsError(`${where} must be a map of settings, contacts and channels`);
  const { contacts, channels, auto_answer_in, ...defaults } = raw;
  for (const key of Object.keys(defaults))
    if (!FIELDS.includes(key)) throw new GrantsError(`${where}: unknown key "${key}"; use ${FIELDS.join(", ")}, auto_answer_in, contacts and channels`);
  const top = entry(where, defaults);
  if (auto_answer_in !== undefined && auto_answer_in !== null) {
    const list = Array.isArray(auto_answer_in) ? auto_answer_in : [auto_answer_in];
    if (list.some((w) => typeof w !== "string" || !WORKSPACE_RE.test(w.trim()))) throw new GrantsError(`${where}: auto_answer_in must be a list of workspace names`);
    top.auto_answer_in = [...new Set(list.map((w) => (w as string).trim()))];
  }
  const grants: Grants = {
    defaults: top,
    contacts: section(`${where}.contacts`, contacts, HANDLE_RE, "agent name"),
    channels: section(`${where}.channels`, channels, CHANNEL_KEY_RE, "channel name or <workspace>/<channel>"),
  };
  checkThresholds(grants, where);
  return grants;
}

function checkThresholds(grants: Grants, where: string) {
  for (const [at, e] of [[where, grants.defaults] as const, ...Object.entries(grants.contacts).map(([k, e]) => [`${where}.contacts.${k}`, e] as const), ...Object.entries(grants.channels).map(([k, e]) => [`${where}.channels.${k}`, e] as const)]) {
    const t = { ...DEFAULT_THRESHOLDS, ...grants.defaults.thresholds, ...e.thresholds };
    if (t.ask > t.reject) throw new GrantsError(`${at}: thresholds.ask (${t.ask}) must not be above thresholds.reject (${t.reject})`);
  }
}

export const EMPTY_GRANTS: Grants = { defaults: {}, contacts: {}, channels: {} };

// The grant for a direct contact (an agent name) or for a channel.
export function grantFor(g: Grants, who: { contact: string } | { channel: ChannelRef }): Grant {
  let source = "defaults";
  let specific: GrantEntry = {};
  if ("contact" in who) {
    if (Object.hasOwn(g.contacts, who.contact)) [source, specific] = [`contacts.${who.contact}`, g.contacts[who.contact]!];
  } else {
    const full = `${who.channel.workspace}/${who.channel.name}`;
    if (Object.hasOwn(g.channels, full)) [source, specific] = [`channels.${full}`, g.channels[full]!];
    else if (Object.hasOwn(g.channels, who.channel.name)) [source, specific] = [`channels.${who.channel.name}`, g.channels[who.channel.name]!];
  }
  const d = g.defaults;
  return {
    source,
    kinds: specific.kinds ?? d.kinds ?? DEFAULT_KINDS,
    per_day: specific.per_day ?? d.per_day ?? null,
    on_doubt: specific.on_doubt ?? d.on_doubt ?? "ask-human",
    // With a list, the list replaces the defaults' switch; a contact's or channel's own still decides for it.
    auto_answer: specific.auto_answer ?? (d.auto_answer_in ? true : d.auto_answer) ?? false,
    auto_answer_in: d.auto_answer_in ?? null,
    thresholds: { ...DEFAULT_THRESHOLDS, ...d.thresholds, ...specific.thresholds },
    allow: specific.allow ?? d.allow ?? [],
    deny: [...(d.deny ?? []), ...(specific.deny ?? [])].filter((t) => t.toLowerCase() !== SECRETS_TOPIC.toLowerCase()),
    posture: [...(d.posture ?? []), ...(specific.posture ?? [])],
    actions: specific.actions ?? d.actions ?? "ask-human",
    hold_timeout_ms: parseDuration(specific.hold_timeout ?? d.hold_timeout ?? DEFAULT_HOLD_TIMEOUT)!,
    on_timeout: specific.on_timeout ?? d.on_timeout ?? "reject",
  };
}

// Whether a message is answered on its own: its grant's auto_answer, and with auto_answer_in, only when the message
// comes from one of those workspaces (its channel's, or for a direct message one the two agents share).
export function autoAnswers(g: Pick<Grant, "auto_answer" | "auto_answer_in">, msg: { channel?: { workspace: string } | null; workspaces?: string[] | null }): boolean {
  if (!g.auto_answer) return false;
  if (g.auto_answer_in === null) return true;
  const from = msg.channel ? [msg.channel.workspace] : (msg.workspaces ?? []);
  return from.some((w) => g.auto_answer_in!.includes(w));
}

// ---- settings that widen what others can do (README: who confirms what) ----------------------------------------
// `auto_answer: true` lets others' messages start the owner's agent, and a list of `actions` lets them ask it to act.
// Either always needs the owner's confirmation in the web app, even when they wrote it in their own terminal: an agent
// that can edit its own file must not be able to widen its own reach. Until confirmed, such a setting is left out (so
// the entry inherits, and the defaults are auto_answer off and actions ask-human). Each one is confirmed by its key,
// which names the agent, the entry and, for a list, the list itself: an edited list
// is a new setting, and turning a setting on for one agent turns it on for no other.
export type Widening = { key: string; agent: string; where: string; text: string };

const whoOf = (where: string) =>
  where === "defaults" ? "everyone without an entry of their own" : where.startsWith("contacts.") ? where.slice(9) : `#${where.slice(9)}`;

const entriesOf = (g: Grants): [string, GrantEntry][] => [
  ["defaults", g.defaults],
  ...Object.entries(g.contacts).map(([k, e]) => [`contacts.${k}`, e] as [string, GrantEntry]),
  ...Object.entries(g.channels).map(([k, e]) => [`channels.${k}`, e] as [string, GrantEntry]),
];

// `prefix`: where these rules sit in the agent's file ("rules"); `agent`: whose they are.
export function widenings(g: Grants, agent: string, prefix = "rules"): Widening[] {
  const out: Widening[] = [];
  for (const [entry, e] of entriesOf(g)) {
    const where = `${prefix}.${entry}`;
    const who = whoOf(entry);
    const whose = entry === "defaults" ? "the questions and requests of everyone without an entry of their own" : `${who}'s questions and requests`;
    if (e.auto_answer === true) out.push({ key: `${agent}:${where}.auto_answer`, agent, where, text: `${agent} answers ${whose} on its own (auto_answer)` });
    if (Array.isArray(e.actions))
      out.push({ key: `${agent}:${where}.actions=${JSON.stringify(e.actions)}`, agent, where, text: `${who} may ask ${agent} to ${e.actions.join("; ")} (actions)` });
    if (e.auto_answer_in?.length)
      out.push({ key: autoAnswerInKey(agent, e.auto_answer_in, prefix), agent, where, text: `${agent} answers the agents of ${e.auto_answer_in.join(", ")} on its own (auto_answer_in)` });
  }
  return out;
}

// The key that turns on an auto_answer_in list (the exact list: an edited list is a new setting).
export const autoAnswerInKey = (agent: string, list: string[], prefix = "rules") => `${agent}:${prefix}.defaults.auto_answer_in=${JSON.stringify(list)}`;

// The rules as the gates apply them: what widens and is not confirmed is left out.
export function withConfirmed(g: Grants, confirmed: Set<string>, agent: string, prefix = "rules"): Grants {
  const strip = (entry: string, e: GrantEntry): GrantEntry => {
    const where = `${agent}:${prefix}.${entry}`;
    const out = { ...e };
    if (out.auto_answer === true && !confirmed.has(`${where}.auto_answer`)) delete out.auto_answer;
    if (Array.isArray(out.actions) && !confirmed.has(`${where}.actions=${JSON.stringify(out.actions)}`)) delete out.actions;
    if (out.auto_answer_in && !confirmed.has(`${where}.auto_answer_in=${JSON.stringify(out.auto_answer_in)}`)) delete out.auto_answer_in;
    return out;
  };
  return {
    defaults: strip("defaults", g.defaults),
    contacts: Object.fromEntries(Object.entries(g.contacts).map(([k, e]) => [k, strip(`contacts.${k}`, e)])),
    channels: Object.fromEntries(Object.entries(g.channels).map(([k, e]) => [k, strip(`channels.${k}`, e)])),
  };
}
