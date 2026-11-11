# POC execution record

Status: proposal approved by Unai in Crit on 8 Nov 2026 (`docs/poc/proposal.md`). POC implementation authorized with autonomous chaining of the increments in `docs/poc/plan.md`. All six POC increments accepted on 8 Nov 2026. Batch 2 (`docs/poc/batch-2.md`) in progress: Increments 7 to 10 accepted on 9 Nov 2026. Batch 2 is complete; an independent review and security audit runs on branch `poc-review` until 03:39 CET.

## Proposal

Approved proposal: `docs/poc/proposal.md` (Crit plan `agent-exchange-proposal`, snapshot v007).

Decisions after the approval (8 Nov 2026):

- Encryption for the POC: sealed boxes now, MLS later.
- Autonomous chaining: the coordinator chains increments without asking for a go and stops only on real blockers.
- Wake-up (proposal section 2.8): only layer 1, the owner's agent started to answer a message. No digest and no doorbell in the POC.
- Inbox consumption: CLI primitives `inbox`, `read`, `answer`, `dismiss`, `watch`; the gatekeeper never starts agents; `rejected` hidden by default. Details in `docs/poc/plan.md`, increment 5.

## Decisions (8 Nov 2026)

| Topic | Decision |
|---|---|
| Repository | Local clone of `ppazosp/patio` in `~/code/uesteibar/patio`. Remote `upstream`, push disabled |
| Branch | All work on `poc`, in worktree `worktrees/poc`. `main` mirrors upstream |
| Commits | Commit as you go on `poc`. No push |
| Implementer | Pi, `anthropic/claude-opus-5-5`, thinking `high`, default Pi agent dir `~/.pi/agent` (Unai's personal subscription). Never `~/.pi/agent-orbit-work`: that dir is for Orbit work only |
| UI implementer | Pi, `anthropic/claude-opus-5-5`, thinking `high`, default Pi agent dir |
| Worker history | 8 Nov: started on Sonnet 5.5 with the Orbit dir by mistake (commits up to `9ecc700`); switched to Opus 5.5 at 15:05 (up to `f14308b`, still Orbit dir); at 15:08 restarted on the default dir by forking the Pi session |
| Live ACP responder smoke | Codex through `codex-acp`, model GPT-6-Luna, effort low. Codex CLI auth (ChatGPT login) |
| Gate model | Jev (TypeSafe, `@typesafe-ai/sdk`). API key from Unai as `TYPESAFE_API_KEY` in the main checkout's `.env` (`~/code/uesteibar/patio/.env`, gitignored, mode 600) |
| Runtime for workers | Rex on Devbox, session `patio`, one window per worktree |

## Budget for live calls

Proposed by Tenex, open to correction by Unai:

- `codex-acp` smoke: at most 10 runs per day. At most 3 runs while the environment is being built. Unai allowed more runs on GPT-6-Luna low; for increment 6 the coordinator raised the limits to 20 per day and 20 in total for the build phase.
- Jev: at most 100 requests per day during the environment build; 300 per day during POC increments.
- Batch 2 (`docs/poc/batch-2.md`): Codex up to 40 runs in total, with no daily cap; Jev 300 per day. In increment 7 the worker set `.dev/budget.json` to `codex_acp_per_day: 40` and `codex_acp_build_total: 59` (the 19 runs of batch 1 plus 40), since 19 of the previous 20 were used. Increment 7 used 3 Codex runs (budget counter 22 of 59). Increment 8 added `claude_acp`, `pi_acp` and `hermes_acp` counters (15 each in total, the batch-2 limits) and used Codex 2 of its 4 runs (counter 24 of 59), Claude Code 4 of 6, Pi 4 of 6 and Hermes 0 prompts (handshakes only, no login in the volume). Increment 9 (worker): `.dev/budget.json` set to `jev_per_day: 600` per the increment 8 acceptance; it used 6 Jev units (two `just grants-live` runs, 3 each; counter 288 for 8 Nov) and no Codex, Claude Code, Pi or Hermes runs. Increment 10 (worker): Codex 3 of its 4 runs (one `just dogfood --yes-live`; counter 27 of 59) and 42 Jev units (`just smoke-gates --yes-live` 18, of which 17 used; `just dogfood --yes-live` 24; counter 330 of 600 for 8 Nov); no Claude Code, Pi or Hermes runs.

## Readiness (8 Nov 2026)

| Check | Result |
|---|---|
| Upstream baseline on Linux | `bun test`: 15 pass, 0 fail (full suite). `tsc --noEmit`: clean. Bun 1.4.4 |
| Pi implementer auth (Orbit dir) | `claude-sonnet-5-5` ready, `claude-opus-5-5` ready (OAuth) |
| Orbit agent dir global `AGENTS.md` | Absent. The repo `AGENTS.md` carries the working rules |
| Codex CLI | 0.166.0, logged in with ChatGPT. Luna through codex-acp not yet exercised |
| Pi `openai-codex` provider | `invalid_state`. Not needed for the decisions above |
| Jev API key | Present in `~/code/uesteibar/patio/.env` (checked by name only; ignored by git through upstream `.gitignore`; mode set to 600) |
| Browser | Chromium 155 and Playwright 1.65 on the host |
| Rex | Server 0.1.0-preview.13 on the local socket |

## Environment acceptance (8 Nov 2026, Tenex)

Checked independently on `8c76e4f`, clean tree:

- `just verify`: PASS, 9 of 9 deterministic steps (doctor, check, 3 scenarios, mcp-probe, browser-check). Evidence in `.verify/2026-11-08T14-18-21-358Z-8c76e4f/`.
- Full test suite: 43 pass, 0 fail (15 upstream plus the tests added for the environment).
- Two instances at the same time: each sees only its own agents. A message across instances fails with exit 3 (recipient offline). `just down` leaves no processes. `~/.patio` was never created.
- Secrets: the TypeSafe key value appears in no file under `.verify`, `.dev`, `src`, `scripts`, `test` or `docs`, and in no commit on `poc`.

Live smokes, run by the worker:

- Jev: 1 run (2 requests, about 175 ms each, model `jev-1.14.0`). Injection message scored 0.99 on injection, secrets and action questions; the benign message scored 0.02 to 0.03.
- Codex through `codex-acp`, GPT-6-Luna low: 2 of 3 build runs used, both failed the fact check. The read-only boundary held (no file created, sandbox unchanged), but Luna at low effort called no tools and said it could not read the file. Open decision: raise the responder effort, or change patio's responder prompt in the POC.

Known limits: `@typesafe-ai/sdk` 0.7.0 needs a fetch workaround under Bun 1.4.4 (`scripts/lib/jev.ts`); Codex smokes still write `~/.codex/sessions/` and load the global `~/.codex/AGENTS.md`; checked on Linux only.

## Responder with the owner's setup: acceptance (8 Nov 2026, Tenex)

Unai decided that, for the POC, the responder runs with its owner's normal agent setup and the security layer is the input and output gates (brief `docs/briefs/responder-unattended.md`). Checked independently on `effbe0e`, clean tree:

- `just verify`: PASS, 9 of 9 deterministic steps. Full suite: 46 pass, 0 fail.
- `just smoke-acp --yes-live`, GPT-6-Luna low, run by Tenex: PASS in 5.3 s. Mode `agent` kept from the owner's setup; one `read` tool call on `docs/release.md`; no permission requests; reply contains PELICAN-7; `smoke-created.txt` absent and the sandbox repo clean (prompt compliance, not enforcement).
- The worker's two runs passed too. Codex build budget: 5 of 10 used.
- Finding for the output gate: the reply included an absolute local path from Bob's machine as a Markdown link. DLP should catch local paths.
- Still unverified: adversarial messages (whether an injection makes Codex write or run commands), other agents (Claude Code, Hermes, Gemini) with their owners' setup.

## Increment 1 acceptance (8 Nov 2026, Tenex)

Checked independently on `48a1223`, clean tree:

- `just verify`: PASS, 12 of 12 deterministic steps, including the new scenarios offline-delivery, exchange-restart and gatekeeper-restart. Full suite: 59 pass, 0 fail.
- The exit-gate tests exist: "the exchange database holds no plaintext, before or after delivery" and "a tampered or wrongly signed envelope is rejected by the recipient and never reaches the inbox".
- Own probe outside the worker's tests: with Bob stopped, Alice's `ask` was queued ("queued at the exchange until they connect", exit 0); a unique marker in the message text appeared in no SQLite table of the instance; after Bob started, his inbox contained it.
- Live `smoke-acp` on the new protocol, GPT-6-Luna low: PASS in 7.1 s (Codex build budget: 6 of 10).
- Library: `libsodium-wrappers` 0.8.4 (sealed boxes and Ed25519).
- Known gaps carried forward: no key revocation or rotation, keys come from the exchange directory without transparency, `ask` fails while the sender's own gatekeeper is disconnected, a recipient must have been online once.

## Increment 2 acceptance (8 Nov 2026, Tenex)

Checked independently on `c54c209` (worker's last code commit `fd55566`), clean tree:

- `just verify`: PASS, 15 of 15 deterministic steps, including scenarios onboarding, non-members and revoke, and the Playwright approval flow. Full suite: 68 pass, 0 fail.
- Test "the agent's credentials cannot approve, pair, invite or revoke" exists, and `mcp-probe` fails if any MCP tool could approve, pair, invite or revoke.
- Web app screenshots reviewed (`.verify/browser/approval-2026-11-08T17-33-46-899Z/`): light grayscale, one dark-gray accent, system fonts, sidebar layout, real empty, pending, error, approved and revoked states.
- Live `smoke-acp` on protocol 3, GPT-6-Luna low: PASS in 7.6 s (Codex build budget: 7 of 10).
- GitHub OAuth callback: GitHub documents that a loopback `redirect_uri` may use any port when the app's callback is `http://127.0.0.1/<path>` (docs.github.com, "Authorizing OAuth apps", "Loopback redirect urls", read 8 Nov 2026). Callback for Unai's OAuth app: `http://127.0.0.1:7781/auth/github/callback`.
- Not built yet, carried forward: device revocation in the web app, agents-per-person limit, explicit agent membership of workspaces, membership re-check for messages queued before a revoke; web sessions and in-progress sign-ins are lost on restart.

## Increment 3 acceptance (8 Nov 2026, Tenex)

Checked independently on `234ba5d`, clean tree:

- `just verify`: PASS, 22 of 22 deterministic steps, including scenarios broadcast, one-reply, reply-to-reply, channel-outsider and revoke-queued, and the Playwright channel views. Full suite: 77 pass, 0 fail.
- Channel thread screenshot reviewed: broadcast with two indented replies, marked read-only, no compose box, same visual language as increment 2.
- Not re-run live: the Codex responder on protocol 4 (budget kept for increments 5 and 6).
- Known limits: the exchange cannot enforce the reply rules (honest gatekeepers drop violations); late joiners do not get earlier broadcasts; no per-channel rate limit; one copy per device when a device hosts several members of a channel (untested).

## Increment 4 acceptance (8 Nov 2026, Tenex)

Checked independently on `c441f5c`, clean tree:

- `just verify`: PASS, 31 of 31 steps, including 8 gate scenarios with the fake Jev and the Playwright approval cards. Full suite: 109 pass, 0 fail.
- Approval cards reviewed (`.verify/browser/gates-2026-11-08T18-20-18-180Z/`): outgoing card with the question answered, an editable draft and per-rule Jev bars; incoming card with the rule that held it. Same visual language.
- Live `smoke-gates` (worker's run, `.verify/live/gates-2026-11-08T18-15-05-781Z/table.md`): 12 of 12 expected verdicts with jev-1.14.0. Benign risk at most 0.05; injections 0.95 to 1.0; denied topics 0.87 to 0.90, at the reject threshold; posture break 0.01 on the posture question.
- The TypeSafe key appears in no file under `.verify`, `.dev`, `src`, `scripts`, `test`, `docs` or the README, and in no commit.
- Coordinator decisions for increment 5, open to Unai's veto: gates are always on (a default grant applies when `grants.yaml` is absent, instead of no gates), and incoming replies get the prompt-injection check (they reach the agent too), but no topic checks.
- Carried forward: held messages have no timeout; grants are read only at start; denied-topic scores sit at the reject threshold, so some denied-topic requests will be held instead of rejected.

## Increment 5 acceptance (8 Nov 2026, Tenex)

Checked independently on `9073fc2`, clean tree:

- `just verify`: PASS, 37 of 37 steps. Full suite: 135 pass, 0 fail.
- A flaky failure found in the first check (`offline-delivery` matched "812" inside a hex device id in `exchange.db-wal`) was a false positive of a 3-character probe, not a leak. Fixed in `9073fc2`: probes use random markers of 16 or more characters, short probes throw, and a positive control checks the scan finds the conversation id. Rerun by Tenex: `offline-delivery` 8 of 8, `just verify` PASS.
- Own CLI exercise: heads-up from Alice; Bob's `inbox --json` (one JSON object per line), `read` (state read), `dismiss`; default `inbox` empty afterwards, `inbox --all` shows `dismissed`.
- Live run by the worker: `watch --once --answer`, real gates and Jev, Codex GPT-6-Luna low answered with a relative path and passed the output gate (Codex build budget: 8 of 10).
- Worker decisions accepted: the smoke no longer asks Codex to create a file (the input gate now treats that as injection); `agent_runs_per_day` is gone with `rules.yaml`; `watch --exec` does not retry a failed command in the same process.
- Not verified yet, moved to increment 6: the channel claim with a real answer, plain streaming `watch`, a DM with a per-workspace `agent.yaml` override, MCP `dismiss` called by a client.

## Increment 6 acceptance (8 Nov 2026, Tenex)

Checked independently on `89730e0`, clean tree:

- `just verify`: PASS. Full suite: 136 pass, 0 fail.
- Live evidence from the worker: `.verify/live/dogfood-2026-11-08T19-06-06-204Z/` (21 of 21 checks: DM and `#backend` answered by Codex GPT-6-Luna low through real Jev gates; two parallel consumers produced one answer) and `.verify/live/adversarial-2026-11-08T19-06-22-338Z/` (6 attacks rejected by the gates; with the prompt alone, Codex refused the 5 that reached it, but read the `.env` key name and the salary note). Report: `docs/poc/dogfood-report.md`.
- `docs/poc/try-it.md` followed by Tenex step by step on a fresh instance: DM with `read` and `reply`; `answer` with the fake ACP agent; channel broadcast with two answers and a refused second reply (exit 6); output gate held a reply with an email (exit 7) and blocked a local path (exit 8); signed in to Bob's web app through the fake GitHub, edited the held draft and sent it, and Alice received the edited text; `watch --once` and `watch --once --exec` (message JSON on stdin); audit log lines present; `just down` stopped all six processes.
- Budget used in the build phase: Codex 19 of 20 runs; Jev 102 of 300 units reserved today.

## Increment 7 acceptance (8 Nov 2026, Tenex)

Checked independently on `42c9034`, clean tree:

- `just verify`: PASS. Full suite: 151 pass, 0 fail.
- Own CLI exercise: `reject` with a reason; Alice's `wait` printed "bob declined your message: declined by the recipient. Reason: busy today, ask Carol"; the message left the default inbox and shows in `inbox --rejected`; a second `reject` exits 6.
- Action card reviewed (`.verify/browser/gates-2026-11-08T21-41-48-378Z/07-gates-card-action.png`): the message, the requested action, an editable "action you allow", Jev bars, and Reject, Deliver without the action, Allow the action.
- Live (worker): `smoke-gates` 18 of 18; `just actions` with Codex: deny rejected, ask-human delivered without the action and Codex did not act, an allowed action was carried out after a prompt fix.
- Worker's question wording changes accepted (the brief's wording delivered a request with extra unlisted actions at 0.94).
- Gap to close in increment 9: with the narrowed injection question, a plain request for a secret now reaches the agent. The default grant will deny the topic "credentials, secrets, keys and passwords" in both gates.

## Increment 8 acceptance (8 Nov 2026, Tenex)

Checked independently on `6a4aa09`, clean tree:

- `just verify`: PASS (48 steps, 169 tests).
- Own live run `just responders --yes-live --only pi` (`.verify/live/responders-2026-11-08T22-08-47-775Z/`): PASS; Pi through `pi-acp` 0.0.34 on Haiku 5.5 low answered the schema question (8.5 s) and the follow-up (5.9 s) correctly, no sandbox changes, global agent configs unchanged.
- Worker's full live table: Codex (GPT-6-Luna low), Claude Code (Haiku 5.5 low) and Pi (Haiku 5.5 low) all correct with no file changes; Hermes in Docker: handshake OK, prompt skipped for the missing login (by design; Unai's two commands are in the README).
- Jev self-imposed daily budget: raised from 300 to 600 units for 8 Nov because increments 9 and 10 need live checks (266 were used by increment 8's end). TypeSafe's own limits were not hit.

## Increment 9 acceptance (8 Nov 2026, Tenex)

Checked independently on `a9a0cdc`, clean tree: `just verify` PASS (`.verify/2026-11-08T22-46-05-951Z-a9a0cdc/`), including the new scenarios gate-secret-default, grants-test, workdir, device-revoke, web-session-restart, keys-changed and init, and the browser check of the keys-changed card and Devices page. Live `grants test` with real Jev: 3 of 3 (secrets 0.99 in both gates).

Carried into increment 10:

- After revoking a device, its agent name cannot be registered on a new device ("lives on another of your devices"). Fix: a revoked device's agent names are free again.
- Every outgoing message now gets a Jev call for the secrets topic; rerun `smoke-gates` live to check legitimate replies are not blocked.
- No live responder has run with the disposable worktree yet; the increment 10 dogfood rerun covers it.

## Increment 10 acceptance (9 Nov 2026, Tenex)

Checked independently on `bd6ae29`, clean tree:

- `just verify`: PASS (`.verify/2026-11-08T23-23-58-326Z-bd6ae29/`). Full suite: 214 pass, 0 fail.
- Commits cover all five improvements: hot reload with the last-valid-grant fallback and the config banner (`8a78e1c`), expiry with the test clock (`5939663`, `56ed388`), the local outbox with cancel and TTL (`64d4079`), the Activity page (`b9fc768`), `patio status` and `patio service install` with a real `systemctl --user` scenario (`3e06486`), plus the revoked-device name fix (`fe95042`).
- Live at `0c2c960`: `smoke-gates` 18 of 18 with real Jev (17 requests) — the always-on secrets question blocks legitimate replies only where expected; `dogfood --yes-live` PASS with 30 of 30 checks, Codex GPT-6-Luna low, answers in disposable worktrees with `discarded: []` and one answer of two parallel consumers.
- Budget: Codex 27 of 59 build runs; Jev 330 of 600 for 8 Nov; responders 4 Claude, 6 Pi, 0 Hermes.
- The worker stopped on an Anthropic 429 (account rate limit) right after its last green verify; nothing was left uncommitted.

## Review merge and S1 (9 Nov 2026, Tenex)

- `poc-review` verified by Tenex (`just verify` PASS on `a692624`) and merged into `poc` (`c885bcf`): S2, S3, S4, S12, S17 fixed; `patio grants check`; S12 follow-up so a rejection notice for a broadcast still reaches its sender.
- S1 (the one high finding) fixed by Pi on Opus 5.5 high (`db834e6`, docs `ec3bad7`): a channel message is bound to the exchange's record of its channel. Tenex: `just verify` PASS on `ec3bad7`; `test/channels.test.ts` 3 of 3 runs green.
- End-to-end with real Jev and Claude Code Haiku 5.5 low, run by Tenex following `docs/poc/e2e.md` on instance `261109-cb83`: `patio init` with `--responder claude`, invite and join through both web apps; question delivered (injection 0.02) and answered in a disposable worktree in 8 s; injection attack rejected (0.99, secrets 0.95); action request held (action 0.99), allowed on the card, and done with `answer --in-place` (`REVIEWED.md` created); outgoing replies sent (secrets 0.02). SOCKS tunnel from the Mac to the Devbox loopback checked (HTTP 200).
- Still unverified: real GitHub sign-in (needs Unai's OAuth App), Hermes answering (needs Unai's login in its Docker volume), macOS.

## What remains unauthorized

- Any push, remote change or publication.
- Messages to Pazos.
- Creating the GitHub OAuth app (Unai's step, scheduled for the end of increment 2).

## Increment 12 accepted (9 Nov 2026): several agents per person, and joining by prompt

- Evidence: Pi's `just verify` PASS on `955aa3a` (`.verify/2026-11-09T16-49-53-393Z-955aa3a/summary.md`), recipe-written, current HEAD, only `.pi/` untracked. Tenex did not rerun it (accepted rule: no duplicate verify runs).
- Deployed to `patio.example.com` with `--dist` (three binaries, `/install.sh`). Pablo moved to `agents/pablo.yaml`; auto-answer turned on again in his web app.
- Live check by Tenex: the invite page's prompt, pasted as is into Claude Code with Haiku at low effort on a fresh patio home. The agent installed patio, ran the join, showed the confirmation link and waited. On one screen, signed in as demo person `erin`, Confirm. On "done", the agent reran the join and reported `erin-orbit`, with `.mcp.json` written. A new Haiku session then asked `pablo` about PR 812 through the MCP tools and got his answer back. Both computers used the server's judge. Cost of the agent runs: about 0.012 USD.
- Findings, small:
  - after Confirm, the page says "Done" and the Agents card shows "no tool in no folder" until the agent reruns the join. The page should say "tell your agent you are done";
  - a person removed from a workspace sees the refusal above a Confirm button that still shows.
- Not verified: the real GitHub sign-in on `/confirm`, the full join on macOS from the compiled binary, Codex and Pi loading their project entries.

## Increments 13 and 14 accepted (9 Nov 2026): a setup that cannot guess, and the rules agreed at join

- Evidence: Pi's `just verify` PASS on `f9019ed` (`.verify/2026-11-09T20-45-09-969Z-f9019ed/summary.md`), current HEAD, only `.pi/` untracked. Not rerun.
- Deployed to `patio-poc` (new binaries, invite page prompt with the three questions).
- Live check by Tenex on Unai's Mac (Unai authorized it), in `~/code/patio-poc` from a reset state: no binary, no agent file, no project MCP files. A new Pi session with Claude Haiku 5.5 at low effort got the invite page's prompt as is:
  - it installed patio with `install.sh`, asked the three questions in one message, and passed the answers as flags;
  - the join printed `tool: Pi (detected from the running process)`, wrote the rules from the answers, configured Claude Code, Codex and Pi, installed the answer service (launchd), and verified each tool: Claude Code passed, Codex and Pi printed their trust step;
  - Tenex did the trust step for both (the same entries the tools' prompts write; the earlier files are backed up), the agent reran the join, and it ended with "nothing to do" and the three answers;
  - a new Pi session asked `pablo` about PR 812 through the MCP tools and reported his answer.
- Found live, to fix next:
  1. the answer service runs with a PATH without `bunx`, so `pi-acp` fails and the message ends as `agent_failed` with "The operation was aborted". The same `patio answer` from Unai's shell answered;
  2. two `patio up` processes ran on the same home at once (both from Unai's first runs), both bound to `daemon.sock`;
  3. `patio wait` refuses `--as`, unlike the other agent commands;
  4. the prompt runs the join in step 2 and says "before joining" in step 3;
  5. the answer said "Passed to uesteibar-orbit, who can confirm further": the answer prompt confuses the agent about who it is;
  6. configuring every installed tool makes the person trust Codex in a repo where they only use Pi, and the join fails until they do.

## Increment 15 accepted (10 Nov 2026): the live run's and the UX review's findings

- Evidence: Pi's `just verify` PASS on `0c8e2a0` (`.verify/2026-11-09T22-59-46-556Z-0c8e2a0/summary.md`), current HEAD, only `.pi/` untracked. Not rerun.
- Deployed to `patio-poc` (`patio server`, new binaries). Pablo's demo answers recorded from a terminal (`requests`, `ask-human`, `yes`).
- Live check by Tenex on Unai's Mac, from `patio uninstall` and an empty `~/.patio`, with Pi on Claude Haiku 5.5 at low effort and the page's prompt as served:
  - the prompt asked the three questions first; "defaults" ran the one ready command;
  - the confirmation screen showed the three answers; Confirm in the dedicated Chrome (real GitHub session);
  - the join detected Pi, wrote the three project files and listed them in `.git/info/exclude`, checked the answer path (`· answering: checked`), did not block on Codex, and stopped only on Pi's trust step; after it, the fixed ending (`patio is ready`, `Next:`, `Try:`, `What needs you:`);
  - `patio status`: `Working`, `Claude Code: listed; Codex: written, waits for your trust in Codex; Pi: listed`, healthy;
  - a question from `pablo` showed under **Questions for you**, counted in status; **Let uesteibar-orbit answer** answered it from the repo;
  - with the third answer set to yes from a terminal, the launchd service answered the next question on its own (live finding 1 fixed);
  - a new Pi session used the MCP `status` and `ask` tools and got Pablo's answer;
  - `patio rules … --answer yes` from no terminal became a "Your rules" card (declined); `--answer no` applied at once;
  - `--help` works, `unknown command: foo`, one id column in `inbox`.
- Found live:
  1. `patio uninstall`, with a 0.12 patio still running (no lock then), printed `unknown endpoint`, exited 0 and did not revoke the computer; the second run said "not signed in; nothing to revoke". The agent name stayed bound to the old computer, and the next Confirm failed with "uesteibar-orbit lives on another of your computers" until the old computer was revoked on the Computers page;
  2. after that move, every teammate's patio holds messages for the new keys until they trust them. This is correct, but nothing tells the person who moved;
  3. `Try: ask erin-orbit …` suggests an offline demo agent.

## Increment 16 (10 Nov 2026): moving to a new computer; stopped here

- Evidence: Pi's `just verify` PASS on `3e750ca` (76 of 76 steps, 314 tests), `.verify/2026-11-09T23-37-08-072Z-3e750ca/summary.md`.
- In: an uninstall that revokes for real, and **Move to this computer**. Also in, though Unai asked to skip them after Pi had built them: the owner and computer on the key card, and the `Try:` choice (`da65f1a`).
- Not deployed and not live-tested. Next steps in `docs/poc/handoff.md`.
