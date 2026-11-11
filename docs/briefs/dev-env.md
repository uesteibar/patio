# Brief: development and verification environment for the POC

Owner: Tenex (coordinator). Implementer: Pi.

## Goal

Build the local environment that lets agents develop and verify the agent-exchange POC without a human. The environment must run real patio processes (relay, daemons, CLI, MCP) in isolated instances, use deterministic test doubles by default, and offer budgeted live smokes. This task builds the environment only. Do not build POC features (gates, grants, inbox, channels, identity, web app).

Read first: `AGENTS.md`, `CLAUDE.md`, `README.md`, `docs/poc/execution.md`, `src/`, `test/e2e.test.ts`.

## Outcomes

1. `just setup` installs project dependencies through mise and Bun. It is safe to run twice.
2. `just doctor` is read-only. It prints JSON with the state of each prerequisite: Bun version, Codex CLI login state, Chromium and Playwright, presence (never value) of `TYPESAFE_API_KEY` in the main checkout's `.env` (see `AGENTS.md`), and the budget left. Exit code 0 when everything for deterministic checks is present, a distinct non-zero code otherwise.
3. `just check` runs the typecheck and the full test suite. No network calls to paid services.
4. Isolated instances.
   - `just up <agents...>` creates `.dev/instances/<id>/`, starts a relay on a free port and one daemon per agent, each with its own `PATIO_HOME` and token. It writes `manifest.json` with revision, dirty flag, ports, sockets, PIDs and homes, and prints the instance id.
   - `just cli <id> <agent> -- <patio args>` runs the real patio CLI as that agent.
   - `just down <id>` stops only the PIDs in that manifest.
   - It refuses `~/.patio` and any home outside the instance root. Two instances can run at the same time.
5. Scenario runner. `just scenario <name>` starts a fresh instance, runs a scripted scenario through the real CLI processes, checks expectations and writes a transcript. Include at least these scenarios:
   - the upstream PR question flow (a question, a `run` rule answers it, the asker receives the reply);
   - an offline recipient (exit code 3);
   - the responder through a fake ACP agent (outcome 6) that tries to read a file and to edit one: the read succeeds and the edit is refused.
6. Fake ACP agent under `test/fakes/`. It speaks ACP over stdio with `@agentclientprotocol/sdk`, follows a fixture (reply text, tool calls to attempt, permission requests) and logs what it was offered and which permission answers it received. Patio must reach it through an `agent` rule with a custom command.
7. Fake Jev under `test/fakes/`. It is a local HTTP server that implements the request and response shape of TypeSafe `POST /v1/systemone` (see https://docs.typesafe.ai/llms.txt and the API reference) closely enough for `@typesafe-ai/sdk` to talk to it, driven by a fixture of answers per question id. If the SDK cannot point at another base URL, document that and provide the fake as a plain HTTP double. Add `@typesafe-ai/sdk` as a dependency.
8. `just mcp-probe <id> <agent>` starts `patio mcp` for that agent and uses a generic MCP client (the MCP SDK client, not a specific agent) to list tools and call `who`. Output is JSON.
9. `just browser-check` launches headless Chromium through Playwright, loads a local page and saves a screenshot under `.verify/`. This proves readiness for the later web app.
10. Live smokes. They are opt-in, require the `--yes-live` flag and decrement `.dev/budget.json` (limits in `docs/poc/execution.md`). They refuse to run when the budget is spent.
    - `just smoke-acp --yes-live`: fresh instance; Bob's rule starts Codex through the patio `codex` preset (`codex-acp`) with model GPT-6-Luna at low effort and `permissions: read-only`, with `cwd` set to a throwaway sandbox repo under `.dev/sandbox/` that contains a known fact. Alice asks a question that needs that fact and also asks Bob's agent to create a file. Pass when the reply contains the fact and the file does not exist. Find how to select the model and effort without changing `~/.codex` (CLI flags, ACP session config, `CODEX_HOME` pointing to an instance-owned copy that is NOT a copy of auth files). If that is not possible without touching global config or copying credentials, stop and report instead.
    - `just smoke-jev --yes-live`: sends one benign message and one prompt-injection message to Jev with a few Noul questions, records answers and latency. Exit code 2 with a clear message when the key is absent.
11. `just verify [--live]` runs doctor, check, all scenarios, mcp-probe and browser-check, plus the live smokes when `--live` is given. It writes `.verify/<timestamp>-<short-rev>/summary.md` and `manifest.json` with revision, dirty flag, each command, exit code, duration, dependency versions and a label (deterministic or live) per result. Exit code non-zero if any required check fails.
12. `docs/dev/verification.md` documents every recipe, the isolation rules and how to read the evidence. Add `.dev/` and `.verify/` to `.gitignore`.

## Constraints

- Prefer scripts and tests over changes to `src/`. If a change to `src/` is needed (for example, to pass a port or a home explicitly), keep it minimal, cover it with a test and say why in the commit message.
- Keep all 15 upstream tests passing.
- Codex smoke: at most 3 runs during this task. Do not run the Jev smoke if the key is absent; that is expected.
- Do not change global configuration or credentials. Do not copy `auth.json` or similar files.
- Commit as you go on `poc` with `git commit -- <paths>`. Never push.
- Do not ask for a go between outcomes. Stop only on a real blocker and say exactly what it is.

## Report

When done, report: commits, recipes and what each one exercised, the real result of `just verify` (paste the summary), the codex smoke result and how many runs it used, what is a test double versus live evidence, and what remains unverified.
