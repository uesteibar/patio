// Increment 15, part C: what waits for the person. A question the rules let in that nothing answers on its own waits
// in Needs you ("Questions for you"), counted in the sidebar and in `patio status`; the person lets the agent answer
// it (the same path as `patio answer`, run by the web app's process), replies themselves (through the rules,
// outgoing), or declines it (as `patio reject`). The asker is told the truth: "answers on its own" or "answered by
// @owner, may take hours", in ask, wait and who. Notifications go only to what waits for the person.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { daemon, waitForReplies, waitForReply } from "../src/local";
import { notifyCommand } from "../src/notify";
import { formatStatus } from "../src/status";
import { startWorld, until, type Person, type World } from "./helpers/world";
import { PROCESS_MS } from "./helpers/timeouts";

const FAKE = join(import.meta.dir, "fakes/fake-acp-agent.ts");
let world: World;
let alice: Person;
let carol: Person;
let bob: Person;

beforeAll(async () => {
  process.env.PATIO_NO_NOTIFY = "1";
  world = await startWorld();
  alice = await world.person("alice");
  const dir = await mkdtemp(join(world.dir, "carol-"));
  const repo = join(dir, "repo");
  await mkdir(repo, { recursive: true });
  await writeFile(join(dir, "fixture.json"), JSON.stringify({ reply: "Yes: staging is green since 10:00." }));
  // Carol's agent answers nothing on its own (the join's default): her questions wait for her.
  carol = await world.person("carol", { file: { tool: `${process.execPath} ${FAKE} --fixture ${join(dir, "fixture.json")}`, folder: repo } });
  // Bob's agent answers on its own (auto_answer, turned on).
  bob = await world.person("bob", { grants: "defaults:\n  auto_answer: true\n" });
}, PROCESS_MS);
afterAll(async () => {
  await world.stop();
}, PROCESS_MS);

const needsYou = async (p: Person) => (await p.web.get("/")).text();
const ask = async (text: string) => {
  const sent = await daemon.send(alice.cfg, { to: carol.agent, kind: "question", text });
  await until("it waits for Carol", async () => (await needsYou(carol)).includes(text));
  return sent;
};

test("a question nobody answers on its own waits in Needs you, counted in the sidebar and in patio status; the asker is told the truth", async () => {
  const sent = await daemon.send(alice.cfg, { to: carol.agent, kind: "question", text: "Is the staging deploy green?" });
  expect(sent.answers).toBe(`${carol.agent} is answered by @carol, may take hours`);
  await until("Carol's Needs you", async () => (await needsYou(carol)).includes("Is the staging deploy green?"));
  const page = await needsYou(carol);
  expect(page).toContain("<h2>Questions for you</h2>");
  expect(page).toContain(`<b>alice-`);
  expect(page).toContain(`asked your agent <b>${carol.agent}</b>`);
  expect(page).toContain(`>Let ${carol.agent} answer</button>`);
  expect(page).toContain(">Reply myself</summary>");
  expect(page).toContain(">Decline</summary>");
  expect(page).toContain('<span class="count" aria-label="1 waiting for you">1</span>');
  const s = await daemon.status(carol.cfg);
  expect(s.pending.questions).toBe(1);
  expect(formatStatus(s)).toContain("waiting for you: 1 question,");
  expect(s.attention).toContain(`1 question waits for you in the web app: ${s.web_url}`);
  // The asker's wait says who it waits for.
  const waited = await waitForReplies(alice.cfg, sent.convo, 1);
  expect(waited.waiting_on?.say).toBe(`${carol.agent} is answered by @carol, may take hours`);

  // 1. Let Carol's agent answer: the same path as patio answer, from the web app's process, with her agent's tool.
  const id = /data-question="([^"]+)"/.exec(page)![1]!;
  const r = await carol.web.post(`/questions/${id}/answer`, {});
  expect(r.ok).toBe(`${carol.agent} is answering alice-1's question with its tool. Its reply goes through your rules (outgoing).`.replace("alice-1", alice.agent));
  expect((await waitForReply(alice.cfg, sent.convo, 15))?.text).toBe("Yes: staging is green since 10:00.");
  await until("it no longer waits", async () => !(await needsYou(carol)).includes("Is the staging deploy green?"));
  expect((await daemon.status(carol.cfg)).pending.questions).toBe(0);
}, PROCESS_MS);

