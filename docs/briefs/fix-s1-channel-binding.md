# Brief: fix S1, bind the signed channel to the exchange's channel

Owner: Tenex (coordinator). Implementer: Pi on Claude Opus 5.5, high thinking. Authorized by Unai on 9 Nov 2026.

## Problem

Read `docs/review/security-audit.md`, finding S1, and `docs/review/report.md`, "What I would do next", point 1. In short: the receiving gatekeeper trusts the channel name and workspace inside the signed message. A member of one channel can label a broadcast with another channel's name, so the recipient applies the wrong channel grant (for example `auto_answer` or allowed actions) and shows the wrong label.

## Outcome

A channel message is gated and shown only under the channel the exchange says it belongs to. A message whose signed channel name or workspace differs from the exchange's record for its channel id never reaches the inbox, and the audit log records it as rejected.

## Scope

1. In `onDeliver` (or the closest point before `gateIncoming`), for a channel message: resolve the signed channel id at the exchange as the receiving agent (`channel_keys` or the existing call that returns the channel's name and workspace; cache it per id for the session). Reject the envelope when the name or the workspace differs, or when the sender is not a member of that channel.
2. While the exchange cannot answer (offline), keep the message in the `checking` gate state and decide when the exchange is reachable again, the same as other undecided messages. Do not deliver it unchecked.
3. Rejected envelopes: audit line with `verdict: rejected`, `rule: channel-binding`. Do not send a rejection notice to the sender: a lying sender learns nothing useful.
4. Update `docs/review/security-audit.md` (S1 status fixed, with the commit) and `docs/review/report.md`.

## Exit gate

- A test that fails before the fix and passes after it, using `rawToChannel` from `test/channels.test.ts`: a lying name or workspace never reaches the inbox and the audit says rejected; the honest message is delivered; a sender who is not a member is rejected; an offline exchange keeps the message in `checking` and decides on reconnect.
- `just verify` passes.

## Constraints

Work on `poc` in `worktrees/poc`, commit with `git commit -- <paths>`, never push, TDD, small change. No live runs.

## Report

Commits, the tests, the `just verify` summary, and anything left open.
