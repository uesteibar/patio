# Brief: increment 15, what the live run and the UX review found

Owner: Tenex (coordinator). Implementer: Pi on Claude Opus 5.5, high thinking. Authorized by Unai on 9 Nov 2026 ("haz una review independiente … coge su feedback y arregla lo que consideres oportuno … 100% autónoma"). Tenex triaged; every item below is decided. Work autonomously, commit as you go, and chain the parts without asking.

Read first:
- `docs/review/ux-review-2026-11-09.md` (the review; its screenshots are in `docs/review/ux-2026-11-09/`);
- the end of `docs/poc/execution.md` (section "Increments 13 and 14 accepted", six live findings);
- `docs/design/rules-at-join.md`, `docs/design/agents-and-setup-shape.md`, `PRODUCT.md`.

Where this brief and the review differ, this brief wins.

## Part A: the answer service and the daemon (live findings 1 and 2)

1. **The service must answer in its own environment.**
   - A launchd or systemd unit has a minimal PATH without mise or other shims. `bunx pi-acp` failed there with "The operation was aborted".
   - Run ACP adapters through patio itself, so they need nothing on PATH. In a compiled binary, `BUN_BE_BUN=1 <patio> x <pkg>` runs `bunx`; in source mode, use `process.execPath x`. Verify this works for the three adapters you use (Claude Code, Codex, Pi), each started from a minimal PATH.
   - Also resolve each tool's own command (`claude`, `codex`, `pi`) to an absolute path at join time, and write it into the service's environment or the agent file, so the service finds it.
   - The join checks this: it runs the answer path's preflight with the service's environment (the adapter starts, the tool is found) and prints `· answering: checked`, or a `!` step with the reason.
   - An adapter or tool that fails says why: the command, its exit code and the last stderr lines, never "The operation was aborted".
2. **One patio per home.** `patio up` takes an exclusive lock (a lock file with the pid, checked at start). A second start exits with "patio is already running (pid N)", and the join reuses the running one. A stale lock (dead pid) is taken over.

## Part B: the join and its prompt (live findings 4 and 6, review P0-3, P1-2, P1-5, P1-6)

1. **Ask before the first run.** The prompt's first step after install asks the three questions, in one message, with the defaults written as words ("default: questions and small requests"). Then it runs one ready-to-run command. Never print `a|b|c` in a line the model may run. Show one full command for the defaults, and a mapping for the other answers.
2. **From no terminal, without the three answers, the join does not enter the workspace.** It may start patio, sign in and confirm the computer, then exit 13 with the exact command. In a terminal it asks.
3. **Rules without a file equal the join's defaults** (`requests`, `ask-human`, `no`), never "anything".
4. **Trust steps: only the agent's tool blocks.** Configure every installed tool as today. The agent's own tool (detected or chosen) must list patio, or the join exits 12 with its `!` step. Other tools that still wait for trust are printed as `· Codex: written; trust this folder in Codex to use patio there`, and they do not block. This refines Unai's earlier decision: trusting a tool you do not use in that repo must not be required.
5. **One ending for success**, in a fixed shape a prompt can key on:
   ```
   patio is ready: <agent> is in <workspace>.
   Next: start a new <tool> session in this folder.
   Try: ask <a teammate's agent> a question about their work.
   What needs you: <web app URL>
   ```
   Rerun with nothing to do prints the same block, with the first line kept as is (`patio is ready`), so the prompt has one ending. Update the prompt to key on it.
6. **Keep the project files out of the team's repository.** Add `.mcp.json`, `.codex/config.toml` and `.pi/mcp.json` to `.git/info/exclude` when they are not tracked already, and print one line that says so. If one is tracked, do not change it; print a warning that names it.
7. **Show the three answers on the confirmation screen.** The one Confirm click covers them too.
8. **Every new agent asks the three questions.** `patio agents new` in a terminal asks them, with the first agent's answers as defaults. A pending `agents add <agent> <workspace>` stays with the agent's waiting card, and the same click confirms both.

## Part C: what waits for the person (review P0-1, P0-2)

1. **Questions for you.** A message that the rules let in but nobody answers on its own waits for the person. Show it in **Needs you** as "Questions for you". Each row has who asked, the text, and three actions:
   - **Let <agent> answer**: runs the same path as `patio answer`, from the web app's process, with the agent's tool;
   - **Reply myself**: a text field, sent as the agent's reply, through the outgoing rules;
   - **Decline**: the same as `patio reject`, with an optional reason.
   Count these rows in the sidebar badge, in `patio status` ("1 question waits for you"), and in the MCP status tool (Part E).
2. **Notify only for what waits for the person**, on macOS and on Linux (`notify-send` when present). A click opens the web app on Needs you. Do not notify for what the service answers.
3. **Tell the asker the truth.** `ask` and `wait_for_reply` results, `who` and the guide's member list say per agent "answers on its own" or "answered by @owner, may take hours". When `wait` times out on such an agent, say so.
4. **Widening outside the join needs the person.**
   - From no terminal, a change that widens the rules (`patio rules <agent> --ask anything`, `--answer yes`, and a rerun of the join with wider answers than the recorded ones) becomes a card in Needs you: "<agent> wants to answer <workspace> on its own". Narrowing applies at once.
   - The first answers of a join keep Unai's decision: they apply without a card, because the person just gave them in the chat.
   - From a terminal, it applies at once, as today.
   - Update the README's "Who confirms what" table and PRODUCT.md so they say exactly this.

