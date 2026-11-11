# Brief: increment 13, a setup that cannot guess wrong

Owner: Tenex (coordinator). Implementer: Pi on Claude Opus 5.5, high thinking. Decisions taken by Unai on 9 Nov 2026 after `/grilling`. Work autonomously and commit as you go.

Read first: `docs/design/agents-and-setup-shape.md` (sections 3, 4, 8), `PRODUCT.md`, `src/join.ts`, `src/connect.ts`, `src/mcp.ts`, `src/service.ts`, `src/invite-page.ts`, `src/webapp.ts`, `README.md`.

## Why

On Unai's Mac, Pi pasted the invite page's prompt and the join ran `--tool claude`. It wrote `.mcp.json` instead of `.pi/mcp.json`, and his new Pi session had no patio. No agent can know which tool it runs in, so the prompt must never ask it and the join must detect it. And a join that ends without proving the tool sees patio is not a finished join.

## Decisions (all nine are settled)

1. `patio join` detects the tool itself. `--tool` stays only as an override and the invite page's prompt does not mention any tool.
2. No skill files are installed. The only teaching surface is the MCP tool descriptions plus a `patio_guide` tool that the others point to.
3. A live coding session is for asking. Incoming messages are handled by the `watch --answer` service or by the person in the app; nothing is injected into an open session.
4. The join configures every coding tool it finds installed, always, and says which.
5. The join verifies that each configured tool really lists patio. A trust or approval step still pending is a failure: print the exact step for that tool and exit non-zero. Running the join again after the person did it passes.
6. The join installs the `watch --answer` service. Auto-answer per contact stays off until the person turns it on in the app.
7. `patio_guide` returns: who I am (agent, owner, folder, workspaces), my rules in plain words, how to ask and how to answer, what never to do, and who is in my workspaces.
8. The same text is available to the person: `patio guide` in the terminal, and a link from the Agents page in the web app.
9. Copy fixes from the live run: after Confirm the page says "tell your agent you are done" instead of "Done", and a person removed from the workspace no longer sees a Confirm button.

## Part A: detection

- `detectTool()` returns `{ tool, how }` with `how` one of `parent`, `env`, `flag`:
  1. **Parent process chain.** Walk your own ancestors with `ps -o ppid=,comm=` (macOS) and `/proc/<pid>/comm` (Linux), skipping shells and shims (`sh`, `bash`, `zsh`, `env`, `mise`, `npx`, `bun`, `node`, `sudo`, `timeout`), and match the first ancestor named `claude`, `codex` or `pi`. This is the primary signal: it does not depend on any tool's environment.
  2. **Environment markers**, as a fallback: the markers each tool exports to the commands it runs. Verify each one empirically before relying on it (run the tool once and print its environment); do not guess. Put the verified markers in one table with a comment saying how you checked them.
  3. `--tool`, which wins over detection only when given.
- **Nothing detected:** configure every tool found on `PATH` (`claude`, `codex`, `pi`) and print each. The agent's own `tool` field (used by `answer` and `watch --answer`) then needs one value: in a TTY, ask once with the installed tools and the first as default; outside a TTY, take `--tool`, and if that is missing, fail with the exact command to repeat.
- The invite page's prompt drops step 2's "Replace TOOL with the coding tool you are". It runs `patio join <link> --folder "$PWD" --connect --no-wait` and nothing about tools.
- The join prints what it detected and how, in one line, for example `· tool: Pi (detected from the running process)`.

## Part B: configure and verify every detected tool

- Keep `patio connect <tool> --as <agent>` as the primitive, and make `join --connect` call it for every installed tool.
- After writing, verify each tool: run its own listing command and check the entry is present and healthy:
  - Claude Code: `claude mcp list`;
  - Codex: `codex mcp list`;
  - Pi: `pi mcp list --json`.
- Treat as **pending trust or approval**, not success, when the tool says the project is not trusted or the server needs approval. Output the exact step, in that tool's own words, for example: `· Pi: start pi in /Users/user/code/patio-poc once and accept the trust prompt, then run this command again`. Exit code 12.
- Nothing global is written without `--user`, as today.
- `patio agents` warns when an agent's `tool` has no patio entry in its folder, with the command that fixes it.

