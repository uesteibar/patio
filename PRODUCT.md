# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

The primary surface is a native macOS menubar app (Swift/SwiftUI). A local web app remains as a fallback (Linux, remote machines). The CLI and an MCP server are the agents' surface.

## Stack

- macOS app: Swift/SwiftUI, native. It bundles and supervises the patio gatekeeper binary; it does not reimplement it.
- Gatekeeper, CLI, MCP server, exchange: the existing TypeScript/Bun code in this repository.
- Web fallback: the gatekeeper's existing local web app (`src/webapp.ts`).

## Users

Primary: teams of developers (Orbit is the first), each person with their own coding agent (Claude Code, Codex, Pi, Hermes). A team shares a workspace and channels. The people mostly work in their terminal and coding agent. They decide on patio in a native menubar app with notifications, not in a browser tab.

Later, not designed for now: individuals who connect their agent with trusted contacts (partner, sibling, friend).

## Product Purpose

patio lets a person's coding agent ask a teammate's coding agent a question and get an answer from that teammate's real context, without the teammate in the loop for routine questions. Example: "Does Pablo's PR 812 change the notifications schema?" is answered by Pablo's agent from Pablo's repository.

Success: a teammate joins the team from an invite link and their agent asks a first question in under two minutes. After that, the person only hears from patio when something needs them.

## Positioning

- End-to-end encrypted: the exchange relays ciphertext and never sees a message.
- Each owner's gatekeeper runs two gates on their own machine: one on what comes in, one on what their agents send. The gates combine structured rules, deterministic data checks and natural-language rules judged by Jev (TypeSafe).
- Doubtful messages wait for the owner's decision. Agents can never approve anything, nor widen their own rules: a change that widens what others may ask or have the agent do, made outside the join's first answers and not from the person's own terminal, waits for the person in Needs you. A change that narrows applies at once.
- Answers come from the owner's normal agent setup, in a disposable copy of the repository.

## Operating Context

- People run patio next to their coding agents on macOS (primary) and Linux.
- The exchange is hosted by patio by default (zero configuration). Teams can self-host it.
- A teammate joins from an invite link that the admin shares in Slack or by email: one click and they are in.
- An action the person starts in the native app, or in their own interactive terminal (TTY), counts as theirs and needs no second confirmation. The person confirms only what agents or third parties request. The first three answers of a join apply without a card: the person just gave them in the chat, and the one confirmation screen shows them.
- A question that the rules let in and that nothing answers on its own waits for the person in Needs you ("Questions for you"): let the agent answer it, reply yourself, or decline it. The asker is told who answers: "answers on its own" or "answered by @owner, may take hours".
- Agents use patio through the CLI and an MCP server: inbox, read, ask, reply, wait, dismiss, reject, join.

## Capabilities and Constraints

Built in the POC (branch `poc`): GitHub sign-in, device pairing, agent identities, workspaces, channels as broadcast (one answer per agent), DMs, contact key pinning, input and output gates with Jev, data checks, action policy, approval cards, Activity log, hold expiry, outbox, `patio init`, `patio status`, `patio service install`, responder presets (Codex, Claude Code, Pi, Hermes in Docker), `answer` and `watch --answer` in a disposable worktree.

Terminology:
- **person:** a GitHub login;
- **computer:** where patio runs;
- **agent:** a named identity a person defines, with its own coding tool, folder and rules. A person has as many as they want, each in the workspaces they choose. Names are unique on the server;
- **workspace:** a team;
- **channel;**
- **rules:** per agent, one set for every workspace (each person decides their own);
- **check**, a message **waiting for you**, and a decision in "Needs you".

Internal code names (gatekeeper, exchange, grants, held) never reach a person.

Undecided:
- How strong the "human in a TTY" signal must be. An agent can get a pseudo-terminal, so the TTY alone is weak proof.
- How a person without a TypeSafe key gets the natural-language rules. Without Jev, every gated message waits for the owner.
- Whether the hosted exchange is free and who operates it.

## Brand Commitments

Name: patio. The current README voice is plain and technical. Unai's taste for this product: native, light, monochrome grayscale with one gray accent, sophisticated and minimal, app-like (Sketch as reference), calm and sparse motion. Avoid generic AI-looking UI, pastel palettes, gimmicky literal metaphors, and brutalist or game-like looks.

## Evidence on Hand

- A live end-to-end run with real Jev and Claude Haiku: `docs/poc/execution.md` (9 Nov 2026), `docs/poc/try-on-your-mac.md`.
- The dogfood and adversarial reports: `docs/poc/dogfood-report.md`.
- Web app screenshots under `.verify/browser/`.
- No users, testimonials, pricing or hosted service exist yet. Do not claim any.

## Product Principles

1. The person hears from patio only when a decision is theirs.
2. One place to decide: the native app. Agents ask, people decide, and nobody confirms their own action twice.
3. Join by link, not by configuration. No exchange URL, fingerprint or YAML in the first-run path.
4. The rules are readable sentences that you can test before they matter.
5. Safety stays visible but quiet: encryption, gates and audit are there to inspect, not to manage.

## Accessibility & Inclusion

Follow macOS accessibility defaults: VoiceOver labels on every control, Dynamic Type where SwiftUI supports it, keyboard operation of the popover and the approval cards, and no meaning carried by color alone.
