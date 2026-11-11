# Brief: increment 11, join by link, the server's judge, and user-facing words

Owner: Tenex (coordinator). Implementer: Pi on Claude Opus 5.5, high thinking. Authorized by Unai on 9 Nov 2026 ("go"). Work autonomously and chain without asking.

Read first: `PRODUCT.md`, `docs/design/onboarding-and-app-shape.md` (the confirmed direction), `AGENTS.md`, `README.md`, `docs/poc/execution.md` (the latest sections), then `src/`.

## Outcome

A teammate joins from an invite link with one command, and nobody confirms their own action twice. New users need no TypeSafe key, because the server judges for them. What people read says "patio", "server", "rules" and "waiting for you", not gatekeeper, exchange, grants or held.

## Scope, in this order (one or more commits each)

1. **Dev environment**
   - Add `just worktree <name> [branch]`. It creates `worktrees/<name>`, copies the main checkout's `.env` with mode 600, and runs `mise install` and `bun install`.
   - `.env` now lives in worktrees, and Bun loads it automatically. Make sure `just check`, `just verify`, every test and every non-live script run **without** it: no `TYPESAFE_*`, `GITHUB_CLIENT_*` or other `.env` values in their environment. Use Bun's own switch if it has one (check `node_modules/bun-types/docs`); otherwise strip it in the recipes. Add a test that fails if a test process sees those variables.
   - Live recipes load the keys explicitly, as today.
   - Update `AGENTS.md`: the `.env` is copied into each worktree, and is still never printed or committed.
2. **User-facing words.** Change every text a person reads (CLI output, the web app, README and docs; MCP tool descriptions too, for consistency):
   - gatekeeper → "patio" or "patio on this computer";
   - exchange → "server";
   - grants → "rules";
   - held → "waiting for you" (or "waiting for <owner>" when it is someone else's);
   - device → "computer" where a person reads it.

   Code identifiers and JSON values may stay. The file is now `rules.yaml` and the commands are `patio rules test` and `patio rules check`. No backwards compatibility: drop `grants.yaml`, `patio grants …`, and the old guard that refuses to start when a `rules.yaml` exists.
3. **The server's judge**
   - **Server side:** a `/judge` endpoint on the exchange.
     - Only approved devices may call it: authenticate the request the way devices already prove themselves.
     - It forwards the Jev request with the server's own `TYPESAFE_API_KEY` and returns Jev's answer.
     - It keeps nothing: no request or response body in logs, the database or memory after the call.
     - A per-device daily quota (`PATIO_JUDGE_PER_DAY`, default 500), answered with 429 when exceeded. Without a key, the endpoint returns 503.
   - **Client side:** when patio has no local `TYPESAFE_API_KEY`, its gates use the server's judge. A local key still wins, for development and self-hosting. Failure stays closed: an unavailable judge means the message waits for you. `patio status` says which judge is in use.
   - **Docs:** the honest sentence for the README: "Messages are end-to-end encrypted and the server stores only ciphertext. To check a message, patio asks the server's judge, which forwards it to Jev and keeps nothing."
4. **Invite links**
   - A workspace admin creates a link in the web app, or with `patio invite --workspace <name> [--expires 7d]` from their own terminal.
   - The link is `https://<server>/join/<code>`. It can be revoked, has an expiry, and has a use limit (optional).
   - The server serves a minimal page at that URL. It shows "<inviter> invited you to <workspace> · N people", a `patio://join/<code>` button for the future app, and the one command to run: `patio join <link>`.
   - Keep the visual language of the web app: light, monochrome and quiet.
5. **Joining with a link, and default channels**
   - `patio init <link>` and `patio join <link>`: sign in if needed, then join the workspace. The person's agents join it too, and they enter its default channels.
   - Channels get a "default" flag that admins set in the web app.
   - Started from an interactive terminal (stdin and stdout are TTYs), this needs no confirmation in the browser.
6. **Who confirms what** (accepted model)
   - Actions a person starts in their own interactive terminal that affect only themselves are done with no second confirmation. These are: join a workspace or channel by link or by name, leave, register an agent, and edit their rules.
   - The same actions started by an agent (MCP, or a non-interactive CLI) wait for the person in the web app, as today.
   - Actions that widen what others can do to the person's agent always need the web app (later the native app), even from a TTY. These are: allow an action, turn on answering on its own, and trust changed keys.
   - Write it down in the README.
7. **A demo teammate without GitHub**
   - `patio exchange demo-person <login> --db <path>` runs on the server's host, so only its operator can use it. It creates the person, or marks an existing one as demo.
   - It prints a one-time sign-in link, valid 10 minutes. That link signs the demo person in to their own patio web app through the same handoff as GitHub, so the operator can act as them.
   - Demo people are labeled "demo" wherever others see them.
   - A real GitHub sign-in whose login collides with a demo person is refused with a clear message.
8. **`patio init` defaults.** `--exchange` becomes `--server`, and it defaults to `https://patio.example.com` (overridable with `PATIO_SERVER`). Its output uses the new words. With a link, it also joins.

## Exit gate

- Scenarios with the fakes:
  - an invite link joins a new person and their agent, and they enter the default channels, with no browser approval from a TTY;
  - the same join from a non-TTY waits for the person;
  - an expired or revoked link is refused with a clear message;
  - `/judge` serves an approved device, refuses an unknown one, enforces the quota, returns 503 without a key, and its logs contain no message text;
  - gates without a local key use `/judge`;
  - the demo person signs in with the one-time link, and the link fails the second time;
  - the GitHub login collision is refused.
- The test proving tests run without `.env` values.
- Browser check of the invite page and of the invite and default-channel controls in the web app, with screenshots.
- `just verify` passes.
- README, `docs/poc/try-on-your-mac.md` and `docs/dev/verification.md` are updated.

## Constraints

- Work on `poc` in `worktrees/poc`, commit as you go with `git commit -- <paths>`, never push. TDD, small commits.
- No live runs: Tenex deploys to the hosted server and runs the live checks.
- Never print or commit the contents of `.env`.

## Report

Commits, scenarios, `just verify` summary, screenshots, what Tenex must do to deploy (environment variables, restart order), and what remains unverified.
