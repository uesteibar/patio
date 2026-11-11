// An agent that is not a member of a channel receives nothing from it, and cannot post to it.
import type { Scenario } from "../lib/scenario";

export default {
  name: "channel-outsider",
  description: "Jorge's agent is in the workspace but not in #payments. Alice's broadcast and Bob's reply never reach it, and it cannot broadcast there (exit 4).",
  label: "deterministic",
  agents: () => [{ handle: "alice", channels: ["payments"] }, { handle: "bob", channels: ["payments"] }, { handle: "jorge" }],
  async run(t) {
    const ask = await t.cli("alice", ["ask", "--channel", "payments", "Are refunds paused?"]);
    t.expect("the broadcast goes to one other member", ask.stderr.includes("sent to 1 agent of"), ask.stderr);
    await t.cli("bob", ["reply", ask.stdout, "Yes, until the migration finishes"]);
    const inbox = await t.cli("jorge", ["inbox"]);
    t.expect("nothing from #payments reaches Jorge's agent", inbox.stdout === "inbox is empty", inbox.stdout);
    const post = await t.cli("jorge", ["ask", "--channel", "payments", "Can I join?"]);
    t.expect("Jorge's agent cannot broadcast to a channel it is not in (exit 4)", post.code === 4, `exit ${post.code}: ${post.stderr}`);
    const join = await t.cli("jorge", ["join", "payments"]);
    t.expect("it can ask to join, which waits for its owner (exit 5)", join.code === 5 && join.stdout === "#team/payments: waiting for you", join.stdout);
  },
} satisfies Scenario;
