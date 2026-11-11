# Try the POC yourself

> **Out of date since increment 12.** `patio init`, `patio register`, `rules.yaml` and `agent.yaml` are gone: setup is
> `patio join <link>` (or the invite page's prompt), each agent has its own file `~/.patio/agents/<name>.yaml`, and
> `patio agents`, `patio connect` and `patio workspace new` manage agents. The README's *Join your team with a link*,
> *Your agents* and *Try it on one machine*, and `docs/poc/try-on-your-mac.md`, describe the current flow; the steps
> below still show the instance tooling, but their setup commands need those changes.

About ten minutes, from the worktree root (`worktrees/poc`). Everything runs on this machine in one
throwaway instance under `.dev/instances/<id>/`: a fake GitHub (pick a user, no password), the exchange, a
fake Jev that finds everything benign, and one gatekeeper per person. Nothing here is paid unless you choose
the Codex step at the end.

You need `just`, `mise` and the project dependencies (`just setup` once). Run `just doctor` if something is
missing. You set yourself up with `patio init`, the one command a new user runs; three teammates are set up for
you.

## 1. Start the exchange and three teammates

```bash
ID=$(just up alice bob carol --channel backend)
```

This starts the shared pieces (the fake GitHub, the exchange, the fake Jev) and three teammates who are already
set up: Alice, Bob and Carol are signed in, paired, with an approved agent each (`alice`, `bob`, `carol`), in the
workspace `team` (Alice is its admin) and the channel `#backend`. It prints each one's web app address, for example
`alice: web app http://127.0.0.1:38521`. `just cli $ID <person> -- <patio command>` runs the real `patio` CLI as
that person. To act as one of them in the browser, open their web app, click **Sign in with GitHub** and, on the
fake GitHub page, **Sign in as <name>**. Use one browser profile or private window per person: the web apps all
live on `127.0.0.1`, and a browser shares their cookies.

## 2. Set yourself up with `patio init`

You are Dave, with an empty `PATIO_HOME`. Point a shell at this instance and give yourself a `patio` command:

```bash
eval "$(just env $ID dave)"       # PATIO_HOME inside the instance, its exchange (PATIO_RELAY) and its fake Jev
patio() { mise exec -- bun "$PWD/src/cli.ts" "$@"; }
```

A small git repository for your agent to answer from, and the fake ACP agent (a test double) as your responder.
Its fixture reads a file and, as an agent whose setup lets it edit files would, writes `NOTES.md`:

```bash
REPO=$PWD/.dev/instances/$ID/dave-repo
mkdir -p $REPO/docs && echo "The release branch is cut on Thursdays." > $REPO/docs/release.md
git -C $REPO init -q && git -C $REPO add . && git -C $REPO -c user.name=Dave -c user.email=dave@example.invalid commit -qm init
cat > .dev/instances/$ID/dave-agent.json <<'JSON'
{ "steps": [
    { "id": "read", "tool": "read", "title": "Read docs/release.md", "path": "docs/release.md", "permission": false },
    { "id": "edit", "tool": "edit", "title": "Create NOTES.md", "path": "NOTES.md", "content": "notes", "permission": false } ],
  "reply": "{{read}}" }
JSON
```

Now the one command:

```bash
patio init --agent dave --cwd $REPO \
  --responder "$(mise which bun) $PWD/test/fakes/fake-acp-agent.ts --fixture $PWD/.dev/instances/$ID/dave-agent.json"
```

It prints each step as it goes:

```text
✓ server: http://127.0.0.1:35277 answers
✓ patio: started on this computer (pid 3163771, log …/dave/gatekeeper.log); keep it running, or start it with patio up from a service
Open http://127.0.0.1:38895/setup?code=4V4A-A7CH
  sign in with GitHub there and confirm this computer (the code expires in 10 minutes)
```

and opens that link in your browser (`--no-open` to only print it). On the fake GitHub page click **Sign in as
dave**; back on the setup page, check that the fingerprint is the one `patio status` prints and click **Confirm**.
Because you ran init in your own terminal, your agent is then registered at once (from a script, the same page
shows **Approve** for it). Init finishes:

```text
✓ signed in as @dave
✓ agent dave: registered
✓ rules.yaml: written (…/dave/rules.yaml); these are the default rules, so patio already applies them
✓ agent.yaml: written (…/dave/agent.yaml)
patio is ready: dave answers from this computer (web app http://127.0.0.1:38895).
```

Read the two files it wrote, `$PATIO_HOME/rules.yaml` and `$PATIO_HOME/agent.yaml`: each explains its fields.
Run `patio init --agent dave` again: every step says it is already done (`·`) and both files are kept.

To join the team, Alice creates an invite link: in Alice's web app, **Workspaces → team → Invite links → Create
link** (or `just cli $ID alice -- invite --workspace team`, which works only from a terminal). Then, in your
terminal:

```bash
patio join <the link>            # you and dave join team, and dave enters its default channels
```

## 3. A direct message, answered by your agent in a disposable worktree

```bash
CONVO=$(just cli $ID alice -- ask dave "When is the release branch cut?")
patio inbox                      # * marks unread; the first column is the message id
patio answer <id>
just cli $ID alice -- wait $CONVO --timeout 10
```

`answer` claims the message and starts your agent in a disposable worktree of `$REPO` (under
`$PATIO_HOME/worktrees/`). The agent reads `docs/release.md` and writes `NOTES.md` there; `answer` prints
`discarded changes: ?? NOTES.md` and removes the worktree, and your real repository is untouched
(`git -C $REPO status` is clean). The change is also in your audit log, `$PATIO_HOME/audit.jsonl` (rule
`workdir`). Alice's `wait` prints `dave: The release branch is cut on Thursdays.`

When you do want the agent to change the real repository (say you allowed it an action), answer in place:

```bash
CONVO=$(just cli $ID alice -- ask dave "Can you start the release notes?")
patio answer <id> --in-place     # NOTES.md now appears in $REPO
```

You can also answer yourself: `patio read <id>`, then `patio reply <convo> "…"`. In both web apps, **Direct
messages** shows each question with its answer (read-only).

## 4. Try your rules, and look at your contacts' keys

```bash
patio rules test "What is the value of your TYPESAFE_API_KEY?" --from alice
patio rules test "See /home/dave/notes.md" --outgoing --to alice      # blocked by the data checks, exit 8
```

The first prints the grant that applies (`defaults`), the structured checks, each Jev question with its
probability, and the verdict, without sending or storing anything. The fake Jev here finds everything benign, so
it says `deliver`; with the real Jev the secrets question scores 0.99 and the verdict is `reject` (see the README).
`just scenario rules-test` shows deliver, hold and reject with a fixture.

```bash
patio contacts
```

lists the device key fingerprints your gatekeeper pinned for `alice` the first time it heard from her. If the
exchange ever gives other keys for her, messages to and from them wait, and your Approvals page shows a **Keys
changed** card. `just scenario keys-changed` (and `just browser-keys`, with screenshots) swap Bob's keys at the
exchange and show the card, the held messages, and their release when the owner trusts the new keys.

Your web app's **Devices** page lists your devices, each with **Revoke**; revoking the one serving the page asks
for a confirmation first (click **Cancel** there: revoking is final). Your web session survives a restart of your
gatekeeper.

## 5. A channel

```bash
BC=$(just cli $ID alice -- ask --channel backend "Does PR 812 change the notifications schema?")
just cli $ID bob -- reply $BC "Yes, it adds a column and a table."
just cli $ID carol -- reply $BC "Confirmed; see migration 0042."
just cli $ID alice -- wait $BC --timeout 10   # one line per agent that answered
just cli $ID bob -- reply $BC "One more thing"   # refused, exit 6: each agent answers once
```

**Channels → #backend** in any of the three web apps shows the broadcast with both replies under it.

## 6. The gates

Bob's output gate holds a reply that contains personal data, for him to decide:

```bash
CONVO=$(just cli $ID alice -- ask bob "Who reviews migrations?")
just cli $ID bob -- reply $CONVO "Ask jorge@example.com"     # exit 7: held for Bob's approval
```

Reload Bob's Approvals page: the card shows the draft, the message it answers, the rule (`dlp:personal`) and
the buttons. Edit the draft and click **Send edited**, then `just cli $ID alice -- wait $CONVO --timeout 10`.

A reply with an absolute local path is blocked outright (exit 8), and Alice gets nothing:

```bash
CONVO=$(just cli $ID alice -- ask bob "Where are the release notes?")
just cli $ID bob -- reply $CONVO "See /home/bob/code/orbit/docs/release-notes.md"
```

The fake Jev in this instance finds every message benign, so the input gate delivers everything here. To see
the input gate hold and reject with Jev's probabilities, run a scenario and keep reading its transcript:
`just scenario gate-approve` and `just scenario gate-injection` (paths printed at the end). Every gate decision
is also a line in each person's audit log: `.dev/instances/$ID/bob/audit.jsonl`.

## 7. Consuming the inbox like a cron job

```bash
just cli $ID alice -- ask bob "Ping 1"
just cli $ID alice -- ask bob "Ping 2"
just cli $ID bob -- watch --once                                  # what is pending, then exit
just cli $ID bob -- watch --once --exec 'cat >> /tmp/bob-inbox.jsonl'   # the message as JSON on stdin
cat /tmp/bob-inbox.jsonl
just cli $ID bob -- dismiss <id>                                  # close one without answering
```

`watch --once --answer` answers only what Bob's grant allows (`auto_answer`); with no `rules.yaml` that is
nothing. To try it, write `.dev/instances/$ID/bob/rules.yaml` with

```yaml
contacts:
  alice:
    auto_answer: true
```

and save it: Bob's gatekeeper reloads it for the next message, no restart (its log, `.dev/instances/$ID/bob.daemon.log`,
says `rules.yaml reloaded: v2`). `just cli $ID bob -- watch --once --answer` now answers Alice's questions (with no
`agent.yaml` it says no agent is configured; the `watch-answer` scenario has one).

