// `patio --help` and `patio <command> --help` (or -h): the commands in one short list, and each command's own help,
// short and specific. Words a person and an agent read: no internal names (see test/vocabulary.test.ts).

export const OVERVIEW = `patio: your coding agent asks your teammates' agents, and answers theirs. End-to-end encrypted.

Set up:
  join <link>        the one setup command: patio on this computer, your agent, its rules, your coding tools
  status             is it working? what needs you? (exit 1 when something needs you)
  agents             your agents; agents new | add | remove
  rules <agent>      an agent's rules, in sentences; change the three answers; test a message
  connect <tool>     add patio to Claude Code, Codex or Pi as an agent
  guide              an agent's guide: who it is, its rules, how to ask and answer
  workspace new      a new workspace, with its invite link (your terminal only)
  invite             an invite link to one of your workspaces (your terminal only)
  service install    the answer service, which answers what your rules let it answer on its own
  update             install the latest patio from your server, and restart it
  uninstall          take patio off this computer
  up                 run patio on this computer in the foreground (patio join starts it for you)
  code               a code to confirm this computer on the web app's Computers page

What agents run (each acts as one agent: --as <agent>, or PATIO_AGENT):
  mcp                the MCP server, for a coding tool
  who                the agents of your workspaces, online or not, and who answers for each
  ask                send a message to an agent, or to a channel
  wait               wait for the reply to a message you sent
  inbox              the messages your agents received
  read, reply, answer, dismiss, reject
                     open, answer yourself, let the agent answer, close, or decline one message
  join, leave        join or leave a channel
  outbox, contacts, watch

Running a server:
  server             run a patio server

patio <command> --help says more about each one. patio --version prints the version.`;

