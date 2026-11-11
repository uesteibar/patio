// `patio status` says whether patio on this computer works and what needs the owner: you, this computer, the server,
// and a table of agents.
import { expect, test } from "bun:test";
import { connectWarnings, formatStatus, withAttention, type AgentRow, type StatusReport } from "../src/status";

const agent = (o: Partial<AgentRow> = {}): AgentRow => ({
  name: "bob-orbit",
  status: "approved",
  workspaces: ["orbit"],
  tool: "claude",
  folder: "~/code/orbit",
  in_place: false,
  file: true,
  error: null,
  connected: ["claude"],
  ...o,
});
const healthy: StatusReport = {
  connected: true,
  relay: "ws://127.0.0.1:7777",
  device: "0123456789abcdef0123456789abcdef",
  label: "laptop",
  login: "bob",
  revoked: false,
  agents: [agent(), agent({ name: "bob-side", workspaces: ["side", "orbit"], tool: "codex", folder: "~/code/side", connected: [] })],
  web_url: "http://127.0.0.1:7801",
  unread: 1,
  files: [],
  judge: { kind: "server", url: "http://127.0.0.1:7777" },
  pending: { held_in: 0, held_out: 0, keys: 0, identities: 0, rules: 0, questions: 0, rule_requests: 0 },
  inbox: { unread: 1, read: 0, claimed: 0, failed: 0, answered: 2, dismissed: 0, rejected: 1 },
  outbox: 0,
  setup: null,
};

test("healthy: you, this computer, the server, and a table of agents", () => {
  const s = withAttention(healthy);
  expect(s.healthy).toBe(true);
  expect(s.attention).toEqual([]);
  const text = formatStatus(s);
  expect(text).toStartWith("you: @bob\nthis computer: laptop (0123 4567 89ab cdef 0123 4567 89ab cdef); web app http://127.0.0.1:7801\n");
  expect(text).toContain("server: ws://127.0.0.1:7777 (connected); judge: the server's (http://127.0.0.1:7777/judge)");
  expect(text).toContain("inbox: 1 unread, 0 read, 0 claimed, 0 failed; 2 answered, 0 dismissed, 1 rejected; outbox: 0 queued");
  const table = text.split("\n").filter((l) => /^(AGENT|bob-)/.test(l));
  expect(table).toEqual([
    "AGENT      STATE    TOOL         FOLDER        WORKSPACES   CODING TOOLS  COMPUTER",
    "bob-orbit  Working  Claude Code  ~/code/orbit  orbit        claude        laptop",
    "bob-side   Working  Codex        ~/code/side   side, orbit  none          laptop",
  ]);
  expect(text).toEndWith("status: healthy");
});

test("each thing that needs the owner is listed", () => {
  const s = withAttention({
    ...healthy,
    connected: false,
    outbox: 2,
    agents: [agent({ error: "agents/bob-orbit.yaml: rules: on_doubt must be ask-human or reject" }), agent({ name: "bob-lone", workspaces: [] }), agent({ name: "bob-nofile", file: false })],
    judge: { kind: "none" },
    pending: { held_in: 1, held_out: 1, keys: 1, identities: 0, rules: 1, questions: 1, rule_requests: 0 },
    inbox: { ...healthy.inbox, failed: 1 },
  });
  expect(s.healthy).toBe(false);
  expect(s.attention).toEqual([
    "not connected to the server at ws://127.0.0.1:7777 (2 messages wait in the outbox)",
    "agents/bob-orbit.yaml: rules: on_doubt must be ask-human or reject (patio keeps the last valid version; fix the file, it is reloaded on save)",
    "bob-lone is not in any workspace: patio agents add bob-lone <workspace>, or patio join <link> --agent bob-lone",
    "bob-nofile has no file: patio agents new bob-nofile --tool <tool> --folder <dir> writes one",
    "no judge: every message waits for you",
    "1 question waits for you in the web app: http://127.0.0.1:7801",
    "2 messages wait for you in the web app: http://127.0.0.1:7801",
    "1 contact changed keys: trust or block them in the web app",
    "1 setting in your agents' rules widens what others can do (auto_answer, actions) and stays off until you turn it on in the web app: http://127.0.0.1:7801",
    "1 message in the inbox failed: see patio inbox",
  ]);
  expect(formatStatus(s)).toContain("status: needs attention\n  - not connected");
});

test("not signed in, or signed in without an approved agent", () => {
  expect(withAttention({ ...healthy, login: null, agents: [] }).attention).toEqual(["not signed in: patio join <link> signs you in"]);
  expect(withAttention({ ...healthy, agents: [agent({ status: "pending" })], pending: { ...healthy.pending, identities: 1 } }).attention).toEqual([
    "no agent yet: patio join <link> --agent <name> sets one up",
    "1 agent waits for your confirmation in the web app",
  ]);
});

test("the judge in use: a local key wins over the server's", () => {
  expect(formatStatus(withAttention({ ...healthy, judge: { kind: "local" } }))).toContain("judge: this computer's key (TYPESAFE_API_KEY)");
});

test("patio agents warns about an agent whose own tool has no patio entry in its folder, with the command that fixes it", () => {
  expect(connectWarnings(healthy.agents)).toEqual(["bob-side: Codex in ~/code/side has no patio entry, so a Codex session there is not bob-side: patio connect codex --as bob-side"]);
  // Connected user-wide counts; a tool patio does not connect (Hermes) has nothing to warn about.
  expect(connectWarnings([agent({ connected: ["claude (user)"] }), agent({ tool: "hermes-docker", connected: [] }), agent({ tool: "pi", connected: ["claude"] })])).toEqual([
    "bob-orbit: Pi in ~/code/orbit has no patio entry, so a Pi session there is not bob-orbit: patio connect pi --as bob-orbit",
  ]);
});
