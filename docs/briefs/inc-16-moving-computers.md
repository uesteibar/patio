# Brief: increment 16, moving to a new computer without a dead end

Owner: Tenex (coordinator). Implementer: Pi on Claude Opus 5.5, high thinking. Part of Unai's autonomous go of 9 Nov 2026. Every item is decided. Work autonomously.

Read first: the end of `docs/poc/execution.md` (section "Increment 15 accepted", findings 1 to 3), `src/join.ts`, the uninstall code, `src/directory.ts`, `src/webapp.ts` (the confirmation page).

## Why

On Unai's Mac:
1. `patio uninstall` met an old patio without the lock. It printed `unknown endpoint`, exited 0 and did not revoke the computer. A rerun said "not signed in; nothing to revoke".
2. The next join's Confirm failed with "uesteibar-orbit lives on another of your computers". The only way out was to find the Computers page and revoke the old one.

## Changes

1. **`patio uninstall` revokes for real, or says it did not.**
   - It revokes this computer on the server with the computer's own key (a signed self-revoke), whether or not a person is signed in locally. Add the server endpoint if it is missing.
   - It stops any patio on this home, also one without the lock: use the pid file, then the socket's owner.
   - Any step that fails prints the reason and the next action, and the command exits non-zero. Never print a raw `unknown endpoint`.
2. **The confirmation screen resolves "lives on another of your computers".**
   - When the agent belongs to another computer of the same person, the screen says so with the other computer's name and when it was last seen. It offers one action: **Move <agent> to this computer**, which revokes the other computer's claim on that agent (not the whole computer, unless it has no agents left) and confirms here.
   - The same case from a terminal join asks in the terminal.
3. **Tell the person who moved what teammates will see.**
   - After a move, the join's ending adds one line: "Your teammates' patio will ask them to trust this computer's new keys before your messages reach them."
   - The asker's side already shows a key change card. Add the owner's login and the new computer's name to that card.
4. **`Try:` suggests an agent that answers**: an online agent of the workspace, else the inviter's agent, never an offline demo agent when an online one exists.

## Exit gate

- Scenarios:
  - uninstall with a patio that holds no lock (start one with the lock check disabled in the test) revokes the computer, exits 0, and the agent name is free;
  - uninstall when the server refuses: non-zero exit with the reason;
  - a join on a second computer for an agent bound to the first one, with **Move** on the confirmation screen, then a teammate's key change card naming the owner and computer;
  - the `Try:` choice.
- Browser check of the confirmation screen's move case, with a screenshot.
- `just verify` passes. README and `docs/poc/try-on-your-mac.md` describe moving computers.

## Constraints

- Work on `poc` in `worktrees/poc`, `git commit -- <paths>`, never push, TDD, small commits.
- Do not touch the live `patio-poc` services, `~/patio-demo` or the Mac.
- No live model runs. Never print `.env`.

## Report

Commits, scenario results, `just verify` summary, screenshot, deploy steps, what remains unverified.
