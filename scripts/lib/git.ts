import { REPO } from "./paths";

export async function gitState() {
  const rev = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: REPO });
  const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: REPO });
  const revision = rev.stdout.toString().trim() || "unknown";
  return { revision, short: revision.slice(0, 7), dirty: status.stdout.toString().trim().length > 0 };
}
