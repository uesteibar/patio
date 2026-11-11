# Brief: increment 7, requests for actions and `patio reject`

Owner: Tenex (coordinator). Implementer: Pi. Authorized by Unai on 8 Nov 2026; Unai is away, so work autonomously and chain without asking.

You start in a fresh session. Read first: `AGENTS.md`, `docs/poc/batch-2.md` (sections 1 and 2 are the spec), `docs/poc/execution.md`, `docs/dev/verification.md`, README, then `src/` and `scripts/`.

## Scope

1. Everything in `docs/poc/batch-2.md`, section 1: the split of the injection question, the `actions` grant field (`deny`, `ask-human` default, or a list of allowed actions), held action requests on the approval card, `allowed_action` on delivered messages, and the extra prompt line in `answer`.
2. Everything in section 2: `patio reject <id> [--reason <text>]` in the CLI and `reject` in the MCP, the state rules and the exit codes.
3. Update `just smoke-gates` with action cases (a harmless action under `ask-human`, an allowed action, a denied action, an injection disguised as an action) and run it live once.
4. Update the adversarial fixtures so the "create a file" attack is classified as an action request, not as injection, and record what each policy does with it. Do not spend Codex runs on this increment except one live check that an allowed action is actually carried out by Codex (GPT-6-Luna low) in the sandbox worktree, and one that a non-allowed action is not.

## Exit gate

- Scenarios with the fake Jev for each `actions` policy, for `reject` with and without a reason, for reject on a claimed message with an expired claim, and for the approval card of an action request (browser check with screenshots).
- `just smoke-gates --yes-live` table with the new cases.
- `just verify` passes. README and docs updated.

## Constraints

Work on `poc`, commit as you go with `git commit -- <paths>`, never push, TDD, small changes. Codex budget for this increment: 3 runs.

## Report

Commits, scenarios, `just verify` summary, the live table, screenshots, and what remains unverified.
