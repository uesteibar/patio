# Brief: increment 1, persistent exchange, inbox and E2E

Owner: Tenex (coordinator). Implementer: Pi. Authorized by Unai on 8 Nov 2026, with autonomous chaining.

Read first: `AGENTS.md`, `docs/poc/proposal.md` (sections 2, 4.1 and 6.2), `docs/poc/plan.md` (increment 1), `docs/dev/verification.md`, and the current `src/`.

## Outcome

A message reaches an agent that is offline when it is sent. The exchange only stores ciphertext.

## Scope

1. Exchange. Turn the relay into an exchange with a store-and-forward mailbox in SQLite (`bun:sqlite`). It delivers queued messages when the recipient connects, and deletes them after the recipient acknowledges. Keep the relay's sender stamping: the exchange sets `from` from the authenticated connection.
2. Device keys. Each gatekeeper creates a device keypair on first start, in its `PATIO_HOME`, with private file permissions. The exchange keeps a directory of public keys per handle.
3. Encryption. Each message is encrypted for each recipient device with sealed boxes and signed by the sender device. Use a maintained library (check the registry for the current version and say which one you chose and why). The exchange can route on the envelope (recipient, message id, conversation id) but never sees text or context.
4. Inbox. The gatekeeper keeps a persistent inbox. CLI and MCP get `inbox` (list, with unread state) and `read`. `ask`, `reply` and `wait` keep working; `ask` to an offline agent is queued instead of failing.
5. Identity stays on the current development tokens. Do not build GitHub, workspaces or channels yet.
6. Keep the responder behavior from `docs/briefs/responder-unattended.md`.

## Exit gate

- Scenarios (`just scenario`): offline delivery (send, then start the recipient, then receive); restart of the exchange with queued messages; restart of a gatekeeper with unread inbox items.
- A test that reads the exchange database after traffic and finds no plaintext from the messages.
- A test that a tampered or wrongly signed envelope is rejected.
- `just verify` passes. Update `docs/dev/verification.md` and the README where behavior changed.

## Constraints

- Work on `poc`, commit as you go with `git commit -- <paths>`, never push.
- TDD for behavior changes. Keep the change as small as the outcome allows.
- No paid live calls are needed in this increment.

## Report

Commits, scenarios added, the `just verify` summary, the library choices, what changed in the protocol, and what remains unverified.
