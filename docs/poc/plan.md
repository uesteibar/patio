# POC increment plan

Source of truth for the product: `docs/poc/proposal.md` (approved 8 Nov 2026). This file splits the POC into increments with exit gates. Unai authorized autonomous chaining on 8 Nov 2026: the coordinator starts the next increment when the previous exit gate passes, and stops only on real blockers.

Each increment ends with `just verify` passing, new scenarios for the new behavior, the coordinator's independent check and a short entry in `docs/poc/execution.md`.

## Increment 1: persistent exchange, inbox and E2E

Outcome: a message reaches an agent that is offline when it is sent, and the exchange only stores ciphertext.

1. The relay becomes the exchange: store-and-forward mailbox in SQLite (`bun:sqlite`), delivery and acknowledgement when the recipient connects.
2. Device keys in each gatekeeper. Each message is encrypted for each recipient device with sealed boxes and signed by the sender device.
3. Persistent inbox in the gatekeeper. CLI and MCP: `inbox`, `read`, `ask`, `reply`, `wait`. `ask` to an offline agent no longer fails.
4. Identity stays on development tokens in this increment.

Exit gate: scenarios for offline delivery, restart of the exchange and of a gatekeeper without message loss, and a test that reads the exchange database and finds no plaintext.

## Increment 2: GitHub identity, workspaces and the local web app

Outcome: an admin invites `@jorge`, Jorge signs in with GitHub, and his agent gets an identity after Jorge approves it in the web app.

1. GitHub OAuth in the exchange, with a fake GitHub provider for tests. Device flow for headless machines.
2. Workspaces, invites by GitHub handle, roster, admin notice with fingerprint and revoke.
3. Agent identity request from CLI and MCP; approval only in the web app.
4. Local web app served by the gatekeeper: sign-in, pending approvals, workspace members.

Exit gate: scenarios with the fake GitHub provider for invite, join, agent request and approval, and a browser check of the approval flow. No MCP or CLI command can approve.

Owner-only step, scheduled last: Unai creates a GitHub OAuth app for the live check.

## Increment 3: channels as broadcast, and DMs

Outcome: an agent asks a channel, each member agent can answer once, and nobody answers an answer.

1. Channels with membership requests (agent asks, owner approves).
2. Broadcast messages and one reply per agent, attached to the broadcast.
3. A `reply` never starts the responder, in channels or DMs.
4. Humans read channels and DMs in the web app, without writing.

Exit gate: scenarios for broadcast with three agents, the one-reply rule and the no-reply-to-reply rule.

## Increment 4: grants and gates with Jev

Outcome: what comes in and what goes out passes the owner's grant, and doubtful cases reach the owner as approval cards.

1. Grants in YAML: structured rules and natural-language rules (allow, deny, posture).
2. Input gate: structured rules, then Jev (injection and denied topics), then a verdict: deliver, ask the human, refuse with a reason, or quarantine.
3. Output gate: deterministic DLP (secrets, local paths, personal data), then Jev (denied topics and posture).
4. Approval cards in the web app, and an audit log.

Exit gate: deterministic scenarios with the fake Jev for each verdict, and a budgeted live run with real Jev on a small fixed set of benign and malicious messages.

## Increment 5: inbox consumption from the CLI

Unai's decisions (8 Nov 2026): for the POC, the only wake-up path is the owner's agent started to answer a message (proposal section 2.8, layer 1). The gatekeeper itself never starts an agent: it receives, gates and stores. The CLI gives primitives to consume the inbox, and each user decides when to run them (cron, a service, a script).

Message states:

| State | When | Shown by `patio inbox` |
|---|---|---|
| `unread` | Passed the input gate | Yes |
| `read` | Shown by `patio read` | Yes |
| `claimed` | `answer` took it. The claim is a lease that expires if the process dies | Yes, marked |
| `answered` | The reply was sent | Only with `--all` |
| `dismissed` | Closed with `dismiss`, without a reply | Only with `--all` |
| `failed` | The agent failed or the output gate blocked the reply, with the reason | Yes, so it can be retried |
| `rejected` | The input gate rejected it, with the reason (the sender also gets the reason) | Never by default. Only with `--rejected` |

CLI surface:

| Command | Behavior |
|---|---|
| `patio inbox [--all] [--rejected] [--json]` | List messages with id, sender, kind and state |
| `patio read <id>` | Show the full message and mark it `read` |
| `patio answer <id> [--agent codex\|claude\|<cmd>] [--cwd <dir>]` | Claim the message, start the owner's agent with its normal setup through ACP, pass the reply through the output gate, send it and mark the message `answered`. Distinct exit codes for already claimed, blocked by the gate and agent failure |
| `patio dismiss <id>` | Mark the message `dismissed` |
| `patio watch [--once] [--json]` | Emit each new message as one JSON line. `--once` processes what is pending and exits, for cron |
| `patio watch --answer` | Run `answer` for each message whose grant allows auto-answer |
| `patio watch --exec <cmd>` | Run the command for each message, with the message as JSON on stdin, never interpolated into the command line |

Rules:

1. patio's `agent` and `run` rules leave the daemon. `watch --answer` replaces `agent` and `watch --exec` replaces `run`. One path, no compatibility layer.
2. The grant has an `auto_answer` flag per contact and channel; `watch --answer` respects it. An explicit `answer <id>` is always allowed.
3. Default agent and working directory are gatekeeper configuration, with overrides per workspace or channel. Command flags override configuration.
4. MCP tools: `inbox`, `read`, `ask`, `reply`, `wait`, `dismiss`. `answer` and `watch` are CLI only, so an agent cannot start other agents.
5. In a channel, the claim guarantees that each gatekeeper answers a broadcast at most once.

Exit gate: scenarios with the fake ACP agent for `answer`, double-claim from two consumers, lease expiry after a crash, `watch --once --answer` with `auto_answer` on and off, `watch --exec` with the message on stdin, `dismiss`, and `rejected` hidden by default; one budgeted live run of `watch --once --answer` with Codex on GPT-6-Luna low.

## Increment 6: end-to-end dogfood

Outcome: the PR question from the proposal works end to end with real agents, and an adversarial run shows what the gates stop.

1. Live scenario: Alice's agent asks Bob's agent about a PR through a DM and through a channel. Bob's responder is Codex on GPT-6-Luna at low effort.
2. Adversarial run: injection attempts against the responder, with and without the input gate.
3. Evidence summary for Unai.
