// A gatekeeper restarts with unread inbox items, and another with a reply nobody collected yet.
import type { Scenario } from "../lib/scenario";
import { EVERY_KIND } from "./inbox";
import { parseInbox } from "./inbox-lib";

export default {
  name: "gatekeeper-restart",
  description:
    "Bob has two unread messages and reads one; after his gatekeeper restarts, the other is still unread. Alice's gatekeeper restarts before she collects Bob's reply; `wait` still returns it.",
  label: "deterministic",
  agents: () => [{ handle: "alice" }, { handle: "bob", grants: EVERY_KIND }],
  async run(t) {
    const q1 = (await t.cli("alice", ["ask", "bob", "Who owns the billing service?"])).stdout;
    await t.cli("alice", ["ask", "bob", "I will rebase main at noon", "--kind", "heads-up"]);
    const before = parseInbox(await t.cli("bob", ["inbox", "--unread"]));
    t.expect("Bob has two unread messages", before.length === 2, `${before.length}`);

    const reply = await t.cli("bob", ["reply", q1, "The payments team (see CODEOWNERS)"]);
    t.expect("Bob answers the question, which marks it read", reply.code === 0);

    await t.stopAgent("alice");
    await t.stopAgent("bob");
    await t.startAgent("bob");
    await t.startAgent("alice");

    const after = parseInbox(await t.cli("bob", ["inbox", "--unread"]));
    t.expect("after Bob's restart only the heads-up is unread", after.length === 1 && after[0]!.text === "I will rebase main at noon", JSON.stringify(after));
    const wait = await t.cli("alice", ["wait", q1, "--timeout", "10"]);
    t.expect("after Alice's restart, wait still returns the reply she never collected", wait.code === 0 && wait.stdout === "bob: The payments team (see CODEOWNERS)", wait.stdout);
    const again = await t.cli("alice", ["wait", q1, "--timeout", "1"]);
    t.expect("the reply is returned once", again.code === 2, `exit ${again.code}`);
  },
} satisfies Scenario;
