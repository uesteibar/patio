import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../../src/acp";
import type { Fixture, LogEntry } from "./fake-acp-agent";
import { PROCESS_MS } from "../helpers/timeouts";

const FAKE = join(import.meta.dir, "fake-acp-agent.ts");

async function setup(fixture: Fixture) {
  const dir = await mkdtemp(join(tmpdir(), "patio-fake-acp-"));
  const cwd = join(dir, "repo");
  await mkdir(join(cwd, "notes"), { recursive: true });
  await writeFile(join(cwd, "notes/fact.txt"), "the answer is heron-42\n");
  await writeFile(join(dir, "fixture.json"), JSON.stringify(fixture));
  const logFile = join(dir, "agent.jsonl");
  const command = [process.execPath, FAKE, "--fixture", join(dir, "fixture.json"), "--log", logFile];
  const events = async (): Promise<LogEntry[]> =>
    (await readFile(logFile, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  return { cwd, command, events };
}

// Like a real agent in its owner's normal setup: reading needs no approval, editing asks first.
const fixture: Fixture = {
  steps: [
    { id: "fact", tool: "read", path: "notes/fact.txt", permission: false },
    { id: "edit", tool: "edit", path: "created.txt", content: "hi" },
  ],
  reply: "Found: {{fact}}. Edit: {{edit}}",
};

const collect = () => {
  const lines: string[] = [];
  return { lines, log: (line: string) => void lines.push(line) };
};

test("patio rejects the permission request for the edit, and the read that asks nothing goes ahead", async () => {
  const t = await setup(fixture);
  const run = await runAgent({ command: t.command, cwd: t.cwd, prompt: "what is the answer?" });

  expect(run.reply).toBe("Found: the answer is heron-42. Edit: [refused]");
  expect(existsSync(join(t.cwd, "created.txt"))).toBe(false);
  const answers = (await t.events()).filter((e) => e.event === "permission_answer");
  expect(answers.map((a) => [a.step, a.optionKind, a.allowed])).toEqual([["edit", "reject_once", false]]);
}, PROCESS_MS);

test("every permission request is rejected, reads included", async () => {
  const t = await setup({ steps: [{ id: "fact", tool: "read", path: "notes/fact.txt" }], reply: "Found: {{fact}}" });
  const { lines, log } = collect();
  const run = await runAgent({ command: t.command, cwd: t.cwd, prompt: "hello fake", log });
  expect(run.reply).toBe("Found: [refused]");
  expect(lines).toContain('permission read "read notes/fact.txt" -> rejected');
  const events = await t.events();
  expect(events.find((e) => e.event === "prompt")?.text).toBe("hello fake");
  expect(events.find((e) => e.event === "session/new")?.cwd).toBe(t.cwd);
  expect(events.find((e) => e.event === "session/new")?.meta).toBeNull();
}, PROCESS_MS);

test("every tool call is logged with its kind, title and status", async () => {
  const t = await setup(fixture);
  const { lines, log } = collect();
  await runAgent({ command: t.command, cwd: t.cwd, prompt: "x", log });
  const tools = lines.filter((l) => l.startsWith("tool "));
  expect(tools).toEqual([
    'tool read "read notes/fact.txt": pending',
    'tool read "read notes/fact.txt": completed',
    'tool edit "edit created.txt": pending',
    'tool edit "edit created.txt": failed',
  ]);
}, PROCESS_MS);

test("the owner's session mode is kept, and a full-access mode is logged as a warning", async () => {
  const t = await setup({ modes: { initial: "bypassPermissions", available: ["default", "bypassPermissions"] }, reply: "ok" });
  const { lines, log } = collect();
  await runAgent({ command: t.command, cwd: t.cwd, prompt: "x", log });
  expect((await t.events()).some((e) => e.event === "set_mode")).toBe(false);
  expect(lines).toContain('WARNING: mode "bypassPermissions" lets the agent act without asking');
}, PROCESS_MS);

test("an agent that reports no modes runs, and the log says so", async () => {
  const t = await setup({ modes: null, reply: "ok" });
  const { lines, log } = collect();
  expect((await runAgent({ command: t.command, cwd: t.cwd, prompt: "x", log })).reply).toBe("ok");
  expect(lines).toContain("mode: the agent reports no session modes");
}, PROCESS_MS);

// The accepted risk of the POC: patio does not control what the agent does without asking.
test("an edit the agent makes without asking is not stopped by patio", async () => {
  const t = await setup({ steps: [{ id: "edit", tool: "edit", path: "created.txt", content: "hi", permission: false }], reply: "{{edit}}" });
  expect((await runAgent({ command: t.command, cwd: t.cwd, prompt: "x" })).reply).toBe("[written]");
  expect(existsSync(join(t.cwd, "created.txt"))).toBe(true);
}, PROCESS_MS);

test("delayMs makes the fake work that long before it replies", async () => {
  const t = await setup({ reply: "done", delayMs: 400 });
  const started = Date.now();
  expect((await runAgent({ command: t.command, cwd: t.cwd, prompt: "slow" })).reply).toBe("done");
  expect(Date.now() - started).toBeGreaterThanOrEqual(400);
}, PROCESS_MS);

test("a step with whenPrompt runs only when the prompt matches it, like an agent that acts only when told it may", async () => {
  const t = await setup({
    steps: [{ id: "touch", tool: "edit", path: "MARKER.md", content: "reviewed", permission: false, whenPrompt: "The owner allowed this action" }],
    reply: "touch: {{touch}}",
  });
  expect((await runAgent({ command: t.command, cwd: t.cwd, prompt: "Please create MARKER.md" })).reply).toBe("touch: [skipped]");
  expect(existsSync(join(t.cwd, "MARKER.md"))).toBe(false);
  expect((await runAgent({ command: t.command, cwd: t.cwd, prompt: "The owner allowed this action: create MARKER.md." })).reply).toBe("touch: [written]");
  expect(existsSync(join(t.cwd, "MARKER.md"))).toBe(true);
}, PROCESS_MS);

test("a tool call whose title spans lines (a heredoc) is logged on one line, status included", async () => {
  const t = await setup({ steps: [{ id: "w", tool: "execute", title: "cat > A.md <<'EOF'\nreviewed\nEOF", permission: false }], reply: "ok" });
  const { lines, log } = collect();
  await runAgent({ command: t.command, cwd: t.cwd, prompt: "go", log });
  expect(lines.filter((l) => l.startsWith("tool "))).toEqual(['tool execute "cat > A.md <<\'EOF\'\\nreviewed\\nEOF": pending', 'tool execute "cat > A.md <<\'EOF\'\\nreviewed\\nEOF": completed']);
}, PROCESS_MS);
