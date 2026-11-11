// An admin revokes a member; their agents can no longer exchange messages with the workspace.
import type { Scenario } from "../lib/scenario";

export default {
  name: "revoke",
  description: "Alice (admin of team) and Bob talk. Alice revokes @bob in the web app. From then on both directions are refused, and the roster shows who revoked him.",
  label: "deterministic",
  agents: () => [{ handle: "alice" }, { handle: "bob" }],
  async run(t) {
    const before = await t.cli("alice", ["ask", "bob", "Still on for the review?"]);
    t.expect("before the revoke, the message is delivered", before.code === 0, `exit ${before.code}`);
    const ws = t.m.workspaces.team!.id;
    const notBob = await t.webPost("bob", `/workspaces/${ws}/revoke`, { login: "alice" });
    t.expect("a member who is not an admin cannot revoke", !!notBob.error?.includes("only an admin"), notBob.error ?? "");
    t.expect("Alice revokes @bob in the web app", (await t.webPost("alice", `/workspaces/${ws}/revoke`, { login: "bob" })).ok === "Removed @bob from the team.");
    const roster = await t.webGet("alice", `/workspaces/${ws}`);
    t.expect("the roster shows @bob revoked, by @alice", /@bob member invited by @alice .*revoked by @alice .*Revoked/.test(roster.text), "");
    const after = await t.cli("alice", ["ask", "bob", "Are you there?"]);
    t.expect("after the revoke, Alice's message is refused (exit 4)", after.code === 4, `exit ${after.code}`);
    const reverse = await t.cli("bob", ["ask", "alice", "Hello?"]);
    t.expect("and so is Bob's", reverse.code === 4, `exit ${reverse.code}`);
    const who = await t.cli("bob", ["who"]);
    t.expect("Bob no longer sees Alice's agent", !who.stdout.split("\n").some((l) => l.startsWith("alice ")), who.stdout);
  },
} satisfies Scenario;
