// Increment 9: contact key pinning. A gatekeeper pins each contact's device keys the first time it sees them (trust
// on first use). When the exchange later gives other keys for a pinned contact, nothing is sealed for or accepted
// from the new keys: the messages are held and the owner sees a "keys changed" card, and decides.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { openInbox } from "../src/inbox";
import { daemon, DaemonError, waitForReply } from "../src/local";
import { startWorld, until, type Gatekeeper, type Person, type World } from "./helpers/world";
import { SERVER_MS } from "./helpers/timeouts";

let world: World;
beforeAll(async () => {
  process.env.PATIO_NO_NOTIFY = "1";
  world = await startWorld();
}, SERVER_MS);
afterAll(() => world.stop(), SERVER_MS);

const dev = (id: string, box = `box-${id}`) => ({ id, sign_pk: `sign-${id}`, box_pk: box });

test("the store pins at first use, accepts the same keys, and reports a change, a sender change and a blocked set", async () => {
  const inbox = openInbox(await mkdtemp(join(world.dir, "pins-")));
  expect(inbox.checkPins("bob", [dev("d1")])).toBe("ok");
  expect(inbox.checkPins("bob", [dev("d1")])).toBe("ok");
  expect(inbox.checkPins("bob", [dev("d2")])).toBe("changed");
  expect(inbox.checkPins("bob", [dev("d1", "other-box")])).toBe("changed");
  expect(inbox.checkPins("bob", [dev("d1"), dev("d3")])).toBe("changed");
  // A sender is checked by its device and signing key only (a delivery carries no box key).
  expect(inbox.checkSender("bob", { id: "d1", sign_pk: "sign-d1" })).toBe("ok");
  expect(inbox.checkSender("bob", { id: "d9", sign_pk: "sign-d9" })).toBe("changed");
  expect(inbox.checkSender("carol", { id: "c1", sign_pk: "sign-c1" })).toBe("ok");
  // A first pin from a delivery has no box key yet; the first full key set fills it in.
  expect(inbox.checkPins("carol", [dev("c1")])).toBe("ok");
  expect(inbox.pins("carol")).toMatchObject([{ id: "c1", sign_pk: "sign-c1", box_pk: "box-c1" }]);

  expect(inbox.recordKeyChange("bob", [dev("d2")])).toBe(true);
  expect(inbox.recordKeyChange("bob", [dev("d2")])).toBe(false);
  inbox.blockKeys("bob");
  expect(inbox.checkPins("bob", [dev("d2")])).toBe("blocked");
  expect(inbox.checkSender("bob", { id: "d2", sign_pk: "sign-d2" })).toBe("blocked");
  // Old keys still pass; yet another set is a new change.
  expect(inbox.checkPins("bob", [dev("d1")])).toBe("ok");
  expect(inbox.checkPins("bob", [dev("d4")])).toBe("changed");
  inbox.recordKeyChange("bob", [dev("d4")]);
  inbox.trustKeys("bob");
  expect(inbox.checkPins("bob", [dev("d4")])).toBe("ok");
  expect(inbox.checkPins("bob", [dev("d1")])).toBe("changed");
  inbox.close();
}, SERVER_MS);

// Swaps, at the exchange, the device that hosts `agent` (what a malicious exchange could do; it is also what a
// contact's own approved move to a new device looks like from here).
function swapAtExchange(agent: string, deviceId: string) {
  const db = new Database(world.dbPath);
  db.run("PRAGMA busy_timeout = 5000");
  db.run("UPDATE agents SET device_id = ? WHERE name = ?", [deviceId, agent]);
  db.close();
}

