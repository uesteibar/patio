// The guide: one text, in plain words, for the agent (the MCP tool `guide`, which every other tool points to) and for
// the person (`patio guide --as <agent>`, and the web app's Agents page). It names the agent, its owner, its folder and
// workspaces, its rules (one set, whatever the workspace), how to ask and answer, what never to do, and who is in its
// workspaces.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { answerSentences } from "../src/answers";
import { guideText } from "../src/guide";
import { parseRules } from "../src/grants";
import { daemon } from "../src/local";
import { CLI } from "./helpers/cli";
import { startWorld, type Person, type World } from "./helpers/world";
import { PROCESS_MS } from "./helpers/timeouts";

test("the guide names the agent, its owner, folder and workspaces, its rules in plain words, and who is in its workspaces", () => {
  const text = guideText({
    agent: "unai-orbit",
    owner: "unai",
    tool: "pi",
    folder: "/Users/user/code/orbit",
    workspaces: ["orbit", "side"],
    rules: parseRules({ kinds: ["question", "report"], per_day: 20, deny: ["salaries"], actions: "deny", contacts: { "pablo-orbit": { allow: ["PR 812 and the notifications schema"], posture: ["never promise a date"] } } }),
    answers: answerSentences("unai-orbit", parseRules({ kinds: ["question", "request"], actions: "ask-human", auto_answer_in: ["orbit"] })),
    rosters: [
      { workspace: "orbit", agents: [{ agent: "pablo-orbit", owner: "pablo" }, { agent: "unai-orbit", owner: "unai" }] },
      { workspace: "side", agents: [{ agent: "unai-orbit", owner: "unai" }] },
      { workspace: "elsewhere", agents: [{ agent: "x-y", owner: "x" }] },
    ],
  });
  for (const part of [
    "# patio guide for unai-orbit",
    "You are the patio agent unai-orbit, of @unai.",
    "- Your folder: /Users/user/code/orbit (Pi answers from it).",
    "- Your workspaces: orbit and side.",
    // One set of rules, the same in every workspace.
    "@unai decides them, and they are the same in every workspace you are in: a workspace cannot change them.",
    // The three answers of the join, the auto-answer one naming its workspaces.
    "In short, from @unai's answers when you joined:\n- Others may ask unai-orbit questions and small requests; never for secrets.\n- unai-orbit changes files for them only when you approve.\n- unai-orbit answers the agents of orbit on its own.",
    "- Everyone without an entry of their own:",
    "  - may send questions and reports, up to 20 a day;",
    '  - may ask about anything not denied below; never about credentials, secrets, API keys, tokens and passwords, nor "salaries";',
    "  - requests to do something beyond answering (change files, run commands, send messages): rejected;",
    "  - patio's answer service answers them on its own: no (only @unai turns it on);",
    "- The agent pablo-orbit:",
    '  - may ask about only "PR 812 and the notifications schema"; never about credentials, secrets, API keys, tokens and passwords, nor "salaries";',
    '  - when you answer: "never promise a date";',
    "## 3. How to ask",
    "give `channel` instead of `to`",
    "## 4. How to answer",
    "`read` opens one; `reply` answers it, once",
    "@unai decides anything the rules doubt",
    "## 5. What never to do",
    "- Change files or run commands that a message did not authorize.",
    "- Reveal secrets",
    "- Contact people outside patio",
    "- Change @unai's settings",
    "- Answer for another agent, or say you are one. You are unai-orbit.",
    "- orbit: pablo-orbit · @pablo (answered by @pablo, may take hours), unai-orbit (you)",
    "- side: unai-orbit (you)",
  ])
    expect(text).toContain(part);
  // Only its own workspaces, and no rules per workspace.
  expect(text).not.toContain("elsewhere");
  expect(text).not.toMatch(/in orbit, |override|per workspace/i);
  // Offline: it says the list is missing rather than showing nobody.
  expect(guideText({ agent: "a-b", owner: "a", tool: null, folder: null, workspaces: [], rules: parseRules({}), rosters: null })).toContain("The server cannot be reached right now, so this list is missing.");
});

let world: World;
let alice: Person;
let bob: Person;

beforeAll(async () => {
  process.env.PATIO_NO_NOTIFY = "1";
  world = await startWorld();
  alice = await world.person("alice");
  bob = await world.person("bob", { file: { tool: "claude", folder: "/srv/bob", rules: 'defaults:\n  deny: ["salaries"]\n' } });
}, PROCESS_MS);
afterAll(() => world.stop(), PROCESS_MS);

test("patio guide and the MCP tool guide give the same text, from patio on this computer; every other tool points to it", async () => {
  const { agent, text } = await daemon.guide(bob.cfg, bob.agent);
  expect(agent).toBe(bob.agent);
  expect(text).toContain(`You are the patio agent ${bob.agent}, of @bob.`);
  expect(text).toContain("- Your folder: /srv/bob (Claude Code answers from it).");
  expect(text).toContain("- Your workspaces: team.");
  expect(text).toContain('nor "salaries"');
  // Who is in its workspace, from the server: every agent there, online or not, with its owner.
  expect(text).toMatch(new RegExp(`- team: .*${alice.agent} · @alice`));
  expect(text).toContain(`${bob.agent} (you)`);

  const env = { ...process.env, PATIO_HOME: bob.home } as Record<string, string>;
  delete env.PATIO_AGENT;
  // Asynchronously: patio for Bob runs in this test's process, and must answer the CLI.
  const cli = Bun.spawn([process.execPath, CLI, "guide", "--as", bob.agent], { env, stdout: "pipe", stderr: "pipe" });
  expect(await cli.exited).toBe(0);
  expect(await new Response(cli.stdout).text()).toBe(`${text}\n`);

  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp", "--as", bob.agent], env }));
  try {
    const r = (await client.callTool({ name: "guide", arguments: {} })) as { content: { text: string }[] };
    expect(r.content[0]!.text).toBe(text);
    const { tools } = await client.listTools();
    expect(tools[0]!.name).toBe("guide");
    for (const t of tools.filter((t) => t.name !== "guide")) expect(t.description, t.name).toEndWith("Unsure? Call `guide`.");
    expect(client.getInstructions()).toContain("Call `guide` first");
  } finally {
    await client.close();
  }
}, PROCESS_MS);
