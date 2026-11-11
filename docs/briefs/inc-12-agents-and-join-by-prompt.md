# Brief: increment 12, several agents per person, and joining by prompt

Owner: Tenex (coordinator). Implementer: Pi on Claude Opus 5.5, high thinking. Authorized by Unai on 9 Nov 2026 ("cierra así el brief, e impleméntalo"). Work autonomously and chain without asking.

Read first: `docs/design/agents-and-setup-shape.md` (the confirmed design, sections 3, 4 and **8**, which win on conflict), `PRODUCT.md`, `docs/design/onboarding-and-app-shape.md`, `AGENTS.md`, `README.md`, then `src/`.

## Outcome

A person pastes the prompt from an invite page into their coding agent. The agent installs patio, creates itself as `<login>-<workspace>`, joins the workspace and connects itself. The person signs in and clicks **Confirm** once. A person can have several agents, each with its own tool, folder and rules (with overrides per workspace), each in the workspaces they choose.

No backwards compatibility anywhere in this increment: drop `patio init`, `patio register`, `agent.yaml`, `rules.yaml`, person-level workspace joins, and the code paths that only served them.

## Part A: agents as the unit

1. **Server model**
   - Workspace membership is per agent. A person is listed as the owner of their member agents.
   - An agent's name must start with its owner's login and a hyphen (`unai-…`). Refuse others with a clear message that suggests a name.
   - The directory shows "agent · @owner".
2. **Files**
   - One file per agent: `~/.patio/agents/<name>.yaml`, with `tool`, `folder`, `in_place`, `rules:` and `workspaces: { <ws>: { rules: … } }`. Validate it strictly and reload it on change, as the rules are today.
   - Optional template: `~/.patio/new-agent.yaml`.
   - The gates resolve the rules of the **receiving agent** (or, for outgoing messages, the sending agent), then that agent's override for the message's workspace.
   - The always-on secrets topic stays.
   - The confirmation for widening settings (auto-answer, allowed actions) applies per agent and per workspace.
3. **CLI for people**
   - `patio agents`: lists tool, folder, workspaces, connected tools and computer.
   - `patio agents new <name> [--tool] [--folder]`.
   - `patio agents add <agent> <workspace>` and `remove`: entering a workspace puts the agent in its default channels.
   - `patio connect <tool> --as <agent> [--user]`:
     - It writes the tool's MCP entry scoped to the agent's folder by default, and shows what it writes first.
     - It covers Claude Code, Codex and Pi. For each tool, use its real, documented way to add an MCP server; check the installed CLI's help and do not change global config unless `--user` is given.
   - `patio rules <agent> [--workspace <w>] [test "<text>" --from <agent>]`.
   - `patio workspace new <name> --agent <agent>`: creates the workspace with that agent in it, and prints an invite link.
   - `patio status`: you, this computer, the server, and a table of agents.
4. **Agent surface**
   - `patio mcp --as <agent>`, and `PATIO_AGENT`. Every tool call acts as that agent. Without one, and with more than one agent on the computer, the call fails with a clear message.
   - The CLI keeps `--as`.
5. **Answering:** `answer` and `watch --answer` use the receiving agent's tool and folder. One `patio service install --answer` covers every agent on the computer.

## Part B: joining by prompt

6. **`patio join <link> --agent <name> [--tool] [--folder] [--connect]`** is the only setup command, and it converges. It does whatever is missing, in order:
   1. patio runs (started in the background if not);
   2. the agent exists (created with the tool and folder given or detected);
   3. the person is signed in and this computer is confirmed;
   4. the agent joins the workspace and its default channels;
   5. with `--connect`, the agent's tool gets the MCP entry.

   From the person's own terminal (a TTY), only the GitHub sign-in needs the browser. From an agent (no TTY), it prints one confirmation link and waits for it.
7. **One confirmation screen** for a join started by an agent.
   - First run: sign in with GitHub, then one screen. It says "Your agent **unai-orbit** (Claude Code in `~/code/orbit`) wants to join **orbit**" and has **Confirm** and **Decline**. **Confirm** covers the computer, the agent and the join.
   - A later agent of a signed-in person: a waiting card in the web app ("unai-side wants to join orbit"), one click.
8. **The invite page `/join/<code>`**
   - It shows "<inviter> invited you to <workspace> · N agents".
   - Its main element is a **Copy prompt** block with the prompt from section 8.2 of the design, filled in with this link and server.
   - Secondary elements: the command for your own terminal, and the `patio://` button for the future app.
   - Keep the web app's light, monochrome, quiet look. Write the prompt so a cheap model (GPT-6-Luna at low effort, Claude Haiku 5.5 at low effort) follows it without help: short numbered steps, exact commands, and what to show the person.
9. **Install**
   - `bun run build` produces single binaries for `darwin-arm64`, `darwin-x64` and `linux-x64` (`bun build --compile --target …`).
   - The server serves `/install.sh` and the binaries from a directory given by `--dist` or `PATIO_DIST`. `install.sh` detects the platform, downloads the binary to `~/.local/bin/patio`, checks it with a SHA-256 the server publishes beside it, and prints the version.
   - Make sure the compiled binary works for everything patio spawns itself: the background patio, the service, and `mcp`.
10. **Web app:**
    - an Agents page with one card per agent: tool, folder, workspaces (add or remove), the connected-tool state, and its rules with a tab per workspace;
    - Needs you and Conversations name the agent involved;
    - every user-facing text keeps the increment 11 words. Also fix the leftovers: "input gate" and "output gate" in the web app copy become "your rules (incoming)" and "your rules (outgoing)", or plainer.

## Exit gate

- Scenarios with the fakes:
  - an agent joins by link from a non-TTY on a fresh home: it waits, then the person signs in and confirms on one screen, and the agent is in the workspace and its default channel, with `agents/<name>.yaml` written;
  - the same from a TTY needs no confirmation;
  - running it again converges, with no change and exit 0;
  - a second agent of a signed-in person joins with one waiting card;
  - two agents of one person sit in two workspaces with different rules, and the gates apply each agent's rules and override;
  - an agent name without the owner's prefix is refused;
  - `patio mcp --as` acts as that agent, and without `--as` and two agents it fails clearly;
  - `connect` writes the expected MCP entry for each tool (golden files) and nothing global without `--user`;
  - `workspace new` returns a working link;
  - `watch --answer` answers for two agents with their own tools and folders.
- `install.sh` with the built binaries: a test installs into a temporary HOME from a local server and runs `patio --version`. One real check on the Mac through an SSH helper with a temporary HOME, removed afterwards.
- Browser check of the invite page (Copy prompt), the one-screen confirmation, the waiting card and the Agents page, with screenshots.
- `just verify` passes. README, `docs/poc/try-on-your-mac.md` and `docs/dev/verification.md` are rewritten for the new flow.

## Constraints

- Work on `poc` in `worktrees/poc`, commit as you go with `git commit -- <paths>`, never push. TDD, small commits.
- Do not touch the demo services (`patio-demo-*` units, `~/patio-demo`) or Unai's `~/.patio` on the Mac. Tenex deploys and runs the live checks.
- No live model runs. Never print `.env`.

## Report

Commits per part, scenarios, `just verify` summary, screenshots, the exact prompt text on the invite page, deploy steps for Tenex, and what remains unverified.
