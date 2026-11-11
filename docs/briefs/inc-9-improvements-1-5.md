# Brief: increment 9, improvements 1 to 5

Owner: Tenex (coordinator). Implementer: Pi. Authorized by Unai on 8 Nov 2026; Unai is away, so work autonomously and chain without asking.

Read first: `docs/poc/batch-2.md` (section 4, improvements 1 to 5), `docs/poc/execution.md` (increment 7 and 8 acceptances), the README, then the code.

## Scope

1. **Disposable worktree for the responder.** When the configured directory is a git repository, `answer` and `watch --answer` create a detached worktree at `HEAD` under the gatekeeper home, run the agent there, then remove it. Before removal, list any changed or new files in the audit log and in the CLI output ("discarded changes: ..."). `--in-place` (and `in_place: true` in `agent.yaml`) runs in the real directory. When an allowed action needs to change the real repository, the owner uses `--in-place` explicitly; document this. When the directory is not a git repository, run in place and print a one-line warning. For `hermes-docker`, mount the disposable worktree.
2. **Contact key pinning.** The gatekeeper stores each contact's device public keys at first use (trust on first use), per contact identity. When the exchange later returns a different key set for a pinned contact, the gatekeeper does not encrypt to or accept from the new keys: it holds those messages and shows a "keys changed" card in the web app with the old and new fingerprints, and the choices "trust the new keys" and "block". Device additions approved by the contact's own gatekeeper look the same as a swap to this gatekeeper, so they also need the card; say so in the card text. Add the fingerprints to `patio contacts` (or the closest existing command).
3. **Device revocation and durable web sessions.** In the web app's Devices page, a revoke button for each of the owner's devices (except the one serving the page, which needs a confirmation step). The exchange stops delivering to a revoked device and rejects its signatures. Web sessions and in-progress GitHub sign-ins are stored in the gatekeeper's database and survive a restart, with an expiry of 7 days for sessions and 10 minutes for sign-ins.
4. **`patio init`.** One guided, idempotent command: checks the exchange URL, starts the gatekeeper if needed, runs the GitHub sign-in, pairs the device, registers the agent name, and writes commented `grants.yaml` and `agent.yaml` files when they are missing. Every step prints what it did and skips what is done. Flags for non-interactive use in scripts and tests. The written `grants.yaml` contains the default grant with explanations, including the new default deny topic below.
5. **`patio grants test`.** `patio grants test "<text>" --from <agent> [--channel <name>] [--kind <kind>]` runs the input gate as a dry run: which grant applies, the structured checks, every Jev question with its probability, and the verdict. `--outgoing --to <agent>` runs the output gate, including DLP. No message is sent or stored. It writes no audit line, and its Jev use counts against the daily budget.

Also in this increment:

- Default grant: add the deny topic "credentials, secrets, API keys, tokens and passwords" to both gates, which closes the gap from increment 7.
- Action card: prefill "action you allow" with a short summary of the requested action taken from the message, not with "what <sender> asks for in this message". If no summary is available, leave the field empty and require the owner to type it before "Allow the action".

## Exit gate

- Scenarios: a responder that writes a file in the disposable worktree leaves the real repository unchanged and the change is listed; `--in-place` changes the real repository; a key swap at the exchange is held with a card, and trusting it releases the messages; device revocation stops delivery; a web session survives a gatekeeper restart; `patio init` on an empty home, then again (idempotent); `grants test` for deliver, hold and reject cases with the fake Jev; a secret request is rejected by the default grant.
- One live check of `grants test` with real Jev on 3 messages.
- Browser check of the keys-changed card and the Devices page, with screenshots.
- `just verify` passes. README and `docs/poc/try-it.md` updated (try-it should now start from `patio init`).

## Constraints

Work on `poc`, commit as you go with `git commit -- <paths>`, never push, TDD, small changes. Codex budget: 2 runs. Prefer the fake ACP agent.

## Report

Commits, scenarios, `just verify` summary, live results, screenshots, and what remains unverified.
