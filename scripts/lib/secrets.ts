// Secrets live in the main checkout's .env (see paths.ts), outside this worktree. Doctor only asks whether a key is present; only live recipes read a value.
import { SECRETS_FILE } from "./paths";

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

async function load(file: string) {
  const f = Bun.file(file);
  return (await f.exists()) ? parseEnvFile(await f.text()) : null;
}

export async function secretPresence(name: string, file = SECRETS_FILE) {
  const vars = await load(file);
  return { file_exists: vars !== null, present: !!vars?.[name] };
}

// For live recipes only. Never print or log the result.
export async function readSecret(name: string, file = SECRETS_FILE): Promise<string | undefined> {
  return (await load(file))?.[name] || undefined;
}
