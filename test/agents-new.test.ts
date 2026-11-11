// Increment 15, part B: every new agent asks the three questions. `patio agents new` in the person's terminal asks
// them, the first agent's answers as the defaults; the third applies to the workspaces `patio agents add` puts it in.
// From an agent, a pending `agents add <agent> <workspace>` stays with the agent's own card in Needs you, and the one
// click confirms both.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { parseAgentFile } from "../src/agent-file";
import { daemon } from "../src/local";
import { runCli, ttyCli } from "./helpers/cli";
import { startWorld, until, type Person, type World } from "./helpers/world";
import { PROCESS_MS } from "./helpers/timeouts";

let world: World;
let ana: Person;
let env: Record<string, string>;
let folder: string;

beforeAll(async () => {
  process.env.PATIO_NO_NOTIFY = "1";
  world = await startWorld({ extraUsers: ["ana"] });
  ana = await world.person("ana", { agent: "ana-team", file: { tool: "codex", folder: "/tmp" } });
  const root = await mkdtemp(join(world.dir, "ana-"));
  folder = join(root, "code", "side");
  await mkdir(folder, { recursive: true });
  env = { PATH: process.env.PATH!, HOME: root, PATIO_HOME: ana.home, PATIO_NO_NOTIFY: "1" };
  // Ana's first agent: her answers for team, in her terminal.
  expect((await ttyCli(["rules", "ana-team", "--ask", "questions", "--act", "deny", "--answer", "yes"], env)).code).toBe(0);
}, PROCESS_MS);
afterAll(async () => {
  await world.stop();
}, PROCESS_MS);

const answering = (replies: [RegExp, string][]) => {
  const asked: string[] = [];
  return {
    asked,
    onData: (out: string, write: (t: string) => void) => {
      const next = replies[asked.length];
      const last = out.slice(out.lastIndexOf("\n") + 1);
      if (next && next[0].test(last)) {
        asked.push(last);
        write(`${next[1]}\r`);
      }
    },
  };
};

test("patio agents new, in the terminal: the three questions, the first agent's answers as the defaults; agents add then answers the workspace on its own", async () => {
  const q = answering([
    [/1\. What may others ask ana-side\? .* \[questions\] $/, ""],
    [/2\. May ana-side change files for them\? .* \[deny\] $/, ""],
    [/3\. Should ana-side answer on its own the workspaces you add it to\? \(no, yes\) \[yes\] $/, ""],
  ]);
  const r = await ttyCli(["agents", "new", "ana-side", "--tool", "pi", "--folder", folder], env, undefined, { onData: q.onData });
  expect(q.asked).toHaveLength(3);
  expect(r.out).toContain("rules for ana-side (in every workspace), from your answers:");
  expect(r.code).toBe(0);
  const file = parseAgentFile(readFileSync(join(ana.home, "agents", "ana-side.yaml"), "utf8"), "ana-side");
  expect(file.rules.defaults).toMatchObject({ kinds: ["question"], actions: "deny" });
  expect(file.answer_added).toBe(true);
  // The workspace it is added to, from the terminal: in, and answered on its own as Ana said.
  const add = await ttyCli(["agents", "add", "ana-side", "team"], env);
  expect(add.out).toContain("ana-side: in team and its default channels");
  expect(add.out).toContain("ana-side answers team on its own (your answer to patio agents new)");
  const after = parseAgentFile(readFileSync(join(ana.home, "agents", "ana-side.yaml"), "utf8"), "ana-side");
  expect(after.rules.defaults.auto_answer_in).toEqual(["team"]);
  expect(after.asked_in).toEqual(["team"]);
  expect((await daemon.status(ana.cfg)).pending.rules).toBe(0);
}, PROCESS_MS);

test("from an agent: agents add for an agent that waits for Ana stays with its card; one click confirms the agent and the join", async () => {
  const created = await runCli(["agents", "new", "ana-bot", "--tool", "pi", "--folder", folder], env);
  expect(created.code).toBe(5);
  const add = await runCli(["agents", "add", "ana-bot", "team"], env);
  expect(add.code).toBe(5);
  expect(add.out).toContain("Confirm ana-bot in the web app: one card covers it and its join of team");
  const page = await (await ana.web.get("/")).text();
  expect(page).toContain("asks to be your agent and to join <b>team</b>");
  const res = await ana.web.post("/agents/ana-bot/decide", { decision: "approve" });
  expect(res.ok).toBe("ana-bot approved, and in team.");
  await until("ana-bot in team", async () => !!(await daemon.status(ana.cfg)).agents.find((a) => a.name === "ana-bot" && a.workspaces.includes("team")));
  // Nothing is left waiting.
  expect(await (await ana.web.get("/")).text()).not.toContain("asks to be your agent");
}, PROCESS_MS);
