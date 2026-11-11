# Recipes for developing and verifying the agent-exchange POC. See docs/dev/verification.md.
set positional-arguments := true

bun := "mise exec -- bun"

default:
    @just --list

# Install project dependencies through mise and Bun. Safe to run twice.
setup:
    mise install
    {{bun}} install --frozen-lockfile

# A new worktree of this repository at worktrees/<name> (on <branch>, created when missing; default: <name>), with a
# copy of the main checkout's .env (mode 600), its tools (mise install) and its dependencies (bun install).
worktree name branch="":
    #!/usr/bin/env bash
    set -euo pipefail
    main="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
    dest="$main/worktrees/$1"
    branch="${2:-$1}"
    if [ -e "$dest" ]; then echo "worktree: $dest already exists" >&2; exit 1; fi
    if git show-ref --verify --quiet "refs/heads/$branch"; then git worktree add "$dest" "$branch"; else git worktree add -b "$branch" "$dest"; fi
    if [ -f "$main/.env" ]; then install -m 600 "$main/.env" "$dest/.env"; echo "copied .env (mode 600); bunfig.toml keeps Bun from loading it in tests and scripts"; else echo "no .env in $main: live recipes will say a key is missing" >&2; fi
    cd "$dest"
    mise install
    mise exec -- bun install --frozen-lockfile
    echo "ready: $dest (branch $branch)"

# Single patio binaries for darwin-arm64, darwin-x64 and linux-x64, each with its SHA-256, in dist/ (or --out DIR).
# The server serves them with /install.sh: patio exchange --dist dist.
build *flags:
    @{{bun}} scripts/build.ts "$@"

# Read-only JSON report of prerequisites. Exit 10 when deterministic checks cannot run.
doctor:
    @{{bun}} scripts/doctor.ts

# Typecheck and the full test suite. No network calls to paid services.
check:
    {{bun}} run typecheck
    PATIO_NO_NOTIFY=1 {{bun}} test

# Start an isolated instance: a fake GitHub, an exchange, a fake Jev and one onboarded patio per agent, all in the
# workspace `team`; `--channel <name>` puts every agent in that channel too. Prints the instance id.
up +agents:
    @{{bun}} scripts/instance.ts up "$@"

# Stop only the processes listed in that instance's manifest.
down id:
    @{{bun}} scripts/instance.ts down "$@"

# Run the real patio CLI as <agent> in instance <id>: just cli <id> alice -- who
cli id agent *args:
    @{{bun}} scripts/instance.ts cli "$@"

# Shell exports for a new person in instance <id>, to set up by hand with `patio join <link>`: eval "$(just env <id> dave)"
env id person:
    @{{bun}} scripts/instance.ts env "$@"

# Run a scripted scenario (or `all`) against a fresh instance; writes transcript.md in the instance.
scenario name:
    @{{bun}} scripts/scenario.ts "$@"

# Start `patio mcp` as <agent> and use the generic MCP SDK client to list tools and call `who`. JSON out.
mcp-probe id agent:
    @{{bun}} scripts/mcp-probe.ts "$@"

# Headless Chromium via Playwright loads a local page and saves a screenshot under .verify/browser/.
browser-check:
    @{{bun}} scripts/browser-check.ts

# The real Claude Code, Codex and Pi on this machine (no model run), each with an isolated HOME: patio's entry is a
# pending step before the person trusts the project and listed after; a command each tool runs detects that tool.
# JSON report under .verify/. Not part of verify (it needs the tools installed).
probe-tools:
    @{{bun}} scripts/probe-tools.ts

# The real ACP adapters of Claude Code, Codex and Pi, started as the answer service starts them: from a minimal PATH,
# through patio itself. Each runs the join's preflight (initialize and a session, no prompt: no model call). JSON report
# under .verify/. Not part of verify (it needs the tools installed, and downloads the adapters on a first run).
probe-answer *flags:
    @{{bun}} scripts/probe-answer.ts "$@"

# LIVE, paid: Bob's `watch --once --answer` answers with Codex (gpt-6-luna low) through real gates and real Jev.
# Needs --yes-live; spends 1 codex_acp and 2 jev units; exit 2 without TYPESAFE_API_KEY.
smoke-acp *flags:
    @{{bun}} scripts/smoke-acp.ts "$@"

