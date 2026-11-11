# Shape: the rules, agreed during the join

Status: **confirmed by Unai on 9 Nov 2026**. Implementation: `docs/briefs/inc-14-rules-at-join.md`. Decisions taken after `/impeccable shape` on 9 Nov.

Product truth: `PRODUCT.md`. The agent model: `docs/design/agents-and-setup-shape.md`.

## 1. Job and audience

A developer is joining a team. They already have a coding agent open in the terminal, and they pasted the invite page's prompt. They have not read any documentation and do not know what their rules are. Mode: **Operate**.

The join is the only moment where the person is certainly thinking about what this new team may reach. Today the agent file lands with the safe default and nobody ever sees it. The question this feature answers is: **what may this new team ask my agent, and what may it do for them?**

## 2. Outcome and proof

- **Outcome:** when the join finishes, the agent's rules are exactly the three answers the person gave, and nothing else changed.
- **Proof:**
  - after the join, `patio rules <agent>` shows the three answers in plain words;
  - the first message from the team is answered or held, as the person chose;
  - the file has no per-workspace rules.

## 3. Selected direction

**The interview happens where the person already is: the chat with their agent.** No new screen, no form, no second confirmation in the app.

- **The prompt carries the three questions.** Step 3 of the invite page's prompt becomes: ask the person these three questions in one message, with a default on each, wait for the answer, then pass them as flags.
- **The three questions are the whole vocabulary.** Everything else stays in `patio rules` and the app for later.
  1. **What may they ask you?** questions only / questions and small requests / anything they like. Secrets are never shared, whatever the answer.
  2. **May your agent change files for them?** no / only when you approve.
  3. **Should it answer this team on its own?** yes / no.
- **The CLI asks the same three** with the same defaults when a person runs it in a terminal.
- **The answers go in as flags**, so an agent can pass them: `--ask questions|requests|anything`, `--act deny|ask-human`, `--answer yes|no`.

The consequence, accepted: the agent writes settings that widen access without a second confirmation in the app, because the person just answered. The widening is capped:

- the secrets rule is not optional;
- actions can only be `deny` or `ask-human`, never a free allow-list;
- auto-answer can only be for this workspace's agents;
- the natural-language rules (`allow`, `deny`, `posture`) are not touched by the join.

## 4. Scope and boundaries

- **In scope:**
  - the three flags and the TTY prompts, with the caps enforced and a clear refusal when an answer asks for more;
  - **deleting per-workspace rule overrides everywhere**: the agent file's `workspaces: { … rules: … }`, the resolution in `grants.ts`, the guide's per-workspace wording, the web app's rules tabs, the README and the design docs. No migration, no compatibility;
  - the invite page's prompt text;
  - the Agents page shows the three answers in the same words.
- **Out of scope:** editing `allow`/`deny`/`posture` from the join; rules per workspace, in any form; rule templates; a settings form during the join.
- **Untouched:** the gates' semantics, the secrets rule, the judge, the message protocol.
- **Anti-goals:** a fourth question; the agent guessing an answer when the person does not reply (it must stop and wait); a "skip" that leaves the file half-written.

## 5. States and ranges

| State | What happens |
|---|---|
| First agent on the join | The three questions are asked with the defaults: questions and small requests; only when you approve; answer this team on its own: no |
| Second agent of the same person | The same three, with the first agent's answers as the defaults |
| Rerun of the same join | No questions: it prints the answers and the command to change them |
| Agent path without the flags | Refuses the join and prints the exact command with the three flags |
| An answer beyond the caps (for example an allow-list of actions) | Refuses, says which cap it broke, and leaves the file as it was |
| A person who does not answer | The agent waits; nothing is written |

## 6. Interaction and layout

**In the agent's chat**, one message, four lines, defaults named:

> Before I join, three questions. Reply with three answers, or say "defaults".
> 1. What may orbit ask me? **questions and small requests** (or: only questions, anything they like)
> 2. May I change files for them? **only when you approve** (or: never)
> 3. Should I answer orbit on my own? **no** (or: yes)

Then the agent runs the join with `--ask requests --act ask-human --answer no` and reports the result in the same words.

**In a terminal**, the same three, one prompt each, the default in brackets and Enter accepting it.

**In the web app's Agents page**, the card shows the three answers as sentences, with a link to `patio rules <agent>` to change them. No per-workspace tabs.

## 7. Constraints and open decisions

- Platform: CLI and MCP first; the web app only shows the result.
- The prompt has to work with a cheap model: numbered, short, one question per line, an explicit default, and the exact command to run.
- Accessibility: the terminal path must work with no TTY-reading tricks: plain lines, no cursor addressing.
- **Open:** whether the Agents page ever gets an editor for these three, or stays read-only with the command. Recommendation: read-only until the macOS app exists, then the app gets the three switches.
