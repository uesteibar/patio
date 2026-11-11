// A broadcast to a channel with three other member agents; two answer, and the asker's wait returns both.
import type { Scenario } from "../lib/scenario";
import { parseInbox } from "./inbox-lib";

export default {
  name: "broadcast",
  description:
    "Alice asks #release, where Bob, Carol and Dave's agents are members. All three get it; Bob and Carol answer. Alice's wait returns both replies with their senders, and the replies hang from the broadcast for every member.",
  label: "deterministic",
  agents: () => ["alice", "bob", "carol", "dave"].map((handle) => ({ handle, channels: ["release"] })),
  async run(t) {
    const ask = await t.cli("alice", ["ask", "--channel", "release", "Does PR 812 change the notifications schema?", "--pr", "812"]);
    const convo = ask.stdout;
    t.expect("the broadcast goes to the three other member agents", ask.code === 0 && ask.stderr.includes("sent to 3 agents of #release in team"), ask.stderr);
    for (const who of ["bob", "carol", "dave"]) {
      const inbox = await t.cli(who, ["inbox"]);
      t.expect(`${who} has it, marked with the channel`, parseInbox(inbox).some((r) => r.from === "alice" && r.kind === "question" && r.text.startsWith("#release · Does PR 812")), inbox.stdout);
    }
    const r1 = await t.cli("bob", ["reply", convo, "No, it only adds an index on notifications.user_id"]);
    const r2 = await t.cli("carol", ["reply", convo, "It also renames notifications.kind (see migration 0042)"]);
    t.expect("Bob and Carol answer", r1.code === 0 && r2.code === 0, `${r1.code} ${r2.code}`);
    const wait = await t.cli("alice", ["wait", convo, "--timeout", "3"]);
    const lines = wait.stdout.split("\n").sort();
    t.expect(
      "Alice's wait returns both replies, each with its sender",
      wait.code === 0 && lines.length === 2 && lines[0] === "bob: No, it only adds an index on notifications.user_id" && lines[1] === "carol: It also renames notifications.kind (see migration 0042)",
      wait.stdout,
    );
    const dave = parseInbox(await t.cli("dave", ["inbox"]));
    t.expect("Dave, who did not answer, sees both replies under the broadcast", dave.filter((r) => r.kind === "reply").length === 2);
  },
} satisfies Scenario;