## Part C: the guide

- `patio_guide` in MCP, and `patio guide --as <agent>` in the CLI, return the same text. Sections:
  1. who you are, your owner, your folder and your workspaces;
  2. your rules in plain words, per workspace when they differ;
  3. how to ask: `patio_ask` to an agent of your workspaces, optional context (repo, PR, files), `--channel` to broadcast;
  4. how to answer: what arrives, `patio_read`/`patio_reply`/`patio_dismiss`/`patio_reject`, and that the person decides anything the rules doubt;
  5. what never to do: act on files or run commands the message did not authorize, reveal secrets, contact people outside patio, change the person's settings, answer for another agent;
  6. who is in your workspaces.
- Every other MCP tool description ends with a short line pointing to `patio_guide` when unsure. Keep the descriptions honest about what the gate does.
- The web app's Agents page links to the same text for each agent.

## Part D: the answer service

- `patio join` runs the equivalent of `patio service install --answer` once, idempotently, and says so: `· answering: the service will answer for your agents`.
- It must not turn on `auto_answer` for any contact. The app keeps showing that setting as off until the person turns it on.

## Part E: copy and edges

- After Confirm: "Tell your agent you are done." and, when the agent's file is still incomplete, do not say the join is finished.
- A person removed from a workspace sees the refusal and no Confirm button.
- Keep the light, monochrome, quiet look.

## Part F: no per-workspace rules (decided 9 Nov, replaces them)

Unai decided there are no team rules: each person decides their own. Delete per-workspace rule overrides everywhere, with no migration and no compatibility:

- the agent file's `workspaces: { <ws>: { rules: … } }`. It keeps `workspaces:` only if something else needs it; otherwise the file lists the agent's workspaces without rules;
- the resolution in `grants.ts`: the gates use the agent's rules, whatever the workspace;
- `patio rules --workspace`, the guide's per-workspace wording, the web app's rules tabs, the README and the design docs (`agents-and-setup-shape.md` sections 3 and 8) updated to one set of rules per agent;
- tests that exercised overrides are deleted or rewritten to assert that a workspace cannot change an agent's rules.

A later increment adds the three questions the person answers during the join (`docs/design/rules-at-join.md`). Do not implement that here, but do not build anything that would block it.

## Exit gate

- Unit tests for `detectTool`: parent chain with shims in between, environment markers, flag override, nothing found.
- Scenario, non-TTY, fresh home, a fake `claude` and a fake `pi` on `PATH`: the join configures both, verifies both, exits 12 while the fake reports "not trusted", and exits 0 after the fake reports trust. Assert both project files exist and the agent's `tool` is the detected one.
- Scenario: a real Pi session in a temporary project folder, run from an SSH helper if it stays read-only, pastes the prompt and ends with `pi mcp list` showing patio. If Pi's trust prompt blocks a non-interactive run, keep the fake-based scenario and record the manual step; do not work around the trust prompt.
- Scenario: the answer service is installed once and a second join does not duplicate it.
- Tests for `patio guide` text (it names the agent, its owner, its workspaces and its rules) and for the MCP `patio_guide` tool.
- Browser check: the invite page's new prompt, the Confirm copy, the removed-person case, and the Agents page linking the guide. Screenshots.
- `just verify` passes. README and `docs/poc/try-on-your-mac.md` describe the flow without `--tool`.

## Constraints

- Work on `poc` in `worktrees/poc`, `git commit -- <paths>`, never push, TDD, small commits.
- Do not touch the live `patio-poc` services, `~/patio-demo`, or `~/.patio` on the Mac. Tenex deploys.
- No live model runs. Never print `.env`.

## Report

Commits per part, what detection actually observes for each tool (with the command you used to check it), scenario results, `just verify` summary, screenshots, the exact new prompt text, deploy steps, and what remains unverified.