# LIVE, paid: benign and injection messages to Jev. Needs --yes-live; spends 2 jev units; exit 2 without key.
smoke-jev *flags:
    @{{bun}} scripts/smoke-jev.ts "$@"

# Run doctor, check, all scenarios, mcp-probe and the browser checks (and the live smokes with --live).
# Writes .verify/<timestamp>-<short-rev>/summary.md and manifest.json. Non-zero if a required step fails.
verify *flags:
    @{{bun}} scripts/verify.ts "$@"

# Headless Chromium: an agent joins by prompt on a fresh home and the person confirms on one screen; then the Agents
# page (tool, folder, workspaces out and back in, one set of rules). Screenshots under .verify/browser/.
browser-join:
    @{{bun}} scripts/browser-join.ts

# LIVE: a real GitHub OAuth sign-in by a human in the browser. Needs --yes-live and GITHUB_CLIENT_ID and
# GITHUB_CLIENT_SECRET in the main checkout's .env (exit 2 without them). Not part of verify --live.
smoke-github *flags:
    @{{bun}} scripts/smoke-github.ts "$@"

# Headless Chromium checks the read-only channel and DM views; screenshots under .verify/browser/.
browser-channels:
    @{{bun}} scripts/browser-channels.ts

# Headless Chromium checks the gates' approval cards (fake Jev): held incoming and outgoing, approve, edit.
browser-gates:
    @{{bun}} scripts/browser-gates.ts

# LIVE, paid: `patio rules test` with the real Jev on 3 messages (the default grant: a benign question, a request for an
# API key, a reply that gives away a password). Needs --yes-live; reserves 3 jev units; exit 2 without key.
rules-live *flags:
    @{{bun}} scripts/rules-live.ts "$@"

# Headless Chromium checks the keys-changed card (trust) and the Devices page (revoke, confirmation); screenshots
# under .verify/browser/.
browser-keys:
    @{{bun}} scripts/browser-keys.ts

# Headless Chromium checks the Activity page (timeline, an opened row, a filter) and the banner an invalid grants.yaml
# shows; screenshots under .verify/browser/.
browser-activity:
    @{{bun}} scripts/browser-activity.ts

# Headless Chromium checks the invite links and default channels in the web app, the server's invite page (Copy
# prompt), and a later agent's join that waits for one card; screenshots under .verify/browser/.
browser-invites:
    @{{bun}} scripts/browser-invites.ts

# LIVE, paid: 18 fixed messages (6 of them requests for actions) through Bob's real gates and the real Jev; table
# of probabilities and verdicts under .verify/live/. Needs --yes-live; reserves 18 jev units; exit 2 without key.
smoke-gates *flags:
    @{{bun}} scripts/smoke-gates.ts "$@"

# LIVE, paid: the PR question by DM and in #backend, answered by Codex (gpt-6-luna low) through `watch --once
# --answer`, real Jev in every gate. Needs --yes-live; spends 3 codex_acp and reserves 24 jev units.
dogfood *flags:
    @{{bun}} scripts/dogfood.ts "$@"

# LIVE, paid: 6 attacks against Bob's responder, with his gates on and with the prompt alone; writes a table under
# .verify/live/. Needs --yes-live (1 codex_acp unit per attack that reaches the agent, 12 jev). --fake: test doubles.
adversarial *flags:
    @{{bun}} scripts/adversarial.ts "$@"

# LIVE, paid: the adversarial create-file request under each actions policy (deny, ask-human, an allowed list), with
# Codex (gpt-6-luna low) answering the two that reach Bob. Needs --yes-live (2 codex_acp, 3 jev). --fake: test doubles.
actions *flags:
    @{{bun}} scripts/actions.ts "$@"

# LIVE, paid: the responder matrix. Alice asks Bob the PR question and a follow-up; Bob answers with codex, claude,
# pi and hermes-docker in turn (the tool in his agent's file), real Jev in every gate; table under .verify/live/. Needs
# --yes-live; 1 run of the responder's budget per answer, 8 jev per message. --only <name>; --fake: test doubles.
responders *flags:
    @{{bun}} scripts/responders.ts "$@"