let alice: Person;
let bob: Person;
let spare: Gatekeeper;
const cards = async (p: Person) => [...((await (await p.web.get("/")).text()).match(/data-keys="[^"]+"/g) ?? [])];

test("a key swap at the exchange: messages to and from the new keys are held with a card; trusting releases them", async () => {
  alice = await world.person("alice");
  bob = await world.person("bob");
  // First contact pins Bob's device on Alice's gatekeeper.
  const first = await daemon.send(alice.cfg, { to: bob.agent, kind: "question", text: "First contact" });
  await until("bob has it", async () => (await daemon.inbox(bob.cfg)).messages.some((m) => m.id === first.id));
  expect((await daemon.contacts(alice.cfg)).contacts.find((c) => c.agent === bob.agent)).toMatchObject({ devices: [{ id: bob.d.device.id }], change: null });

  // A second device of Bob's, and the exchange now says Bob's agent lives there.
  spare = await world.gatekeeper();
  await bob.web.post("/pair", { code: (await daemon.pair(spare.cfg)).code });
  await until("paired", () => spare.d.login() === "bob");
  swapAtExchange(bob.agent, spare.d.device.id);

  // Alice's next message is not sealed for the new keys: it is held, and she sees a card.
  const held = await daemon.send(alice.cfg, { to: bob.agent, kind: "question", text: "Held for the new keys" });
  expect(held.status).toBe("held");
  expect(held.reason).toBe(`${bob.agent}'s keys changed; trust or block them in the web app`);
  expect(await cards(alice)).toEqual([`data-keys="${bob.agent}"`]);
  const page = await (await alice.web.get("/")).text();
  expect(page).toContain("Keys changed");
  expect(page).toContain(bob.d.device.id.match(/.{1,4}/g)!.join(" "));
  expect(page).toContain(spare.d.device.id.match(/.{1,4}/g)!.join(" "));
  expect(page).toContain("adds or moves to a new computer");
  expect(page).toContain("Trust the new keys");
  const contact = (await daemon.contacts(alice.cfg)).contacts.find((c) => c.agent === bob.agent)!;
  expect(contact.change).toMatchObject({ state: "pending", devices: [{ id: spare.d.device.id }], held_out: 1, held_in: 0 });

  // The new device sends as Bob's agent: Alice holds it too, out of her inbox.
  await spare.stop();
  spare = await world.gatekeeper(spare.home);
  await until("the spare hosts bob's agent", () => spare.d.agents().some((a) => a.name === bob.agent));
  const fromNew = await daemon.send({ ...spare.cfg, handle: bob.agent }, { to: alice.agent, kind: "question", text: "Hello from the new device" });
  await until("alice holds it", async () => (await daemon.contacts(alice.cfg)).contacts.find((c) => c.agent === bob.agent)?.change?.held_in === 1);
  expect((await daemon.inbox(alice.cfg)).messages.map((m) => m.id)).not.toContain(fromNew.id);

  // Alice trusts the new keys: her held message goes to the new device, and Bob's reaches her inbox.
  const trusted = await alice.web.post(`/keys/${bob.agent}/decide`, { decision: "trust" });
  expect(trusted.ok).toBe(`Trusted ${bob.agent}'s new keys. Released 1 incoming and 1 outgoing message.`);
  await until("the held message reaches the new device", async () => (await daemon.inbox({ ...spare.cfg, handle: bob.agent })).messages.some((m) => m.id === held.id));
  await until("bob's message reaches alice", async () => (await daemon.inbox(alice.cfg)).messages.some((m) => m.id === fromNew.id));
  expect((await daemon.contacts(alice.cfg)).contacts.find((c) => c.agent === bob.agent)).toMatchObject({ devices: [{ id: spare.d.device.id }], change: null });
  expect(await cards(alice)).toEqual([]);
  const log = (await Bun.file(join(alice.home, "audit.jsonl")).text()).trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.rule === "keys");
  expect(log.map((l) => l.verdict)).toEqual(["held", "held", "trusted"]);
}, SERVER_MS);

test("block: the new keys get nothing and nothing from them is accepted; sending fails", async () => {
  // Back to Bob's first device: for Alice, who now pins the spare, that is a change again.
  swapAtExchange(bob.agent, bob.d.device.id);
  const held = await daemon.send(alice.cfg, { to: bob.agent, kind: "question", text: "Held again" });
  expect(held.status).toBe("held");
  const blocked = await alice.web.post(`/keys/${bob.agent}/decide`, { decision: "block" });
  expect(blocked.ok).toBe(`Blocked ${bob.agent}'s new keys. Dropped 0 incoming and 1 outgoing message.`);
  const err = await daemon.send(alice.cfg, { to: bob.agent, kind: "question", text: "And now?" }).then(() => null, (e) => e as DaemonError);
  expect(err?.code).toBe("keys_blocked");
  // Bob's first device writes to Alice: dropped, never in her inbox.
  const fromOld = await daemon.send(bob.cfg, { to: alice.agent, kind: "question", text: "From the blocked keys" }).catch(() => null);
  await Bun.sleep(300);
  if (fromOld) expect((await daemon.inbox(alice.cfg, { filter: "all" })).messages.map((m) => m.id)).not.toContain(fromOld.id);
  expect((await daemon.contacts(alice.cfg)).contacts.find((c) => c.agent === bob.agent)?.change).toMatchObject({ state: "blocked" });
  expect(await waitForReply(alice.cfg, held.convo, 1)).toBeNull();
}, SERVER_MS);

test("a broadcast goes to the members whose keys hold; a member whose keys changed gets its copy once trusted", async () => {
  const carol = await world.person("carol");
  const dave = await world.person("dave");
  const erin = await world.person("jorge");
  const t = await world.team();
  const id = await world.channel(t.admin, t.id, "pinning");
  for (const p of [carol, dave, erin]) await world.joinChannel(p, id);
  const first = await daemon.send(carol.cfg, { channel: id, kind: "question", text: "First broadcast" });
  for (const p of [dave, erin]) await until("both get it", async () => (await daemon.inbox(p.cfg)).messages.some((m) => m.id === first.id));

  // Erin's agent moves (at the exchange) to a second device of hers.
  const erin2 = await world.gatekeeper();
  await erin.web.post("/pair", { code: (await daemon.pair(erin2.cfg)).code });
  await until("paired", () => erin2.d.login() === "jorge");
  swapAtExchange(erin.agent, erin2.d.device.id);
  await erin2.stop();
  const erin2b = await world.gatekeeper(erin2.home);

  const second = await daemon.send(carol.cfg, { channel: id, kind: "question", text: "Second broadcast" });
  expect(second.status).not.toBe("held");
  await until("dave gets it", async () => (await daemon.inbox(dave.cfg)).messages.some((m) => m.id === second.id));
  const change = (await daemon.contacts(carol.cfg)).contacts.find((c) => c.agent === erin.agent)?.change;
  expect(change).toMatchObject({ state: "pending", held_out: 1 });
  expect((await carol.web.post(`/keys/${erin.agent}/decide`, { decision: "trust" })).ok).toBe(`Trusted ${erin.agent}'s new keys. Released 0 incoming and 1 outgoing message.`);
  await until("erin's new device gets its copy", async () => (await daemon.inbox({ ...erin2b.cfg, handle: erin.agent })).messages.some((m) => m.id === second.id));
}, SERVER_MS);
