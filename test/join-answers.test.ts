// The join asks the person three questions and the agent's rules become their answers (docs/design/rules-at-join.md).
// The real CLI on fresh homes: from an agent (no terminal) without the answers it joins everything else and exits 13
// with the command to run with them; in a terminal it asks, one line each, Enter keeping the default; run again it asks
// nothing; a second agent of the same person starts from the first one's answers; a value outside the caps is refused
// and nothing changes.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { parseAgentFile } from "../src/agent-file";
import { autoAnswerInKey, SECRETS_TOPIC } from "../src/grants";
import { daemon } from "../src/local";
import type { Config } from "../src/config";
import { fakeTools, runCli, ttyCli } from "./helpers/cli";
import { startWorld, WebClient, type World } from "./helpers/world";
import { PROCESS_MS } from "./helpers/timeouts";

let world: World;
let link: string;
const started: string[] = [];

beforeAll(async () => {
  process.env.PATIO_NO_NOTIFY = "1";
  world = await startWorld({ extraUsers: ["ana", "ben", "cai", "dia"] });
  const unai = await world.person("unai", { team: false });
  const created = await unai.web.post("/workspaces", { name: "orbit" });
  const wsId = decodeURIComponent(created.location!.pathname.split("/").pop()!);
  const code = await world.inviteLink(unai.web, wsId);
  await world.joinByLink(unai, code);
  link = `${world.exchangeUrl}/join/${code}`;
}, PROCESS_MS);

afterAll(async () => {
  for (const home of started) {
    const pidFile = join(home, "patio.pid");
    if (!existsSync(pidFile)) continue;
    try {
      process.kill(Number(readFileSync(pidFile, "utf8").trim()), "SIGTERM");
    } catch {}
  }
  await world.stop();
}, PROCESS_MS);

async function fresh(name: string) {
  const root = await mkdtemp(join(world.dir, `${name}-`));
  const home = join(root, ".patio");
  const folder = join(root, "code", "orbit");
  await mkdir(folder, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: folder });
  started.push(home);
  const fake = await fakeTools(join(root, "bin"), []);
  const env = { PATH: fake.path, HOME: root, PATIO_HOME: home, PATIO_WEB_PORT: "0", PATIO_NO_NOTIFY: "1", PATIO_NO_PREFLIGHT: "1", PATIO_DEVICE_NAME: `${name}-laptop`, TYPESAFE_API_KEY: "world-key", PATIO_JEV_URL: world.jev.url };
  const cfg: Config = { home, handle: "", relay: `ws://127.0.0.1:${world.port}`, socket: join(home, "daemon.sock") };
  const file = (agent: string) => join(home, "agents", `${agent}.yaml`);
  return { root, home, folder, env, cfg, file };
}

const confirm = (login: string) => async (line: string) => {
  const m = /^Confirm in your browser: (http:\/\/127\.0\.0\.1:\d+)\/confirm\?code=([\w-]+)$/.exec(line);
  if (!m) return;
  const web = new WebClient(m[1]!);
  await web.signIn(login);
  await web.post("/confirm", { code: m[2]!, decision: "confirm" });
};
const signIn = (login: string) => async (line: string) => {
  const m = /Sign in with GitHub to confirm this computer: (http:\/\/127\.0\.0\.1:\d+)(\/setup\?code=[\w-]+)/.exec(line);
  if (!m) return;
  const web = new WebClient(m[1]!);
  await web.signIn(login);
  await web.get(m[2]!);
};

// Answers each question as it appears, from a list (an empty string is Enter).
const answering = (replies: [RegExp, string][]) => {
  const asked: string[] = [];
  return {
    asked,
    onData: (out: string, write: (t: string) => void) => {
      const next = replies[asked.length];
      if (next && next[0].test(out.slice(out.lastIndexOf("\n") + 1))) {
        asked.push(out.slice(out.lastIndexOf("\n") + 1));
        write(`${next[1]}\r`);
      }
    },
  };
};

