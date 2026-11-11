// Increment 10: nothing stays open forever. Held messages time out (hold_timeout, on_timeout), and the exchange
// drops what it could not deliver within the message TTL and tells the sender. The instance's test clock moves
// forward instead of anyone sleeping.
import { Database } from "bun:sqlite";
import type { Scenario, Transcript } from "../lib/scenario";
import type { FakeJevFixture } from "../../test/fakes/fake-jev";
import { bob, until } from "./inbox";
import { parseInbox } from "./inbox-lib";

const noul = (n: number) => ({ type: "noul" as const, noul: n });
// Everything benign, except that a message with HOLD-ME is doubtful (injection 0.6): Bob's input gate holds it.
const HOLDING: FakeJevFixture = {
  default: noul(0.02),
  answers: { allow: noul(0.98), injection: [{ stateMatches: "HOLD-ME", answer: noul(0.6) }, { answer: noul(0.02) }] },
};
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const heldCount = async (t: Transcript, who: string) => JSON.parse((await t.cli(who, ["status", "--json"])).stdout).pending as { held_in: number; held_out: number };

const holdIn: Scenario = {
  name: "hold-timeout-in",
  description:
    "Bob's grant holds doubtful messages for at most 1h (hold_timeout); Carol's says on_timeout: inbox, the default is reject. Alice and Carol each send a message Bob's input gate holds. Nobody decides: after 30 minutes both still wait; after an hour Alice's is rejected (she is told: not reviewed in time) and Carol's is delivered to Bob's inbox marked not reviewed, which `watch --answer` leaves to a person.",
  label: "deterministic",
  jev: HOLDING,
  agents: () => [
    { handle: "alice" },
    { handle: "carol" },
    bob({ reply: "Thursdays." }, { grants: "defaults:\n  hold_timeout: 1h\ncontacts:\n  carol:\n    on_timeout: inbox\n    auto_answer: true\n" }),
  ],
  async run(t) {
    const a = (await t.cli("alice", ["ask", "bob", "HOLD-ME: what is in the release plan?"])).stdout;
    await t.cli("carol", ["ask", "bob", "HOLD-ME: when is the freeze?"]);
    await until("both held", async () => (await heldCount(t, "bob")).held_in === 2);
    t.expect("both messages wait for Bob", (await t.held("bob")).length === 2);
    await t.advanceClock(30 * MIN, "30 minutes");
    t.expect("after 30 minutes both still wait", (await heldCount(t, "bob")).held_in === 2);
    await t.advanceClock(31 * MIN, "31 more minutes (past the 1h hold_timeout)");
    await until("both decided by the timeout", async () => (await heldCount(t, "bob")).held_in === 0);
    const rejected = parseInbox(await t.cli("bob", ["inbox", "--rejected"]));
    t.expect("Alice's message is rejected (on_timeout: reject, the default)", rejected.some((r) => r.from === "alice" && r.text.includes("HOLD-ME")), JSON.stringify(rejected));
    const told = await t.cli("alice", ["wait", a, "--timeout", "10"]);
    t.expect("Alice is told: not reviewed in time", told.code === 0 && told.stdout === "bob: bob's patio rejected your message: not reviewed in time.", told.stdout);
    const inbox = parseInbox(await t.cli("bob", ["inbox"]));
    const carol = inbox.find((r) => r.from === "carol");
    t.expect("Carol's message is in Bob's inbox, marked not reviewed (on_timeout: inbox)", !!carol && carol.state.endsWith("(not reviewed)"), JSON.stringify(inbox));
    const watch = await t.cli("bob", ["watch", "--answer", "--once"]);
    t.expect("watch --answer leaves it to a person, though Carol's grant has auto_answer", watch.stderr.includes("it was not reviewed") && !watch.stdout.trim(), watch.stderr);
    const read = await t.cli("bob", ["read", carol?.id ?? "-"]);
    t.expect("read says it was not reviewed", read.stdout.includes("not reviewed: it waited for you and nobody decided in time"), read.stdout);
    const log = t.gateLog("bob").filter((l) => l.rule === "timeout");
    t.expect(
      "the audit log has both, decided by the timeout",
      log.length === 2 && log.some((l) => l.from === "alice" && l.verdict === "rejected") && log.some((l) => l.from === "carol" && l.verdict === "delivered-unreviewed") && log.every((l) => l.by === "timeout"),
      JSON.stringify(log),
    );
  },
};

