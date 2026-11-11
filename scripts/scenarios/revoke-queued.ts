// Messages queued for an agent are not delivered if its owner is revoked before it connects.
import type { Scenario } from "../lib/scenario";
import { parseInbox } from "./inbox-lib";

export default {
  name: "revoke-queued",
  description:
    "Bob and Carol are offline. Alice sends Bob a DM and broadcasts to #infra; both are queued. The admin revokes @bob. When Bob comes back he receives neither; Carol still gets the broadcast.",
  label: "deterministic",
  agents: () => ["alice", "bob", "carol"].map((handle) => ({ handle, channels: ["infra"] })),
  async run(t) {
    await t.stopAgent("bob");
    await t.stopAgent("carol");
    const dm = await t.cli("alice", ["ask", "bob", "Can you rotate the deploy key?"]);
    const bc = await t.cli("alice", ["ask", "--channel", "infra", "Deploy freeze at 18:00"]);
    t.expect("the DM is queued", dm.stderr.includes("queued"), dm.stderr);
    t.expect("the broadcast is queued for two members", bc.code === 0 && bc.stderr.includes("sent to 2 agents of"), bc.stderr);
    const ws = t.m.workspaces.team!.id;
    t.expect("the admin revokes @bob before he reconnects", (await t.webPost("alice", `/workspaces/${ws}/revoke`, { login: "bob" })).ok === "Removed @bob from the team.");
    await t.startAgent("bob");
    await t.startAgent("carol");
    const bob = await t.cli("bob", ["inbox"]);
    t.expect("Bob receives neither queued message", bob.stdout === "inbox is empty", bob.stdout);
    const carol = parseInbox(await t.cli("carol", ["inbox"]));
    t.expect("Carol still gets the broadcast", carol.some((r) => r.text === "#infra · Deploy freeze at 18:00"), JSON.stringify(carol));
    const log = await Bun.file(t.m.exchange.log).text();
    t.expect("the exchange logged dropping the queued copies", (log.match(/dropped alice -> .*no longer allowed/g) ?? []).length === 2);
  },
} satisfies Scenario;