test("from an agent, without the answers: nothing joins, exit 13 with the questions and one command; with them, the rules are the answers", async () => {
  const p = await fresh("ana");
  const args = ["join", link, "--tool", "pi", "--folder", p.folder];
  const first = await runCli(args, p.env, confirm("ana"));
  expect(first.out).toContain("Three answers needed first: ask your person these three questions in one message, then run the command with their answers.");
  expect(first.out).toContain("  1. What may orbit ask your agent? default: questions and small requests (--ask requests); or only questions (--ask questions), anything they like (--ask anything)");
  expect(first.out).toContain("  2. May it change files for them? default: only when you approve (--act ask-human); or never (--act deny)");
  expect(first.out).toContain("  3. Should it answer orbit on its own? default: no (--answer no); or yes (--answer yes)");
  // One command, ready to run with the defaults: no a|b|c.
  expect(first.out).toContain(`With the defaults, run:\n  patio join ${link} --tool pi --folder ${p.folder} --ask requests --act ask-human --answer no\n`);
  expect(first.out).not.toMatch(/--ask \w+\|/);
  expect(first.out).toContain("not finished: nothing joined orbit. Your agent's rules wait for your three answers (--ask, --act, --answer).");
  expect(first.code).toBe(13);
  // Nothing joined: no sign-in link was printed, no agent file was written.
  expect(first.out).not.toContain("Confirm in");
  expect(existsSync(p.file("ana-orbit"))).toBe(false);
  expect((await daemon.status(p.cfg)).agents).toEqual([]);

  const done = await runCli([...args, "--ask", "questions", "--act", "deny", "--answer", "yes"], p.env, confirm("ana"));
  expect(done.out).toContain(`✓ rules for ana-orbit (in every workspace), from your answers (~/.patio/agents/ana-orbit.yaml):`);
  expect(done.out).toContain("  what orbit may ask: only questions\n  changing files for them: never\n  answering orbit on its own: yes");
  expect(done.out).toContain("patio is ready: ana-orbit is in orbit.");
  expect(done.code).toBe(0);
  const f = parseAgentFile(readFileSync(p.file("ana-orbit"), "utf8"), "ana-orbit");
  expect(f.rules.defaults).toMatchObject({ kinds: ["question"], actions: "deny", auto_answer_in: ["orbit"], deny: [SECRETS_TOPIC] });
  expect(f.asked_in).toEqual(["orbit"]);
  // "Yes" is the person's first answer: answering orbit on its own is on, with no card.
  const s = await daemon.status(p.cfg);
  expect(s.pending.rules).toBe(0);
  const audit = readFileSync(join(p.home, "audit.jsonl"), "utf8");
  expect(audit).toContain(JSON.stringify(autoAnswerInKey("ana-orbit", ["orbit"])));
  expect(audit).toContain('"by":"your answer to patio join"');

  // Run again: no question, the answers in one line each and the command to change them.
  const again = await runCli(args, p.env);
  expect(again.code).toBe(0);
  expect(again.out).toContain("· rules for ana-orbit (in every workspace), from your answers:\n  what orbit may ask: only questions\n  changing files for them: never\n  answering orbit on its own: yes");
  expect(again.out).toContain("  change them: patio rules ana-orbit --ask … --act … --answer …");
  expect(again.out).not.toContain("✓");

  // A value outside the caps is refused, naming the cap, and the file is left as it was.
  const before = readFileSync(p.file("ana-orbit"), "utf8");
  const capped = await runCli([...args, "--ask", "questions", "--act", "run the tests", "--answer", "yes"], p.env);
  expect(capped.code).toBe(1);
  expect(capped.out).toContain("--act run the tests: changing files for them is ask-human (only when you approve) or deny (never); the join never writes a list of allowed actions");
  expect(capped.out).toContain("Nothing was changed.");
  const other = await runCli([...args, "--ask", "questions", "--act", "deny", "--answer", "side"], p.env);
  expect(other.out).toContain("--answer side: yes or no, for orbit only");
  expect(readFileSync(p.file("ana-orbit"), "utf8")).toBe(before);
}, PROCESS_MS);

test("run again from an agent with wider answers: the widening becomes a card, what narrows applies at once; the card's Confirm applies it", async () => {
  const p = await fresh("dia");
  const args = ["join", link, "--tool", "pi", "--folder", p.folder];
  expect((await runCli([...args, "--ask", "requests", "--act", "ask-human", "--answer", "no"], p.env, confirm("dia"))).code).toBe(0);
  // Wider: anything, and answer on its own. Narrower: never change files.
  const r = await runCli([...args, "--ask", "anything", "--act", "deny", "--answer", "yes"], p.env);
  expect(r.code).toBe(0);
  expect(r.out).toContain("  what orbit may ask: questions and small requests\n  changing files for them: never\n  answering orbit on its own: no");
  expect(r.out).toContain("waits for you in the web app (");
  expect(r.out).toContain("dia-orbit wants others to ask it anything they like; dia-orbit wants to answer orbit on its own");
  const f = parseAgentFile(readFileSync(p.file("dia-orbit"), "utf8"), "dia-orbit");
  expect(f.rules.defaults).toMatchObject({ kinds: ["question", "request"], actions: "deny" });
  expect(f.rules.defaults.auto_answer_in).toBeUndefined();
  // In the web app: one card in Needs you.
  const s = await daemon.status(p.cfg);
  const web = new WebClient(s.web_url);
  await web.signIn("dia");
  const page = await (await web.get("/")).text();
  expect(page).toContain("dia-orbit wants others to ask it anything they like<br>dia-orbit wants to answer orbit on its own");
  const action = /action="(\/rules\/requests\/[^"]+\/decide)"/.exec(page)![1]!;
  expect((await web.post(action, { decision: "approve" })).ok).toBe("Done: dia-orbit: others may now ask it anything they like; dia-orbit may now answer orbit on its own.");
  const after = parseAgentFile(readFileSync(p.file("dia-orbit"), "utf8"), "dia-orbit");
  expect(after.rules.defaults).toMatchObject({ kinds: ["question", "report", "heads-up", "request"], actions: "deny", auto_answer_in: ["orbit"] });
  expect((await daemon.status(p.cfg)).pending.rules).toBe(0);

  // patio rules from an agent: a widening is a card too (exit 5); a narrowing applies at once.
  const narrow = await runCli(["rules", "dia-orbit", "--answer", "no"], p.env);
  expect(narrow.code).toBe(0);
  expect(narrow.out).toContain("answering orbit on its own: no");
  const wide = await runCli(["rules", "dia-orbit", "--answer", "yes"], p.env);
  expect(wide.code).toBe(5);
  expect(wide.out).toContain("dia-orbit wants to answer orbit on its own");
  expect(parseAgentFile(readFileSync(p.file("dia-orbit"), "utf8"), "dia-orbit").rules.defaults.auto_answer_in).toBeUndefined();
  // From the person's own terminal it applies at once.
  const tty = await ttyCli(["rules", "dia-orbit", "--answer", "yes"], p.env);
  expect(tty.code).toBe(0);
  expect(parseAgentFile(readFileSync(p.file("dia-orbit"), "utf8"), "dia-orbit").rules.defaults.auto_answer_in).toEqual(["orbit"]);
}, PROCESS_MS);

