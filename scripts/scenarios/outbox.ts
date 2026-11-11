// Increment 10: the local outbox. While the exchange is unreachable, `ask` and `reply` pass the output gate and wait,
// encrypted, in the sender's gatekeeper; they are sent in order when it is back. `patio outbox` lists them and
// `patio outbox cancel` takes one back; one older than the message TTL expires unsent.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { plaintextMarker, type Scenario, type Transcript } from "../lib/scenario";
import { until } from "./inbox";
import { parseInbox } from "./inbox-lib";

const DAY = 86_400_000;
const outboxOf = async (t: Transcript, who: string) =>
  (await t.cli(who, ["outbox", "--json"])).stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: string; convo: string; to: string; text: string });
const disconnected = (t: Transcript, who: string) =>
  until(`${who} to notice the outage`, async () => JSON.parse((await t.cli(who, ["status", "--json"])).stdout).connected === false);

const outbox: Scenario = {
  name: "outbox",
  description:
    "The exchange goes down. Alice asks Bob three questions and Bob answers an earlier one: each passes its sender's output gate and waits in the sender's outbox (\"queued, will send when the server is reachable\"). Alice cancels her third question, and her gatekeeper restarts while the exchange is still down: the outbox survives. When the exchange is back, both outboxes are sent in order: Bob gets the first two questions in the order they were asked and never the third, and Alice gets Bob's answer.",
  label: "deterministic",
  agents: () => [{ handle: "alice" }, { handle: "bob" }],
  async run(t) {
    const q0 = await t.cli("alice", ["ask", "bob", "Before the outage: who owns billing?"]);
    const first = await until("q0 in Bob's inbox", async () => parseInbox(await t.cli("bob", ["inbox", "--json"])).find((r) => r.convo === q0.stdout.slice(0, 8)));

    await t.stopExchange();
    await disconnected(t, "alice");
    await disconnected(t, "bob");
    const marker = plaintextMarker("OUTBOX");
    const asks = [];
    for (const text of [`Outbox one: is PR 812 merging? ${marker}`, "Outbox two: and PR 813?", "Outbox three: never mind"]) asks.push(await t.cli("alice", ["ask", "bob", text]));
    t.expect(
      "each ask exits 0 and says it is queued until the server is reachable",
      asks.every((a) => a.code === 0 && a.stderr.startsWith("queued, will send when the server is reachable")),
      asks.map((a) => `${a.code} ${a.stderr}`).join(" | "),
    );
    const reply = await t.cli("bob", ["reply", first.id, "The payments team."]);
    t.expect("Bob's reply is queued too", reply.code === 0 && reply.stderr.startsWith("queued, will send"), `${reply.code} ${reply.stderr}`);
    const again = await t.cli("bob", ["reply", first.id, "A second answer"]);
    t.expect("a second reply to the same message is refused while the first waits (exit 6)", again.code === 6, `${again.code} ${again.stderr}`);
    const home = t.m.agents.alice!.home;
    const db = Buffer.concat(readdirSync(home).filter((f) => f.startsWith("inbox.db")).map((f) => readFileSync(join(home, f))));
    t.expect("the outbox is encrypted at rest: the text is nowhere in Alice's inbox.db", db.length > 0 && !db.includes(marker), `${db.length} bytes`);
    const listed = await outboxOf(t, "alice");
    t.expect("patio outbox lists Alice's three, oldest first", listed.map((i) => i.text.split(":")[0]).join(",") === "Outbox one,Outbox two,Outbox three", JSON.stringify(listed));
    t.expect("the outbox gate ran: three output-gate decisions before queuing", t.gateLog("alice", false).filter((l) => l.direction === "out" && l.verdict === "send").length >= 4);
    const plain = await t.cli("alice", ["outbox"]);
    t.expect("the plain listing says it waits for the exchange", plain.stderr.startsWith("waiting for the server"), plain.stderr);
    const cancel = await t.cli("alice", ["outbox", "cancel", listed[2]!.id.slice(0, 8)]);
    t.expect("Alice cancels the third", cancel.code === 0, cancel.stderr);
    const w3 = await t.cli("alice", ["wait", asks[2]!.stdout, "--timeout", "1"]);
    t.expect("wait on it says it will not be sent (exit 11)", w3.code === 11 && w3.stderr === "not sent: cancelled in the outbox", `${w3.code} ${w3.stderr}`);
    const status = await t.cli("alice", ["status"]);
    t.expect("patio status: needs attention, not connected, two in the outbox", status.code === 1 && status.stdout.includes("outbox: 2 queued") && status.stdout.includes("(2 messages wait in the outbox)"), status.stdout);

    await t.stopAgent("alice");
    await t.startAgent("alice", undefined, { connected: false });
    const after = await outboxOf(t, "alice");
    t.expect("after Alice's gatekeeper restarts (exchange still down), the two are still queued", after.map((i) => i.text.split(":")[0]).join(",") === "Outbox one,Outbox two", JSON.stringify(after));

    await t.startExchange();
    const got = await until("both questions at Bob's", async () => {
      const rows = (await t.cli("bob", ["inbox", "--json"])).stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.text.startsWith("Outbox"));
      return rows.length >= 2 ? rows : null;
    });
    const order = [...got].sort((a, b) => a.received_at - b.received_at).map((m) => m.text.split(":")[0]);
    t.expect("Bob gets them in the order they were asked", order.join(",") === "Outbox one,Outbox two", order.join(","));
    await Bun.sleep(500);
    const all = await t.cli("bob", ["inbox", "--all"]);
    t.expect("and never the cancelled one", !all.stdout.includes("Outbox three"), all.stdout);
    const answer = await t.cli("alice", ["wait", q0.stdout, "--timeout", "10"]);
    t.expect("Alice gets Bob's queued answer", answer.code === 0 && answer.stdout === "bob: The payments team.", answer.stdout);
    t.expect("both outboxes are empty", (await outboxOf(t, "alice")).length === 0 && (await outboxOf(t, "bob")).length === 0);
    const read = await t.cli("bob", ["read", first.id]);
    t.expect("Bob's question is answered once its reply left", read.stdout.includes("state: answered"), read.stdout);
    const log = t.gateLog("alice").filter((l) => l.rule === "outbox").map((l) => l.verdict);
    t.expect("Alice's audit log: three queued, one cancelled, two sent", log.join(",") === "queued,queued,queued,cancelled,sent,sent", log.join(","));
  },
};

