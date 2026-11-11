// Increment 9: the responder runs in a disposable git worktree of its working directory. Bob's agent is the fake
// ACP agent (a test double) whose setup lets it write a file without asking; his cwd is a git repository.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentSpec } from "../lib/instance";
import type { Scenario } from "../lib/scenario";
import { ask, fakeAgent } from "./inbox";

let repo = "";
const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", "-c", "user.name=Bob", "-c", "user.email=bob@patio.invalid", "-c", "init.defaultBranch=main", ...args], { cwd }).stdout.toString().trim();

const bobWithRepo = (): AgentSpec => ({
  handle: "bob",
  agentConfig: async (dir) => {
    const root = dirname(dir);
    repo = join(root, "sandbox", "bob-git");
    await mkdir(join(repo, "docs"), { recursive: true });
    await writeFile(join(repo, "docs/release.md"), "The release branch is cut on Thursdays.\n");
    git(repo, "init", "-q");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    const agent = await fakeAgent(root, "fake-acp-writer", {
      steps: [
        { id: "read", tool: "read", title: "Read docs/release.md", path: "docs/release.md", permission: false },
        { id: "edit", tool: "edit", title: "Create NOTES.md", path: "NOTES.md", content: "written by bob's agent", permission: false },
      ],
      reply: "{{read}} I also wrote NOTES.md.",
    });
    return `agent: ${JSON.stringify(agent.command)}\ncwd: ${JSON.stringify(repo)}\n`;
  },
});

const workdir: Scenario = {
  name: "workdir",
  description:
    "Bob's cwd is a git repository and his agent's setup lets it write a file. `patio answer` runs it in a disposable worktree: the agent writes NOTES.md there, the change is listed (CLI and audit log) and discarded, and the real repository is unchanged. `patio answer --in-place` runs it in the real repository, and NOTES.md stays.",
  label: "deterministic",
  agents: () => [{ handle: "alice" }, bobWithRepo()],
  async run(t) {
    const q = await ask(t, "alice", "When is the release branch cut?");
    const a = await t.cli("bob", ["answer", q.id]);
    t.expect("answer exits 0", a.code === 0, `${a.code} ${a.stderr.split("\n").pop()}`);
    t.expect("it ran in a disposable worktree of the repository", a.stderr.includes(`in a disposable worktree of ${repo}`), a.stderr.split("\n")[0]);
    t.expect("the CLI lists the discarded change", a.stderr.includes("discarded changes: ?? NOTES.md"), a.stderr);
    t.expect("the real repository is unchanged", !(await Bun.file(join(repo, "NOTES.md")).exists()) && git(repo, "status", "--porcelain") === "", git(repo, "status", "--porcelain"));
    t.expect("and has no worktree left", git(repo, "worktree", "list").split("\n").length === 1, git(repo, "worktree", "list"));
    const entry = t.gateLog("bob").find((l) => l.rule === "workdir");
    t.expect("the audit log lists the discarded change", entry?.verdict === "discarded" && JSON.stringify(entry.discarded) === '["?? NOTES.md"]', JSON.stringify(entry));
    t.expect("Alice gets the answer", (await t.cli("alice", ["wait", q.convo, "--timeout", "5"])).stdout.includes("Thursdays"));

    const q2 = await ask(t, "alice", "Can you add release notes?");
    const b = await t.cli("bob", ["answer", q2.id, "--in-place"]);
    t.expect("answer --in-place exits 0", b.code === 0, `${b.code} ${b.stderr.split("\n").pop()}`);
    t.expect("it ran in the real repository", b.stderr.includes(`in ${repo}`) && !b.stderr.includes("discarded"), b.stderr.split("\n")[0]);
    t.expect("NOTES.md is in the real repository", (await Bun.file(join(repo, "NOTES.md")).exists()) && git(repo, "status", "--porcelain") === "?? NOTES.md", git(repo, "status", "--porcelain"));
  },
};

export const WORKDIR_SCENARIOS = [workdir];
