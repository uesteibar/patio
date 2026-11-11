// End-to-end encryption between gatekeepers. Each device has a signing key (Ed25519) and a box key (X25519).
// A message is signed by the sender device, then sealed (libsodium crypto_box_seal) for each recipient device.
// The exchange routes on the envelope (recipient, message id, conversation id) and never sees text or context.
//
// Sign, then encrypt: the signed bytes name the sender, the recipient, the message id and the conversation, so a
// recipient checks that the envelope it was handed matches what the sender signed. A device id is a hash of its
// signing key, so a device id cannot be paired with someone else's key.
import { chmod, lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sodium from "libsodium-wrappers";
import { validateOutgoing, type Context, type Kind, type DeliveredEnvelope, type PublicDevice } from "./protocol";

await sodium.ready;

const B64 = sodium.base64_variants.ORIGINAL;
const b64 = (bytes: Uint8Array) => sodium.to_base64(bytes, B64);
const unb64 = (text: string) => sodium.from_base64(text, B64);

export type DeviceKeys = {
  id: string;
  signPk: Uint8Array;
  signSk: Uint8Array;
  boxPk: Uint8Array;
  boxSk: Uint8Array;
};

export type { PublicDevice };

// The message as the sender signed it. Only the two gatekeepers ever see it.
export type Inner = {
  id: string;
  convo: string;
  from: string;
  to: string;
  kind: Kind;
  text: string;
  context?: Context;
  sent_at: number;
};

// One recipient device's copy, as the exchange delivers it (`from` is stamped by the exchange, and
// `sender_sign_pk` comes from its directory and is checked against `from_device`).
export type DeliveredCopy = Omit<DeliveredEnvelope, "ts" | "agent">;

export class EnvelopeError extends Error {}

export function deviceIdOf(signPk: Uint8Array): string {
  return sodium.to_hex(sodium.crypto_generichash(16, signPk, null));
}

export function publicDevice(keys: DeviceKeys): PublicDevice {
  return { id: keys.id, sign_pk: b64(keys.signPk), box_pk: b64(keys.boxPk) };
}

// Creates the device keypairs on first start and keeps them in PATIO_HOME, readable only by this user.
export async function loadOrCreateDevice(home: string): Promise<DeviceKeys> {
  const file = join(home, "device.json");
  const existing = await lstat(file).catch(() => null);
  if (existing) {
    if (!existing.isFile()) throw new Error(`${file} is not a plain file`);
    if ((existing.mode & 0o077) !== 0) throw new Error(`${file} is readable by other users; run chmod 600 on it`);
    const raw = (await Bun.file(file).json()) as { sign_sk: string; box_sk: string };
    const signSk = unb64(raw.sign_sk);
    const boxSk = unb64(raw.box_sk);
    // A libsodium Ed25519 secret key is the 32-byte seed followed by the public key.
    const signPk = signSk.slice(32);
    return { id: deviceIdOf(signPk), signPk, signSk, boxPk: sodium.crypto_scalarmult_base(boxSk), boxSk };
  }
  await mkdir(home, { recursive: true, mode: 0o700 });
  const sign = sodium.crypto_sign_keypair();
  const box = sodium.crypto_box_keypair();
  const keys: DeviceKeys = { id: deviceIdOf(sign.publicKey), signPk: sign.publicKey, signSk: sign.privateKey, boxPk: box.publicKey, boxSk: box.privateKey };
  const body = JSON.stringify({ id: keys.id, sign_pk: b64(keys.signPk), sign_sk: b64(keys.signSk), box_pk: b64(keys.boxPk), box_sk: b64(keys.boxSk) }, null, 2);
  // flag "wx": never overwrite a key another process created meanwhile.
  await writeFile(file, body + "\n", { mode: 0o600, flag: "wx" });
  await chmod(file, 0o600);
  return keys;
}

// Sealed for this device alone: what waits in the gatekeeper's outbox is stored encrypted, and only these keys open it.
export function sealForSelf(keys: DeviceKeys, value: unknown): string {
  return b64(sodium.crypto_box_seal(sodium.from_string(JSON.stringify(value)), keys.boxPk));
}

export function openForSelf<T>(keys: DeviceKeys, sealed: string): T {
  return JSON.parse(sodium.to_string(sodium.crypto_box_seal_open(unb64(sealed), keys.boxPk, keys.boxSk))) as T;
}

export function sealMessage(inner: Inner, sender: DeviceKeys, recipients: PublicDevice[]): { from_device: string; copies: Record<string, string> } {
  const signed = JSON.stringify(inner);
  const sig = b64(sodium.crypto_sign_detached(sodium.from_string(signed), sender.signSk));
  const plaintext = sodium.from_string(JSON.stringify({ v: 1, from_device: sender.id, signed, sig }));
  const copies: Record<string, string> = {};
  for (const r of recipients) copies[r.id] = b64(sodium.crypto_box_seal(plaintext, unb64(r.box_pk)));
  return { from_device: sender.id, copies };
}

// Opens, verifies and checks one delivered copy. Throws EnvelopeError for anything that does not hold.
export function openMessage(copy: DeliveredCopy, me: DeviceKeys, myHandle: string): Inner {
  let plaintext: Uint8Array;
  try {
    plaintext = sodium.crypto_box_seal_open(unb64(copy.ciphertext), me.boxPk, me.boxSk);
  } catch {
    throw new EnvelopeError("cannot decrypt: not sealed for this device, or tampered with");
  }
  let outer: { from_device?: unknown; signed?: unknown; sig?: unknown };
  try {
    outer = JSON.parse(sodium.to_string(plaintext));
  } catch {
    throw new EnvelopeError("decrypted payload is not JSON");
  }
  if (typeof outer.signed !== "string" || typeof outer.sig !== "string") throw new EnvelopeError("payload is not signed");

  let signPk: Uint8Array;
  try {
    signPk = unb64(copy.sender_sign_pk);
  } catch {
    throw new EnvelopeError("bad signature: sender key is not valid base64");
  }
  if (deviceIdOf(signPk) !== copy.from_device || outer.from_device !== copy.from_device)
    throw new EnvelopeError("bad signature: the sender key does not belong to the sending device");
  let valid = false;
  try {
    valid = sodium.crypto_sign_verify_detached(unb64(outer.sig), sodium.from_string(outer.signed), signPk);
  } catch {}
  if (!valid) throw new EnvelopeError("bad signature");

  const inner = JSON.parse(outer.signed) as Inner;
  for (const key of ["id", "convo", "from", "to"] as const)
    if (inner[key] !== copy[key]) throw new EnvelopeError(`envelope ${key} does not match the signed message`);
  if (inner.to !== myHandle) throw new EnvelopeError("message is addressed to someone else");
  const problem = validateOutgoing(inner);
  if (problem) throw new EnvelopeError(`invalid message: ${problem}`);
  return inner;
}

// Proof that a connecting gatekeeper holds the device's signing key: it signs the exchange's random nonce.
const helloBytes = (nonce: string) => sodium.from_string(`patio-hello:${nonce}`);

export function signChallenge(keys: DeviceKeys, nonce: string): string {
  return b64(sodium.crypto_sign_detached(helloBytes(nonce), keys.signSk));
}

export function verifyChallenge(device: PublicDevice, nonce: string, sig: string): boolean {
  try {
    const pk = unb64(device.sign_pk);
    return deviceIdOf(pk) === device.id && sodium.crypto_sign_verify_detached(unb64(sig), helloBytes(nonce), pk);
  } catch {
    return false;
  }
}

// Proof that an HTTP request to the server comes from a device that holds its signing key (the server's judge): the
// device signs `patio-request:<path>:<device id>:<time>:<sha256 of the body>`. The server checks it against the key it
// has for that device, and that the time is recent.
const requestBytes = (path: string, deviceId: string, time: string, body: string) =>
  sodium.from_string(`patio-request:${path}:${deviceId}:${time}:${new Bun.CryptoHasher("sha256").update(body).digest("hex")}`);

export function signRequest(keys: DeviceKeys, path: string, time: string, body: string): string {
  return b64(sodium.crypto_sign_detached(requestBytes(path, keys.id, time, body), keys.signSk));
}

export function verifyRequest(signPk: string, path: string, deviceId: string, time: string, body: string, sig: string): boolean {
  try {
    const pk = unb64(signPk);
    return deviceIdOf(pk) === deviceId && sodium.crypto_sign_verify_detached(unb64(sig), requestBytes(path, deviceId, time, body), pk);
  } catch {
    return false;
  }
}
