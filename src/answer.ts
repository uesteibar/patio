// `patio answer <id>`: the owner's agent answers one message. This runs in the CLI process, never in the
// gatekeeper: claim the message (a lease, renewed while the agent works, so a crash frees it), pick the receiving
// agent's tool and folder (its file, agents/<name>.yaml, or the flags), run the tool through ACP with its owner's normal setup, in a
// disposable git worktree of that directory unless the owner asked for in place (workdir.ts), list and discard what
// it changed there, and hand its reply to the gatekeeper, which passes it through the output gate and sends it.
import { buildPrompt, runAgent } from "./acp";
import { prepareRunner, presetAgent, resolveAgent, type AgentChoice } from "./agents";
import { appendAudit } from "./audit";
import type { Config } from "./config";
import type { PublicItem } from "./inbox";
import { daemon, DaemonError } from "./local";
import { prepareWorkdir, type Workdir } from "./workdir";

export type AnswerResult = "answered" | "held" | "blocked" | "already_claimed" | "already_replied" | "agent_failed" | "error";

// Distinct exit codes, so a script or cron job can tell what happened.
export const ANSWER_EXIT: Record<AnswerResult, number> = {
  answered: 0,
  error: 1,
  already_replied: 6,
  held: 7,
  blocked: 8,
  already_claimed: 9,
  agent_failed: 10,
};

export type AnswerOutcome = {
  id: string;
  result: AnswerResult;
  reason?: string;
  status?: string;
  web_url?: string;
  // Where the agent ran, and what it changed in a disposable worktree (discarded).
  workdir?: { mode: Workdir["mode"]; dir: string; discarded: string[]; warning?: string };
};

export type AnswerOptions = AgentChoice & {
  // Only a message that reached this agent.
  as?: string;
  log?: (line: string) => void;
  // Test hook: the agent run, replaced by a crash or a stub.
  run?: typeof runAgent;
};

export async function answer(cfg: Config, ref: string, opts: AnswerOptions = {}): Promise<AnswerOutcome> {
  const log = opts.log ?? ((line: string) => console.error(line));
  let claim: { message: PublicItem; token: string; lease_ms: number; agent: string; agent_config: AgentChoice; owner?: string | null };
  try {
    claim = await daemon.claim(cfg, ref, opts.as);
  } catch (err) {
    if (!(err instanceof DaemonError)) throw err;
    const result: AnswerResult =
      err.code === "already_claimed"
        ? "already_claimed"
        : err.code === "already_replied" || err.code === "already_rejected" || err.code === "reply_to_reply"
          ? "already_replied"
          : "error";
    return { id: ref, result, reason: err.message };
  }
  const { message: m, token } = claim;
  const id = m.id;
  let config;
  try {
    // The receiving agent's last valid file (patio reloads it on change and keeps the last valid version).
    config = resolveAgent(claim.agent, claim.agent_config, { tool: opts.tool, folder: opts.folder, model: opts.model, effort: opts.effort, in_place: opts.in_place });
  } catch (err) {
    config = { error: (err as Error).message };
  }
  if ("error" in config) {
    await daemon.release(cfg, id, token).catch(() => {});
    return { id, result: "error", reason: config.error };
  }

  prepareRunner(cfg.home);
  let work: Workdir;
  try {
    work = await prepareWorkdir({ home: cfg.home, cwd: config.cwd, id, inPlace: config.inPlace });
  } catch (err) {
    await daemon.release(cfg, id, token).catch(() => {});
    return { id, result: "error", reason: (err as Error).message };
  }
  if (work.warning) log(`warning: ${work.warning}`);
  // In a worktree the preset is launched again there (hermes-docker mounts its directory).
  const launchCfg = work.mode === "worktree" ? { ...config, ...presetAgent(config.agent, work.dir, { model: config.model, effort: config.effort }) } : config;

  // Renew the lease while the agent works; if this process dies, the lease runs out and the message is free.
  const renew = setInterval(() => void daemon.renew(cfg, id, token).catch((err) => log(`could not renew the claim: ${(err as Error).message}`)), Math.max(200, claim.lease_ms / 3));
  const me = m.local_agent || m.to;
  const where = work.mode === "worktree" ? `a disposable worktree of ${config.cwd} (${work.dir})` : config.cwd;
  log(`answering ${id.slice(0, 8)} (${m.kind} from ${m.from}) as ${me} with ${config.name === "command" ? "" : `${config.name}: `}${launchCfg.command.join(" ")} in ${where}`);
  let text: string;
  let failure: string | null = null;
  try {
    const { name: _name, source: _source, agent: _agent, inPlace: _inPlace, ...launch } = launchCfg;
    const run = await (opts.run ?? runAgent)({ ...launch, prompt: buildPrompt(m, me, claim.owner), log: (line) => log(`[agent] ${line}`) });
    text = run.reply;
    log(`agent finished (${run.stopReason})${run.tools === undefined ? "" : `, ${run.tools} tool call${run.tools === 1 ? "" : "s"}`}`);
  } catch (err) {
    text = "";
    failure = `the agent failed: ${(err as Error).message}`;
  }
  clearInterval(renew);
  // What the agent changed in the worktree is listed (here and in the audit log) and thrown away.
  const { discarded } = await work.cleanup().catch((err) => ({ discarded: [`(could not remove the worktree: ${(err as Error).message})`] }));
  const workdir = { mode: work.mode, dir: work.dir, discarded, ...(work.warning ? { warning: work.warning } : {}) };
  if (work.mode === "worktree") {
    log(discarded.length ? `discarded changes: ${discarded.join(", ")}` : "the agent changed nothing in its worktree");
    appendAudit(cfg.home, { message_id: id, convo: m.convo, direction: "in", from: m.from, to: me, rule: "workdir", verdict: "discarded", cwd: config.cwd, discarded });
  } else appendAudit(cfg.home, { message_id: id, convo: m.convo, direction: "in", from: m.from, to: me, rule: "workdir", verdict: "in-place", cwd: config.cwd, ...(work.warning ? { warning: work.warning } : {}) });
  if (failure) {
    await daemon.failClaim(cfg, id, token, failure).catch(() => {});
    return { id, result: "agent_failed", reason: failure, workdir };
  }
  // What the agent wanted to say, for its owner, whatever the output gate then does with it.
  log(`agent reply: ${JSON.stringify(text)}`);
  if (!text.trim()) {
    const reason = "the agent finished without an answer";
    await daemon.failClaim(cfg, id, token, reason).catch(() => {});
    return { id, result: "agent_failed", reason, workdir };
  }
  try {
    const sent = await daemon.complete(cfg, id, token, text);
    if (sent.status === "held") return { id, result: "held", reason: sent.reason, web_url: sent.web_url, workdir };
    return { id, result: "answered", status: sent.status, workdir };
  } catch (err) {
    if (!(err instanceof DaemonError)) throw err;
    if (err.code === "blocked") return { id, result: "blocked", reason: err.message, workdir };
    if (err.code === "already_replied" || err.code === "reply_to_reply") return { id, result: "already_replied", reason: err.message, workdir };
    if (err.code === "lost_claim") return { id, result: "already_claimed", reason: err.message, workdir };
    return { id, result: "error", reason: err.message, workdir };
  }
}