const outboxTtl: Scenario = {
  name: "outbox-ttl",
  description:
    "The exchange is down for more than the message TTL (7 days). Alice's question waits in her outbox, and her `wait` waits for its answer; after 8 days it expires unsent: `wait` exits 11, the outbox is empty, the audit log says so, and Bob never gets it when the exchange is back.",
  label: "deterministic",
  agents: () => [{ handle: "alice" }, { handle: "bob" }],
  async run(t) {
    await t.stopExchange();
    await disconnected(t, "alice");
    const q = await t.cli("alice", ["ask", "bob", "Outbox TTL: still there?"]);
    t.expect("queued in the outbox", q.code === 0 && q.stderr.startsWith("queued, will send"), q.stderr);
    const waiting = t.start("alice", ["wait", q.stdout, "--timeout", "60"]);
    await Bun.sleep(300);
    await t.advanceClock(8 * DAY, "8 days");
    const w = await waiting.result;
    t.expect("the waiting `wait` exits 11: expired in the outbox", w.code === 11 && w.stderr === "not sent: expired in the outbox: the server was not reachable within 7d", `${w.code} ${w.stderr}`);
    t.expect("the outbox is empty", (await outboxOf(t, "alice")).length === 0);
    const log = t.gateLog("alice").filter((l) => l.rule === "ttl");
    t.expect("the audit log has it, expired", log.length === 1 && log[0]!.verdict === "expired" && log[0]!.by === "timeout", JSON.stringify(log));
    await t.startExchange();
    await Bun.sleep(800);
    t.expect("Bob never gets it", !(await t.cli("bob", ["inbox", "--all"])).stdout.includes("Outbox TTL"));
  },
};

export const OUTBOX_SCENARIOS = [outbox, outboxTtl];
