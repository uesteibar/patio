// Each agent answers a broadcast once.
import type { Scenario } from "../lib/scenario";
import { parseInbox } from "./inbox-lib";

export default {
  name: "one-reply",
  description: "Bob answers Alice's broadcast, then tries again. The CLI refuses the second reply (exit 6), and Alice still has exactly one reply from Bob.",
  label: "deterministic",
  agents: () => ["alice", "bob", "carol"].map((handle) => ({ handle, channels: ["ops"] })),
  async run(t) {
    const convo = (await t.cli("alice", ["ask", "--channel", "ops", "Is staging healthy?"])).stdout;
    const first = await t.cli("bob", ["reply", convo, "Yes, all checks green"]);
    t.expect("Bob's first reply is sent", first.code === 0, `exit ${first.code}`);
    const second = await t.cli("bob", ["reply", convo, "Actually, the queue is backed up"]);
    t.expect("Bob's second reply is refused (exit 6)", second.code === 6 && second.stderr.includes("answers once"), second.stderr);
    const wait = await t.cli("alice", ["wait", convo, "--timeout", "2"]);
    t.expect("Alice has exactly one reply from Bob", wait.stdout === "bob: Yes, all checks green", wait.stdout);
    const carol = parseInbox(await t.cli("carol", ["inbox"]));
    t.expect("Carol sees one reply from Bob", carol.filter((r) => r.kind === "reply" && r.from === "bob").length === 1);
  },
} satisfies Scenario;
