// The server's judge. A person without a TypeSafe key of their own still gets the natural-language checks: patio on
// their computer sends the gate's state and questions to the server, which forwards them to Jev with the server's
// own TYPESAFE_API_KEY and returns Jev's answer.
//
// - Only computers the server knows and that are signed in (paired, not revoked) may call it. Each request is signed
//   with the computer's device key (crypto.ts signRequest), recent, and used once.
// - It keeps nothing: the request and the answer are never logged or stored, and nothing about them stays in memory
//   after the call. The log line says which computer asked, how many checks it has used today and how long it took.
// - A daily quota per computer (PATIO_JUDGE_PER_DAY, default 500), answered with 429 when it is used up. Without a
//   key the endpoint answers 503.
//
// On the computer, a local TYPESAFE_API_KEY wins (development, self-hosting). Failure stays closed either way: when
// the judge is unavailable, the gate holds the message for its owner.
import type { DeviceKeys } from "./crypto";
import { signRequest, verifyRequest } from "./crypto";
import type { Directory } from "./directory";
import type { Judge, JudgeAnswer, JudgeQuestion } from "./gates";

const SIGNED_AS = "judge";
const MAX_SKEW_MS = 5 * 60_000;
const MAX_BODY = 256 * 1024;

export const judgePerDay = (env = process.env) => {
  const n = Number(env.PATIO_JUDGE_PER_DAY ?? 500);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 500;
};

// The judge as patio on a computer uses it: one signed POST to <server>/judge per gate decision.
export function serverJudge(o: { url: string; keys: DeviceKeys; timeoutMs?: number }): Judge {
  return async (state, questions) => {
    const body = JSON.stringify({ state, questions });
    const res = await fetch(`${o.url.replace(/\/$/, "")}/judge`, {
      method: "POST",
      headers: signedHeaders(o.keys, SIGNED_AS, body),
      body,
      signal: AbortSignal.timeout(o.timeoutMs ?? 30_000),
    }).catch((err: Error) => {
      throw new JudgeUnavailable(`the server's judge is not reachable (${err.name})`);
    });
    const data = (await res.json().catch(() => ({}))) as Partial<JudgeAnswer> & { error?: string };
    if (!res.ok) throw new JudgeUnavailable(`the server's judge answered ${res.status}: ${data.error ?? "no reason given"}`);
    if (!data.answers || typeof data.answers !== "object") throw new JudgeUnavailable("the server's judge gave no answers");
    return { answers: data.answers, model: data.model, request_id: data.request_id ?? null };
  };
}

export class JudgeUnavailable extends Error {
  override name = "JudgeUnavailable";
}

const validQuestions = (q: unknown): q is Record<string, JudgeQuestion> =>
  typeof q === "object" &&
  q !== null &&
  !Array.isArray(q) &&
  Object.keys(q).length > 0 &&
  Object.keys(q).length <= 64 &&
  Object.values(q).every((x) => typeof x === "object" && x !== null && ["text", "yes", "no"].every((k) => typeof (x as Record<string, unknown>)[k] === "string"));

// A request signed with a computer's device key (signRequest), checked on the server: a computer it knows, a signature
// that verifies for `signedAs`, a recent time, and a signature not seen before (`seen` keeps only signatures). The
// device and the body, or the answer that refuses it.
export async function checkSigned(req: Request, dir: Directory, signedAs: string, seen: Map<string, number>, now: () => number = Date.now) {
  const fail = (status: number, error: string) => Response.json({ error }, { status });
  const deviceId = req.headers.get("x-patio-device") ?? "";
  const time = req.headers.get("x-patio-time") ?? "";
  const sig = req.headers.get("x-patio-signature") ?? "";
  if (!deviceId || !time || !sig) return fail(401, "sign the request with this computer's key");
  const body = await req.text();
  if (body.length > MAX_BODY) return fail(413, "the request is too large");
  const device = dir.device(deviceId);
  if (!device) return fail(401, "unknown computer");
  if (!verifyRequest(device.sign_pk, signedAs, deviceId, time, body, sig)) return fail(401, "the signature does not verify");
  if (!(Math.abs(now() - Number(time.split(".")[0])) <= MAX_SKEW_MS)) return fail(401, "the request is too old or too new: check this computer's clock");
  for (const [s, until] of seen) if (until < now()) seen.delete(s);
  if (seen.has(sig)) return fail(401, "this request was already used");
  seen.set(sig, now() + 2 * MAX_SKEW_MS);
  return { device, body, deviceId };
}

// The headers of a request signed with this computer's key, for `signedAs`. The time carries a random nonce, so two
// identical requests in the same millisecond differ.
export function signedHeaders(keys: DeviceKeys, signedAs: string, body: string): Record<string, string> {
  const time = `${Date.now()}.${crypto.randomUUID()}`;
  return { "content-type": "application/json", "x-patio-device": keys.id, "x-patio-time": time, "x-patio-signature": signRequest(keys, signedAs, time, body) };
}

// The /judge route on the server.
export function judgeRoute(dir: Directory, opts: { judge: Judge | null; perDay: number; log: (line: string) => void; now?: () => number }) {
  const now = opts.now ?? Date.now;
  // Signatures seen recently: a request is used once. Only the signatures are kept, never a body.
  const seen = new Map<string, number>();
  const fail = (status: number, error: string) => Response.json({ error }, { status });

  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return fail(405, "POST a signed request");
    const signed = await checkSigned(req, dir, SIGNED_AS, seen, now);
    if (signed instanceof Response) return signed;
    const { device, body, deviceId } = signed;
    if (device.revoked_at) return fail(403, "this computer was revoked");
    if (!device.login) return fail(403, "this computer is not signed in: patio join <link> signs it in");
    if (!opts.judge) return fail(503, "this server has no judge (no TYPESAFE_API_KEY); set a key on your computer instead");
    let parsed: { state?: unknown; questions?: unknown };
    try {
      parsed = JSON.parse(body);
    } catch {
      return fail(400, "the body is not JSON");
    }
    if (parsed.state === undefined || !validQuestions(parsed.questions)) return fail(400, "give a state and the questions");
    const used = dir.useJudge(deviceId, new Date(now()).toISOString().slice(0, 10), opts.perDay);
    if (used === null) {
      opts.log(`judge: computer ${deviceId.slice(0, 8)} (@${device.login}) is over its daily limit of ${opts.perDay}`);
      return fail(429, `this computer used its ${opts.perDay} checks for today; it waits for you until tomorrow (UTC)`);
    }
    const started = now();
    try {
      const answer = await opts.judge(parsed.state, parsed.questions);
      opts.log(`judge: computer ${deviceId.slice(0, 8)} (@${device.login}), ${used}/${opts.perDay} today, ${now() - started} ms`);
      return Response.json({ answers: answer.answers, model: answer.model, request_id: answer.request_id ?? null });
    } catch (err) {
      // Only the kind of error: Jev's message could quote what it was asked.
      const kind = (err as Error)?.constructor?.name ?? "Error";
      opts.log(`judge: computer ${deviceId.slice(0, 8)} (@${device.login}), Jev failed (${kind}) after ${now() - started} ms`);
      return fail(502, `the judge failed (${kind})`);
    }
  };
}