const HELP: Record<string, string> = {
  join: `patio join <link> [--ask A --act C --answer Y] [--agent NAME] [--folder D] [--tool T] [--connect] [--no-wait] [--no-open]
patio join <channel> [--as A]

With an invite link: the one setup command, safe to run again. It starts patio on this computer, writes your agent's
file (NAME defaults to <login>-<workspace>, D to the git repository, T to the coding tool running the command), signs
you in and confirms this computer, puts the agent in the workspace with your three answers as its rules, and with
--connect adds patio to every coding tool installed. It ends with "patio is ready".

The three answers (asked in your terminal; from an agent, give them as flags, or nothing joins and it exits 13):
  --ask     what the workspace may ask: requests (questions and small requests, the default), questions, anything
  --act     changing files for them: ask-human (only when you approve, the default), deny (never)
  --answer  answering the workspace on its own: no (the default), yes

Exit 5: it waits for your confirmation (--no-wait); 12: a step is yours (printed with "!"); 13: the three answers.

With a channel name (or <workspace>/<channel>): the agent asks to join that channel.`,
  leave: `patio leave <channel> [--as A]

The agent leaves a channel (<workspace>/<channel> when the name is in several workspaces).`,
  agents: `patio agents [--json]
patio agents new <name> [--tool T] [--folder D]
patio agents add <agent> <workspace>
patio agents remove <agent> <workspace>

Your agents: tool, folder, workspaces, and the state of each coding tool. new creates one (its name starts with your
login and a hyphen); in your terminal it asks the three questions. add puts an agent in one of your workspaces and its
default channels; remove takes it out.`,
  connect: `patio connect <claude|codex|pi> --as <agent> [--user] [--dry-run]

Adds patio to the coding tool's MCP servers as the agent, in the agent's folder (--user: for every folder). It shows
what it writes first; --dry-run writes nothing.`,
  guide: `patio guide --as <agent>

The agent's guide: who it is, its rules in plain words, how to ask and answer, what never to do, and who is in its
workspaces. The same text its coding tool reads with the MCP tool guide.`,
  rules: `patio rules <agent> [--json]
patio rules <agent> [--ask A] [--act C] [--answer Y] [--workspace W]
patio rules <agent> test "<text>" --from <agent> [--channel C] [--kind K] [--json]
patio rules <agent> test "<text>" --outgoing --to <agent> [--channel C] [--kind K] [--json]

Shows the agent's rules: the three answers in sentences, then in full. --ask (requests, questions or anything), --act
(ask-human or deny) and --answer (yes or no, for the workspace W; its only one by default) change the answers: from
your terminal at once; from an agent, a change that widens them waits for you in the web app (exit 5), and one that
narrows them applies at once. test runs the rules on a text without sending anything (one request to the judge): exit
0 it would pass, 7 it would wait for you, 8 it would be refused.`,
  workspace: `patio workspace new <name> --agent <agent> [--tool T] [--folder D]

A new workspace with the agent in it and a default #general, and its invite link. Only from your own terminal.`,
  invite: `patio invite --workspace <name> [--expires 7d] [--uses N]

An invite link to one of your workspaces. Only from your own terminal (or in the web app).`,
  status: `patio status [--json]

You, this computer, the server, and your agents. It checks that each agent's coding tool lists patio and that the
answer service can start it, and prints each step that is yours with "!". Exit 0 when nothing needs you, 1 otherwise.`,
  service: `patio service install [--answer] [--uninstall] [--name N]

Runs patio watch (--answer: the answer service, for every agent of this computer) as your own service: a systemd user
unit on Linux, a launchd agent on macOS. patio join installs the answer service once.`,
  update: `patio update

Installs the latest patio from the server this computer uses (its install.sh), then restarts patio and the answer
service.`,
  uninstall: `patio uninstall [--binary] [--yes]

Stops the answer service and patio, takes this computer's agents out of their workspaces, revokes this computer at the
server with its own key (its agents' names stay yours, for another computer), and removes the project entries patio
wrote (and their lines in .git/info/exclude). --binary removes the patio binary too. It asks first in your terminal;
from an agent it needs --yes. A step that fails says why and what to do, and the exit code is 1.`,
  up: `patio up

Runs patio on this computer in the foreground (PATIO_HOME, PATIO_RELAY, PATIO_WEB_PORT). One per home: a second one
exits with "patio is already running (pid N)". patio join starts it in the background for you.`,
  code: `patio code

A code to confirm this computer on the web app's Computers page, valid 10 minutes. patio join does it for you.`,
  mcp: `patio mcp [--as A]

The MCP server over stdio, for a coding tool, speaking as the agent.`,
  who: `patio who [--as A]

Every agent of your agents' workspaces, online or not, with its owner, and who answers for it: "answers on its own",
or "answered by @owner, may take hours". An agent offline gets what you send once its computer connects.`,
  ask: `patio ask <agent> <text…> [--as A] [--kind question|request|report|heads-up] [--repo R] [--pr N] [--file F]… [--wait] [--timeout secs]
patio ask --channel <channel> <text…> […]

Sends a message to an agent (or to every agent of a channel), and prints its id. With --wait, prints the reply.
Exit 7: your rules (outgoing) keep it for you to decide; 8: they refuse it; 3: no such agent; 4: no shared workspace.`,
  wait: `patio wait <id> [--as A] [--timeout secs]

Waits for the reply to a message you sent (its id, or its conversation id). Exit 0 with the reply, 2 when none came in
time (it says who it waits for), 11 when no reply will come.`,
  inbox: `patio inbox [--as A] [--unread] [--all] [--rejected] [--json]

The messages your agents received, newest first, one id each. * marks unread. --all adds answered and dismissed;
--rejected lists only what was declined. Alias: list.`,
  read: `patio read <id> [--as A]

Shows one message in full and marks it read. The message id or the conversation id (a unique prefix is enough).`,
  reply: `patio reply <id> <text…> [--as A]

Answers a message yourself, once (never a reply). The message id or the conversation id.`,
  answer: `patio answer <id> [--as A] [--tool T] [--folder D] [--in-place]

Lets the agent the message reached answer it, with its own tool and folder, in a disposable copy of a git repository
(--in-place: the folder itself). The reply goes through your rules (outgoing).`,
  dismiss: `patio dismiss <id> [--as A]

Closes a message without answering it. The message id or the conversation id.`,
  reject: `patio reject <id> [--as A] [--reason <text>]

Declines a message: the sender is told it was declined, with your reason when you give one.`,
  outbox: `patio outbox [--json]
patio outbox cancel <id>

What your agents sent while the server was not reachable, sent in order once it is; cancel takes one back.`,
  contacts: `patio contacts [--json]

Each contact's keys, as first seen, and keys that changed (they wait for you in the web app).`,
  watch: `patio watch [--once] [--json] [--as A]
patio watch --answer [--once] [--as A] [--tool T] [--folder D] [--in-place]
patio watch --exec <command> [--once]

Streams new messages. --answer: the answer service, which answers what your rules let it answer on its own, each with
the tool and folder of the agent it reached. --exec runs a command for each message, the message as JSON on stdin.`,
  server: `patio server [--port 7777] [--host 127.0.0.1] [--db PATH] [--public-url URL] [--dist DIR]
patio server demo-person <login> --db PATH [--public-url URL]

Runs a patio server. GitHub sign-in needs GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET; its judge needs
TYPESAFE_API_KEY. --dist: the built binaries it serves with /install.sh. demo-person: on the server's host, a person
without GitHub and a one-time sign-in link.`,
  version: `patio --version

Prints patio's version.`,
};

// The aliases a command is also known by.
const ALIASES: Record<string, string> = { list: "inbox", exchange: "server", relay: "server", pair: "code", "--version": "version" };
export const canonical = (command: string) => ALIASES[command] ?? command;

export const helpFor = (command: string): string | null => HELP[canonical(command)] ?? null;
export const COMMANDS = Object.keys(HELP);
export const isHelpFlag = (a: string) => a === "-h" || a === "--help";
