// Increment 9: contact key pinning. Bob has two devices (his agents bob and bob-2). Alice pins bob's device when she
// first writes to him. Then the exchange's directory says bob lives on bob-2's device: a key swap, as a malicious
// exchange could make (or as Bob moving his agent would look from Alice's side).
import { Database } from "bun:sqlite";
import type { Manifest } from "../lib/instance";
import type { Scenario } from "../lib/scenario";
import { parseInbox } from "./inbox-lib";

export function swapAtExchange(m: Manifest, agent: string, toAgentsDevice: string) {
  const db = new Database(m.exchange.db);
  db.run("PRAGMA busy_timeout = 5000");
  db.run("UPDATE agents SET device_id = (SELECT device_id FROM agents WHERE name = ?) WHERE name = ?", [toAgentsDevice, agent]);
  db.close();
}

const keysChanged: Scenario = {
  name: "keys-changed",
  description:
    "Alice pins Bob's device keys at first contact. The exchange then gives another device for bob (a swap in its directory). Alice's next question is not sealed for the new keys: `ask` exits 7 and `patio contacts` shows both fingerprints. A message from the new device is held too, out of her inbox. Her web app shows a keys-changed card; she trusts the new keys, and both messages are released.",
  label: "deterministic",
  agents: () => [{ handle: "alice" }, { handle: "bob" }, { handle: "bob-2", login: "bob" }],
  async run(t) {
    const first = await t.cli("alice", ["ask", "bob", "First contact: is PR 812 merging?"]);
    t.expect("first contact is sent (and pins Bob's keys)", first.code === 0, `exit ${first.code}`);
    const pinned = await t.cli("alice", ["contacts"]);
    t.expect("patio contacts shows Bob's pinned fingerprint", pinned.stdout.includes("bob\n  pinned  "), pinned.stdout);

    swapAtExchange(t.m, "bob", "bob-2");
    t.note("**The exchange's directory now says bob lives on bob-2's device** (a key swap at the exchange).");
    const held = await t.cli("alice", ["ask", "bob", "Second: who reviews the migration?"]);
    t.expect("Alice's next question is held, not sent (exit 7)", held.code === 7 && held.stderr.includes("waiting for you, not sent: bob's keys changed"), `${held.code} ${held.stderr}`);
    const contacts = await t.cli("alice", ["contacts"]);
    t.expect("patio contacts shows the pinned and the new fingerprint", contacts.stdout.includes("  pinned  ") && contacts.stdout.includes("  NEW     ") && contacts.stdout.includes("1 outgoing message(s) wait"), contacts.stdout);

    // bob-2's gatekeeper learns, at its next connection, that the exchange says it hosts bob.
    await t.stopAgent("bob-2");
    await t.startAgent("bob-2");
    const fromNew = await t.cli("bob-2", ["ask", "alice", "Hi Alice, it is bob on the new device.", "--as", "bob"]);
    t.expect("the new device sends as bob", fromNew.code === 0, `${fromNew.code} ${fromNew.stderr}`);
    await Bun.sleep(500);
    t.expect("Alice holds it out of her inbox", !parseInbox(await t.cli("alice", ["inbox"])).some((r) => r.text.includes("new device")));
    const page = await t.webGet("alice", "/");
    t.expect("Alice's web app shows the keys-changed card with both fingerprints", page.text.includes("Keys changed") && page.text.includes("The server now gives other keys for bob") && page.text.includes("1 incoming and 1 outgoing messages wait"), page.text.slice(0, 600));
    t.expect("the card says a device addition looks the same", page.text.includes("adds or moves to a new computer"));
    const trusted = await t.webPost("alice", "/keys/bob/decide", { decision: "trust" });
    t.expect("trusting releases both", trusted.ok === "Trusted bob's new keys. Released 1 incoming and 1 outgoing message.", trusted.ok ?? trusted.error ?? "");
    await Bun.sleep(500);
    t.expect("Bob's message is in Alice's inbox", parseInbox(await t.cli("alice", ["inbox"])).some((r) => r.text.includes("new device")));
    t.expect("Alice's question reached the new device", parseInbox(await t.cli("bob-2", ["inbox", "--as", "bob"])).some((r) => r.text.includes("who reviews the migration")));
    const log = t.gateLog("alice").filter((l) => l.rule === "keys").map((l) => l.verdict);
    t.expect("the audit log has both holds and the trust", log.join() === "held,held,trusted", log.join());
  },
};

export const KEY_SCENARIOS = [keysChanged];
