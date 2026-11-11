# Shape: joining a team and living with patio on macOS

Status: brief for Unai's confirmation. No code. Product truth is in `PRODUCT.md`.

## 1. Job and audience

A developer in a team (Orbit first). They get an invite link in Slack from a teammate, and they work in a terminal with their coding agent. They want their agent to reach the team's agents with as little setup as possible, and then forget about patio until it needs them. Mode: **Operate**. The first run is a short task flow; day to day, it is a quiet tray app.

## 2. Outcome and proof

- **First run:** from clicking the invite link to "your agent can reach Pablo" in **under 2 minutes**. One browser visit (GitHub sign-in) and about three clicks in the app. No terminal is required, except to install the app when there is no `.dmg` yet.
- **Day to day:** the menubar icon is quiet. It shows a count only when a decision is yours. A notification lets you decide without opening anything.
- **Proof of the product:** the first screen after joining offers to send a real first question ("Ask Pablo's agent something"), and shows the answer in the app.

## 3. Today vs the target

| Today (POC) | Target |
|---|---|
| `patio init --exchange <url> --agent <name> --responder … --cwd …` | Open the app. The hosted exchange is the default; self-hosting is a setting |
| Gatekeeper as a loose background process with a PID file | The app runs and supervises the gatekeeper as a login item. You never see it |
| Pairing code, then **Pair** after comparing a fingerprint | Signing in from the app on this Mac *is* the pairing. The fingerprint lives in Settings → Devices |
| Agent name typed, then **Approve** in the browser | The agent identity is created for you (`unai-claude`) and is editable. Your click is the approval |
| Admin invites by `@login` in their web app; you must know the workspace name | Admin copies an invite link. You click it: "Pablo invited you to orbit" → **Join** |
| `patio join --workspace orbit`, then approve your own join in the browser, for each channel | **Join** once. You land in the team's default channels. Other channels are one click in the app |
| `grants.yaml` and `agent.yaml` as the interface | A Rules screen in plain sentences, with a "try a message" box. The YAML stays as the stored form and the export |
| Web app with six peer sections | A menubar popover with "Needs you" and "Conversations", plus a Settings window. The web app mirrors it as a fallback |

## 4. Selected direction

**Thesis: patio is a quiet teammate in your menubar.** Agents talk, people decide, and the app holds only what needs you.

### First run (team member)

1. **Invite link** (`https://patio.dev/join/<code>`) opens a minimal web page: "Pablo invited you to **orbit** on patio · 4 teammates." It has two buttons, **Open in patio** (deep link `patio://join/<code>`) and **Download for Mac**. The link is single-team and revocable, and it can expire.
2. **App opens on the invite** with one sheet: "Join orbit" and **Continue with GitHub**.
3. **GitHub sign-in** opens the system browser, which returns to the app (`patio://auth`). This binds the person and this Mac's device key. There is no code and no fingerprint step.
4. **Connect your coding agent:** the app detects Claude Code, Codex, Pi and Hermes on this Mac and pre-selects the ones it finds.
   - For each one it shows what it will do ("add patio to Claude Code's MCP servers") before doing it.
   - It also asks for the folder the agent answers from, defaulting to the most recent git repository.
5. **Done:** "You're in orbit. Your agent can now ask Pablo, Jorge and 2 more." Below it, a suggested first question and **Send**. The answer appears in the same sheet.

The admin's first run is the same, except step 1 is **Create a team** (name), and step 5 shows the invite link with **Copy**.

### Day to day

- **Menubar icon:** calm by default. It shows a small count when something needs you, and a distinct state when offline or misconfigured.
- **Popover:**
  1. **Needs you:** compact cards for held messages, action requests, keys changed, and agent requests to join a channel. Each card says who, what, and why it was held in one line, with the primary decisions inline: **Allow** or **Send**, **Edit**, **Decline**.
  2. **Conversations:** recent threads between your agent and others. A thread opens to the question and the answers.
  3. **Footer:** the team, the connection state, and Settings.
