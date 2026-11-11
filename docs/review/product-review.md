# Product review: the POC after batch 2

Reviewer: Pi worker on `poc-review` (brief `docs/briefs/review-and-security-audit.md`). Reviewed at `50e0f06` on `poc`
(increments 1 to 9 accepted, increment 10 up to `service install`; the Activity page landed later and is not
repeated here). The loop is the one the coordinator used for batch 2: what works, what is hard, which corner cases
are open, which concepts are unclear, ranked by impact on a new user and on reliability; then the improvements I
propose to implement, each with the problem, the change and the check. Improvements that batch 2 already made (1 to
10) or that increment 10 is finishing (Activity page, `status`, `service install`) are not proposed again.

## What works

- The whole path from the proposal is real and tested: offline delivery through a ciphertext-only exchange,
  GitHub-backed identity, pairing and approvals only in the web app, channels as broadcasts with one reply per
  agent, grants with structured and natural-language rules, both gates with Jev and DLP, consumption from the CLI,
  the responder in a disposable worktree, key pinning, expiry, outbox, hot reload, `init` and `status`.
- The deterministic harness is unusually good: 50-plus scenarios through real processes, fakes for GitHub, Jev and
  the responder, instance isolation, evidence under `.verify/`. A reviewer can trust `just verify`.
- The security posture is explicit and mostly correct: sign-then-seal, approval only from a human session, fail-closed
  gates, 0600 files, no text in the audit log. The audit found one high finding (S1) and three cheap mediums; see
  `docs/review/security-audit.md`.
- `patio init`, `grants test`, the commented `grants.yaml` and the exit codes of `answer`/`reject` make the CLI
  scriptable and self-explaining.

## What is hard to use or to understand

Ranked by impact on a new user (U) and on reliability (R).

1. **(U, R) A channel message carries the channel name the sender wrote.** `patio inbox`, the cards, the audit log and
   the grant lookup use `message.channel.name`, which is signed by the sender and not checked against the exchange.
   That is security finding S1, but it is also a product problem: the owner cannot trust the `#backend` label.
2. **(U) The approval card for an incoming message hides its context.** `ask --repo --pr --files` context reaches the
   agent's prompt and Jev, but `HeldCard` has no `context` field, so the owner decides on text alone. For the
   reference case ("does PR 812 change the schema?") the PR number is the most useful fact on the card.
3. **(U) Grants fail silently in three ways.** `thresholds: { ask: 1, reject: 1 }` switches the judge off and nothing
   says so; a bare `channels.backend` key matches `backend` in every workspace; `deny` entries in a contact add to the
   defaults (good) but `allow` replaces them, which surprises people who expect the same for both. `grants test`
   shows one message's outcome, not the resolved grants.
4. **(U) Two users on one machine share browser cookies.** Every gatekeeper web app lives on `127.0.0.1:<port>` and
   the cookie name is the same, so signing in to Bob's app signs you out of Alice's. `try-it.md` warns; a cookie name
   that includes the port would remove the trap. (Cheap; not proposed below because `try-it` already works around it
   and the fix touches the browser scenarios.)
5. **(U) The Approvals page does not refresh.** The setup page polls; the Approvals page, where the owner waits for a
   card, does not, and a card that arrives while the page is open is invisible until a reload. A meta refresh while a
   card is pending and no textarea is being edited would do; an outgoing card with an edited draft must not reload.
6. **(R) A rejected or expired outgoing draft tells the sender nothing.** When Bob's owner rejects the draft of Bob's
   reply (or it times out), Bob's message goes back to `failed` and Alice's `wait` only times out. She learns nothing
   unless Bob answers again or `reject`s. Proposal 2.7 lists "reject" among the four actions; the sender side of it
   is incomplete.
7. **(U) Concepts that need one paragraph each.** Owner vs agent vs device vs gatekeeper; why an agent is an identity
   and not a process; what "held", "not reviewed", "keys changed" and "outbox" mean to the sender; what the sender
   learns on a rejection (the category only). The README has it all, across 650 lines; a short glossary at the top of
   `try-it.md` would save the first ten minutes.
