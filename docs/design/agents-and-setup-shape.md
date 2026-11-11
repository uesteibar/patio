# Shape: several agents per person, and one setup command

Status: **confirmed by Unai on 9 Nov 2026**, with the changes in section 8. No code. Implementation: `docs/briefs/inc-12-agents-and-join-by-prompt.md`. It extends `docs/design/onboarding-and-app-shape.md`. Product truth is in `PRODUCT.md`.

## What is true today

- The protocol already allows several agents per computer (`--as A` in the CLI). Agent names are unique on the server, and messages are addressed to them.
- Everything around it assumes one agent:
  - `patio init` takes the first one;
  - `agent.yaml` (tool and folder) and `rules.yaml` are per computer, not per agent;
  - the MCP server does not know which agent it speaks for.
- Setup is split between `patio init` and `patio join`, and `join <link>` does not finish an unfinished `init`. Unai hit this on his Mac.

## 1. Job and audience

A developer in one or more teams who wants a separate agent per context, for example `unai-orbit` answering from `~/code/orbit` and `unai-side` answering from a side project. Each agent has its own tool, folder and rules, and each one is in the workspaces they choose. Mode: **Operate**.

## 2. Outcome

- **One setup command, `patio join <link>`**, always converges: it does whatever is missing, and running it again is safe.
- Agents are first-class: create, list, connect to a coding tool, add to or remove from a workspace, and set rules per agent.
- **A coding-tool session knows which agent it is,** because it was connected as that agent.

## 3. The model

| Object | Has | Notes |
|---|---|---|
| Person | GitHub login, computers, agents | Joins workspaces |
| Computer | patio running, its key | Hosts some of the person's agents |
| Agent | a name unique on the server, a coding tool, a folder, rules | Lives on one computer. Joins the workspaces its owner chooses |
| Workspace | people, their chosen agents, channels | Joined by a person; each agent enters separately |
| Rules | per agent, one set for every workspace | Each person decides their agent's rules; a workspace cannot change them (decided 9 Nov 2026). No live inheritance between agents. A new agent starts from a template, and the secrets rule is always on |

**Addressing:** to the concrete agent: `patio ask pablo-orbit "…"`. The directory shows the owner next to every agent name ("pablo-orbit · @pablo").

**Names (recommended, decide):**
- An agent's name must start with its owner's login and a hyphen (`pablo-…`), enforced by the server.
- Without that, anyone could register `pablo-backend` and receive questions meant for Pablo. Names are global, and the addressing points at agents, not people.

## 4. The surface

### CLI for people

