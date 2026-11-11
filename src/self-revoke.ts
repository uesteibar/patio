// `patio uninstall` revokes this computer at the server with the computer's own key: one signed POST to
// <server>/revoke-self (crypto.ts signRequest), so it works whether or not patio runs and whether or not it knows who
// is signed in. The server takes the computer's agents out of their workspaces and revokes the computer; their names
// stay their owner's, free for another of their computers.
import type { DeviceKeys } from "./crypto";
import type { Directory } from "./directory";
import { checkSigned, signedHeaders } from "./judge";

export const SELF_REVOKE_PATH = "/revoke-self";
const SIGNED_AS = "revoke-self";

// unknown: the server never saw this computer; not_signed_in: nobody confirmed it; already: revoked before.
export type SelfRevoke = { state: "revoked" | "already" | "not_signed_in" | "unknown"; label: string | null; left: { agent: string; workspace: string }[] };

// The route on the server. `revoked`: the computer's live connection, if any, is closed.
export function selfRevokeRoute(dir: Directory, opts: { log: (line: string) => void; revoked: (deviceId: string) => void; now?: () => number }) {
  const seen = new Map<string, number>();
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return Response.json({ error: "POST a signed request" }, { status: 405 });
    if (!dir.device(req.headers.get("x-patio-device") ?? "")) return Response.json({ state: "unknown", label: null, left: [] } satisfies SelfRevoke);
    const signed = await checkSigned(req, dir, SIGNED_AS, seen, opts.now);
    if (signed instanceof Response) return signed;
    const r = dir.revokeSelf(signed.deviceId);
    if (r.state === "revoked") {
      opts.log(`device ${signed.deviceId.slice(0, 8)} (${r.label}) of @${signed.device.login} revoked itself (patio uninstall)${r.left.length ? `; ${r.left.map((l) => `${l.agent} left ${l.workspace}`).join(", ")}` : ""}`);
      opts.revoked(signed.deviceId);
    }
    return Response.json(r satisfies SelfRevoke);
  };
}

// What patio uninstall gets: the server's answer, or why there is none.
export type SelfRevokeResult =
  | { ok: true; result: SelfRevoke }
  | { ok: false; why: "unreachable"; detail: string }
  // A server from before this route: it answers 404 without one of these answers.
  | { ok: false; why: "old_server" }
  | { ok: false; why: "refused"; detail: string };

export async function revokeSelfAt(serverHttp: string, keys: DeviceKeys, timeoutMs = 15_000): Promise<SelfRevokeResult> {
  const body = "{}";
  let res: Response;
  try {
    res = await fetch(`${serverHttp.replace(/\/$/, "")}${SELF_REVOKE_PATH}`, { method: "POST", headers: signedHeaders(keys, SIGNED_AS, body), body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return { ok: false, why: "unreachable", detail: (err as Error).name };
  }
  const data = (await res.json().catch(() => null)) as (Partial<SelfRevoke> & { error?: string }) | null;
  if (res.ok && data && typeof data.state === "string") return { ok: true, result: { state: data.state, label: data.label ?? null, left: data.left ?? [] } };
  if (res.status === 404) return { ok: false, why: "old_server" };
  return { ok: false, why: "refused", detail: data?.error ?? `the server answered ${res.status}` };
}
