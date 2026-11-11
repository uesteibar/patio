// Increment 15, part C: what waits for the person. Bob's agent answers nothing on its own (the join's default), so
// Alice's questions wait for Bob in Needs you, "Questions for you", and Alice is told so. Bob settles each one from his
// web app in one of the three ways: he lets his agent answer (the same path as `patio answer`, with his agent's tool,
// here the fake ACP agent), he replies himself, or he declines with a reason. Then his agent asks to answer team on
// its own from a command that is not his terminal: that widening becomes a card, which he confirms; a narrowing
// applies at once.
import type { Scenario } from "../lib/scenario";
import { bob, until } from "./inbox";

const questionsForYou: Scenario = {
  name: "questions-for-you",
  description:
    "Alice asks Bob three questions; his rules let them in and nothing answers them on its own, so each waits in his Needs you, counted in the sidebar and in patio status, and Alice's ask says Bob answers when he can. Bob lets his agent answer the first (its reply reaches Alice), replies to the second himself, and declines the third with a reason (Alice is told).",
  label: "deterministic",
  agents: () => [{ handle: "alice" }, bob({ reply: "Staging is green since 10:00 (deploy log)." })],
  async run(t) {
    const asks: { id: string; text: string }[] = [];
    for (const text of ["Is staging green?", "Can you review PR 812 today?", "What is the prod database password?"]) {
      const r = await t.cli("alice", ["ask", "bob", text]);
      t.expect(`Alice asks: ${text}`, r.code === 0 && r.stderr.includes("bob is answered by @bob, may take hours"), r.stderr);
      asks.push({ id: r.stdout, text });
    }
    const page = await until("all three in Bob's Needs you", async () => {
      const p = await t.webGet("bob", "/");
      return asks.every((a) => p.html.includes(a.text)) ? p : null;
    });
    t.expect("Needs you: Questions for you, three rows, the badge counts them", page.html.includes("<h2>Questions for you</h2>") && (page.html.match(/data-question=/g) ?? []).length === 3 && page.html.includes('aria-label="3 waiting for you"'));
    const status = await t.cli("bob", ["status"]);
    t.expect("patio status: 3 questions wait for you", status.stdout.includes("3 questions wait for you in the web app"), status.stdout);
    const rows = page.html.split('data-question="').slice(1).map((b) => ({ id: b.slice(0, b.indexOf('"')), body: b }));
    const ids = asks.map((a) => rows.find((r) => r.body.includes(a.text))?.id ?? "");

    const let_ = await t.webPost("bob", `/questions/${ids[0]}/answer`, {});
    t.expect("Let bob answer: his agent answers with its tool", let_.ok === "bob is answering alice's question with its tool. Its reply goes through your rules (outgoing).", let_.ok ?? let_.error ?? "");
    const w1 = await t.cli("alice", ["wait", asks[0]!.id, "--timeout", "20"]);
    t.expect("Alice gets the agent's answer", w1.stdout === "bob: Staging is green since 10:00 (deploy log).", w1.stdout + w1.stderr);

    const mine = await t.webPost("bob", `/questions/${ids[1]}/reply`, { text: "Tomorrow morning, first thing." });
    t.expect("Reply myself: sent as bob's reply", mine.ok === "Sent your reply to alice, as bob.", mine.ok ?? mine.error ?? "");
    const w2 = await t.cli("alice", ["wait", asks[1]!.id, "--timeout", "10"]);
    t.expect("Alice gets Bob's own words", w2.stdout === "bob: Tomorrow morning, first thing.", w2.stdout);

    const no = await t.webPost("bob", `/questions/${ids[2]}/decline`, { reason: "Never shared." });
    t.expect("Decline, with a reason", no.ok === "Declined alice's question; alice was told, with your reason.", no.ok ?? no.error ?? "");
    const w3 = await t.cli("alice", ["wait", asks[2]!.id, "--timeout", "10"]);
    t.expect("Alice is told it was declined, with the reason", w3.stdout.includes("declined your message: declined by the recipient. Reason: Never shared."), w3.stdout);

    const after = await t.webGet("bob", "/");
    t.expect("nothing waits for Bob any more: one empty state", after.html.includes("data-empty") && !after.html.includes('class="count"'));
  },
};

const widening: Scenario = {
  name: "rules-widening",
  description:
    "Bob's agent runs `patio rules bob --answer yes` from a command that is not his terminal: the widening becomes a card in his Needs you (\"bob wants to answer team on its own\"), exit 5, and his rules stay as they were; he confirms it and bob answers team on its own. A narrowing (`--ask questions`) applies at once. In his own terminal the same widening applies at once.",
  label: "deterministic",
  agents: () => [{ handle: "alice" }, bob({ reply: "ok" })],
  async run(t) {
    const wide = await t.cli("bob", ["rules", "bob", "--answer", "yes", "--workspace", "team"]);
    t.expect("from an agent, a widening waits for Bob (exit 5)", wide.code === 5 && wide.stdout.includes("bob wants to answer team on its own"), wide.stdout + wide.stderr);
    const card = await t.webGet("bob", "/");
    t.expect("a card in Needs you, under Your rules", card.html.includes("bob wants to answer team on its own") && card.html.includes("data-rule-request="));
    const action = /action="(\/rules\/requests\/[^"]+\/decide)"/.exec(card.html)?.[1] ?? "";
    const ok = await t.webPost("bob", action, { decision: "approve" });
    t.expect("Bob confirms it", ok.ok === "Done: bob may now answer team on its own.", ok.ok ?? ok.error ?? "");
    const rules = await t.cli("bob", ["rules", "bob"]);
    t.expect("bob answers team on its own now", rules.stdout.includes("bob answers the agents of team on its own."), rules.stdout);
    const narrow = await t.cli("bob", ["rules", "bob", "--ask", "questions", "--workspace", "team"]);
    t.expect("a narrowing applies at once (exit 0)", narrow.code === 0 && narrow.stdout.includes("what team may ask: only questions"), narrow.stdout);
    const back = await t.cli("bob", ["rules", "bob", "--ask", "anything", "--workspace", "team"]);
    t.expect("widening it again from an agent waits again", back.code === 5 && back.stdout.includes("bob wants others to ask it anything they like"), back.stdout);
  },
};

export const NEEDS_YOU_SCENARIOS = [questionsForYou, widening];
