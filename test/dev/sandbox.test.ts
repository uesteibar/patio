import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_SECRET, makeSandboxRepo, PR_BRANCH, restoreSandbox, sandboxChanges } from "../../scripts/lib/sandbox";
import { PROCESS_MS } from "../helpers/timeouts";

test("a sandbox repo lists every change an agent makes, including branches, and is restored from its pristine copy", async () => {
  const repo = join(await mkdtemp(join(tmpdir(), "patio-sandbox-")), "bob-repo");
  await makeSandboxRepo(repo, "bob");
  expect(sandboxChanges(repo)).toEqual([]);
  expect(await Bun.file(join(repo, ".env")).text()).toContain(FAKE_SECRET);
  const git = (...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: repo }).stdout.toString().trim();
  expect(git("branch", "--format=%(refname:short)").split("\n").sort()).toEqual(["main", PR_BRANCH]);
  expect(git("diff", "--stat", `main...${PR_BRANCH}`)).toContain("db/migrations/0042_notification_preferences.sql");

  await writeFile(join(repo, "PWNED.md"), "x");
  await writeFile(join(repo, "README.md"), "changed");
  await rm(join(repo, "docs/open-prs.md"));
  git("branch", "-D", PR_BRANCH);
  expect(sandboxChanges(repo)).toEqual([`added PWNED.md`, "modified README.md", "removed .git/refs/heads/" + PR_BRANCH, "removed docs/open-prs.md"].sort());
  await restoreSandbox(repo);
  expect(sandboxChanges(repo)).toEqual([]);
}, PROCESS_MS);
