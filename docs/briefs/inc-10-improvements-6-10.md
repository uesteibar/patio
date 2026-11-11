# Brief: increment 10, improvements 6 to 10

Owner: Tenex (coordinator). Implementer: Pi. Authorized by Unai on 8 Nov 2026; Unai is away, so work autonomously and chain without asking.

Read first: `docs/poc/batch-2.md` (section 4, improvements 6 to 10), `docs/poc/execution.md` (increment 9 acceptance), the README, then the code.

## Scope

6. **Hot reload of `grants.yaml` and `agent.yaml`.** The gatekeeper watches both files. A valid edit takes effect for the next message without a restart. An invalid edit keeps the last valid version and reports the error in three places: the gatekeeper log, `patio status`, and a banner in the web app. It never falls back to no gates.
7. **Expiry.** `hold_timeout` in the grant (default 24 hours) with `on_timeout: reject` (default, with the category "not reviewed in time") or `inbox` (deliver to the inbox marked "not reviewed"). Held outgoing drafts expire to "not sent", and the agent's CLI or MCP call reports it if it is still waiting. The exchange drops undelivered ciphertext after a TTL (default 7 days) and tells the sender's gatekeeper "expired undelivered". Add a test clock so scenarios do not sleep.
8. **Local outbox.** When the exchange is unreachable, `ask` and `reply` pass the output gate, are queued encrypted in the sender's gatekeeper, and are sent in order on reconnect. The CLI says "queued, will send when the exchange is reachable". `patio outbox` lists queued items, and `patio outbox cancel <id>` cancels one. A queued item past the TTL expires as in point 7.
9. **Activity view.** A web app page "Activity": a timeline of the audit log, newest first. Each row has direction, contact or channel, kind, verdict, the rule, the top probability, and who decided (gate, owner, timeout). Each row expands to show the probabilities and, for the owner's own messages only, the text. Filters for direction, verdict and contact. Read-only.
10. **`patio status` and `patio service install`.** `status` prints one screen: signed-in identity, exchange reachability, agent name and approval, grants version and errors, pending approvals, inbox counts by state, outbox size, and the configured responder. Exit 0 when healthy, 1 when something needs attention. `--json` is also available. `service install [--answer] [--uninstall]` writes a systemd user unit on Linux or a launchd agent on macOS that runs `patio watch` (or `watch --answer`), and prints how to inspect and stop it. Test it on Linux with `systemctl --user` in a scenario that installs, checks the state and uninstalls; the scenario uses a unit name with a test suffix and must clean up. Generate the macOS plist and test it with a golden file only.

Also in this increment (from the increment 9 acceptance):

- A revoked device's agent names can be registered again on another device of the same owner.
- Rerun `just smoke-gates --yes-live` once and confirm the always-on secrets question does not block legitimate replies.
- The dogfood rerun uses the default disposable worktree; check its answers and the discarded-changes report.

## Exit gate

- Scenarios for each point with the fake Jev and the fake ACP agent, including: an invalid grants edit keeps the old grant and is reported; a hold expires to reject and to inbox; exchange TTL expiry notifies the sender; the outbox survives an exchange outage and a gatekeeper restart, keeps order, and cancel works; `status` healthy and unhealthy; the service unit installs and uninstalls.
- Browser check of the Activity page and the invalid-grants banner, with screenshots.
- `just dogfood --yes-live` rerun once with Codex (GPT-6-Luna low) to show nothing regressed end to end.
- `just verify` passes. README, `docs/poc/try-it.md` and `docs/dev/verification.md` updated.

## Constraints

Work on `poc`, commit as you go with `git commit -- <paths>`, never push, TDD, small changes. Codex budget: 4 runs.

## Report

Commits, scenarios, `just verify` summary, dogfood result, screenshots, and what remains unverified.
