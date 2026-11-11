# Review and security audit: report

Worker: Pi on `poc-review` (worktree `worktrees/review`), brief `docs/briefs/review-and-security-audit.md`.
Phase 1 reviewed `50e0f06`; Phase 2 ran on top of it and then merged `poc` at `40ad377` (increment 10 complete).
Documents: `docs/review/product-review.md`, `docs/review/security-audit.md`, this report.

## Findings

| Id | Severity | Finding | Status |
|---|---|---|---|
| S1 | high | The signed channel name and workspace are not checked against the exchange: a channel member picks which of the recipient's channel grants applies (auto_answer, allowed actions) and what label the owner sees | fixed `db834e6` (after the review, brief `docs/briefs/fix-s1-channel-binding.md`) |
| S2 | medium | The responder and `watch --exec` inherited the CLI's whole environment, including `TYPESAFE_API_KEY` (Bun autoloads `.env`) | fixed `d193c92` |
| S3 | medium | Channels and Direct messages pages were readable by any signed-in human, not only the owner | fixed `981b4b9` |
| S4 | medium | DLP bypassed by zero-width, bidi, soft-hyphen and fullwidth characters | fixed `010a697` |
| S5 | medium | No quotas at the exchange (mailbox, pending identities, connections) | accepted for the POC (local exchange, members only) |
| S6 | low | Any GitHub account can sign in at the exchange | accepted for the POC; must change before a shared exchange |
| S7 | low | The local socket trusts every process of the user | accepted (proposal 2.7) |
| S8 | low | Message fragments in logs | accepted for the POC |
| S9 | low | Loopback-only cookie and transport settings | accepted for the POC |
| S10 | low | Pairing codes guessable without rate limit | accepted (entropy); rate limit before a shared exchange |
| S11 | low | The exchange can delay or reorder within the TTL | accepted (by design) |
| S12 | low | A DM reply was accepted from any contact who knew the id; a broadcast reply from another channel | fixed `17c3352` |
| S13 | low | Grants can switch a gate off silently (`ask: 1`, bare channel keys, `allow` replaces, `per_day: 0`) | mitigated: `patio grants check` warns, `35cf22c` |
| S14 | low | Agent name existence leak | accepted |
| S15 | info | XSS, CSRF, clickjacking, open redirects, OAuth state, handoff, sessions: reviewed, none found; Activity page reviewed after the merge, clean | — |
| S16 | info | The responder can read the owner's keys and inbox | accepted (proposal 2.6) |
| S17 | low | Unbounded in-flight OAuth sign-ins at the exchange | fixed `8ebcb94` |
| S18 | info | Dependencies: `bun audit` clean, adapters version-pinned | accepted |
| S19–S22 | info | Exchange metadata, Jev sees plaintext, revoked devices, command injection and traversal: reviewed, no gap | — |

Every fix has a test that failed before it and passes after it (S17 checked by stashing the fix).

## Improvements made

| # | Improvement | Commit |
|---|---|---|
| P2 | `patio grants check`: the resolved grant per entry and five warnings (judge off, per_day 0, bare channel key, allow replaces, unreviewed with auto_answer); README section and command table | `35cf22c` |

Proposed in the product review and not done (time): P3 context on the incoming card, P4 telling the
sender when a draft is rejected or expires, P5 retry cap for `watch --answer`, P6 glossary and README safety note.

## Commits on `poc-review` (after the brief)

```
c1d7b34 Review: product review and security audit (Phase 1)
010a697 S4: DLP normalizes NFKC and strips format characters before scanning
d193c92 S2: the responder gets no TYPESAFE_*, GITHUB_CLIENT_* or PATIO_* variables; watch --exec no secrets
17c3352 S12: a reply to a DM only from its addressee; a reply to a broadcast only from the same channel
8ebcb94 S17: the exchange prunes expired OAuth sign-ins and bounds those in flight
35cf22c P2: patio grants check
8fbf4f5 Merge branch 'poc' into poc-review (increment 10 at 40ad377)
981b4b9 S3: Channels and Direct messages pages are the owner's only
<docs>  Report and audit status update (docs/review only)
```

## `just verify`

Run on `981b4b9` (the last code commit; the commits after it change only `docs/review/`). Result: see the line
below, filled in when it finished.

**PASS**, 66 of 66 deterministic steps (doctor, check with typecheck and the full test suite, every scenario, mcp-probe, the browser checks, `actions --fake`, `responders --fake`), evidence in `.verify/2026-11-09T02-05-14-451Z-981b4b9/summary.md`. The summary marks the tree dirty: the only uncommitted files while it ran were `docs/review/security-audit.md` and `docs/review/report.md` (this update), no source.

No live run was made: every fix is covered by deterministic tests, and no responder or Jev budget was spent.

## What I would do next, in order

1. ~~**S1**~~: done in `db834e6`, see "S1 fix" below.
2. **P3** context on the incoming card and **P4** a decline to the sender when a draft is rejected or expires: both
   small, both change what a new user understands first.
3. **P5** a retry cap for `watch --answer` as a service.
4. Before any shared exchange: S5 quotas, S6 invite-only sign-in, S10 pairing rate limit, S9 TLS and cookie flags.
5. **P6** and the README safety note on S16; a per-port cookie name for two gatekeepers in one browser.

## S1 fix (after the review)

Brief `docs/briefs/fix-s1-channel-binding.md`, on `poc`, commit `db834e6`. Before the input gate, the receiving
gatekeeper asks the exchange `channel_keys` for the signed channel id as the receiving agent (remembered per id for
the session) and rejects the message when the signed name or workspace differs or the sender is not a member: audit
`rule: channel-binding`, `verdict: rejected`, no notice to the sender. While the exchange cannot answer, the message
stays `checking` and is decided on reconnect; every reconnect now re-gates `checking` messages, not only the first.
Two tests in `test/channels.test.ts` (lying name and workspace with `rawToChannel`; the exchange unreachable mid-check
through `test/helpers/proxy.ts`) failed before and pass after. `just verify`: PASS, 66 of 66 deterministic steps, 227
tests, `.verify/2026-11-09T09-55-48-803Z-db834e6/summary.md`. No live run.

## Limits of this review

- Read-only reasoning on the code plus the project's own scenarios; no fuzzing, no live attack runs against a real
  responder or Jev.
- The time stamps in my session were wrong for most of the work (the shell reported 00:10–00:22 while it was later),
  so Phase 2 was cut short: S1, the one high finding, was designed and documented but not implemented; it was fixed
  afterwards (`db834e6`).
