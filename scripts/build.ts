// bun run build: single patio binaries for darwin-arm64, darwin-x64 and linux-x64 (bun build --compile), each with its
// SHA-256 beside it, in dist/ (or the directory given). The server serves them with /install.sh: `patio exchange
// --dist dist`. `--only <platform>` builds one (the tests build linux-x64 alone).
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { PLATFORMS } from "../src/install";

const { values } = parseArgs({ args: process.argv.slice(2), options: { out: { type: "string" }, only: { type: "string", multiple: true } } });
const out = resolve(values.out ?? "dist");
const repo = resolve(import.meta.dir, "..");
const rev = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: repo }).stdout.toString().trim();
const dirty = Bun.spawnSync(["git", "status", "--porcelain", "--untracked-files=no"], { cwd: repo }).stdout.toString().trim() ? "+dirty" : "";
const platforms = values.only?.length ? PLATFORMS.filter((p) => values.only!.includes(p)) : [...PLATFORMS];
if (!platforms.length) throw new Error(`--only takes ${PLATFORMS.join(", ")}`);
await mkdir(out, { recursive: true });
for (const p of platforms) {
  const file = join(out, `patio-${p}`);
  const r = Bun.spawnSync(
    [process.execPath, "build", "--compile", `--target=bun-${p}`, "--minify-syntax", `--define`, `PATIO_BUILD_REV=${JSON.stringify(`${rev}${dirty}`)}`, join(repo, "src/cli.ts"), "--outfile", file],
    { cwd: repo, stdout: "pipe", stderr: "pipe" },
  );
  if (r.exitCode !== 0) throw new Error(`bun build for ${p} failed: ${r.stderr.toString() || r.stdout.toString()}`);
  const sha = new Bun.CryptoHasher("sha256").update(await Bun.file(file).arrayBuffer()).digest("hex");
  await writeFile(`${file}.sha256`, `${sha}  patio-${p}\n`);
  console.log(`${file}  ${sha}`);
}