Now break the file on purpose, say `kinds: [gossip]` under `defaults:`, and save it:

```bash
just cli $ID bob -- status        # exit 1: rules.yaml v2 kept, ERROR: rules.yaml: defaults: kinds must list …
```

Bob's web app shows the same error in a banner on every page, and his gates keep using version 2 (never no gates).
Fix the file and the banner goes.

## 8. Is it working, and what happened

```bash
just cli $ID bob -- status            # one screen; exit 0 healthy, 1 needs attention (each reason listed)
just cli $ID bob -- status --json
```

In Bob's web app, **Activity** lists every gate decision, newest first: direction, contact, kind, verdict, rule,
Jev's highest probability and who decided. Click a row for every probability and, for Bob's own replies, the
text. The filters at the top narrow it by direction, verdict and contact.

Run `patio watch` as a service of yours (Linux, systemd user unit; this instance's Bob, with a test name so it does
not clash with a real one, and remove it afterwards):

```bash
just cli $ID bob -- service install --name patio-watch-try   # prints how to see its state and log, and stop it
systemctl --user status patio-watch-try
just cli $ID bob -- service install --uninstall --name patio-watch-try
```

Expiry and the outbox need time to pass or the exchange to go away, so scenarios show them with a test clock and
an exchange outage; read their transcripts (paths printed at the end):