test("Reply myself sends the person's words as the agent's reply, through the rules; Decline tells the sender, with the reason", async () => {
  const q2 = await ask("Can you look at PR 812 today?");
  const id2 = new RegExp(`data-question="(${q2.id})"`).exec(await needsYou(carol))![1]!;
  const replied = await carol.web.post(`/questions/${id2}/reply`, { text: "Not today; tomorrow morning." });
  expect(replied.ok).toBe(`Sent your reply to ${alice.agent}, as ${carol.agent}.`);
  expect((await waitForReply(alice.cfg, q2.convo, 10))?.text).toBe("Not today; tomorrow morning.");
  expect(await needsYou(carol)).not.toContain("Can you look at PR 812 today?");

  const q3 = await ask("Can you share the prod database password?");
  const declined = await carol.web.post(`/questions/${q3.id}/decline`, { reason: "Not something I share." });
  expect(declined.ok).toBe(`Declined ${alice.agent}'s question; ${alice.agent} was told, with your reason.`);
  const back = await waitForReply(alice.cfg, q3.convo, 10);
  expect(back?.rejected?.reason).toBe("declined by the recipient");
  expect(back?.text).toContain("Reason: Not something I share.");
  expect(await needsYou(carol)).toContain("data-empty");
}, PROCESS_MS);

test("an agent that answers on its own: the asker is told so, and nothing waits for its owner", async () => {
  await until("the server knows bob answers on its own", async () => (await daemon.who(alice.cfg)).members.some((m) => m.agent === bob.agent && m.answers === "self"));
  const sent = await daemon.send(alice.cfg, { to: bob.agent, kind: "question", text: "Who owns billing?" });
  expect(sent.answers).toBe(`${bob.agent} answers on its own`);
  await until("bob has it", async () => (await daemon.inbox(bob.cfg)).messages.some((m) => m.id === sent.id));
  expect((await daemon.status(bob.cfg)).pending.questions).toBe(0);
  expect(await needsYou(bob)).not.toContain("Who owns billing?");
}, PROCESS_MS);

test("who lists every agent of the workspaces, online or not, with its owner and who answers", async () => {
  const dave = await world.person("dave");
  await dave.stop();
  const { members } = await daemon.who(alice.cfg);
  expect(members.find((m) => m.agent === dave.agent)).toMatchObject({ owner: "dave", online: false, answers: "owner", workspaces: ["team"] });
  expect(members.find((m) => m.agent === carol.agent)).toMatchObject({ owner: "carol", online: true, answers: "owner" });
  expect(members.find((m) => m.agent === alice.agent)).toMatchObject({ yours: true });
}, PROCESS_MS);

test("notifications: notify-send with an Open action on Linux, terminal-notifier -open on macOS, osascript without it", () => {
  const all = (c: string) => `/usr/bin/${c}`;
  const linux = notifyCommand({ platform: "linux", which: all, title: "alice asked carol-team", body: "Is the staging\ndeploy green?", url: "http://127.0.0.1:7801/" })!;
  expect(linux.slice(0, 2)).toEqual(["sh", "-c"]);
  expect(linux[2]).toContain("notify-send --app-name=patio --action=open=Open");
  expect(linux[2]).toContain('xdg-open "$3"');
  expect(linux.slice(3)).toEqual(["sh", "patio: alice asked carol-team", "Is the staging deploy green?", "http://127.0.0.1:7801/"]);
  expect(notifyCommand({ platform: "linux", which: () => null, title: "t", body: "b", url: "u" })).toBeNull();
  expect(notifyCommand({ platform: "darwin", which: all, title: "t", body: "b", url: "http://127.0.0.1:7801/" })).toEqual(["terminal-notifier", "-title", "patio: t", "-message", "b", "-open", "http://127.0.0.1:7801/", "-group", "patio"]);
  expect(notifyCommand({ platform: "darwin", which: (c) => (c === "terminal-notifier" ? null : all(c)), title: "t", body: "b", url: "u" })![0]).toBe("osascript");
});