- **Notifications:** only for "Needs you" items, with **Allow** and **Decline** actions. Answered questions do not notify.
- **Settings window:**
  - **Team:** members, invite link, channels, and default channels.
  - **Agents:** connected coding agents, the folder each answers from, and "answers on its own" per teammate or channel.
  - **Rules:** sentences plus "try a message".
  - **Devices:** fingerprints and revoke.
  - **Activity:** the audit log, readable.

### Who confirms what

- Started by you, in the app or in your own interactive terminal: done, no second confirmation.
- Started by an agent (MCP, or a non-interactive CLI call), or by a third party: a **Needs you** card and a notification.
- **Open decision:** an agent can get a pseudo-terminal, so a TTY alone is weak proof that a human is there. Recommendation:
  - Terminal actions that only affect you (join a team you were invited to, leave, change your own rules) are accepted from a TTY.
  - Actions that widen what others can do to your agent (allow an action, turn on "answers on its own", trust changed keys) always confirm in the app. The app can require Touch ID for them.

### Rules screen

Four plain rows, each editable, with defaults for a team:
- **Teammates can ask about:** code, PRs, releases (free text)
- **Never about:** secrets (always), plus your own topics
- **My agent answers on its own:** off, or on for these teammates or channels
- **Requests to do things:** ask me, never, or allow (list)

A **Try a message** field runs the dry run (`patio grants test`) and shows the verdict and why, in a sentence.

## 5. Scope and boundaries

- In scope for this shape:
  - the hosted-exchange first run, invite links, auto-joined default channels, and the TTY/app confirmation model;
  - the macOS menubar app (onboarding, popover, notifications, Settings), and the CLI changes it needs;
  - the web fallback restructured to the same information architecture.
- Out of scope: the individual or trusted-contacts use case, Linux and Windows native apps, pricing, the hosted exchange's operations, and a mobile app.
- Untouched: the cryptography, the gates and their semantics, agent-side CLI and MCP verbs (`ask`, `reply`, `inbox`…), and the audit log format.
- Anti-goals: a dashboard; YAML in the first run; any visible exchange URL, fingerprint or "device" concept before Settings; marketing tone in the app; notifications for things that need no decision.

## 6. States and ranges

- Team size: 2 to 30 people. Channels: 1 to 20. "Needs you": usually 0, rarely more than 5 at once.
- **First run:** no agent detected (offer the CLI path and docs); GitHub sign-in cancelled; invite expired or revoked; already a member; signed in as a different GitHub user than the one invited.
- **Running:** exchange unreachable (outbox; a quiet offline state); gatekeeper crashed (the app restarts it, then says so); invalid rules (the last valid version stays; Settings shows the error).
- **Jev not configured:** see open decisions. Every gated message would wait, which is a bad first run.

## 7. Constraints and open decisions

- **Stack:** SwiftUI menubar app (`MenuBarExtra`) that bundles the patio binary (compiled with `bun build --compile`). It talks to the gatekeeper over its local socket, not through the web app. URL scheme `patio://`. Distribution: a signed, notarized `.dmg`; Homebrew cask later.
- **Visual:** native macOS. System materials, SF Pro and SF Symbols, light and dark from the system, Unai's monochrome taste within the system palette, calm motion. The web fallback follows the same IA, not a separate look.
- **Decisions:**
  1. **TTY trust (accepted 9 Nov 2026):** TTY for self-only actions; the app, with optional Touch ID, for actions that widen access.
  2. **Jev for new users (open, being discussed):** options are a TypeSafe key per person (pasted in onboarding), a team key the admin sets once and the exchange hands to members encrypted, or launching without natural-language rules (structured rules and data checks only) until there is a key.
  3. **Hosted exchange (decided 9 Nov 2026):** for now, `https://patio.example.com`, operated by Unai on the Devbox behind a tailnet-only HTTPS proxy. Invite pages live on it.
- **Build order (proposal):**
  1. Protocol and CLI: invite links, default channels, the confirmation model, `patio login` and `patio join <link>`, and a local API for the app.
  2. The SwiftUI app: onboarding first, then the popover and notifications, then Settings.
  3. The web fallback restructured.
