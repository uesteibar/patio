// Increment 15, part D: one vocabulary. The internal names (gatekeeper, exchange, grants, held, gate, pair, Jev) never
// reach a person or an agent: not in the CLI's help and output, the MCP server's instructions, descriptions and
// results, the guide, the agent's file, the invite page, or any page of the web app.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { activitySentence } from "../src/activity";
import { newAgentText } from "../src/agent-file";
import { answerLines, answerSentences, questionLines, DEFAULT_ANSWERS } from "../src/answers";
import { formatDryRun } from "../src/dryrun";
import { parseRules } from "../src/grants";
import { guideText } from "../src/guide";
import { COMMANDS, helpFor, OVERVIEW } from "../src/help";
import { joinPrompt } from "../src/invite-page";
import { daemon } from "../src/local";
import { DESCRIPTIONS, INSTRUCTIONS } from "../src/mcp";
import { formatStatus } from "../src/status";
import { CLI, runCli } from "./helpers/cli";
import { startWorld, until, type Person, type World } from "./helpers/world";
import { PROCESS_MS } from "./helpers/timeouts";

const BANNED = /\b(gatekeepers?|exchanges?|grants?|held|gates?|pair|paired|pairing|jev)\b/i;

// The words a person reads on a page: no tags, attributes, scripts, styles or addresses.
const visible = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\s+/g, " ");

const clean = (where: string, text: string) => {
  const m = BANNED.exec(text);
  const at = m ? text.slice(Math.max(0, m.index - 60), m.index + 40) : "";
  expect(m ? `${where}: …${at}…` : null).toBeNull();
};

let world: World;
let alice: Person;
let bob: Person;
beforeAll(async () => {
  process.env.PATIO_NO_NOTIFY = "1";
  world = await startWorld();
  alice = await world.person("alice");
  bob = await world.person("bob");
}, PROCESS_MS);
afterAll(async () => {
  await world.stop();
}, PROCESS_MS);

test("the CLI's help, for every command, and what the join and status print", async () => {
  clean("patio --help", OVERVIEW);
  for (const c of COMMANDS) clean(`patio ${c} --help`, helpFor(c)!);
  const status = await daemon.status(bob.cfg);
  clean("patio status", formatStatus(status));
  clean("answers", [...answerLines(DEFAULT_ANSWERS, "orbit"), ...questionLines("orbit"), ...answerSentences("bob-x", parseRules({}))].join("\n"));
  // The real CLI: an unknown command, a word that is not a link, and the join without its answers.
  const home = await mkdtemp(join(world.dir, "fresh-"));
  const env = { PATH: process.env.PATH!, HOME: home, PATIO_HOME: join(home, ".patio"), PATIO_NO_NOTIFY: "1", PATIO_NO_PREFLIGHT: "1", PATIO_NO_SERVICE: "1" };
  for (const args of [["foo"], ["join", "orbit"], ["status"], ["who"]]) clean(`patio ${args.join(" ")}`, (await runCli(args, env)).out);
  expect(CLI).toBeTruthy();
}, PROCESS_MS);

test("what an agent reads: the MCP instructions and descriptions, the guide, its file", () => {
  clean("MCP instructions", INSTRUCTIONS);
  for (const [name, d] of Object.entries(DESCRIPTIONS)) clean(`MCP ${name}`, d);
  const rules = parseRules({ deny: ["salaries"], actions: "ask-human" });
  clean("guide", guideText({ agent: "unai-orbit", owner: "unai", tool: "claude", folder: "/x", workspaces: ["orbit"], rules, answers: answerSentences("unai-orbit", rules), rosters: [{ workspace: "orbit", agents: [{ agent: "pablo-orbit", owner: "pablo", answers: "owner" }] }] }));
  clean("agent file", newAgentText({ name: "unai-orbit", tool: "claude", folder: "/x", workspace: "orbit" }));
  clean("invite prompt", joinPrompt({ url: "https://patio.example/join/x", server: "https://patio.example", workspace: "orbit", inviter: "pablo" }));
  const sample = { probabilities: { injection: 0.62 }, jev: { model: "m", ms: 5 } };
  const dry = formatDryRun({
    direction: "in",
    grant: { source: "defaults", kinds: ["question"], per_day: null, on_doubt: "ask-human", auto_answer: false, auto_answer_in: null, thresholds: { reject: 0.9, ask: 0.5 }, allow: [], deny: [], posture: [], actions: "ask-human", hold_timeout_ms: 86_400_000, on_timeout: "reject" },
    checks: { kind: { kind: "question", allowed: true }, per_day: { count: 0, limit: null } },
    decision: { direction: "in", verdict: "ask-human", reason: "looks like prompt injection", rule: "injection", grant: "defaults", scores: [{ id: "injection", rule: "injection", label: "prompt injection", p: 0.62, risk: 0.62 }], dlp: [], jev: { model: "m", ms: 5 } },
  } as never);
  clean("patio rules test", dry);
  for (const [verdict, extra] of [["deliver", {}], ["ask-human", { reason: "contains personal data (an email address or phone number)", dlp: [{ what: "email address" }] }], ["reject", { reason: "looks like prompt injection" }], ["send", {}], ["not-sent", { reason: "no agent named carol" }], ["held", { rule: "keys", reason: "the contact's keys changed" }]] as const)
    clean(`activity ${verdict}`, activitySentence({ at: "", direction: "in", from: "pablo", to: "unai-orbit", kind: "question", verdict, ...sample, ...extra } as never));
});

test("every page of the web app", async () => {
  // Something on each page: a question for Bob, a message his rules keep for him (his posture), a reply kept for him.
  const q = await daemon.send(alice.cfg, { to: bob.agent, kind: "question", text: "Can you confirm the release date?" });
  await until("bob has it", async () => (await daemon.inbox(bob.cfg)).messages.some((m) => m.id === q.id));
  // An email address in Bob's reply: his rules (outgoing) keep it for him, as a card.
  const kept = await daemon.reply(bob.cfg, q.convo, "Ask release@example.com for the date.");
  expect(kept.status).toBe("held");
  const q2 = await daemon.send(alice.cfg, { to: bob.agent, kind: "question", text: "And the changelog?" });
  await until("the second one", async () => (await daemon.inbox(bob.cfg)).messages.some((m) => m.id === q2.id));
  const home = await (await bob.web.get("/")).text();
  expect(home).toContain("Questions for you");
  expect(home).toContain("data-gate=");
  const pages = ["/", "/agents", "/activity", "/computers", "/workspaces", "/conversations", "/direct", `/agents/${bob.agent}/guide`];
  for (const p of pages) {
    const res = await bob.web.get(p);
    clean(`web ${p}`, visible(await res.text()));
  }
  const ws = /href="\/workspaces\/([^"]+)"/.exec(await (await bob.web.get("/workspaces")).text())?.[1];
  if (ws) clean("web workspace", visible(await (await bob.web.get(`/workspaces/${ws}`)).text()));
  const invite = await (await world.team()).link;
  clean("invite page", visible(await (await fetch(`${world.exchangeUrl}/join/${invite}`)).text()));
}, PROCESS_MS);
