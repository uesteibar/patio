# Brief: increment 3, channels as broadcast, and DMs

Owner: Tenex (coordinator). Implementer: Pi. Authorized by Unai on 8 Nov 2026, with autonomous chaining.

Read first: `docs/poc/proposal.md` (sections 2.2, 2.9, 4.3), `docs/poc/plan.md` (increments 3 and 5), `docs/poc/execution.md` (increment 2 acceptance) and the current code.

## Outcome

An agent asks a channel. Each member agent can answer once, the answer hangs from the broadcast, and nobody answers an answer. Humans read channels and DMs in the web app without writing.

## Scope

1. Channels inside a workspace. A member creates a channel and owns it. Agents join by request (CLI `join`, MCP `join_channel`); the agent's owner approves in the web app. Private channels also need the channel owner's approval.
2. Explicit workspace membership for agents: an approved agent is no longer implicitly in all of its owner's workspaces. It asks to join a workspace, and its owner approves. This closes the gap noted in increment 2.
3. Broadcast. `ask --channel <name>` (and the MCP equivalent) sends one message to every member agent, encrypted for each recipient device as today.
4. One reply per agent. A reply to a broadcast names the broadcast; the sender's gatekeeper and every member's gatekeeper keep at most one reply per agent per broadcast and drop extras. A reply to a reply is refused by the CLI and MCP, and dropped by gatekeepers.
5. A `reply` never starts an agent, in channels or DMs. Keep the current responder path working for `question` and `request` until increment 5 replaces it.
6. `wait` on a broadcast returns the replies that arrived within the timeout, with the sender of each.
7. Web app: a read-only view of channels (broadcasts with their replies) and DMs. No compose box.
8. Re-check membership at delivery time, so messages queued before a revoke or a channel leave are not delivered.

## Visual direction

Same as increment 2: light, grayscale with one gray accent, minimal, app-like, with real empty and loading states. Threads should read clearly: the broadcast, then its replies indented or grouped under it.

## Exit gate

- Scenarios: broadcast with three agents and replies from two; a second reply from the same agent is dropped; a reply to a reply is refused; an agent that is not a channel member receives nothing; revoke between queue and delivery.
- Browser check of the channel view with a broadcast and its replies; screenshots under `.verify/`.
- `just verify` passes. Docs and README updated.

## Constraints

- Work on `poc`, commit as you go with `git commit -- <paths>`, never push.
- TDD for behavior changes. Keep the change as small as the outcome allows.
- No paid live calls in this increment. The Codex build budget has 3 runs left; leave them for increments 5 and 6.

## Report

Commits, scenarios added, the `just verify` summary, screenshots, protocol changes, and what remains unverified.
