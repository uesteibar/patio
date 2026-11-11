// An agent's file (agents/<name>.yaml) for tests and instances, from rules written the way rules.yaml had them
// (defaults, contacts, channels) and the agent's tool and folder. JSON is YAML, so the output is a valid file.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseRules } from "../../src/grants";

type Legacy = { defaults?: Record<string, unknown>; contacts?: Record<string, unknown>; channels?: Record<string, unknown> } | null;

export function rulesOf(yaml: string | undefined): Record<string, unknown> {
  const g = ((yaml ? Bun.YAML.parse(yaml) : null) ?? {}) as Legacy & Record<string, unknown>;
  const { defaults, contacts, channels } = g;
  return { ...(defaults ?? {}), ...(contacts ? { contacts } : {}), ...(channels ? { channels } : {}) };
}

export type AgentFileSpec = {
  // Rules in the old rules.yaml shape: defaults, contacts and channels.
  rules?: string;
  tool?: string;
  folder?: string;
  in_place?: boolean;
  model?: string;
  effort?: string;
};

export function agentFileText(o: AgentFileSpec): string {
  const doc: Record<string, unknown> = {};
  for (const k of ["tool", "folder", "in_place", "model", "effort"] as const) if (o[k] !== undefined) doc[k] = o[k];
  doc.rules = rulesOf(o.rules);
  return JSON.stringify(doc, null, 2) + "\n";
}

export async function writeAgentFile(home: string, name: string, o: AgentFileSpec) {
  await mkdir(join(home, "agents"), { recursive: true, mode: 0o700 });
  await Bun.write(join(home, "agents", `${name}.yaml`), agentFileText(o));
}

// Rules written the way rules.yaml had them, parsed as an agent's rules.
export const legacyGrants = (yaml: string) => parseRules(rulesOf(yaml));