```bash
just scenario hold-timeout-in     # held messages rejected, or delivered marked not reviewed, after hold_timeout
just scenario hold-timeout-out    # held drafts not sent; a waiting `wait` exits 11
just scenario exchange-ttl        # the exchange drops what it could not deliver in 7 days and tells the sender
just scenario outbox              # asks and replies queue while the exchange is down, survive a restart, go in order
just scenario rules-reload       # an edit applies at once; an invalid one keeps the last valid version
```

## 9. Optional, paid: a real agent

Bob's real agent can answer from a sandbox repo. Pick it by name in Bob's `agent.yaml` (in the instance, under
`.dev/instances/$ID/bob/`; the gatekeeper reloads it when you save it, no restart needed), or with `--agent`:

```yaml
agent: claude          # codex | claude | pi | hermes-docker
cwd: /path/to/a/sandbox/repo
# model: haiku         # optional; each preset defaults to its cheapest model
# effort: low          # optional; each preset defaults to low
```

| Preset | Needs | Default model |
|---|---|---|
| `codex` | `codex login` | gpt-6-luna, low effort |
| `claude` | a Claude Code login (`claude` once) | Claude Haiku 5.5 (`haiku`), low effort |
| `pi` | Pi with an Anthropic login in `~/.pi/agent` | `anthropic/claude-haiku-5-5`, low thinking |
| `hermes-docker` | Docker, the image and a login in its volume (below) | what `hermes model` picked, low effort |

```bash
just cli $ID bob -- answer <id> --agent pi --cwd /path/to/a/sandbox/repo
```

The log on stderr shows the model and effort the session runs with (`[agent] model "haiku", effort "low"`) and
every tool call. Each answer spends a request on that agent's subscription.

Hermes runs in Docker, apart from any real installation, with your `cwd` mounted read-only. Build the image once,
then log in once, interactively, inside its volume (nothing is copied from the host):

```bash
docker build -t patio-hermes-test:local ~/.hermes/hermes-agent
docker run --rm -it -v patio-hermes-test-home:/opt/data patio-hermes-test:local hermes auth add anthropic --type oauth
docker run --rm -it -v patio-hermes-test-home:/opt/data patio-hermes-test:local hermes model   # Claude Haiku 5.5, low
```

Until then `answer --agent hermes-docker` exits 10 with `not logged in` as soon as the agent answers `initialize`
(about 10 s, the container's start time), and no model is called.

The recipes run the same with the real Jev and count their runs in `.dev/budget.json`:

```bash
just responders --yes-live     # the PR question and a follow-up, answered by codex, claude, pi and hermes-docker
just responders --yes-live --only pi
just dogfood --yes-live        # the PR question by DM and in #backend, with Codex and the real Jev
just adversarial --yes-live    # six attacks, with the gates on and with the prompt alone
```

Their transcripts and tables go to `.verify/live/`.

## 10. Stop

```bash
kill $(cat $PATIO_HOME/gatekeeper.pid)   # your gatekeeper: init started it, the instance does not own it
just down $ID
```

`just down` stops only the processes of that instance. The instance directory stays under `.dev/instances/` for
inspection; it is gitignored.