test("in the person's terminal: three questions, one line each, Enter keeps each default; a second agent starts from the first one's answers", async () => {
  const p = await fresh("ben");
  const first = answering([
    [/1\. What may orbit ask ben-orbit\? questions and small requests \(requests\), only questions \(questions\), anything they like \(anything\) \[requests\] $/, ""],
    [/2\. May ben-orbit change files for them\? only when you approve \(ask-human\), never \(deny\) \[ask-human\] $/, ""],
    [/3\. Should ben-orbit answer orbit on its own\? \(no, yes\) \[no\] $/, ""],
  ]);
  const r = await ttyCli(["join", link, "--tool", "codex", "--folder", p.folder, "--no-open"], p.env, signIn("ben"), { onData: first.onData });
  expect(first.asked).toHaveLength(3);
  expect(r.out).toContain("Three questions about what orbit may do with ben-orbit (Enter keeps the default in brackets):");
  expect(r.code).toBe(0);
  const f = parseAgentFile(readFileSync(p.file("ben-orbit"), "utf8"), "ben-orbit");
  expect(f.rules.defaults).toMatchObject({ kinds: ["question", "request"], actions: "ask-human" });
  expect(f.rules.defaults.auto_answer_in).toBeUndefined();
  expect(f.asked_in).toEqual(["orbit"]);
  // The file keeps its comments.
  expect(readFileSync(p.file("ben-orbit"), "utf8")).toContain("# rules: what other people's agents may ask this agent");

  // Run again in the terminal: nothing is asked.
  const again = await ttyCli(["join", link, "--folder", p.folder, "--no-open"], p.env);
  expect(again.out).not.toContain("1. What may");
  expect(again.out).toContain("· rules for ben-orbit (in every workspace), from your answers:");
  expect(again.code).toBe(0);

  // A second agent: the first agent's answers are the defaults. Changed here: only questions, never, yes.
  // In the person's terminal: the widening ("yes") applies at once.
  expect((await ttyCli(["rules", "ben-orbit", "--ask", "questions", "--act", "deny", "--answer", "yes"], p.env)).code).toBe(0);
  const side = join(p.root, "code", "side");
  await mkdir(side, { recursive: true });
  const second = answering([
    [/1\. What may orbit ask ben-side\? .* \[questions\] $/, ""],
    [/2\. May ben-side change files for them\? .* \[deny\] $/, ""],
    [/3\. Should ben-side answer orbit on its own\? \(no, yes\) \[yes\] $/, ""],
  ]);
  const r2 = await ttyCli(["join", link, "--agent", "ben-side", "--tool", "pi", "--folder", side, "--no-open"], p.env, undefined, { onData: second.onData });
  expect(second.asked).toHaveLength(3);
  expect(r2.code).toBe(0);
  expect(parseAgentFile(readFileSync(p.file("ben-side"), "utf8"), "ben-side").rules.defaults).toMatchObject({ kinds: ["question"], actions: "deny", auto_answer_in: ["orbit"] });
}, PROCESS_MS);

test("an answer outside the caps, typed in the terminal, is refused and nothing is written", async () => {
  const p = await fresh("cai");
  const q = answering([[/1\. What may orbit ask cai-orbit\?.*\[requests\] $/, "everything please"]]);
  const r = await ttyCli(["join", link, "--tool", "codex", "--folder", p.folder, "--no-open"], p.env, signIn("cai"), { onData: q.onData });
  expect(r.code).toBe(1);
  expect(r.out).toContain("that is not one of requests, questions, anything. Nothing was changed; run the same patio join again");
  expect(parseAgentFile(readFileSync(p.file("cai-orbit"), "utf8"), "cai-orbit").asked_in).toBeUndefined();
}, PROCESS_MS);
