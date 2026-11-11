#!/usr/bin/env bun
// A fake ACP agent for deterministic tests. It speaks ACP over stdio with @agentclientprotocol/sdk,
// follows a fixture, and logs what it was offered and which permission answers it received.
//
//   bun test/fakes/fake-acp-agent.ts --fixture fixture.json --log agent.log.jsonl
//
// Fixture (JSON):
//   modes:  { initial: "default", available: ["default", "plan"] } | null   (null: report no modes)
//   steps:  [{ id, tool: "read"|"edit"|"execute"|"fetch"|..., title?, path?, content?, permission?: true, whenPrompt? }]
//           whenPrompt: a regex; the step runs only when the prompt matches it (otherwise it yields "[skipped]")
//   reply:  text sent back; "{{id}}" is replaced by what step `id` produced
//   delayMs: how long to work before replying (to test leases and concurrent consumers)
//   configOptions: [{ id, category, current, options }]   session options (model, effort) the client may set
//   authMethods: what initialize advertises
//   startDelayMs: how long initialize takes (to test start timeouts)
//
// For each step the agent announces a tool call, asks for permission (unless permission is false),
// and only when the answer selects an allow option does it act: "read" reads `path`, "edit" writes
// `content` to `path`, both relative to the session cwd. A refused step really does nothing, so a
// test can check the disk afterwards.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import * as acp from "@agentclientprotocol/sdk";

export type Step = {
  id: string;
  tool: acp.ToolKind;
  title?: string;
  path?: string;
  content?: string;
  permission?: boolean;
  whenPrompt?: string;
};

export type FakeConfigOption = { id: string; category?: string; current: string; options: string[] };

export type Fixture = {
  modes?: { initial: string; available: string[] } | null;
  configOptions?: FakeConfigOption[];
  authMethods?: acp.AuthMethod[];
  startDelayMs?: number;
  steps?: Step[];
  reply?: string;
  delayMs?: number;
};

export type LogEntry = { event: string; [key: string]: unknown };

const { values } = parseArgs({
  options: { fixture: { type: "string" }, log: { type: "string" } },
  strict: false,
});

const fixture: Fixture = values.fixture ? JSON.parse(readFileSync(String(values.fixture), "utf8")) : {};
const logFile = values.log ? String(values.log) : undefined;
const log = (entry: LogEntry) => {
  if (logFile) appendFileSync(logFile, JSON.stringify({ ts: Date.now(), ...entry }) + "\n");
};

const modeState = (current: string): acp.SessionModeState | null => {
  if (fixture.modes === null) return null;
  const available = fixture.modes?.available ?? ["default"];
  return { currentModeId: current, availableModes: available.map((id) => ({ id, name: id })) };
};

const sessions = new Map<string, { cwd: string; mode: string; config: FakeConfigOption[] }>();

const configState = (config: FakeConfigOption[]): acp.SessionConfigOption[] =>
  config.map((o) => ({
    type: "select",
    id: o.id,
    name: o.id,
    ...(o.category && { category: o.category }),
    currentValue: o.current,
    options: o.options.map((v) => ({ value: v, name: v })),
  })) as acp.SessionConfigOption[];

const ALLOW = new Set(["allow_once", "allow_always"]);

