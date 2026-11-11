# Brief: increment 5, inbox consumption from the CLI

Owner: Tenex (coordinator). Implementer: Pi. Authorized by Unai on 8 Nov 2026, with autonomous chaining.

Read first: `docs/poc/plan.md` (increment 5, which is the spec), `docs/poc/proposal.md` (section 2.8), `docs/poc/execution.md` (increment 4 acceptance), README and the current code.

## Outcome

The gatekeeper never starts an agent. It receives, gates and stores. The CLI gives primitives to consume the inbox (`inbox`, `read`, `answer`, `dismiss`, `watch`), and each user decides when to run them.

## Scope

1. Everything in `docs/poc/plan.md`, increment 5: message states, CLI surface, the rules about `agent` and `run` leaving the daemon (`watch --answer` and `watch --exec` replace them, no compatibility layer), `auto_answer` in the grant, default agent and working directory in gatekeeper configuration with per-workspace and per-channel overrides, MCP tools, and the channel claim.
2. `answer` sends the agent's reply through the output gate. A held reply leaves the message `claimed` until the owner decides; a blocked one marks it `failed` with the reason.
3. Gates always on: when `grants.yaml` is absent, a default grant applies: kinds question, request, heads-up and report; prompt-injection check; `on_doubt: ask-human`; `auto_answer: false`. Update the existing scenarios as needed.
4. Incoming replies get the prompt-injection check only (no topic checks), because they also reach the agent.
5. Remove `rules.yaml` and its actions from the daemon. A `rules.yaml` file that still exists makes the gatekeeper fail to start with a clear message pointing to `grants.yaml` and `patio watch`.

## Exit gate

- The scenarios listed in the plan's exit gate for increment 5, with the fake ACP agent and the fake Jev.
- One live run: `watch --once --answer` with Codex on GPT-6-Luna at low effort answering a question from the sandbox repo, through the real output gate with real Jev. Spend at most 1 Codex run (the build budget has 3 left).
- `just verify` passes. README, `docs/dev/verification.md` and the smoke recipes updated.

## Constraints

- Work on `poc`, commit as you go with `git commit -- <paths>`, never push.
- TDD for behavior changes. Keep the change as small as the outcome allows.

## Report

Commits, scenarios added or changed, the `just verify` summary, the live run's transcript summary, and what remains unverified.
