// The exchange restarts while messages for an offline agent are queued; nothing is lost.
import type { Scenario } from "../lib/scenario";
import { EVERY_KIND } from "./inbox";
import { parseInbox } from "./inbox-lib";

const MESSAGES = ["Deploy freeze starts at 18:00", "The staging database is being restored until 15:00"];

export default {
  name: "exchange-restart",
  description: "Alice sends two heads-ups to Bob while he is offline. The exchange restarts with them queued. When Bob starts, both are in his inbox.",
  label: "deterministic",
  agents: () => [{ handle: "alice" }, { handle: "bob", grants: EVERY_KIND }],
  async run(t) {
    await t.stopAgent("bob");
    for (const text of MESSAGES) {
      const ask = await t.cli("alice", ["ask", "bob", text, "--kind", "heads-up"]);
      t.expect(`queued: ${text}`, ask.code === 0 && ask.stderr.includes("queued"), ask.stderr);
    }
    await t.restartExchange();
    const who = await t.cli("alice", ["who"]);
    t.expect("Alice's gatekeeper reconnected to the restarted exchange", who.code === 0 && who.stdout.startsWith("alice · @alice · yours"), who.stdout);

    await t.startAgent("bob");
    const inbox = await t.cli("bob", ["inbox"]);
    const rows = parseInbox(inbox);
    for (const text of MESSAGES) t.expect(`Bob's inbox has, unread: ${text}`, rows.some((r) => r.unread && r.kind === "heads-up" && r.text === text), inbox.stdout);
    t.expect("nothing was delivered twice", rows.length === MESSAGES.length, `${rows.length} rows`);
  },
} satisfies Scenario;
