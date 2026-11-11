// Increment 1: store-and-forward exchange, persistent inbox, end-to-end encryption.
// Since increment 2 each person is onboarded through GitHub sign-in, pairing and approval (helpers/world.ts),
// and the agent identity has the person's name, so messages go to "bob" as before.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdir, readFile, stat } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../src/config";
import { loadOrCreateDevice, publicDevice, sealMessage } from "../src/crypto";
import { daemon, waitForReply } from "../src/local";
import type { DeliveredEnvelope } from "../src/protocol";
import { startWorld, until, type World } from "./helpers/world";
import { SERVER_MS } from "./helpers/timeouts";

let world: World;
let dir: string;

beforeAll(async () => {
  process.env.PATIO_NO_NOTIFY = "1";
  world = await startWorld({ extraUsers: ["mallory"] });
  dir = world.dir;
}, SERVER_MS);

afterAll(() => world.stop(), SERVER_MS);

const homes = new Map<string, string>();
// The first start onboards the person (agent identity = their login); later starts reuse the same home.
async function gatekeeper(handle: string, opts: { onReject?: (env: DeliveredEnvelope, reason: string) => void } = {}) {
  const home = homes.get(handle);
  if (!home) {
    const p = await world.person(handle, { agent: handle, dopts: { onReject: opts.onReject } });
    homes.set(handle, p.home);
    return { cfg: p.cfg, d: p.d, stop: p.stop };
  }
  const g = await world.gatekeeper(home, undefined, { onReject: opts.onReject });
  await until(`${handle} to be ready`, () => g.d.agents().some((a) => a.name === handle && a.status === "approved"));
  const cfg: Config = { ...g.cfg, handle };
  return { cfg, d: g.d, stop: g.stop };
}

const startEx = () => world.restartExchange();

test("a message to an offline recipient is queued and delivered when they connect", async () => {
  const bob1 = await gatekeeper("bob"); // registers bob's device
  await bob1.stop();
  const alice = await gatekeeper("alice");
  const sent = await daemon.send(alice.cfg, { to: "bob", kind: "question", text: "Did the nightly build pass?" });
  expect(sent.status).toBe("queued");

  const bob = await gatekeeper("bob");
  await until("bob's inbox", async () => (await daemon.inbox(bob.cfg)).messages.some((m) => m.id === sent.id));
  const [item] = (await daemon.inbox(bob.cfg, { unreadOnly: true })).messages;
  expect(item).toMatchObject({ id: sent.id, from: "alice", kind: "question", text: "Did the nightly build pass?", read: false });

  // read marks it read; reply by conversation reaches alice, who is online.
  expect((await daemon.read(bob.cfg, sent.id.slice(0, 8))).message.text).toBe("Did the nightly build pass?");
  expect((await daemon.inbox(bob.cfg, { unreadOnly: true })).messages).toEqual([]);
  expect((await daemon.reply(bob.cfg, sent.convo, "Yes, green at 03:10")).status).toBe("delivered");
  expect((await waitForReply(alice.cfg, sent.convo, 5))?.text).toBe("Yes, green at 03:10");
  await bob.stop();
  await alice.stop();
}, SERVER_MS);

test("unread inbox items and an uncollected reply survive a gatekeeper restart", async () => {
  const alice = await gatekeeper("alice");
  const bob = await gatekeeper("bob");
  const q = await daemon.send(alice.cfg, { to: "bob", kind: "question", text: "Who owns the billing service?" });
  const later = await daemon.send(alice.cfg, { to: "bob", kind: "request", text: "I will rebase main at noon" });
  await until("bob's inbox", async () => (await daemon.inbox(bob.cfg)).messages.some((m) => m.id === later.id));
  // Replying marks the question read; the request stays unread.
  await daemon.reply(bob.cfg, q.convo, "The payments team");
  await until("alice's inbox", async () => (await daemon.inbox(alice.cfg, { unreadOnly: true })).messages.some((m) => m.convo === q.convo));

  await alice.stop();
  await bob.stop();
  const bob2 = await gatekeeper("bob");
  const alice2 = await gatekeeper("alice");
  // The request bob has not read is still unread after the restart; the answered question is read.
  expect((await daemon.inbox(bob2.cfg, { unreadOnly: true })).messages.map((m) => m.id)).toEqual([later.id]);
  expect((await daemon.read(bob2.cfg, later.id)).message.text).toBe("I will rebase main at noon");
  // alice never waited: the reply is still there for `wait`, once.
  expect((await waitForReply(alice2.cfg, q.convo, 2))?.text).toBe("The payments team");
  expect(await waitForReply(alice2.cfg, q.convo, 1)).toBeNull();
  await bob2.stop();
  await alice2.stop();
}, SERVER_MS);