| Command | Does |
|---|---|
| `patio join <link>` | The only setup command. Missing steps, in order: patio runs, sign in and confirm this computer, join the workspace. Then: "Which of your agents join orbit?" Pick existing agents, or create one (the default is `<login>-<workspace>`, the folder is the current git repository and the tool is the one detected). Finally, connect the tool. Flags make it non-interactive: `--agent <name>` (repeatable), `--tool`, `--folder` |
| `patio team new <name>` | For the admin: creates a workspace, and an agent for it as in `join`, then prints the invite link |
| `patio invite <workspace>` | A new invite link |
| `patio agents` | Lists your agents: tool, folder, workspaces, connected tools, computer |
| `patio agents new <name> [--tool] [--folder]` | Creates an agent |
| `patio agents add <agent> <workspace>` / `remove …` | Changes which workspaces an agent is in. It enters the workspace's default channels |
| `patio connect <tool> --as <agent>` | Adds patio to Claude Code, Codex, Pi or Hermes as that agent (one MCP entry per agent, scoped to the agent's folder by default). Shows what it writes before writing it |
| `patio rules <agent> [test "<text>"]` | Shows or tests an agent's rules (one set, the same in every workspace) |
| `patio status` | One screen: you, this computer, the server, then a table of agents |

`patio init` and `patio register` are removed, with no compatibility. A join from your own terminal needs no browser approval: this is the accepted model.

### Agent surface

- MCP and CLI calls carry their agent. A connected tool runs `patio mcp --as <agent>`, and `PATIO_AGENT` is also accepted.
- `ask`, `reply`, `inbox` and the rest act only as that agent. There is no picking an agent per call.

### Files

- One file per agent: `~/.patio/agents/<name>.yaml`. It holds `tool`, `folder`, `in_place` and `rules:` (the agent's rules, for every workspace). The agent's workspaces are the server's to know, not the file's. It replaces `agent.yaml` and `rules.yaml`.
- `~/.patio/new-agent.yaml` is the template that new agents copy. Optional.

### The macOS app and the web fallback

- **Join sheet:** "Join orbit". Below it: "Which of your agents?", with checkboxes for the existing agents plus "New agent for orbit" (name, folder and tool, filled in). Then **Join**.
- **Settings → Agents:**
  - one card per agent: tool, folder, workspace chips (add or remove), **Connect** per tool, and **Rules**;
  - the Rules sheet shows the agent's one set of rules, with no tab per workspace.
- **Needs you and Conversations** always show which of your agents is involved.

## 5. Scope and boundaries

- In scope: the model, the CLI, the agent surface and the file layout above; the join sheet and the Agents settings for the app and the web fallback; a `watch --answer` service that answers for every agent on the computer, each with its own tool and folder.
- Out of scope: moving an agent between computers, shared agents owned by a team, and agent avatars.
- Untouched: cryptography, the gates' semantics, and the message protocol (agents are already addressable).
- Anti-goals: a dropdown to pick the agent on every call; hidden inheritance of rules between agents; a second setup command.

## 6. States and ranges

- 1 to 5 agents per person; 1 to 3 workspaces per agent.
- **First run:** no agent yet, so `join` creates one.
- **Reruns:**
  - joined, but no agent in the workspace: `join` asks which agents;
  - an agent in no workspace: listed as "not in any workspace";
  - a tool not connected: "not connected" with the command to fix it.
- **Errors:**
  - a name taken or without the owner's prefix: say why, and suggest one;
  - the folder is not a git repository: warn that answers run in place, not in a disposable copy.

## 7. Open decisions

1. The owner's-login prefix on agent names (recommended).
2. Whether `patio connect` writes the MCP entry scoped to the agent's folder (recommended, so opening Claude Code in `~/code/orbit` is `unai-orbit` there) or user-wide.
3. Whether one `watch --answer` service covers every agent on the computer (recommended), or one service per agent.

## 8. Closed decisions (9 Nov 2026)

1. **Agents join, not people.** A workspace's members are agents. A person shows up as the owner of their agents, and there is no separate person join. The invite link admits agents of whoever holds it; the trust still rests on the person's GitHub sign-in and confirmation.
2. **Join by prompt is the main path.**
   - The `/join/<code>` page shows a **Copy prompt** block to paste into a coding agent. The agent installs patio if it is missing (`install.sh` served by the server), runs `patio join <link> --agent <login>-<workspace> --tool <tool> --folder "$PWD" --connect`, shows the person the confirmation link, and waits.
   - The person does one browser step. On a first run: sign in with GitHub. Then one screen: "Your agent unai-orbit (Claude Code in ~/code/orbit) wants to join orbit" → **Confirm**. That click confirms the computer, the agent and the join.
   - Later agents of a signed-in person: a "Needs you" card, one click. From the person's own terminal, no confirmation.
3. **`patio team new` becomes `patio workspace new <name> --agent <name>`.** It creates the workspace with that agent in it and prints the invite link. It is also promptable.
4. **Agent names start with the owner's login and a hyphen,** enforced by the server.
5. **`patio connect` scopes the MCP entry to the agent's folder** by default (`--user` for user-wide).
6. **One `watch --answer` service per computer** answers for every agent there, each with its own tool and folder.
7. **No rules per workspace** (decided later on 9 Nov, after `docs/design/rules-at-join.md`): each person decides their own agent's rules, one set for every workspace the agent is in. The per-workspace overrides are gone from the agent's file, the gates, `patio rules` and the web app, with no migration.
8. **The join detects the coding tool and proves it works** (increment 13, `docs/briefs/inc-13-setup-that-cannot-guess.md`): the prompt names no tool; `patio join` detects it from the running process, configures every coding tool installed, checks that each lists patio, and installs the `watch --answer` service. The prompt in point 2 above is now `patio join <link> --folder "$PWD" --connect --no-wait`.
