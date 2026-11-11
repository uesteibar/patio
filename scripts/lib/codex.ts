// How the Codex smoke selects its model and effort without touching ~/.codex: codex-acp merges the JSON in
// CODEX_CONFIG into each session's Codex config. The variable is set only on Bob's `patio watch --answer` in the
// smoke, so it reaches the codex-acp process that command starts and nothing else. Codex keeps using its
// normal home for auth (read, never copied). APP_SERVER_LOGS sends codex-acp's own log into the instance.
import { handshake } from "../../src/acp";
import { presetAgent } from "../../src/agents";

export const SMOKE_MODEL = "gpt-6-luna";
export const SMOKE_EFFORT = "low";

export function codexSmokeEnv(logDir: string): Record<string, string> {
  return {
    CODEX_CONFIG: JSON.stringify({ model: SMOKE_MODEL, model_reasoning_effort: SMOKE_EFFORT }),
    APP_SERVER_LOGS: logDir,
  };
}

// Starts the same codex-acp command patio's `codex` preset uses, opens a session and reads back the model and
// effort Codex reports (from CODEX_CONFIG alone: the handshake is not asked to set them), then closes it. No
// prompt is sent, so no model call is made and no budget is spent.
export async function preflightCodex(cwd: string, env: Record<string, string>, timeoutMs = 120_000) {
  const { command } = presetAgent("codex", cwd);
  const h = await handshake({ command, cwd, env, model: null, effort: null, startTimeoutMs: timeoutMs, timeoutMs });
  return { agent: h.agent, model: h.model, effort: h.effort, modes: h.modes, current_mode: h.mode, ok: h.model === SMOKE_MODEL && h.effort === SMOKE_EFFORT };
}
