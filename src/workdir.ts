// Where `patio answer` runs the owner's agent. When the configured directory is in a git repository, the agent
// gets a disposable worktree: detached at HEAD, under $PATIO_HOME/worktrees/, removed when the agent is done.
// Whatever the agent changed there (new, changed or deleted files, and commits) is listed and then discarded, so
// a message that slipped through the gates cannot change the real repository. The owner opts out with
// `--in-place` (or `in_place: true` in the agent's file) when an allowed action has to change the real directory.
// A directory that is not in a git repository runs in place, with a warning.
//
// Limits: the worktree has what HEAD has, not the owner's uncommitted changes; files ignored by git are not
// listed; and the agent can still reach anything outside the worktree that its own setup lets it reach.
import { mkdir, realpath, rm } from "node:fs/promises";
import { join, relative } from "node:path";

export type Workdir = {
  // Where the agent runs.
  dir: string;
  mode: "worktree" | "in-place";
  // The directory the owner configured.
  cwd: string;
  // Set when the agent runs in place because the directory is not in a git repository.
  warning?: string;
  // Removes the worktree; returns what the agent changed there (empty in place).
  cleanup: () => Promise<{ discarded: string[] }>;
};

const git = (cwd: string, args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return { ok: r.exitCode === 0, out: r.stdout.toString(), err: r.stderr.toString().trim() };
};

export async function prepareWorkdir(o: { home: string; cwd: string; id: string; inPlace?: boolean }): Promise<Workdir> {
  const inPlace = (warning?: string): Workdir => ({ dir: o.cwd, mode: "in-place", cwd: o.cwd, ...(warning ? { warning } : {}), cleanup: async () => ({ discarded: [] }) });
  if (o.inPlace) return inPlace();
  const top = git(o.cwd, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return inPlace(`${o.cwd} is not a git repository: the agent runs in place, and what it changes there stays changed`);
  const repo = top.out.trim();
  const base = git(repo, ["rev-parse", "--verify", "-q", "HEAD"]);
  if (!base.ok) return inPlace(`${repo} has no commit yet, so there is nothing to make a worktree from: the agent runs in place`);
  const sub = relative(await realpath(repo), await realpath(o.cwd));
  // A directory git ignores (or never committed) is not part of HEAD, so a worktree would not have it.
  if (sub && (git(repo, ["check-ignore", "-q", sub]).ok || !git(repo, ["ls-tree", "-d", "HEAD", "--", sub]).out.trim()))
    return inPlace(`${o.cwd} is not part of the last commit of ${repo} (ignored or not committed): the agent runs in place, and what it changes there stays changed`);
  const root = join(o.home, "worktrees");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const wt = join(root, `${o.id.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`);
  const added = git(repo, ["worktree", "add", "--detach", "--quiet", wt, "HEAD"]);
  if (!added.ok) throw new Error(`could not create a worktree of ${repo}: ${added.err}`);
  return {
    dir: sub ? join(wt, sub) : wt,
    mode: "worktree",
    cwd: o.cwd,
    cleanup: async () => {
      const commits = git(wt, ["log", "--format=%s", `${base.out.trim()}..HEAD`]);
      const status = git(wt, ["status", "--porcelain=v1", "--untracked-files=all"]);
      const discarded = [
        ...(commits.ok ? commits.out.split("\n").filter(Boolean).reverse().map((s) => `commit: ${s}`) : []),
        ...(status.ok ? status.out.split("\n").filter(Boolean).map((l) => `${l.slice(0, 2).trim()} ${l.slice(3)}`) : ["(could not list the changes)"]),
      ];
      if (!git(repo, ["worktree", "remove", "--force", "--force", wt]).ok) {
        await rm(wt, { recursive: true, force: true });
        git(repo, ["worktree", "prune"]);
      }
      return { discarded };
    },
  };
}
