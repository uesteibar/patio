# The wake-up problem: how an external process can make a coding agent notice a new message

Date of research: 8 November 2026. All sources were fetched on this date.

Scope: Claude Code, OpenAI Codex CLI, Pi, Hermes Agent, Gemini CLI, OpenCode, plus MCP and ACP at the protocol level. For each agent, the three questions are:

- **(a) Inject**: put a new message into an ACTIVE interactive session (a turn is running).
- **(b) Wake**: make an IDLE interactive session start a new turn.
- **(c) Headless**: start or resume a session without a UI to handle the message.

Labels used in this file:

- **Verified**: read in official docs, release notes or source code fetched today.
- **Inferred**: follows from verified facts or source code, but not tested and not stated directly.
- **Not verified**: could not confirm.

No agent was run. Nothing was installed or configured. Local copies used for reading: `cache/scratch/wakeup/` (doc downloads) and `cache/scratch/*-src` (shallow clones).

---

## 1. Summary table

Confidence: **H** = verified in docs or code, **M** = verified pieces plus inference, **L** = inferred or unclear.

| Agent (version) | (a) Inject into active session | (b) Wake idle session | (c) Headless start / resume |
|---|---|---|---|
| **Claude Code** 2.1.319 (6 Nov 2026) | **Channels**: MCP server declares `experimental['claude/channel']`, emits `notifications/claude/channel`. Events that arrive while Claude is busy are delivered together on the next turn. Research preview; custom channels need `--dangerously-load-development-channels`. [channels-reference] **H**. Also: **mods** `$.session`/hooks, `PostToolUse` hook `additionalContext` (pull) **H** | **Channels** start Claude responding to the event in the open session [channels-reference] **H**. **Mods** `$.prompt.submit({text})` "waits until the session is idle and then starts a new turn" (v2.1.287+) [mods/api] **H**. **`asyncRewake` hook**: "wakes Claude immediately even when the session is idle" on exit code 2 [hooks] **H**. **Plugin monitors**: a background command for the whole session whose output "reaches Claude as notifications" [plugins/components] **M** (idle wake not stated explicitly). Cross-session inbox socket exists but message wire format is undocumented **L** | `claude -p "<msg>" --resume <id>` [headless] **H**. `claude --resume <id> --bg "<msg>"` continues in place or forks (v2.1.257+) [agent-view] **H**. Agent SDK streaming input. `claude agents --json` reports `busy`/`waiting`/`idle` [agent-view] **H**. Same session in two processes interleaves into one transcript [sessions] **H** |
| **Codex CLI** 0.167.0 (6 Nov 2026) | **App-server** `turn/steer` appends user input to the in-flight turn; `thread/inject_items` appends items without starting a turn [app-server] **H**. Reaching the TUI's own thread needs the TUI to use a shared app-server daemon (default on Unix per source) **M**. **Hooks**: `PostToolUse`/`UserPromptSubmit` `additionalContext`; `async` hooks deliver at the next safe point [hooks] **H** (pull) | **App-server** `turn/start` on the loaded thread from a second connection **M** (API verified; multi-client attach to a TUI thread is inferred from `thread_processor.rs`). **Hooks cannot**: "Finishing a background hook doesn't start a new turn" [hooks] **H**. `Stop` hook `decision:"block"` continues a turn that is ending, not an idle one [hooks] **H** | `codex exec resume <SESSION_ID> "<msg>"` [non-interactive-mode] **H**. App-server `thread/resume` + `turn/start` over stdio/unix socket [app-server] **H**. ACP: `@agentclientprotocol/codex-acp` 2.6.0 (spawns its own `codex app-server`) **H** |
| **Pi** 1.5.0 (`@earendil-works/pi-coding-agent`) | **Extension** `pi.sendMessage(msg, {deliverAs:"steer"})` queues while streaming and delivers before the next LLM call; `pi.sendUserMessage()` [extensions.md] **H**. **RPC** `steer` / `follow_up` commands [rpc-commands.md] **H** (only for a Pi you launched in RPC mode) | **Extension** `pi.sendMessage(msg, {triggerTurn:true})`: "If agent is idle, trigger an LLM response immediately" [extensions.md] **H**. An extension can listen on a socket or watch a file (inferred, ordinary Node code) **M** | `pi --print "<msg>" --session <path|id>`; `--mode json`; `--mode rpc` with `prompt` [cli.md, rpc-commands.md] **H**. No native ACP; community `pi-acp` 0.0.34 on npm **L** |
| **Hermes Agent** v0.23.0 (5 Nov 2026) | **Plugin** `ctx.inject_message(content, session_key=...)`. Classic CLI in-process: mid-turn message interrupts like typed input. Gateway sessions: enters the busy-session queue. Needs `allow_gateway_injection: true` [plugins doc] **H**. `display.busy_input_mode: steer` exists for typed input [CLI doc] **H** | **Plugin** `ctx.inject_message`: if idle, "queued as the next input and starts a new turn" [plugins doc] **H**. API server `POST /api/sessions/{id}/chat` runs a turn in a named session [API server doc] **H**. Note: TUI/Desktop need the durable `ses_…` key; the attached classic CLI does not display injected turns [plugins doc] **H** | `hermes chat -q`, `hermes --resume <id>`, API server `/v1/runs` with `X-Hermes-Session-Id`, `hermes peer run` (async, idempotency key), webhook routes (one session per event by default), ACP adapter with new/load/resume/fork/list [docs] **H** |
| **Gemini CLI** stable 0.67.0 (4 Nov 2026) | **Hooks only (pull)**: `AfterTool` `additionalContext` is appended to a tool result; `BeforeAgent` `additionalContext` is appended to the prompt [hooks/reference.md] **H**. "Model steering" is experimental and only for text the user types [model-steering.md] **H** | **None found.** No async or background hooks; `AfterAgent` `decision:"deny"` forces a retry turn at turn end only [hooks/reference.md] **H**. No external injection API found **M** (absence) | `gemini -p "<msg>"`; `--resume <id|latest>` [cli-reference.md, session-management.md] **H** (combination `-p` + `--resume` not verified). `gemini --acp` with `loadSession: true` [acp-mode.md, acpRpcDispatcher.ts] **H** |
| **OpenCode** v1.19.5 (28 Oct 2026) | **Server** `POST /session/:id/prompt_async` (204, no wait); `/tui/append-prompt` + `/tui/submit-prompt` drive the TUI [opencode.ai/docs/server] **H**. Behaviour when the session is busy (queue vs. reject) **not verified** | **Server** `prompt_async` on an idle session **H**. **Plugin** in-process `client` SDK + `session.idle` event [plugins.mdx] **H**. TUI port is random unless `--port` is set [server doc] **H**, so discovery is the hard part | `opencode run --session <id>` / `--attach <url>` [cli.mdx] **H**. `opencode acp` with `session/load`, `session/resume` [cli/src/acp/agent.ts] **H** |