## Part D: words, states and messages (review P1-3, P1-4, P1-7, P1-8, P1-9, live findings 3 and 5)

1. **`-h` and `--help` on every subcommand**, short and specific. An unknown command says `unknown command: foo` and lists the commands. `patio wait` accepts `--as` like the other agent commands.
2. **Invite links are recognized**: anything that contains `/join/` is a link; add `https://` when it is missing. A word that is not a link, on a fresh computer: "This is not an invite link. Paste the link from your invite page." Never advise `patio up` to a new user.
3. **Truthful states.**
   - Per tool: "listed", "written, waits for your trust in <tool>", "not set up".
   - Per agent: "Working", "Not in a workspace", "Waits for your three answers", "Not connected to <tool>". No "Ready" badge.
   - `patio status` exits 1 and prints the `!` steps when the agent's tool does not list patio, or when the answer preflight fails.
4. **One id.** Every command and MCP tool accepts the message id or the conversation id. `patio inbox` prints a header row and one id column.
5. **Activity in sentences**: "unai-orbit asked pablo. Sent." / "pablo asked unai-orbit. Waits for you." / "Held for you: it contains an email address." Never log a send that the server refused; log "not sent: no agent named carol". Probabilities go behind Details, and the bar shows how sure the check is.
6. **One vocabulary.** No "gatekeeper", "exchange", "grants", "held", "gate", "pair", "Jev" in anything a person or an agent reads: MCP instructions and results (`held` becomes `waiting_for_owner`), the guide, the web app, the CLI output, the agent file's comments (use the person's own workspace in examples). "rules for <agent> (in every workspace)".
7. **The answer prompt knows who it is.** `buildPrompt` names the agent and its owner without ambiguity ("You are uesteibar-orbit, the coding agent of @uesteibar. pablo asked you…"). The live answer said "Passed to uesteibar-orbit, who can confirm further". Add a test that the prompt never casts the agent as a third party.

## Part E: day 2 and the agent surface (review P1-1, P1-10, P1-11, P2)

1. **The invite page** says, above the prompt, in three short lines: what patio is; what it installs and writes (a binary in `~/.local/bin`, patio in the background, an answer service, the project files, ignored by git); what you decide (three questions, one Confirm). List the workspace's agents with their owners. Remove the "Open in the patio app" button until the app exists.
2. **`patio uninstall`**: stop the service and patio, take this computer's agents out of their workspaces, revoke this computer, remove the project entries it wrote and their exclude lines, and remove the binary on request (`--binary`). Print what it did. Confirm in a terminal; from no terminal, it needs `--yes`.
3. **`patio update`**: rerun `install.sh` from the computer's server, then restart patio and the service.
4. **Leaving a workspace** asks for confirmation in the web app: "Take <agent> out of <workspace>? It leaves #backend. Its open questions close."
5. **MCP:** `who` lists every member agent with `online` and its owner. Add a read-only `status` tool: connected, the judge, what waits for the owner. Each tool description is one or two sentences plus the pointer to `guide`. Add `leave_channel` and a list of the agent's channels.
6. **`patio rules <unknown agent>`** fails: "no agent named nobody on this computer (patio agents)".
7. **Polish from the review's P2** (all of them except 5's text, which becomes "Remove from team"):
   - Needs you shows only what waits, with one empty state; the agent list moves to Agents.
   - The confirmation page is focused (no sidebar), and the fingerprint is explained or behind Details.
   - Fix the stray borders, the horizontal scrollbars and the full-width pills.
   - Use quiet gray text or a small dot for states; keep the filled style for the one primary button.
   - Show `~` for home in the join output and the web app.
   - Fix "1 member agent(s)", "Approve once", and the `/devices` URL (use `/computers`).

## Out of scope

- Editing the three answers in the web app. Unai kept them read-only until the macOS app exists; the web app shows the commands.
- The macOS app.

## Exit gate

- Tests and scenarios for every part. At least:
  - the service answering from a minimal PATH;
  - the lock;
  - the prompt's order;
  - no workspace without the answers;
  - only the agent's tool blocking;
  - the exclude lines;
  - a question waiting for the person, answered from the web app in each of the three ways;
  - widening outside the join becoming a card;
  - `--help` on every subcommand;
  - link recognition;
  - truthful states;
  - one id;
  - Activity sentences and no false send;
  - a vocabulary test that greps the person- and agent-facing text for the banned words;
  - uninstall and update;
  - `who` with offline agents;
  - the `status` tool.
- Browser checks with screenshots: invite page, confirmation screen, Needs you with "Questions for you", Agents, Activity, the leave confirmation.
- `just verify` passes. README, `docs/poc/try-on-your-mac.md` and `docs/dev/verification.md` match.

## Constraints

- Work on `poc` in `worktrees/poc`, `git commit -- <paths>`, never push, TDD, small commits per part.
- Do not touch the live `patio-poc` services, `~/patio-demo`, or anything on the Mac. Tenex deploys and reruns the live test.
- No live model runs. Never print `.env`.

## Report

Commits per part, scenario results, `just verify` summary, screenshots, the exact new prompt text, deploy steps, what you did not do and why.
