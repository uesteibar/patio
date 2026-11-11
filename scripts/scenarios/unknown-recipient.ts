// A recipient the exchange does not know: the real CLI fails straight away with exit code 3.
import type { Scenario } from "../lib/scenario";

export default {
  name: "unknown-recipient",
  description: "Alice asks for an agent called carol, which no one has registered. The CLI exits 3 at once.",
  label: "deterministic",
  agents: () => [{ handle: "alice" }],
  async run(t) {
    const ask = await t.cli("alice", ["ask", "carol", "Are you there?", "--wait", "--timeout", "5"]);
    t.expect("ask exits 3 (recipient unknown)", ask.code === 3, `exit ${ask.code}`);
    t.expect("the error says the exchange has no such agent", ask.stderr.includes("carol is not an agent on the server"), ask.stderr);
    t.expect("it fails fast rather than waiting for the timeout", ask.ms < 4000, `${ask.ms} ms`);
  },
} satisfies Scenario;
