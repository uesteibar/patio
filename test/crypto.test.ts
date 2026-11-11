import { expect, test } from "bun:test";
import { chmod, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvelopeError, loadOrCreateDevice, openMessage, publicDevice, sealMessage, type Inner } from "../src/crypto";

const home = () => mkdtemp(join(tmpdir(), "patio-crypto-"));

const inner = (over: Partial<Inner> = {}): Inner => ({
  id: "m1", convo: "c1", from: "alice", to: "bob", kind: "question", text: "Is PR 812 merging?", context: { pr: "812" }, sent_at: 1, ...over,
});

async function pair() {
  const alice = await loadOrCreateDevice(await home());
  const bob = await loadOrCreateDevice(await home());
  return { alice, bob };
}

// What the exchange hands to bob's device for one message.
function delivered(sealed: ReturnType<typeof sealMessage>, to: { id: string }, signPk: string, over: Record<string, unknown> = {}) {
  return { id: "m1", convo: "c1", from: "alice", to: "bob", from_device: sealed.from_device, ciphertext: sealed.copies[to.id]!, sender_sign_pk: signPk, ...over };
}

test("a device key is created once, privately, and reused", async () => {
  const h = await home();
  const first = await loadOrCreateDevice(h);
  expect((await stat(join(h, "device.json"))).mode & 0o777).toBe(0o600);
  expect((await loadOrCreateDevice(h)).id).toBe(first.id);
  await chmod(join(h, "device.json"), 0o644);
  expect(loadOrCreateDevice(h)).rejects.toThrow("readable by other users");
});

test("a message sealed for each recipient device opens on each, and verifies", async () => {
  const { alice, bob } = await pair();
  const bob2 = await loadOrCreateDevice(await home());
  const sealed = sealMessage(inner(), alice, [publicDevice(bob), publicDevice(bob2)]);
  expect(Object.keys(sealed.copies).sort()).toEqual([bob.id, bob2.id].sort());
  expect(JSON.stringify(sealed)).not.toContain("PR 812");
  const pk = publicDevice(alice).sign_pk;
  expect(openMessage(delivered(sealed, bob, pk), bob, "bob")).toEqual(inner());
  expect(openMessage(delivered(sealed, bob2, pk), bob2, "bob").text).toBe("Is PR 812 merging?");
});

test("tampered ciphertext is rejected", async () => {
  const { alice, bob } = await pair();
  const sealed = sealMessage(inner(), alice, [publicDevice(bob)]);
  const bytes = Buffer.from(sealed.copies[bob.id]!, "base64");
  bytes[bytes.length - 5]! ^= 1;
  sealed.copies[bob.id] = bytes.toString("base64");
  expect(() => openMessage(delivered(sealed, bob, publicDevice(alice).sign_pk), bob, "bob")).toThrow(EnvelopeError);
});

test("a message signed by another device is rejected, even when the exchange vouches for it", async () => {
  const { alice, bob } = await pair();
  const mallory = await loadOrCreateDevice(await home());
  const sealed = sealMessage(inner(), mallory, [publicDevice(bob)]);
  // Mallory claims to be alice's device: the signing key does not match the device id.
  const forged = delivered(sealed, bob, publicDevice(mallory).sign_pk, { from_device: alice.id });
  expect(() => openMessage(forged, bob, "bob")).toThrow("signature");
  // Alice's real key does not verify Mallory's signature.
  expect(() => openMessage(delivered(sealed, bob, publicDevice(alice).sign_pk, { from_device: alice.id }), bob, "bob")).toThrow("signature");
});

test("an envelope that does not match the signed message is rejected", async () => {
  const { alice, bob } = await pair();
  const sealed = sealMessage(inner(), alice, [publicDevice(bob)]);
  const pk = publicDevice(alice).sign_pk;
  for (const over of [{ from: "mallory" }, { convo: "other" }, { id: "m2" }, { to: "carol" }])
    expect(() => openMessage(delivered(sealed, bob, pk, over), bob, over.to ?? "bob")).toThrow(EnvelopeError);
});

test("a copy sealed for another device cannot be opened", async () => {
  const { alice, bob } = await pair();
  const carol = await loadOrCreateDevice(await home());
  const sealed = sealMessage(inner(), alice, [publicDevice(carol)]);
  expect(() => openMessage({ ...delivered(sealed, carol, publicDevice(alice).sign_pk) }, bob, "bob")).toThrow("decrypt");
});
