// Offline delivery: Alice asks Bob while his gatekeeper is down. The exchange keeps only ciphertext. Bob
// starts, finds the message unread in his inbox, reads it and replies; Alice's `wait` returns the reply.
import { plaintextMarker, type Scenario } from "../lib/scenario";
import { parseInbox } from "./inbox-lib";

export default {
  name: "offline-delivery",
  description: "Alice asks Bob while he is offline. The message waits in the exchange as ciphertext, reaches Bob's inbox when he starts, and his reply reaches Alice's `wait`.",
  label: "deterministic",
  agents: () => [{ handle: "alice" }, { handle: "bob" }],
  async run(t) {
    // Each piece of text and context carries its own random marker; the database scans look only for those.
    const m = { text: plaintextMarker("QTEXT"), repo: plaintextMarker("QREPO"), pr: plaintextMarker("QPR"), file: plaintextMarker("QFILE"), reply: plaintextMarker("RTEXT") };
    const QUESTION = `Does PR 812 change the notifications schema? (ref ${m.text})`;
    const CONTEXT = [`orbit-backend-${m.repo}`, `812-${m.pr}`, `db/schema/notifications-${m.file}.sql`];
    const REPLY = `No, it only adds an index on notifications.user_id (ref ${m.reply})`;
    await t.stopAgent("bob");
    const who = await t.cli("alice", ["who"]);
    t.expect("Bob is listed offline: what Alice sends still reaches him when he connects", who.stdout === "alice · @alice · yours\nbob · @bob · offline · answered by @bob, may take hours", who.stdout);

    const ask = await t.cli("alice", ["ask", "bob", QUESTION, "--repo", CONTEXT[0]!, "--pr", CONTEXT[1]!, "--file", CONTEXT[2]!]);
    const convo = ask.stdout;
    t.expect("ask to an offline agent succeeds and says it is queued", ask.code === 0 && ask.stderr.includes("bob is offline; queued"), ask.stderr);
    t.expect("the exchange database holds no plaintext of the message", t.scanExchangeDb([m.text, m.repo, m.pr, m.file]).length === 0);
    // Positive control: the scan does find what the exchange is allowed to store (routing metadata).
    t.expect("the same scan finds the conversation id, which the exchange routes on", t.scanExchangeDb([convo]).length === 1);

    await t.startAgent("bob");
    const inbox = await t.cli("bob", ["inbox", "--unread", "--json"]);
    const row = parseInbox(inbox).find((r) => convo.startsWith(r.convo));
    t.expect("Bob's inbox lists the question as unread, from alice", !!row && row.unread && row.from === "alice" && row.kind === "question", inbox.stdout);

    const read = await t.cli("bob", ["read", row?.id ?? "missing"]);
    t.expect("read shows the full message and its context", read.code === 0 && read.stdout.includes(QUESTION) && read.stdout.includes("PR 812") && read.stdout.includes("from: alice"), read.stdout);
    const after = await t.cli("bob", ["inbox", "--unread"]);
    t.expect("the message is no longer unread", after.stdout === "no unread messages", after.stdout);

    const reply = await t.cli("bob", ["reply", convo, REPLY]);
    t.expect("Bob's reply is accepted", reply.code === 0, `exit ${reply.code}`);
    const wait = await t.cli("alice", ["wait", convo, "--timeout", "10"]);
    t.expect("Alice's wait returns Bob's reply", wait.code === 0 && wait.stdout === `bob: ${REPLY}`, wait.stdout);
    t.expect("after delivery the exchange database still holds no plaintext", t.scanExchangeDb([m.text, m.repo, m.pr, m.file, m.reply]).length === 0);
  },
} satisfies Scenario;
