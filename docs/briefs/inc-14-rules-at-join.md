# Brief: increment 14, the rules agreed during the join

Owner: Tenex (coordinator). Implementer: Pi on Claude Opus 5.5, high thinking. Design: `docs/design/rules-at-join.md`, confirmed by Unai on 9 Nov 2026. Depends on increment 13 (per-workspace rules must be gone before this starts).

Read first: `docs/design/rules-at-join.md` (it wins on wording), `docs/design/agents-and-setup-shape.md`, `PRODUCT.md`, `src/join.ts`, `src/grants.ts`, `src/agent-file.ts`, `src/gates.ts`, `src/invite-page.ts`, `src/webapp.ts`, `README.md`.

## Outcome

Before the join finishes, the person answers three plain questions in the chat with their agent (or at the terminal), and the agent's rules become exactly those answers. Nothing else in the rules changes, and the widening is capped.

## The three answers

| Flag | Values | Becomes |
|---|---|---|
| `--ask` | `questions` \| `requests` \| `anything` | `rules.kinds`: `[question]`, `[question, request]` (plus `report`, `heads-up`), all four |
| `--act` | `deny` \| `ask-human` | `rules.actions`: only these two values are accepted by the join |
| `--answer` | `yes` \| `no` | `rules.auto_answer_in: [<workspace being joined>]` or absent |

- The secrets rule (`deny` credentials, secrets, API keys, tokens, passwords) is written if it is missing and is never removable by the join.
- The natural-language `allow`, `deny` and `posture` rules are not touched.
- `auto_answer` today is a boolean with per-contact entries. Add `auto_answer_in: string[]` (workspaces) so a person can answer a whole team on their own without touching anyone else's: an incoming message is answered automatically only when `auto_answer` is on for its sender or its channel, **and** the sender's workspace is in `auto_answer_in` when that list is present. Document the precedence in `grants.ts` and the README.

## Behaviour

1. **Agent path (no TTY).** `patio join <link> --connect …` without the three flags does not write rules silently and does not fail either: it joins everything else, then prints the exact command to finish, in the same three words, and exits 13. With the three flags, it writes them and finishes normally.
2. **Person path (TTY).** The join asks the three questions, one line each, the default in brackets, Enter accepting. The defaults: `requests`, `ask-human`, `no`. A second agent of the same person shows the first agent's answers as the defaults.
3. **Rerun.** If the agent's file already records the answers, no question is asked: print them in one line each and the command to change them (`patio rules <agent>`).
4. **Caps enforced with a clear refusal.** A value outside the table (an allow-list of actions, an unknown kind, a different workspace) is refused with a message naming the cap and the accepted values, and the file is left as it was.
5. **The invite page's prompt** asks the three questions in one message with the defaults named, waits for the answer, then runs the join with the flags. Keep it short and numbered so a cheap model follows it. Exact shape:

   ```
   3. Before joining, ask me these three questions in one message, with the defaults in bold, and wait for my answer:
      1. What may <workspace> ask you? questions and small requests / only questions / anything
      2. May you change files for them? only when I approve / never
      3. Should you answer <workspace> on your own? no / yes
      Then run the join again adding: --ask requests|questions|anything --act ask-human|deny --answer no|yes
   ```
   Keep the existing steps about the confirmation link and the new session, renumbered.
6. **The Agents page** shows the three answers as sentences, with `patio rules <agent>` as the way to change them. No editing there, no per-workspace tabs.
7. **`patio_guide`** prints the same three sentences, and the auto-answer sentence names the workspaces where it applies.

## Exit gate

- Tests: each flag mapping; the caps and their refusal messages; the secrets rule written when missing and never removed; `auto_answer_in` gating (an agent outside the listed workspaces is not auto-answered); rerun without questions; second agent inheriting the first's answers as defaults; non-TTY without flags exits 13 with the exact command.
- Scenario with a pseudo-terminal: the three prompts, Enter accepting each default, and the resulting file.
- Scenario, non-TTY: join exits 13, then the same command with the flags finishes and the file matches.
- Scenario: an agent with `auto_answer_in: [orbit]` answers a message from an orbit agent on its own, and holds one from an agent outside it.
- Browser check of the invite page's new prompt step and of the Agents page sentences. Screenshots.
- `just verify` passes. README's rules section and `docs/poc/try-on-your-mac.md` explain the three answers.

## Constraints

- Work on `poc` in `worktrees/poc`, `git commit -- <paths>`, never push, TDD, small commits.
- Do not touch the live `patio-poc` services, `~/patio-demo` or `~/.patio` on the Mac. Tenex deploys and runs live checks.
- No live model runs. Never print `.env`.

## Report

Commits, the exact prompt text shipped, scenario results, `just verify` summary, screenshots, deploy steps, and what remains unverified.