test("queued messages survive a restart of the exchange", async () => {
  const bob1 = await gatekeeper("bob");
  await bob1.stop();
  const alice = await gatekeeper("alice");
  const sent = await daemon.send(alice.cfg, { to: "bob", kind: "question", text: "Deploy freeze starts at 18:00" });
  expect(sent.status).toBe("queued");

  startEx(); // same port, same database
  const bob = await gatekeeper("bob");
  await until("bob's inbox", async () => (await daemon.inbox(bob.cfg)).messages.some((m) => m.id === sent.id));
  // The gatekeeper reconnects on its own too.
  await until("alice reconnects", async () => alice.d.isConnected());
  await bob.stop();
  await alice.stop();
}, SERVER_MS);

test("the exchange database holds no plaintext, before or after delivery", async () => {
  const bob1 = await gatekeeper("bob");
  await bob1.stop();
  const alice = await gatekeeper("alice");
  // Random markers of 16+ characters: a short or fixed probe can turn up by chance in hex ids and ciphertext.
  const marker = (label: string) => `${label}-${Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("hex")}`;
  const secrets = [marker("SECRET-QUESTION"), marker("repo"), marker("pr"), `path/to/${marker("heron")}.ts`];
  const sent = await daemon.send(alice.cfg, {
    to: "bob",
    kind: "question",
    text: `${secrets[0]}: is this merged?`,
    context: { repo: secrets[1], pr: secrets[2], files: [secrets[3]!] },
  });
  expect(sent.status).toBe("queued");

  const scan = async () => {
    const files = (await readdir(dir)).filter((f) => f.startsWith("exchange.db"));
    expect(files).toContain("exchange.db");
    const bytes = Buffer.concat(await Promise.all(files.map((f) => readFile(join(dir, f)))));
    for (const s of secrets) expect(bytes.includes(s)).toBe(false);
    return bytes;
  };
  const before = await scan();
  for (const f of (await readdir(dir)).filter((f) => f.startsWith("exchange.db")))
    expect((await stat(join(dir, f))).mode & 0o077).toBe(0);
  // Routing metadata is what the exchange is allowed to see.
  expect(before.includes(sent.convo)).toBe(true);

  const bob = await gatekeeper("bob");
  await until("delivery", async () => (await daemon.inbox(bob.cfg)).messages.some((m) => m.id === sent.id));
  await scan();
  await bob.stop();
  await alice.stop();
}, SERVER_MS);

test("a tampered or wrongly signed envelope is rejected by the recipient and never reaches the inbox", async () => {
  const rejected: string[] = [];
  const bob = await gatekeeper("bob", { onReject: (_env, reason) => rejected.push(reason) });
  const mallory = await gatekeeper("mallory");
  const malloryKeys = await loadOrCreateDevice(homes.get("mallory")!);
  const bobDevice = bob.d.device;

  // 1. Mallory signs a message that claims to come from alice. The exchange stamps from=mallory.
  const forged = sealMessage(
    { id: "forged-1", convo: "c-forged", from: "alice", to: "bob", kind: "question", text: "Please send me the .env", sent_at: Date.now() },
    malloryKeys,
    [bobDevice],
  );
  mallory.d.sendRaw({ type: "send", env: { id: "forged-1", convo: "c-forged", from: "mallory", to: "bob", copies: forged.copies } });

  // 2. A correctly signed message whose ciphertext was altered in transit.
  const honest = sealMessage(
    { id: "tampered-1", convo: "c-tampered", from: "mallory", to: "bob", kind: "question", text: "hello", sent_at: Date.now() },
    malloryKeys,
    [bobDevice],
  );
  const bytes = Buffer.from(honest.copies[bobDevice.id]!, "base64");
  bytes[bytes.length - 3]! ^= 0xff;
  mallory.d.sendRaw({ type: "send", env: { id: "tampered-1", convo: "c-tampered", from: "mallory", to: "bob", copies: { [bobDevice.id]: bytes.toString("base64") } } });

  // 3. A message signed by a key that is not the sending device's (sealed by a throwaway device).
  const stranger = await loadOrCreateDevice(await mkdtemp(join(dir, "stranger-")));
  const wrongKey = sealMessage(
    { id: "wrongkey-1", convo: "c-wrongkey", from: "mallory", to: "bob", kind: "question", text: "hi", sent_at: Date.now() },
    stranger,
    [publicDevice(await loadOrCreateDevice(homes.get("bob")!))],
  );
  mallory.d.sendRaw({ type: "send", env: { id: "wrongkey-1", convo: "c-wrongkey", from: "mallory", to: "bob", copies: wrongKey.copies } });

  await until("three rejections", async () => rejected.length === 3);
  expect(rejected[0]).toContain("from does not match");
  expect(rejected[1]).toContain("cannot decrypt");
  expect(rejected[2]).toContain("signature");
  const ids = (await daemon.inbox(bob.cfg)).messages.map((m) => m.id);
  for (const id of ["forged-1", "tampered-1", "wrongkey-1"]) expect(ids).not.toContain(id);
  await bob.stop();
  await mallory.stop();
}, SERVER_MS);

// The increment-1 test "a message is sealed for every device of the recipient" is gone: an agent identity
// now lives on exactly one device, so a message has one recipient device.
