// Increment 11: the server's judge. Bob has no TypeSafe key of his own, so his gates ask the server, which forwards
// the questions to Jev (here the instance's fake Jev) with its own key and keeps nothing.
import { readFileSync } from "node:fs";
import { plaintextMarker, type Scenario } from "../lib/scenario";
import { until } from "./inbox";

const serverJudge: Scenario = {
  name: "server-judge",
  description:
    "Bob has no TYPESAFE_API_KEY; the server judges with the instance's fake Jev. `patio status` says Bob uses the server's judge. Alice's question passes Bob's input gate through the server's /judge; Bob's reply passes his output gate the same way. The exchange's log names Bob's computer and its count for the day, and neither its log nor its database holds the text.",
  label: "deterministic",
  serverJudge: true,
  agents: () => [{ handle: "alice" }, { handle: "bob", env: { TYPESAFE_API_KEY: "" } }],
  async run(t) {
    const status = await t.cli("bob", ["status"]);
    t.expect("Bob's status names the server's judge", status.stdout.includes(`judge: the server's (${t.m.exchange.url.replace("ws", "http")}/judge)`), status.stdout);
    const marker = plaintextMarker("JUDGE");
    const before = t.jev!.requests.length;
    const ask = await t.cli("alice", ["ask", "bob", `Is the release branch cut? ${marker}`]);
    t.expect("Alice's question is delivered", ask.code === 0, ask.stderr);
    // The input gate runs after delivery (through the server's judge): wait for it to put the question in the inbox.
    const inbox = await until("the question in Bob's inbox", async () => {
      const r = await t.cli("bob", ["inbox"]);
      return r.stdout.includes("Is the release branch cut?") ? r : null;
    }).catch(() => null);
    t.expect("it passed Bob's input gate and is in his inbox", !!inbox, inbox?.stdout);
    const reply = await t.cli("bob", ["reply", ask.stdout, "Yes, this morning."]);
    t.expect("Bob's reply passes his output gate", reply.code === 0, reply.stderr);
    t.expect("Alice gets it", (await t.cli("alice", ["wait", ask.stdout, "--timeout", "10"])).stdout === "bob: Yes, this morning.");
    const asked = t.jev!.requests.slice(before);
    t.expect("the fake Jev was asked for Alice's output gate, Bob's input gate (through the server) and both of Bob's reply gates", asked.length >= 3, `${asked.length} requests`);
    const log = readFileSync(t.m.exchange.log, "utf8");
    t.expect("the exchange log has a judge line per check for Bob's computer", (log.match(/judge: computer \w{8} \(@bob\), \d+\/500 today/g) ?? []).length >= 2, log.split("\n").filter((l) => l.includes("judge")).join(" | "));
    t.expect("and never the text", !log.includes(marker));
    t.expect("nor does the exchange's database", t.scanExchangeDb([marker]).length === 0);
  },
};

export const JUDGE_SCENARIOS = [serverJudge];
