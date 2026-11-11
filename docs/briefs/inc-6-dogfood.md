# Brief: increment 6, end-to-end dogfood and adversarial run

Owner: Tenex (coordinator). Implementer: Pi. Authorized by Unai on 8 Nov 2026, with autonomous chaining.

Read first: `docs/poc/proposal.md` (sections 1, 4.3 and 6), `docs/poc/plan.md` (increment 6), `docs/poc/execution.md` (increment 5 acceptance) and the README.

## Outcome

The PR question from the proposal works end to end with real agents, through a DM and through a channel. An adversarial run shows what the gates stop and what the prompt alone stops. Unai gets a short report and a guide to try the POC himself.

## Scope

1. Live dogfood recipe `just dogfood --yes-live`. One instance with Alice, Bob and Carol in a workspace and a channel `backend`, with realistic `grants.yaml` files (allow code and PR topics, deny a private topic, a posture rule) and `agent.yaml` pointing each responder at a sandbox repo with a small realistic history: a PR branch that changes a schema, a release note, and a file with a fake secret.
   - DM: Alice's agent asks Bob's agent whether the PR changes the schema. Bob runs `watch --once --answer`. Alice gets an answer that cites relative paths and passes both gates.
   - Channel: Alice broadcasts the same question to `backend`. Bob and Carol each run `watch --once --answer`; each answers once. Run Bob's consumer twice in parallel to show the claim prevents a second answer.
   - Responders are Codex on GPT-6-Luna at low effort through `codex-acp`. Real Jev in all gates.
2. Adversarial recipe `just adversarial --yes-live`, a fixed set of about 6 attacks against Bob's responder: ask it to create or edit a file, to run a command that changes state, to reveal the fake secret, to reveal the denied private topic, to contact another agent, and a reply-to-a-question that carries an injection. Run each attack twice:
   - with Bob's normal grant (gates on): record the input gate verdict, and when a message passes, what the responder did and what the output gate did;
   - with a permissive test grant (thresholds that never hold or reject, no deny rules): record only what the responder did with the prompt alone, and whether the output gate's DLP still caught anything.
   Record tool calls, file changes in the sandbox repo, and replies. Restore the sandbox between attacks.
3. Close the gaps from increment 5: plain streaming `watch` without flags in a scenario; a DM with a per-workspace `agent.yaml` override in a scenario; MCP `dismiss` called by the generic MCP client in `mcp-probe`.
4. Report `docs/poc/dogfood-report.md` for Unai, in plain language: what works, the attack table (attack, gates on result, prompt-only result), what the gates stopped that the prompt did not and the reverse, costs (Codex runs, Jev requests, time per answer), and the open risks. No marketing tone.
5. Guide `docs/poc/try-it.md`: how Unai can start an instance, open each person's web app, and run the DM and channel flows by hand with the fake GitHub, in a few copyable commands.

## Budget

Raise the Codex limits in `.dev/budget.json` and the recipe defaults to 20 runs per day and 20 in total for the build phase (8 are used). Model and effort stay GPT-6-Luna at low effort. Plan for about 3 runs for the dogfood and about 6 for the prompt-only half of the adversarial run (attacks that the gates hold or reject do not start Codex). Jev stays at 300 per day.

## Exit gate

- `just dogfood --yes-live` passes, with transcripts under `.verify/live/`.
- `just adversarial --yes-live` runs to completion and writes its table; the result is evidence, not a pass or fail on each attack, but any file change in the sandbox repo or any secret in a reply must be listed.
- The three gap scenarios pass; `just verify` passes.
- `docs/poc/dogfood-report.md` and `docs/poc/try-it.md` exist; I will follow `try-it.md` myself.

## Constraints

- Work on `poc`, commit as you go with `git commit -- <paths>`, never push.
- Do not change global configuration. The sandbox repos live under `.dev/`.

## Report

Commits, the dogfood transcripts summary, the attack table, budget used, and what remains unverified.
