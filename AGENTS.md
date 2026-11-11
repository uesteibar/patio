# AGENTS.md

This fork of patio is the base for the agent-exchange POC. Upstream is `ppazosp/patio` (remote `upstream`, push disabled). Read `CLAUDE.md` for Bun conventions. These rules apply to every agent that works here.

## Branch and commits

- Work only on the `poc` branch, in this worktree (`worktrees/poc`).
- Commit as you go, in small commits with clear messages. Commit only the files of your task: `git commit -- <paths>`.
- Never push. Never add or change remotes. Never edit `main`.

## Toolchain

- Bun is pinned in `mise.toml`. Run commands through `mise exec --` or a shell where mise is active.
- Recipes live in the `justfile`. Prefer a recipe to an ad hoc command when one exists.
- Do not install tools globally. Do not change global configuration (`~/.codex`, `~/.claude`, `~/.pi`, shell files). Project dependencies go in `package.json`.

## How to work

- Use TDD for behavior changes: write a failing test for the behavior, make it pass, then refactor.
- Test behavior that matters. Do not test constants, framework behavior or implementation details.
- Keep the upstream test suite green. If an upstream test must change, say why in the commit message.
- Keep the change small. Do not add abstractions that the current task does not need.

## Isolation

- Every run uses its own instance root under `.dev/instances/<id>/` (gitignored). Each agent there has its own `PATIO_HOME`.
- Never use `~/.patio` or any home outside an instance root. Ask the OS for free ports (port 0) and read them from the instance manifest.
- Stop only processes that the instance manifest owns.
- Set `PATIO_NO_NOTIFY=1` in all tests and scripts.

## Paid and live calls

- `just check` and `just verify` without `--live` must not make network calls to paid services.
- Live smokes are opt-in recipes with a budget counter in `.dev/budget.json`. Respect the budget in `docs/poc/execution.md`.
- Secrets live in the main checkout's `.env` (`/home/devbox/code/uesteibar/patio/.env`, resolve it as the parent of `git rev-parse --path-format=absolute --git-common-dir`). `just worktree <name>` copies it into each new worktree, mode 600; it is gitignored there too. `bunfig.toml` sets `env = false`, so Bun loads it nowhere: `just check`, `just verify`, every test and every non-live script run without its values (`test/dev/env-isolation.test.ts` fails if a test process sees one). Live recipes read the keys they need explicitly. Never print, log or commit a secret, and never copy `.env` anywhere else. Report only whether a secret is present.
- Test doubles (fake ACP agent, fake Jev) are not live evidence. Label results as deterministic or live.

## Verification

- Before you report a task done, run `just verify` and read its summary under `.verify/`.
- Report what you ran, the real exit codes and outcomes, and what remains unverified.
- See `docs/dev/verification.md` for the full recipe list.
