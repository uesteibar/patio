// Upstream PR question flow, consumed the increment-5 way: Alice asks Bob about a PR; Bob's `patio watch --once
// --exec` runs his own script with the message as JSON on stdin, and the script answers with `patio reply`.
import { join } from "node:path";
import { PATIO_CLI } from "../lib/paths";
import type { Scenario } from "../lib/scenario";
import { parseInbox } from "./inbox-lib";

// Bob's handler: reads the message from stdin and replies through the patio CLI (PATIO_HOME comes from watch).
const HANDLER = `const m = await Bun.stdin.json(); const p = Bun.spawnSync([process.execPath, ${JSON.stringify(PATIO_CLI)}, "reply", m.id, "PR " + m.context.pr + " is green, merging today (asked by " + m.from + ")"]); process.exit(p.exitCode)`;

export default {
  name: "pr-question",
  description: "A question about PR 812 reaches Bob's inbox and waits. Bob's `watch --once --exec` runs his script, which answers with `patio reply`; Alice's `wait` prints the reply.",
  label: "deterministic",
  agents: () => [{ handle: "alice" }, { handle: "bob" }],
  async run(t) {
    const who = await t.cli("alice", ["who"]);
    t.expect("both agents are listed, each with its owner, online, and who answers", who.code === 0 && who.stdout === "alice · @alice · yours\nbob · @bob · online · answered by @bob, may take hours", who.stdout);
    const ask = await t.cli("alice", ["ask", "bob", "Is PR 812 going to merge today?", "--pr", "812"]);
    t.expect("ask exits 0", ask.code === 0, `exit ${ask.code}`);
    let inbox = await t.cli("bob", ["inbox"]);
    for (let i = 0; i < 30 && !inbox.stdout.includes("Is PR 812"); i++) (await Bun.sleep(100), (inbox = await t.cli("bob", ["inbox"])));
    const row = parseInbox(inbox)[0];
    t.expect(
      "the question waits, unread, in Bob's inbox: a header row, then one id per message",
      /^\s*ID\s+FROM\s+KIND\s+STATE\s+MESSAGE/.test(inbox.stdout.split("\n")[0]!) && !!row && row.unread && row.from === "alice" && row.kind === "question" && row.text.startsWith("Is PR 812"),
      inbox.stdout,
    );
    const handler = join(t.m.root, "bob-handler.ts");
    await Bun.write(handler, HANDLER);
    const watch = await t.cli("bob", ["watch", "--once", "--exec", `${process.execPath} ${handler}`]);
    t.expect("watch --once --exec ran Bob's script once, and it succeeded", watch.code === 0 && /"exit_code":0/.test(watch.stdout) && watch.stdout.split("\n").length === 1, watch.stdout);
    const wait = await t.cli("alice", ["wait", ask.stdout, "--timeout", "10"]);
    t.expect("Alice receives the reply", wait.code === 0 && wait.stdout === "bob: PR 812 is green, merging today (asked by alice)", wait.stdout);
    const all = await t.cli("bob", ["inbox", "--all"]);
    t.expect("Bob's question is now answered", parseInbox(all).some((r) => r.state === "answered" && r.text.startsWith("Is PR 812")), all.stdout);
  },
} satisfies Scenario;