Sources for the table are listed per agent in section 2.

---

## 2. Per-agent notes

### 2.1 Claude Code (2.1.319, 6 Nov 2026)

Sources: <https://code.claude.com/docs/en/changelog> (top entry 2.1.319, 6 Nov 2026), <https://code.claude.com/docs/en/channels>, <https://code.claude.com/docs/en/channels-reference>, <https://code.claude.com/docs/en/hooks>, <https://code.claude.com/docs/en/plugins/components> (Monitors), <https://code.claude.com/docs/en/tools-reference> (Monitor tool), <https://code.claude.com/docs/en/plugins/mods/api>, <https://code.claude.com/docs/en/plugins/mods/overview>, <https://code.claude.com/docs/en/cross-session-messaging>, <https://code.claude.com/docs/en/agent-view>, <https://code.claude.com/docs/en/headless>, <https://code.claude.com/docs/en/sessions>, <https://code.claude.com/docs/en/mcp>, <https://code.claude.com/docs/en/env-vars>.

Claude Code has the most push options. They differ in maturity and setup cost.

1. **Channels** (verified). An MCP server that runs as a stdio subprocess declares `capabilities.experimental['claude/channel'] = {}` and sends `notifications/claude/channel` with `{content, meta}`. The model sees `<channel source="..." k="v">content</channel>`. "Events queue into the session and are processed in order. If several notifications arrive while Claude is busy, they're delivered together on the next turn." The doc example shows Claude starting to respond to a `curl` POST in the open session, so this covers (a) and (b). Added in 2.1.80 (19 Mar 2026). Limits:
   - Research preview. `--channels` accepts only allowlisted plugins. A custom channel needs `claude --dangerously-load-development-channels server:<name>`, which shows a confirmation dialog at each start and is ignored in `-p` and the Agent SDK.
   - Needs claude.ai or Console auth. Not available on Bedrock, Vertex or Foundry. Team/Enterprise orgs must set `channelsEnabled`.
   - No delivery acknowledgement. Events are dropped silently if the server is not loaded as a channel.
   - On the v2 MCP client runtime, a channel server that negotiates MCP revision 2026-07-28 is not registered (<https://code.claude.com/docs/en/mcp>, "Push messages with channels"). A patio channel must stay on the earlier handshake.
   - Patio's MCP server is already Bun + `@modelcontextprotocol/sdk`, which is exactly the shape the docs describe.
2. **Mods** (verified, v2.1.287+, on by default). In-process JS/TS plugin handlers. `$.clock.every()` runs a timer between turns without starting one. `$.prompt.submit({ text })` "waits until the session is idle and then starts a new turn". `$.ui.notify/toast/status` show text without a turn. `$.session.send()` sends a cross-session message. A patio mod could poll the local gatekeeper (or read a socket through `$.process`/network access) and submit a prompt when a message arrives. Refused in `claude -p` and Agent SDK sessions (mods/api "Calls refused in `claude -p` runs").
3. **`asyncRewake` hooks** (verified). A command hook with `asyncRewake: true` runs in the background and "wakes Claude immediately even when the session is idle" when it exits with code 2; stderr is shown as a system reminder. `timeout` is still enforced. Inferred pattern: a `Stop` or `SessionStart` hook runs `patio wait --any --timeout N`, exits 2 with the message on stderr. It must be re-armed after each wake (for example by the next `Stop`). Not tested.
4. **Monitor tool and plugin monitors** (verified with one inference). The Monitor tool streams each output line of a background command back to Claude ("Claude interjects when an event arrives"); each watch has a deadline (5 min default, 30 max). **Plugin monitors** (`monitors/monitors.json`) run "in the background for the whole session" and their output "reaches Claude as notifications". They do not start in `-p`. Whether a monitor line starts a turn on an idle session is not stated explicitly (Inferred: yes, because the doc says Claude reacts without being asked; test needed).
5. **Background Bash completion** (today's patio approach). `patio wait` as a background command; Claude is notified when it exits. Works, but needs the model to re-launch the wait after every wake.
6. **Cross-session messaging inbox socket** (verified that it exists; not usable yet). Each session binds a Unix socket (`CLAUDE_CODE_MESSAGING_SOCKET`, v2.1.224+). "When the receiving session is idle, Claude Code starts a new turn with the message." The docs say a script or hook can post to it and document the auth line `{"type":"auth","token":...}`, but **the message line format is not documented**, and a gatekeeper is not a child process, so the own-child trust rule does not apply. Treat as unsupported for a third party.
7. **Pull hooks** (verified). `UserPromptSubmit`, `SessionStart`, `PostToolUse` can add `additionalContext`. Hook output "is delivered on the next conversation turn. If the session is idle, the response waits until the next user interaction", except `asyncRewake`.
8. **Headless** (verified). `claude -p "..." --resume <id>`; `--input-format stream-json` for long-running SDK use; `claude --resume <id> --bg "<prompt>"` dispatches to a background session (continues in place or forks with a `note:` line, v2.1.257+). Resuming a running **background** session opens that session (v2.1.285+). Resuming the same session in two terminals without forking "interleave[s] into one transcript" (sessions doc). `claude agents --json` gives `status: busy|waiting|idle` and `sessionId` for live sessions, which a gatekeeper can poll.
9. **MCP standard notifications** (verified). `list_changed` only refreshes lists; it does not start a turn.

### 2.2 OpenAI Codex CLI (0.167.0, 6 Nov 2026)

Sources: <https://github.com/openai/codex/releases/tag/rust-v0.167.0> (published 2026-11-06), <https://learn.chatgpt.com/docs/hooks.md>, <https://learn.chatgpt.com/docs/app-server.md>, <https://learn.chatgpt.com/docs/non-interactive-mode.md>, <https://learn.chatgpt.com/docs/config-file/config-advanced.md> (Notifications), source at commit `748ab55` (8 Nov 2026): `codex-rs/tui/src/startup_orchestration.rs`, `codex-rs/features/src/lib.rs`, `codex-rs/app-server-daemon/README.md`, `codex-rs/app-server/src/request_processors/thread_processor.rs`, `codex-rs/rmcp-client/src/logging_client_handler.rs`.

1. **App-server JSON-RPC** (verified). `thread/resume`, `turn/start`, `turn/steer` ("append user input to the active in-flight turn ... without creating a new turn", requires `expectedTurnId`), `thread/inject_items` (append model-visible items without a turn), `thread/loaded/list`, `thread/status/changed` notifications. Transports: stdio (default), `unix://` (default control socket), experimental WebSocket.
2. **Shared daemon** (verified in source, inferred end-to-end). `codex app-server daemon start|stop|...` is experimental. The TUI probes the default daemon socket and reuses it ("implicit daemon discovery", `startup_orchestration.rs`); feature `daemon_auto_start` is `Stable`, `default_enabled: true` (`features/src/lib.rs`); `--no-daemon` opts out. A resume request for an already loaded thread is "delegated to the loaded thread" (`thread_processor.rs`). Inference: when the TUI runs on the daemon, a gatekeeper can connect to the same unix socket, `thread/resume` the user's thread, then `turn/start` (idle) or `turn/steer` (busy), and the TUI sees the turn. This is the only path that wakes an idle Codex TUI. **Must be tested**; the WebSocket transport is labelled "experimental and unsupported".
3. **Hooks** (verified). Events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, etc. `async: true` hooks deliver `additionalContext` "at the next safe point"; "If no turn is active, Codex waits until the next user turn. Finishing a background hook doesn't start a new turn." `Stop` with `decision: "block"` continues the ending turn with `reason` as a new prompt. So hooks can deliver a digest and can extend a turn that is ending, but cannot wake an idle TUI.
4. **`notify`** (verified). Outbound only: runs a program on `agent-turn-complete`. Useful for the gatekeeper to learn that a turn ended, not for input.
5. **Headless** (verified). `codex exec resume <SESSION_ID> "<msg>"` or `--last`.
6. **MCP** (verified in source). `rmcp-client` logs `resources/updated` and `list_changed` notifications (`logging_client_handler.rs`); tool list changes refresh tools. No turn is started.
7. **ACP** (verified). Development moved to `agentclientprotocol/codex-acp` (2.6.0, commit `f320891`, 8 Nov 2026). It implements `session/load` and `session/resume`, but spawns its own `codex app-server` over stdio (`src/CodexJsonRpcConnection.ts`), so an ACP resume runs in a separate process from the user's TUI.
8. Codex has an under-development `agent_message_board` feature (`features/src/lib.rs`, `UnderDevelopment`, off by default) for messages inside one agent tree. Not usable for cross-user messaging today.

### 2.3 Pi coding agent (1.5.0)

Sources: npm `@earendil-works/pi-coding-agent` latest = 1.5.0; repo cloned from `badlogic/pi-mono` (now `earendil-works/pi`), commit `0cc8373` (8 Nov 2026): `packages/coding-agent/docs/extensions.md`, `rpc-commands.md`, `cli.md`, `mcp.md`, `sessions.md`. pi.dev itself was not fetched; the repo docs were used.

1. **Extensions** (verified). `pi.sendMessage(message, { deliverAs, triggerTurn })`:
   - `deliverAs: "steer"` (default): queued while streaming, delivered after the current tool calls, before the next LLM call.
   - `"followUp"`: delivered when the agent has no more tool calls.
   - `"nextTurn"`: stored for the next user prompt.
   - `triggerTurn: true`: "If agent is idle, trigger an LLM response immediately."
   - `pi.sendUserMessage()` sends a real user message that starts or queues a turn.
   This covers (a) and (b) in one API. An extension is ordinary TypeScript, so it can hold a socket to the gatekeeper (inferred).
2. **RPC mode** (verified). `pi --mode rpc` reads JSONL commands: `prompt` (with `streamingBehavior`), `steer`, `follow_up`, `abort`, `new_session`, `get_state`. Only works for a Pi process that the caller started, so it fits a responder, not the user's own TUI.
3. **Headless** (verified). `pi --print`, `--mode json`, `--session <path|id>`, `--continue`, `--fork`.
4. **MCP** (verified). Pi now has an MCP client (`pi mcp add`). It handles `notifications/tools/list_changed`; logging notifications go to `~/.pi/agent/mcp.log`. No turn is started.
5. **ACP** (not native). Community adapter `pi-acp` 0.0.34 on npm; behaviour not verified.

### 2.4 Hermes Agent (v0.23.0, 5 Nov 2026)

Sources: <https://github.com/NousResearch/hermes-agent/releases/tag/v0.23.0> (published 2026-11-05), <https://hermes-agent.nousresearch.com/docs/llms-full.txt> sections: Plugins "Injecting Messages" (<https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins>), CLI "Redirecting the Agent Mid-Turn", API Server (<https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server>), Webhooks (<https://hermes-agent.nousresearch.com/docs/user-guide/messaging/webhooks>), CLI reference `hermes peer`, MCP (<https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp>), ACP internals.

1. **Plugin `ctx.inject_message()`** (verified). Signature `inject_message(content, role="user", *, session_key=None, origin=None) -> bool`.
   - Classic CLI, in-process: idle → "queued as the next input and starts a new turn"; mid-turn → "interrupts the current operation".
   - Gateway sessions with `session_key`: enters the normal message path; "Active sessions use the existing busy-session queue rather than starting a competing turn." Route and auth are rechecked. Text cannot run slash commands or approve tools.
   - TUI/Desktop: pass the durable `ses_…` key. Requires `plugins.entries.<name>.allow_gateway_injection: true`.
   - Caveat: when the target is a classic CLI session reached through the gateway, "the attached classic CLI does not display" the injected turn.
2. **API server** (verified). `POST /api/sessions/{session_id}/chat` (+ `/stream`), `/v1/runs` with `X-Hermes-Session-Id` / `X-Hermes-Session-Key`, durable admission queue, idempotency keys, interrupt endpoint.
3. **`hermes peer`** (verified). Bot-to-bot DMs between Hermes gateways: `dm` runs one turn in the remote agent's canonical "Bot Chat" session; `run`/`status`/`stop` for async turns. This is close to what patio does, but Hermes-only.
4. **Webhooks** (verified). Each event runs in its own session by default; `mirror_to_session: true` writes the delivered message into a chat session transcript; `cron_job` can be fired instead.
5. **Hooks, cron, heartbeats** (verified exist). `/heartbeat` re-enters the current session when idle on a timer (a polling fallback).
6. **MCP** (verified). Acts on `tools/list_changed`; `prompts/list_changed` and `resources/list_changed` "are received but not yet acted on".
7. **ACP** (verified). Adapter supports new/load/resume/fork/list/cancel session methods.

### 2.5 Gemini CLI (stable 0.67.0, 4 Nov 2026)

Sources: repo `google-gemini/gemini-cli` commit `62bab5b` (6 Nov 2026; package version `0.69.0-nightly.20261104`): `docs/changelogs/latest.md` (stable v0.67.0, released 4 Nov 2026), `docs/hooks/reference.md`, `docs/cli/acp-mode.md`, `docs/cli/cli-reference.md`, `docs/cli/session-management.md`, `docs/cli/model-steering.md`, `packages/core/src/tools/mcp-client.ts`, `packages/cli/src/acp/acpRpcDispatcher.ts`.

1. **Hooks** (verified). Command hooks only, synchronous (timeout default 60 s). `BeforeAgent` and `AfterTool` can add `additionalContext`; `AfterAgent` `decision: "deny"` sends `reason` as a new prompt (retry at turn end). `Notification` hooks are advisory. No async or rewake hooks. So Gemini supports pull at boundaries only.
2. **Model steering** (verified). Experimental, off by default; it treats text the user types while the agent works as a hint. No external API.
3. **No wake path found** for an idle interactive session (inferred from the absence of any such API in docs and hook reference).
4. **Headless** (verified). `gemini -p`, `--resume <id|latest|index>`. The `-p` + `--resume` combination is plausible but not verified.
5. **ACP** (verified). `gemini --acp` (also `--experimental-acp` in the CLI reference); `loadSession: true`; `newSession`, `loadSession`, `setSessionMode`.
6. **MCP** (verified in source). Handlers for tools/resources/prompts `list_changed` and progress only.
7. There is an experimental `packages/a2a-server` (A2A protocol). Not evaluated.

### 2.6 OpenCode (v1.19.5, 28 Oct 2026)

Sources: <https://opencode.ai/docs/server/>, repo `sst/opencode` (redirects to `anomalyco/opencode`), commit `3ce4ca4` (8 Nov 2026): `packages/web/src/content/docs/{server,cli,plugins,acp}.mdx`, `packages/cli/src/acp/agent.ts`; latest release v1.19.5 published 2026-10-28. Note: the dev branch packages say `2.2.5`; that version is not in GitHub releases, so treat dev-branch details as possibly unreleased.

1. **Client/server architecture** (verified). The TUI talks to an HTTP server; "When you start the TUI it randomly assigns a port and hostname. You can instead pass in the `--hostname` and `--port` flags." Endpoints: `POST /session/:id/prompt_async` (204), `POST /session/:id/message`, `/tui/append-prompt`, `/tui/submit-prompt`, `/tui/show-toast`, SSE `/event`.
2. **Plugins** (verified). In-process; get an SDK `client`; can subscribe to `session.idle`, `session.status`, message events. Inferred: a patio plugin can call the SDK prompt method when a message arrives, and use `session.idle` to time delivery.
3. **Busy behaviour** of `prompt_async` (queue vs. error) **not verified**.
4. **Headless** (verified). `opencode run --session <id>`, `--attach <url>` to a running server, `opencode attach`.
5. **ACP** (verified in source). `session/new|load|list|resume|close|delete`.

---

## 3. Protocol-level options

### 3.1 MCP

Sources: <https://modelcontextprotocol.io/specification/2026-07-28/changelog.md>, <https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions.md>, client docs and source cited in section 2.

- **The current revision is 2026-07-28** (verified). It makes MCP stateless (no `initialize` handshake), replaces `resources/subscribe` and the HTTP GET stream with `subscriptions/listen`, replaces server-initiated `sampling/createMessage` and `elicitation/create` with Multi Round-Trip Requests inside a client request, and **deprecates Sampling, Roots and Logging** (SEP-2577).
- **Standard notifications are change signals, not messages.** `subscriptions/listen` delivers `tools/prompts/resources list_changed` and `resources/updated`. The spec defines no notification that carries conversational content or asks the host to start a turn.
- **No client in this set starts a turn on a standard MCP notification** (verified per client): Claude Code refreshes lists; Codex logs them; Gemini refreshes lists; Pi refreshes tools; Hermes refreshes tools only.
- **Elicitation/sampling** are tied to a request the client already made. Under MRTR they cannot be used to wake an idle session.
- **The only MCP-based push is vendor-specific**: Claude Code's `claude/channel` experimental capability. It is not portable, and Claude Code does not register it on a 2026-07-28 connection.
- Conclusion: an MCP server alone cannot solve the wake-up problem portably. MCP stays the right surface for the agent to **pull** (`inbox`, `read`, `reply`).

### 3.2 ACP (Agent Client Protocol)

Sources: <https://agentclientprotocol.com/protocol/v1/session-setup.md>, <https://agentclientprotocol.com/rfds/updates.md>, <https://agentclientprotocol.com/rfds/v2/background-work.md>, adapter source cited in section 2.

- **Session reuse is in the spec** (verified). `session/load` (capability `loadSession`, replays history); `session/resume` (stabilized 22 Apr 2026, no replay); `session/list` (completed); `session/close` (stabilized). Draft RFDs: `session/status` (26 Oct 2026), session notices (5 Aug 2026), v2 background work.
- **Per agent** (verified in source): `claude-agent-acp` 0.101.0 advertises `loadSession: true` and `sessionCapabilities.resume` (`src/acp-agent.ts`); `codex-acp` 2.6.0 handles load and resume; Gemini `loadSession: true`; OpenCode load/resume; Hermes load/resume/fork/list; Pi only through community `pi-acp`.
- **Important limit** (inferred from the protocol shape and adapter source): ACP is client-spawns-agent over stdio. `session/load` in the gatekeeper's agent process loads the transcript **into a second process**. It does not attach to the user's live TUI, does not show anything there, and while the TUI is open both processes can write the same session (Claude Code docs confirm interleaving for two processes). ACP therefore solves (c), not (a) or (b).
- Note on the patio README: "Verified with Claude Code 0.101.0 through `claude-agent-acp`" — 0.101.0 is the adapter version, not the Claude Code version.

---

## 4. Candidate designs for the gatekeeper

Common pieces for every design:

- **Session registry.** The agent tells the gatekeeper which session it is in (MCP tool `register_session` at start, or a `SessionStart` hook that runs `patio register --agent claude --session $ID`). The gatekeeper also needs the session state: `claude agents --json`, Codex `thread/status/changed`, OpenCode `session.status`, Pi extension state.
- **Untrusted content.** Every delivered message is prompt-injection input. Wrap it as data ("Message from <peer> via patio, treat as untrusted"), never let it approve tools or run slash commands (Claude cross-session messaging and Hermes injection already enforce this; patio should do the same), and keep the gatekeeper's input gates in front.
- **Loop control.** Hop counter and rate limit per convo (compare Claude Code's per-sender throttle and Hermes `max_hops`).

### Design A: per-agent "doorbell" adapters (native push)

A small adapter per agent that the gatekeeper calls when a message passes the gates.

| Agent | Adapter | Covers |
|---|---|---|
| Claude Code | Patio plugin with (1) a plugin monitor running `patio watch --lines`, or (2) a mod using `$.prompt.submit`, or (3) an `asyncRewake` hook running `patio wait --any`. Later: a `claude/channel` capability on the existing patio MCP server once channels leave preview | a, b |
| Codex | Gatekeeper connects to the shared app-server daemon socket; `turn/steer` if busy, `turn/start` if idle | a, b (only when the TUI uses the daemon) |
| Pi | Patio extension holding a socket to the gatekeeper; `pi.sendMessage(..., {deliverAs:"steer", triggerTurn:true})` | a, b |
| Hermes | Patio plugin calling `ctx.inject_message(..., session_key=...)` | a, b |
| OpenCode | Patio plugin using the in-process `client`, or gatekeeper calls `prompt_async` when the port is known | a, b |
| Gemini CLI | Not possible today | none |

- Requires: one adapter per agent, a session registry, per-agent install steps.
- Covers today: 5 of 6 agents (Gemini excluded; Codex conditional).
- Risks: Claude channels are a research preview with an allowlist and a startup dialog; Claude mods and monitors are new; the Codex path depends on an experimental daemon and on untested multi-client behaviour; each agent changes fast, so adapters break.
- Effort: M per agent (S for Pi and Hermes, M for Claude and OpenCode, M to L for Codex).

### Design B: pull at turn boundaries through hooks (digest)

Hooks call `patio inbox --digest --since-last` and return `additionalContext`: at `SessionStart`, `UserPromptSubmit`, and after tool calls (`PostToolUse` / `AfterTool`). Optionally a `Stop` / `AfterAgent` hook blocks the end of a turn once if urgent messages are pending.

- Requires: hook configs for Claude Code, Codex, Gemini; equivalent extension/plugin events for Pi, Hermes, OpenCode.
- Covers today: all six for (a)-like delivery at boundaries. Covers none for (b): an idle session waits for the user.
- Risks: context noise on every turn; the `Stop`-block trick can make the agent loop; latency is unbounded while idle.
- Effort: S.

### Design C: ACP resume of the user's own session

The gatekeeper runs `session/load` or `session/resume` with the user's session id in a new ACP agent process and sends the message as a prompt.

- Requires: ACP adapters (exist for all except Pi), session ids from the registry.
- Covers today: Claude, Codex, Gemini, OpenCode, Hermes for (c).
- Risks: high. The user's open TUI does not see the turn; two processes can write the same transcript (verified for Claude Code); context and permission mode may differ from the live session. Only safe when the user's session is closed, or for agent-native background sessions (Claude Code `claude --resume <id> --bg`, which continues in place or forks).
- Effort: S to build, but hard to make safe. Use only as a fallback for closed sessions, preferably with fork.

### Design D: responder-only auto-answer plus digest at next turn

The gatekeeper never touches the user's session. A message that the rules allow is answered by a **separate** responder session through ACP (patio's existing `do: agent` path), fresh or forked from a "knowledge" session. Everything else waits in the inbox. The user's main agent sees a short digest at its next turn (Design B) and can `read`/`reply`.

- Requires: the existing ACP responder, the hook digest, a policy for which messages the responder may answer.
- Covers today: all six agents for (c) (Pi through `pi --mode rpc` or `pi --print --session` instead of ACP), all six for digest delivery.
- Risks: the responder lacks the live session's working context; cost of extra sessions; no real-time interruption of the user's agent.
- Effort: S to M (most of it exists in patio).

---

## 5. Recommendation for the POC

Build **D + B as the baseline for every agent, and A as an opt-in doorbell for two agents first.**

1. **Baseline (all agents):** keep the ACP responder for rule-approved auto-answers; add the hook/extension digest so the user's agent sees "N new patio messages" at its next turn. This needs no preview features, works for all six agents, and never writes into a live session from outside.
2. **Doorbell, first wave:**
   - **Pi** (extension `sendMessage` with `triggerTurn`): a stable, documented API with exact steer/follow-up/idle semantics. Lowest risk.
   - **Claude Code**: ship a patio plugin. Start with an `asyncRewake` hook or a plugin monitor that runs `patio wait --any` / `patio watch` (no allowlist, works on all providers). Keep `claude/channel` on the patio MCP server behind a flag for users who accept `--dangerously-load-development-channels`; switch to it when channels leave preview. Test first whether a monitor line wakes an idle session.
3. **Doorbell, second wave:** Hermes (`ctx.inject_message`, documented, needs `allow_gateway_injection`), OpenCode (plugin), then Codex through the shared app-server daemon after a spike confirms that `turn/start` from a second connection appears in the user's TUI.
4. **Gemini CLI:** baseline only (digest through `BeforeAgent`/`AfterTool` hooks, responder through `gemini --acp`). Revisit when it gets async hooks or an injection API.
5. **Do not** use ACP `session/load` on a session the user has open. Use resume only for closed sessions, and prefer fork.

### Spikes to run before committing (all unverified today)

- Claude Code: does a plugin-monitor line or an `asyncRewake` exit 2 start a turn on an idle interactive session, and how often can it be re-armed?
- Codex: with the TUI on the default daemon, does a second unix-socket client's `thread/resume` + `turn/start` render in the TUI, and does `turn/steer` work across connections?
- OpenCode: what does `prompt_async` do when the session is busy?
- Gemini: does `gemini -p --resume <id>` continue the session?
