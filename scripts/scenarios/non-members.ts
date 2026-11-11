// Agents whose owners share no workspace cannot message each other.
import type { Scenario } from "../lib/scenario";

export default {
  name: "non-members",
  description: "Alice is in workspace a, Carol in workspace c. Alice's agent cannot see or message Carol's: the exchange refuses delivery and the CLI exits 4.",
  label: "deterministic",
  agents: () => [
    { handle: "alice", workspace: "a" },
    { handle: "carol", workspace: "c" },
  ],
  async run(t) {
    const who = await t.cli("alice", ["who"]);
    t.expect("Carol's agent is not listed for Alice", !who.stdout.split("\n").some((l) => l.startsWith("carol ")), who.stdout);
    const ask = await t.cli("alice", ["ask", "carol", "Can you see this?"]);
    t.expect("ask exits 4: no shared workspace", ask.code === 4 && ask.stderr.includes("share no workspace"), ask.stderr);
    const back = await t.cli("carol", ["ask", "alice", "And this?"]);
    t.expect("the other direction is refused too", back.code === 4, `exit ${back.code}`);
    const inbox = await t.cli("carol", ["inbox"]);
    t.expect("nothing reached Carol", inbox.stdout === "inbox is empty", inbox.stdout);
  },
} satisfies Scenario;
