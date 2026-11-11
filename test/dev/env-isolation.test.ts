// The checkout's .env (copied into each worktree by `just worktree`) holds real keys. bunfig.toml switches off Bun's
// automatic .env loading, so tests, scripts and the processes they start never see them; live recipes read the keys
// they need explicitly (scripts/lib/secrets.ts). This test fails if a test process, or a patio process a test starts
// from the repository, sees one of them. It reads only the names in .env, never a value.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "../../scripts/lib/paths";
import { parseEnvFile } from "../../scripts/lib/secrets";
import { PROCESS_MS } from "../helpers/timeouts";

const PREFIXES = ["TYPESAFE_", "GITHUB_CLIENT_"];
const dotenv = join(REPO, ".env");
const namesInDotenv = existsSync(dotenv) ? Object.keys(parseEnvFile(readFileSync(dotenv, "utf8"))) : [];
const leaked = (env: Record<string, string | undefined>) =>
  Object.keys(env).filter((k) => env[k] !== undefined && (PREFIXES.some((p) => k.startsWith(p)) || namesInDotenv.includes(k)));

test("a test process sees no TYPESAFE_*, GITHUB_CLIENT_* or other .env variable", () => {
  expect(leaked(process.env)).toEqual([]);
}, PROCESS_MS);

test("a Bun process started from the repository does not load .env either", async () => {
  const proc = Bun.spawn([process.execPath, "-e", "console.log(JSON.stringify(Object.keys(process.env)))"], { cwd: REPO, env: process.env, stdout: "pipe" });
  const keys = JSON.parse(await new Response(proc.stdout).text()) as string[];
  await proc.exited;
  expect(leaked(Object.fromEntries(keys.map((k) => [k, "set"])))).toEqual([]);
}, PROCESS_MS);
