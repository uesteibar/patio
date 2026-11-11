// The agents' files reloaded while patio runs; an invalid edit keeps the last valid version.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLiveConfig } from "../src/live-config";

const home = async () => {
  const dir = await mkdtemp(join(tmpdir(), "patio-live-config-"));
  await mkdir(join(dir, "agents"));
  return dir;
};
const write = (dir: string, name: string, text: string) => Bun.write(join(dir, "agents", `${name}.yaml`), text);
const summary = (c: ReturnType<typeof loadLiveConfig>, name: string) => c.summary().find((f) => f.agent === name)!;

test("a valid edit is the next version; an invalid one keeps the last valid version and reports the error until fixed", async () => {
  const dir = await home();
  await write(dir, "unai-a", "rules:\n  kinds: [question]\n");
  const logs: string[] = [];
  const c = loadLiveConfig(dir, { log: (l) => logs.push(l) });
  expect(c.agent("unai-a")!.rules.defaults.kinds).toEqual(["question"]);
  expect(summary(c, "unai-a")).toMatchObject({ version: 1, error: null, name: "agents/unai-a.yaml" });

  await write(dir, "unai-a", "rules:\n  kinds: [question, heads-up]\n");
  expect(c.agent("unai-a")!.rules.defaults.kinds).toEqual(["question", "heads-up"]);
  expect(summary(c, "unai-a").version).toBe(2);

  await write(dir, "unai-a", "rules:\n  kinds: [gossip]\n");
  expect(c.agent("unai-a")!.rules.defaults.kinds).toEqual(["question", "heads-up"]);
  expect(summary(c, "unai-a").error?.message).toContain("agents/unai-a.yaml: rules: kinds must list some of");
  expect(c.errors().length).toBe(1);
  expect(logs.at(-1)).toContain("keeping the last valid version (v2");

  await write(dir, "unai-a", "rules:\n  kinds: [report]\n");
  expect(c.agent("unai-a")!.rules.defaults.kinds).toEqual(["report"]);
  expect(summary(c, "unai-a")).toMatchObject({ version: 3, error: null });
});

test("a file removed while running keeps the last valid version, never no rules", async () => {
  const dir = await home();
  await write(dir, "unai-a", "rules:\n  per_day: 3\n");
  const c = loadLiveConfig(dir);
  await rm(join(dir, "agents", "unai-a.yaml"));
  expect(c.agent("unai-a")!.rules.defaults.per_day).toBe(3);
  expect(summary(c, "unai-a").error?.message).toContain("agents/unai-a.yaml was removed; keeping the last valid version (v1)");
});

test("without files, no agents (the default rules); a file created later is loaded, an invalid new one reported", async () => {
  const dir = await home();
  const c = loadLiveConfig(dir);
  expect(c.names()).toEqual([]);
  expect(c.agent("unai-b")).toBeNull();
  await write(dir, "unai-b", "tool: codex\nfolder: /tmp\n");
  expect(c.agent("unai-b")!.tool).toBe("codex");
  expect(c.names()).toEqual(["unai-b"]);
  await write(dir, "unai-c", "tool: [\n");
  expect(c.agent("unai-c")).toBeNull();
  expect(summary(c, "unai-c").error?.message).toStartWith("agents/unai-c.yaml:");
});

test("an invalid file at start stops patio, with the file's error", async () => {
  const dir = await home();
  await write(dir, "unai-a", "agnet: codex\n");
  expect(() => loadLiveConfig(dir)).toThrow('agents/unai-a.yaml: unknown key "agnet"');
});

test("the watcher picks up an edit without anyone asking", async () => {
  const dir = await home();
  await write(dir, "unai-a", "rules:\n  per_day: 1\n");
  const logs: string[] = [];
  const c = loadLiveConfig(dir, { log: (l) => logs.push(l), pollMs: 60_000 });
  c.watch();
  await write(dir, "unai-a", "rules:\n  per_day: 2\n");
  const end = Date.now() + 3000;
  while (!logs.some((l) => l.startsWith("agents/unai-a.yaml reloaded: v2")) && Date.now() < end) await Bun.sleep(20);
  c.stop();
  expect(logs).toContainEqual(expect.stringMatching(/^agents\/unai-a\.yaml reloaded: v2/));
});
