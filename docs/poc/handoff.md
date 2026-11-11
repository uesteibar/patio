# Handoff: patio POC, where it stopped (10 Nov 2026, 00:45)

Stopped on Unai's request ("wrap it up"). Branch `poc` in `worktrees/poc`, HEAD `3e750ca` plus this handoff. Nothing is pushed (upstream push is disabled; `main` mirrors upstream).

## State

- Increments 1 to 16 are on `poc`. Acceptance notes for each are in `docs/poc/execution.md`; briefs in `docs/briefs/`.
- Last evidence: `just verify` PASS on `3e750ca` (76 of 76 steps, 314 tests), `.verify/2026-11-09T23-37-08-072Z-3e750ca/summary.md`.
- Hosted server `https://patio.example.com` runs increment 15 (`0c8e2a0`), not 16. Units: `patio-demo-exchange` (server, `--dist ~/patio-demo/dist`), `patio-demo-pablo-gk` and `patio-demo-pablo` (the demo teammate Pablo and his answer service). The database has backups in `~/patio-demo/exchange.db.bak-*`.
- Unai's Mac runs increment 15: agent `uesteibar-orbit` (Pi in `~/code/patio-poc`, default answers, not answering on its own), launchd `dev.patio.watch`. Backups: `~/.patio.bak-tenex-2045/`. Pi trusts `~/code/patio-poc`; Codex does not.

## Increment 16 (not deployed, not live-tested)

- Done and in `verify`:
  - `patio uninstall` revokes for real, with a signed self-revoke, or exits non-zero with the reason;
  - **Move <agent> to this computer** on the confirmation screen and in the terminal.
- Unai asked at 00:30 not to do the teammates' new-keys notice nor the `Try:` choice. Pi had already built and tested them before the message arrived (`da65f1a`), so they are in. To drop them, revert the two parts of `da65f1a`: the key card's owner and computer line, and `pickTeammate` in the join ending.
- Not verified: the macOS socket lookup, a real 0.12 patio during uninstall, the live server, and launchd.

## Open, in order

1. Decide whether to keep the notice and `Try:` (see above).
2. Deploy increment 16:
   1. run `just build`;
   2. restart `patio-demo-exchange` with `patio server … --dist`; the server goes first;
   3. restart Pablo's two units.
3. Live recheck on the Mac: `patio update`, `patio uninstall --binary --yes`, then the page's prompt with Pi on Haiku 5.5 low. Expected: the old computer is revoked without the Computers page.
4. Known gaps that were left out on purpose:
   - editing the three answers in the web app (read-only until the macOS app);
   - the macOS app (increment 12 of the product plan);
   - Hermes as a responder (it needs Unai's login in the Docker volume).

## Clean-up for Unai on the Mac

```
rm -rf ~/.patio-test-chrome ~/.patio-test-*
```

Close the test Chrome window first.