const app = acp
  .agent({ name: "fake-acp-agent" })
  .onRequest(acp.methods.agent.initialize, async (ctx) => {
    log({ event: "initialize", clientCapabilities: ctx.params.clientCapabilities ?? null });
    if (fixture.startDelayMs) await Bun.sleep(fixture.startDelayMs);
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {}, ...(fixture.authMethods && { authMethods: fixture.authMethods }) };
  })
  .onRequest(acp.methods.agent.session.new, (ctx) => {
    const sessionId = `fake-${crypto.randomUUID()}`;
    const mode = fixture.modes?.initial ?? "default";
    const config = structuredClone(fixture.configOptions ?? []);
    sessions.set(sessionId, { cwd: ctx.params.cwd, mode, config });
    log({ event: "session/new", sessionId, cwd: ctx.params.cwd, meta: ctx.params._meta ?? null, env: { PATIO_FAKE_ENV: process.env.PATIO_FAKE_ENV ?? null } });
    return { sessionId, modes: modeState(mode), ...(fixture.configOptions && { configOptions: configState(config) }) };
  })
  .onRequest(acp.methods.agent.session.setConfigOption, (ctx) => {
    const session = sessions.get(ctx.params.sessionId);
    const option = session?.config.find((o) => o.id === ctx.params.configId);
    const value = String((ctx.params as { value: unknown }).value);
    log({ event: "set_config_option", configId: ctx.params.configId, value });
    if (!session || !option) throw acp.RequestError.invalidParams(undefined, `Unknown config option: ${ctx.params.configId}`);
    if (!option.options.includes(value)) throw acp.RequestError.invalidParams(undefined, `Invalid value for config option ${option.id}: ${value}`);
    option.current = value;
    return { configOptions: configState(session.config) };
  })
  .onRequest(acp.methods.agent.session.setMode, (ctx) => {
    const session = sessions.get(ctx.params.sessionId);
    if (session) session.mode = ctx.params.modeId;
    log({ event: "set_mode", modeId: ctx.params.modeId });
    return {};
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const { sessionId } = ctx.params;
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    const promptText = ctx.params.prompt.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n");
    log({ event: "prompt", mode: session.mode, text: promptText });

    const produced = new Map<string, string>();
    for (const step of fixture.steps ?? []) {
      if (step.whenPrompt && !new RegExp(step.whenPrompt).test(promptText)) {
        produced.set(step.id, "[skipped]");
        log({ event: "tool_skipped", step: step.id });
        continue;
      }
      const title = step.title ?? `${step.tool} ${step.path ?? ""}`.trim();
      const toolCallId = `${step.id}-${crypto.randomUUID().slice(0, 8)}`;
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: "tool_call", toolCallId, title, kind: step.tool, status: "pending" },
      });

      let allowed = true;
      if (step.permission !== false) {
        const options: acp.PermissionOption[] = [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ];
        log({ event: "permission_request", step: step.id, kind: step.tool, title, options: options.map((o) => ({ optionId: o.optionId, kind: o.kind })) });
        const res = await ctx.client.request(acp.methods.client.session.requestPermission, {
          sessionId,
          toolCall: { toolCallId, title, kind: step.tool, status: "pending" },
          options,
        });
        const outcome = res.outcome;
        const chosen = outcome.outcome === "selected" ? options.find((o) => o.optionId === outcome.optionId) : undefined;
        allowed = !!chosen && ALLOW.has(chosen.kind);
        log({
          event: "permission_answer",
          step: step.id,
          outcome: outcome.outcome,
          optionId: outcome.outcome === "selected" ? outcome.optionId : null,
          optionKind: chosen?.kind ?? null,
          allowed,
        });
      }

      let result = "[refused]";
      if (allowed) {
        const target = step.path ? (isAbsolute(step.path) ? step.path : join(session.cwd, step.path)) : undefined;
        if (step.tool === "read" && target) result = readFileSync(target, "utf8").trim();
        else if (step.tool === "edit" && target) {
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, step.content ?? "");
          result = "[written]";
        } else result = "[done]";
      }
      produced.set(step.id, result);
      log({ event: "tool_result", step: step.id, performed: allowed });
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: "tool_call_update", toolCallId, status: allowed ? "completed" : "failed" },
      });
    }

    if (fixture.delayMs) await Bun.sleep(fixture.delayMs);
    const reply = (fixture.reply ?? "ok").replace(/\{\{(\w+)\}\}/g, (_, id: string) => produced.get(id) ?? "");
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } },
    });
    log({ event: "reply", text: reply });
    return { stopReason: "end_turn" };
  })
  .onNotification(acp.methods.agent.session.cancel, () => {
    log({ event: "cancel" });
  });

if (import.meta.main) {
  app.connect(
    acp.ndJsonStream(
      Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
    ),
  );
}
