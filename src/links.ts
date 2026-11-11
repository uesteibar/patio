// Invite links on the person's side: `patio join <link>`. A link is
// https://<server>/join/<code>, or patio://join/<code>?server=<url> for the future app. Anything that contains /join/
// is taken as a link (a paste often loses its https://, which is added back).

export type InviteLink = { code: string; server: string | null };
export type InvitePreview = {
  workspace: { id: string; name: string };
  inviter: string;
  people: number;
  agents: number;
  // Older servers do not send it.
  members?: { agent: string; owner: string }[];
  expires_at: number | null;
};

export class LinkError extends Error {}

export function parseInviteLink(raw: string): InviteLink | null {
  let url: URL;
  const text = raw.trim();
  try {
    url = new URL(/^[a-z][\w+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol === "patio:") {
    const m = /^\/\/join\/([\w-]+)\/?$/.exec(`//${url.host}${url.pathname}`) ?? /^\/?join\/([\w-]+)\/?$/.exec(url.pathname);
    return m ? { code: m[1]!, server: url.searchParams.get("server") } : null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const m = /^(.*)\/join\/([\w-]+)\/?$/.exec(url.pathname);
  return m ? { code: m[2]!, server: `${url.origin}${m[1]}` } : null;
}

export const looksLikeLink = (s: string) => /^(https?|patio):\/\//.test(s.trim()) || s.includes("/join/");

// What the server says about a link before anyone signs in; a link that no longer works is refused here, with why.
export async function previewLink(server: string, code: string): Promise<InvitePreview> {
  const res = await fetch(`${server.replace(/\/$/, "")}/api/invites/${encodeURIComponent(code)}`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!res) throw new LinkError(`cannot reach the server at ${server}`);
  const body = (await res.json().catch(() => ({}))) as InvitePreview & { error?: string };
  if (!res.ok) throw new LinkError(body.error ?? `the server answered ${res.status}`);
  return body;
}

// "@pablo invited you to orbit: pablo-orbit (@pablo), ana-orbit (@ana)".
export function describeInvite(p: InvitePreview): string {
  const who = p.members ? (p.members.length ? `: ${p.members.map((m) => `${m.agent} (@${m.owner})`).join(", ")}` : ", where no agent is yet") : "";
  return `@${p.inviter} invited you to ${p.workspace.name}${who}`;
}
