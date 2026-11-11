# Brief: increment 8, responder matrix

Owner: Tenex (coordinator). Implementer: Pi. Authorized by Unai on 8 Nov 2026; Unai is away, so work autonomously and chain without asking.

Read first: `docs/poc/batch-2.md` (section 3 is the spec), `docs/research/hermes-docker-probe.md`, `docs/poc/execution.md`, the README, and the current dogfood and smoke recipes.

## Outcome

`patio answer` and `patio watch --answer` work with four real responders: Codex, Claude Code, Pi and Hermes in Docker. One live recipe shows, per responder, whether the answer is correct, which tools ran, how long it took, and whether any file changed.

## Scope

1. Responder presets in `agent.yaml`, so a user picks a responder by name instead of writing a command line: `codex`, `claude`, `pi`, `hermes-docker`, plus the existing free-form `command`. Each preset sets the command, the model and the effort. The defaults are the cheapest models:
   - `codex`: `codex-acp` with GPT-6-Luna at low effort, through `CODEX_CONFIG` and no global changes;
   - `claude`: `@agentclientprotocol/claude-agent-acp` (0.101.0 checked on npm) with Claude Haiku 5.5 at low effort. Unai's Claude Code login works on this host (`claude -p ... --model haiku --effort low` answered);
   - `pi`: `pi-acp` (0.0.34 on npm). Check that it works with Pi on this host. If it does not, write a small patio adapter over `pi --mode rpc`, the smaller of the two. Use model `anthropic/claude-haiku-5-5` with low thinking and the default Pi agent dir (`~/.pi/agent`, unset `PI_CODING_AGENT_DIR`). Never the Orbit agent dir;
   - `hermes-docker`: the command in `docs/research/hermes-docker-probe.md`, with the configured directory mounted read-only at `/work`. Use a start timeout of at least 60 seconds.
   Pin the npm adapters' versions in `package.json` as dev dependencies, or run them through `bunx <pkg>@<version>`. Do not install anything globally.
2. `just responders --yes-live [--only <name>]`: one instance; Alice asks Bob the sandbox question from the dogfood (the PR schema question) and one follow-up that needs a file read; Bob answers with each responder in turn through the real gates and Jev. Write `.verify/live/responders-<ts>/table.md` with these columns: responder, model, answer correct (checked by fixed expected facts), tool calls, seconds, file changes in the sandbox (must be none), and errors.
3. Hermes login is not configured: the container has no credentials by design. The recipe must detect "Hermes not logged in" and report it as `skipped: needs login (see docs/research/hermes-docker-probe.md)`, not as a failure. Check that the ACP handshake still works (initialize and session/new) and record that.
4. Document the presets and the Hermes login step in the README and in `docs/poc/try-it.md`.

## Budget

At most 4 Codex runs. Claude Code and Pi: at most 6 runs each, Haiku 5.5 low. Hermes: handshake only, unless a login appears in the volume.

## Exit gate

- `just responders --yes-live` table with Codex, Claude Code and Pi answering correctly with no file changes, and Hermes handshake OK with the prompt skipped for the missing login.
- Deterministic tests for the preset resolution and for the "not logged in" detection.
- `just verify` passes.

## Constraints

Work on `poc`, commit as you go with `git commit -- <paths>`, never push, TDD, small changes. Do not change global configuration of Claude Code, Codex, Pi or Hermes.

## Report

Commits, the responder table, budget used, and what remains unverified.