8. **(R) `watch --answer` as a service cannot tell a transient failure from a permanent one.** An agent that fails
   (`agent_failed`) marks the message `failed`, and the next `watch` pass retries it for ever (each pass is a new
   process). A cap or a backoff per message is missing.
9. **(U) `patio who` lists online agents only.** There is no command to see which workspaces and channels this
   gatekeeper's agents are in, or which channels exist to join; the web app has it, the agent does not. The MCP
   `join_channel` tool needs a name the agent can only guess.

## Corner cases still open

- A member of a channel can broadcast to a subset of members (the exchange only refuses stray copies). Honest
  gatekeepers send to all; documented in increment 3.
- Late joiners of a channel do not see earlier broadcasts; one copy per device when a device hosts several members
  (untested); no per-channel rate limit at the exchange.
- Replies in a DM are accepted from any contact who knows the message id (S12); ids are random and sealed.
- `per_day` is counted per contact or channel id, including messages the gate rejected, so a flood of rejected
  messages locks a contact out for the day (arguably right).
- Jev down for longer than `hold_timeout` with `on_timeout: inbox` delivers everything marked "not reviewed";
  `watch --answer` skips those (good), `answer <id>` does not warn.
- Two gatekeepers of the same owner on one machine need separate `PATIO_HOME`s and the browser-cookie trap above.

## Improvements I will implement, in order of impact

| # | Improvement | Problem | Change | Check |
|---|---|---|---|---|
| P1 | Verify the signed channel against the exchange (= S1) | The sender picks the channel grant and label | On delivery of a channel message, look the id up at the exchange as the receiving agent and reject the envelope when the signed name or workspace differs | A raw broadcast with a lying channel name is logged as rejected and never reaches the inbox; the honest one still does |
| P2 | `patio grants check` | Silent misconfigurations (ask=1, bare channel keys, allow-replaces) | A CLI command that prints the resolved grant for every contact and channel key (and the defaults) and warns on: thresholds that can never fire, a bare channel key, `on_timeout: inbox` with `auto_answer`, `actions` as a list with `on_doubt: reject`; exit 0, or 1 with warnings | Unit tests on the warnings and the resolved view; a scenario with the fake Jev is not needed |
| P3 | Context on the incoming card | The owner decides without the repo, PR and files | `HeldCard.context`, shown under the quote as "About: repo · PR · files" | Browser scenario `browser-gates` checks the card shows the PR; unit test on the card builder |
| P4 | Tell the sender when a draft is rejected or expires | The sender's `wait` only times out | When an outgoing reply draft is rejected by the owner or expires, send the original sender a rejection reply with the category `declined by the recipient` (no reason text) so their `wait` ends with "declined"; the original message stays `failed` so the owner can still answer by hand | Scenario: Alice asks, Bob's reply is held, Bob's owner rejects it, Alice's `wait` prints the decline |
| P5 | Retry cap for `watch --answer` | A failing agent is retried for ever by a service | A message that failed `n` times (`max_attempts`, default 3, in `agent.yaml`) is skipped by `watch --answer` with a line that says so; `answer <id>` is always allowed | Scenario: a fake agent that always fails; the fourth pass skips the message |
| P6 | Glossary in `try-it.md` and README safety note | Concepts and what the responder can reach | Eight one-line definitions at the top of `try-it.md`; one paragraph in the README's safety section on what the responder can read (S16) | Structural: the files say what they should |

Not proposed, already covered elsewhere: the Activity page and `status` (increment 10), `grants test` (increment 9),
hot reload and expiry (increment 10). Not proposed, too big for the time: a `patio channels` command (needs an
exchange query), the cookie name per port (touches every browser scenario), the Approvals auto-refresh (needs care
around edited drafts).

## Order of work in Phase 2

Security first (S1/P1, S2, S3, S4, S12, S17), then P2, P3, P4, P5, P6, each as one commit with tests, `just verify`
every few commits, final report in `docs/review/report.md`.
