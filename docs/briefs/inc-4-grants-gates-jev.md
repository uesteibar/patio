# Brief: increment 4, grants and gates with Jev

Owner: Tenex (coordinator). Implementer: Pi. Authorized by Unai on 8 Nov 2026, with autonomous chaining.

You start in a fresh session. Read first: `AGENTS.md`, `docs/poc/proposal.md` (sections 2.4, 2.5, 2.7, 4.3), `docs/poc/plan.md` (increments 4 and 5), `docs/poc/execution.md`, `docs/dev/verification.md`, `README.md`, then the code in `src/` and `scripts/`. Jev docs: https://docs.typesafe.ai/llms.txt (Noul questions, routing by probability, the "Guardrails for LLMs" cookbook). The Jev client already exists in `scripts/lib/jev.ts`, including the fetch workaround that `@typesafe-ai/sdk` 0.7.0 needs under Bun.

## Outcome

What comes in and what goes out passes the owner's grant. Doubtful cases reach the owner as approval cards in the web app, and the sender of a rejected message gets the rejection with a reason.

## Scope

1. Grants file `grants.yaml` in each gatekeeper's home, with the shape in proposal section 2.5: `defaults` (kinds, per_day, on_doubt), `contacts` keyed by agent identity, `channels` keyed by channel name. Structured fields: `kinds`, `per_day`, `on_doubt` (`ask-human` or `reject`), `auto_answer` (stored now, used in increment 5). Natural-language fields: `allow`, `deny`, `posture`. Invalid files fail with a clear error, in line with the existing rule about settings that would be silently ignored.
2. Input gate, in the receiving gatekeeper, after decryption and before the inbox:
   - structured rules (kind, per-day limit);
   - one Jev request with Noul questions: prompt injection, one question per `deny` entry ("does the message ask for information about <topic>?"), and, when `allow` is set, whether the message stays within the allowed topics;
   - verdict by thresholds in code (defaults: reject at 0.9 or more, ask the human from 0.5, deliver below; configurable in `grants.yaml`): deliver, ask the human (message held until the owner decides), or reject.
   - A rejected message is stored with state `rejected` and the reason, and the sender receives a rejection. The reason names the category (for example "asks about a denied topic", "looks like prompt injection", "kind not allowed"), never the text of the owner's deny rule, which would leak private information.
3. Output gate, in the sending gatekeeper, for `ask` and `reply` before encryption:
   - deterministic DLP: secrets and tokens, absolute local paths (the live Codex runs leaked one as a Markdown link), and email addresses and phone numbers;
   - one Jev request: one question per `deny` entry ("does the text reveal information about <topic>?") and one per `posture` entry ("does the text follow: <posture>?");
   - verdict: send, ask the human with the draft, or block. DLP matches on paths and secrets block or go to the human; do not rewrite text silently.
4. Approval cards in the web app for both gates: who, what, which grant rule, the Jev probabilities, and the draft for outgoing messages. Actions: approve once, edit (outgoing only) and reject. "Approve always for this contact" is out of scope.
5. Fail closed: if Jev is not configured or fails, the gate treats the message as doubtful (ask the human), never as clean.
6. Audit log: one JSON line per gate decision in the gatekeeper home, with message id, direction, rule, probabilities and verdict.
7. In channels, the input gate applies the channel's grant; the output gate for a broadcast or a reply in a channel applies the channel's grant.
8. Jev credentials: the gatekeeper reads `TYPESAFE_API_KEY` from its environment. Dev instances pass it only in live recipes, from the main checkout's `.env`; deterministic runs use the fake Jev from `test/fakes/`.

## Exit gate

- Deterministic scenarios with the fake Jev: deliver, ask the human then approve, ask the human then reject, reject on injection, reject on a denied topic (the sender sees the category, not the topic text), output blocked by DLP on a local path, output held for posture and approved with an edit, Jev unavailable leads to ask the human.
- Browser check of input and output approval cards, with screenshots under `.verify/`.
- `just smoke-gates --yes-live`: a fixed set of about 12 messages (benign questions, prompt injections, denied-topic requests, a reply that breaks a posture, a reply with a local path) through real Jev, with a table of probabilities and verdicts. Budget: Jev at most 300 requests per day; the recipe counts and refuses past the budget.
- `just verify` passes. Docs and README updated.

## Constraints

- Work on `poc`, commit as you go with `git commit -- <paths>`, never push.
- TDD for behavior changes. Keep the change as small as the outcome allows.
- Do not use Codex runs in this increment.
- Keep the web app's visual language from increments 2 and 3.

## Report

Commits, scenarios added, the `just verify` summary, the live Jev table with your reading of the thresholds, screenshots, and what remains unverified.
