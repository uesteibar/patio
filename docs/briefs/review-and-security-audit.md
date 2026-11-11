# Brief: independent review and security audit

Owner: Tenex (coordinator). Reviewer and implementer: a Pi worker on Claude Fable 5.1 with high thinking. Authorized by Unai on 9 Nov 2026. Unai is away; work autonomously and do not wait for answers.

## Hard deadline

The Anthropic allowance ran out at 00:30 CET and resets at 03:00, so the work is split: about 40 minutes before the pause, then a second window that **ends hard at 04:00 CET on 9 Nov 2026**. The coordinator closes your terminal at 04:00 whether or not you have finished. Plan for it:

- Stop starting new changes at **03:40 CET**.
- By **03:55 CET**, everything is committed, `just verify` has passed on your last commit, and your final report is written.
- Check the time with `date` between steps, and work in small commits that each leave the branch verifiable.
- The coordinator already merged `poc` (increment 10, accepted) into `poc-review` and fixed one regression the merge exposed (a rejection notice for the owner's own broadcast was dropped as a wrong sender; commit `4c761b3`). Start from that commit.

## Where you work

- Your worktree: `/home/devbox/code/uesteibar/patio/worktrees/review`, branch `poc-review`, created from `poc`. Commit only there, with `git commit -- <paths>`. Never push. Never commit on `poc` or `main`.
- Another worker is implementing increment 10 on `poc` in `worktrees/poc`. Do not touch that worktree, its instances or its processes.
- The coordinator tells you when increment 10 is accepted on `poc`. Then merge `poc` into `poc-review` (`git merge poc`) before you implement.

## Read first

`AGENTS.md`, `README.md`, `docs/poc/proposal.md`, `docs/poc/plan.md`, `docs/poc/batch-2.md`, `docs/poc/execution.md` (every acceptance and its carried gaps), `docs/dev/verification.md`, `docs/poc/try-it.md`, `docs/poc/dogfood-report.md`, then all of `src/` and `scripts/`.

## Phase 1: review and audit (start now, before increment 10 lands)

Do not change code in this phase. Write two documents, commit them, and keep them current.

1. `docs/review/product-review.md`: the same loop the coordinator used for batch 2. Evaluate the POC as it is: what works, what is hard to use or to understand, which corner cases are open, which concepts are unclear. Rank your findings by impact on a new user and on reliability. Then propose the improvements you will implement, each with the problem, the change, and how you will verify it. Do not repeat improvements that batch 2 already made or that increment 10 is making; read the increment 10 brief.
2. `docs/review/security-audit.md`: a threat model and an audit. Cover at least:
   - Assets: message plaintext, private keys, the owner's files and secrets, approval authority, the TypeSafe key.
   - Actors: a malicious contact or channel member, a compromised or curious exchange, a malicious local process or agent on the owner's machine, a network attacker, a revoked device.
   - Areas to read: crypto and signatures (sealing, verification, replay, ordering, key pinning and its bypasses), identity and pairing (GitHub flow, `state`, redirects, device pairing), the web app (session cookies, CSRF on every state-changing route, origin and host checks, XSS in every place where message text, names, reasons or fingerprints are shown, clickjacking), the local HTTP and MCP surfaces (binding, authentication, who can approve), the agent's credentials versus the owner's authority, the gates (fail-open paths, Jev errors, oversized or malformed input, Unicode and encoding tricks against DLP, threshold edge cases, grant parsing), `answer`, `watch --exec` and the disposable worktree (command injection, path traversal, symlinks, what leaks into the prompt or the environment), the exchange (authorization of every endpoint, rate limits, resource exhaustion, metadata it stores), file permissions of every file the gatekeeper writes, logs and the audit log (secrets or plaintext in them), and dependencies.
   - For each finding: severity (critical, high, medium, low), where it is (`path:line`), how to exploit it, and the fix. Mark each finding as fixed, accepted for the POC (with the reason), or open.

## Phase 2: implement (after increment 10 is merged into your branch)

1. Fix every critical and high security finding. Fix the medium ones that are cheap. Each fix comes with a test or scenario that fails before the fix and passes after it.
2. Implement your product improvements in order of impact, as many as the time allows, each with tests and docs.
3. TDD, small commits, one finding or improvement per commit, with the finding id in the message. Keep the project's style and the web app's visual language.
4. Run `just verify` after every few commits; it must pass on your final commit.

## Budget and live runs

Prefer the fakes. Live runs are allowed only when a change needs them, with the cheapest models: Codex on GPT-6-Luna at low effort, Claude Code or Pi on Claude Haiku 5.5 at low effort. At most 6 responder runs in total. Jev: stay within `.dev/budget.json`. The TypeSafe key lives in the main checkout's `.env`; never copy, print or commit it.

## Report

Write `docs/review/report.md` and print a summary: the findings table (id, severity, status), the improvements made, the commits, the `just verify` result on the last commit, and what you would do next with more time.