const holdOut: Scenario = {
  name: "hold-timeout-out",
  description:
    "Bob's output gate holds what his agents send with an email address in it. His question to Alice is held and his `patio wait` is still waiting for its answer; his agent's reply to Alice's question (`patio answer`) is held too. Nobody reviews them within the default 24h: neither is sent, the waiting `wait` exits 11 (not sent: not reviewed in time), and Alice's question is marked failed in Bob's inbox, so it can be answered again.",
  label: "deterministic",
  agents: () => [{ handle: "alice" }, bob({ reply: "Write to bob@example.com about it." })],
  async run(t) {
    const asked = await t.cli("bob", ["ask", "alice", "Can you mail me at bob@example.com?"]);
    t.expect("Bob's question is held by his output gate (exit 7)", asked.code === 7, `${asked.code} ${asked.stderr}`);
    const waiting = t.start("bob", ["wait", asked.stdout, "--timeout", "60"]);
    const sent = await t.cli("alice", ["ask", "bob", "Who owns the billing service?"]);
    const q = await until("Alice's question in Bob's inbox", async () => parseInbox(await t.cli("bob", ["inbox", "--json"])).find((r) => r.convo === sent.stdout.slice(0, 8)));
    const answered = await t.cli("bob", ["answer", q.id]);
    t.expect("the agent's reply is held too (exit 7)", answered.code === 7, `${answered.code}`);
    t.expect("two drafts wait", (await heldCount(t, "bob")).held_out === 2);
    await t.advanceClock(23 * HOUR, "23 hours");
    t.expect("after 23 hours they still wait", (await heldCount(t, "bob")).held_out === 2);
    await t.advanceClock(2 * HOUR, "2 more hours (past the default 24h)");
    const w = await waiting.result;
    t.expect("the waiting `patio wait` reports it (exit 11)", w.code === 11 && w.stderr === "not sent: your owner did not review it in time", `${w.code} ${w.stderr}`);
    t.expect("no draft waits any more", (await heldCount(t, "bob")).held_out === 0);
    const read = await t.cli("bob", ["read", q.id]);
    t.expect("Alice's question is failed, so it can be answered again", read.stdout.includes("state: failed (the reply was not reviewed in time; it was not sent)"), read.stdout);
    const none = await t.cli("alice", ["inbox", "--all"]);
    t.expect("Alice never got Bob's question", !none.stdout.includes("bob@example.com"), none.stdout);
    const log = t.gateLog("bob").filter((l) => l.rule === "timeout");
    t.expect("the audit log has both drafts: not sent, by the timeout", log.length === 2 && log.every((l) => l.verdict === "not-sent" && l.by === "timeout" && l.direction === "out"), JSON.stringify(log));
  },
};

const ttl: Scenario = {
  name: "exchange-ttl",
  description:
    "Bob's gatekeeper is down. Alice's question waits at the exchange as ciphertext, and her `wait` waits for the answer. After 8 days (the TTL is 7) the exchange drops it and tells Alice's gatekeeper: `wait` exits 11, expired undelivered. A second question expires while Alice's gatekeeper is down too; she is told when it reconnects. Bob, back, gets neither.",
  label: "deterministic",
  agents: () => [{ handle: "alice" }, { handle: "bob" }],
  async run(t) {
    await t.stopAgent("bob");
    const q1 = await t.cli("alice", ["ask", "bob", "Is PR 812 merging today?"]);
    t.expect("the question is queued at the exchange", q1.code === 0 && q1.stderr.includes("queued at the server"), q1.stderr);
    const waiting = t.start("alice", ["wait", q1.stdout, "--timeout", "60"]);
    await Bun.sleep(300);
    await t.advanceClock(8 * DAY, "8 days");
    const w = await waiting.result;
    t.expect("Alice's wait exits 11: expired undelivered", w.code === 11 && w.stderr === "expired undelivered: bob's computer did not connect within 7d", `${w.code} ${w.stderr}`);
    const mailbox = () => {
      const db = new Database(t.m.exchange.db, { readonly: true });
      const n = db.query<{ n: number }, []>("SELECT count(*) AS n FROM mailbox").get()!.n;
      db.close();
      return n;
    };
    t.expect("the exchange holds no copy any more", mailbox() === 0, `${mailbox()} rows`);

    const q2 = await t.cli("alice", ["ask", "bob", "And PR 813?"]);
    await t.stopAgent("alice");
    await t.advanceClock(8 * DAY, "8 more days");
    await t.startAgent("alice");
    await until("Alice told on reconnect", async () => t.gateLog("alice", false).some((l) => l.rule === "ttl" && l.convo === q2.stdout));
    const log = t.gateLog("alice").filter((l) => l.rule === "ttl");
    t.expect("Alice's audit log has both, expired at the exchange", log.length === 2 && log.every((l) => l.verdict === "expired" && l.by === "exchange" && l.to === "bob"), JSON.stringify(log));
    const again = await t.cli("alice", ["wait", q2.stdout, "--timeout", "1"]);
    t.expect("wait on the second one also says why", again.code === 11 && again.stderr.startsWith("expired undelivered"), `${again.code} ${again.stderr}`);
    await t.startAgent("bob");
    await Bun.sleep(500);
    const inbox = await t.cli("bob", ["inbox", "--all"]);
    t.expect("Bob, back, gets neither", !inbox.stdout.includes("PR 81"), inbox.stdout);
  },
};

export const EXPIRY_SCENARIOS = [holdIn, holdOut, ttl];
