// Increment 9: the responder runs in a disposable git worktree of its working directory, unless the owner asks for
// the real directory (--in-place, or in_place in agent.yaml) or the directory is not a git repository.
import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareWorkdir } from "../src/workdir";
import { PROCESS_MS } from "./helpers/timeouts";

const root = await mkdtemp(join(tmpdir(), "patio-workdir-"));
afterAll(() => rm(root, { recursive: true, force: true }), PROCESS_MS);

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

async function repo(name: string) {
  const dir = join(root, name);
  await mkdir(join(dir, "docs"), { recursive: true });
  await Bun.write(join(dir, "README.md"), "hello\n");
  await Bun.write(join(dir, "docs", "release.md"), "Thursdays\n");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

test("in a git repository the agent gets a detached worktree at HEAD; its changes are listed and discarded", async () => {
  const real = await repo("r1");
  const home = join(root, "home1");
  const w = await prepareWorkdir({ home, cwd: real, id: "abcdef1234" });
  expect(w.mode).toBe("worktree");
  expect(w.dir.startsWith(join(home, "worktrees"))).toBe(true);
  expect(await Bun.file(join(w.dir, "docs", "release.md")).text()).toBe("Thursdays\n");
  await Bun.write(join(w.dir, "NEW.md"), "x");
  await Bun.write(join(w.dir, "README.md"), "changed\n");
  git(w.dir, "add", "NEW.md");
  git(w.dir, "commit", "-q", "-m", "an agent commit");
  await Bun.write(join(w.dir, "docs", "draft.md"), "y");
  const { discarded } = await w.cleanup();
  expect(discarded).toEqual(["commit: an agent commit", "M README.md", "?? docs/draft.md"]);
  // The real repository is unchanged, and the worktree is gone (also from git's list).
  expect(await Bun.file(join(real, "README.md")).text()).toBe("hello\n");
  expect(existsSync(join(real, "NEW.md"))).toBe(false);
  expect(git(real, "status", "--porcelain")).toBe("");
  expect(git(real, "log", "--oneline").split("\n").length).toBe(1);
  expect(existsSync(w.dir)).toBe(false);
  expect(git(real, "worktree", "list").split("\n").length).toBe(1);
}, PROCESS_MS);

test("a subdirectory of a repository maps to the same subdirectory in the worktree", async () => {
  const real = await repo("r2");
  const w = await prepareWorkdir({ home: join(root, "home2"), cwd: join(real, "docs"), id: "1" });
  expect(w.dir.endsWith("/docs")).toBe(true);
  expect(existsSync(join(w.dir, "release.md"))).toBe(true);
  expect((await w.cleanup()).discarded).toEqual([]);
}, PROCESS_MS);

test("in place: the real directory, nothing discarded", async () => {
  const real = await repo("r3");
  const w = await prepareWorkdir({ home: join(root, "home3"), cwd: real, id: "1", inPlace: true });
  expect(w).toMatchObject({ mode: "in-place", dir: real });
  expect(w.warning).toBeUndefined();
  await Bun.write(join(real, "KEPT.md"), "x");
  expect((await w.cleanup()).discarded).toEqual([]);
  expect(existsSync(join(real, "KEPT.md"))).toBe(true);
}, PROCESS_MS);

test("not a git repository: in place, with a one-line warning", async () => {
  const plain = join(root, "plain");
  await mkdir(plain, { recursive: true });
  const w = await prepareWorkdir({ home: join(root, "home4"), cwd: plain, id: "1" });
  expect(w).toMatchObject({ mode: "in-place", dir: plain });
  expect(w.warning).toBe(`${plain} is not a git repository: the agent runs in place, and what it changes there stays changed`);
}, PROCESS_MS);

test("a directory git ignores, or that HEAD does not have, runs in place with a warning", async () => {
  const real = await repo("r5");
  await Bun.write(join(real, ".gitignore"), ".dev/\n");
  git(real, "add", ".gitignore");
  git(real, "commit", "-q", "-m", "ignore .dev");
  await mkdir(join(real, ".dev", "sandbox"), { recursive: true });
  const ignored = await prepareWorkdir({ home: join(root, "home5"), cwd: join(real, ".dev", "sandbox"), id: "1" });
  expect(ignored.mode).toBe("in-place");
  expect(ignored.warning).toContain("is not part of the last commit");
  await mkdir(join(real, "fresh"), { recursive: true });
  expect((await prepareWorkdir({ home: join(root, "home5"), cwd: join(real, "fresh"), id: "1" })).mode).toBe("in-place");
  expect(git(real, "worktree", "list").split("\n").length).toBe(1);
}, PROCESS_MS);
