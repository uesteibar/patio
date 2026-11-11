// Nobody answers an answer.
import type { Scenario } from "../lib/scenario";
import { parseInbox } from "./inbox-lib";

export default {
  name: "reply-to-reply",
  description: "Bob answers Alice's broadcast. Carol tries to answer Bob's answer, in the channel and in a DM: the CLI refuses both (exit 6).",
  label: "deterministic",
  agents: () => ["alice", "bob", "carol"].map((handle) => ({ handle, channels: ["eng"] })),
  async run(t) {
    const convo = (await t.cli("alice", ["ask", "--channel", "eng", "Who is on call this week?"])).stdout;
    await t.cli("bob", ["reply", convo, "I am, until Friday"]);
    const bobsReply = parseInbox(await t.cli("carol", ["inbox"])).find((r) => r.kind === "reply" && r.from === "bob");
    t.expect("Carol sees Bob's reply", !!bobsReply);
    const refused = await t.cli("carol", ["reply", bobsReply?.id ?? "missing", "Are you sure? I thought it was me"]);
    t.expect("answering Bob's reply is refused (exit 6)", refused.code === 6 && refused.stderr.includes("nobody answers an answer"), refused.stderr);

    // The same rule in a DM: Bob answers Alice's question; Alice cannot answer the answer.
    const dm = (await t.cli("alice", ["ask", "bob", "Can you cover Saturday?"])).stdout;
    await t.cli("bob", ["reply", dm, "Yes"]);
    const reply = parseInbox(await t.cli("alice", ["inbox", "--json"])).find((r) => r.kind === "reply" && r.convo === dm.slice(0, 8));
    const again = await t.cli("alice", ["reply", reply?.id ?? "missing", "Thanks!"]);
    t.expect("in a DM, answering the answer is refused too (exit 6)", again.code === 6, again.stderr);
  },
} satisfies Scenario;
