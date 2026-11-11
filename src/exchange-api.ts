// The exchange's HTTP API, for humans only. Every /api route needs a web session, and a web session can only
// be created by signing in with GitHub (OAuth web flow), or with a demo person's one-time link (`patio exchange
// demo-person`, run by the server's operator), and handing the result to a gatekeeper's web app. Public routes: the
// invite page (/join/<code>) and what it shows (/api/invites/<code>).
// Devices (gatekeepers) talk to the exchange over the WebSocket and have no way to get a session, so nothing
// an agent can reach through its gatekeeper can approve, invite, pair or revoke.
import { DirectoryError, LINK_ERRORS, type Directory, type Moved } from "./directory";
import { invitePage } from "./invite-page";

export type GitHubConfig = {
  clientId: string;
  clientSecret: string;
  webUrl: string; // https://github.com, or the fake provider
  apiUrl: string; // https://api.github.com, or the fake provider
};

export type ApiHooks = {
  // A device was paired, or one of its agents changed status: the exchange tells it over the WebSocket.
  devicePaired: (deviceId: string, login: string) => void;
  agentsChanged: (deviceId: string) => void;
  // A device was revoked: the exchange closes its connection.
  deviceRevoked: (deviceId: string) => void;
  // An agent moved to another computer of its owner: the computer it left is told (or closed, when revoked).
  movedAway: (m: Moved) => void;
  // Whether a device is connected now.
  online: (deviceId: string) => boolean;
};

// Sign-ins that may be in flight at once (each lives 10 minutes).
const MAX_PENDING_SIGN_INS = 1000;

const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (status: number, error: string) => json({ error }, status);

// Only a gatekeeper's web app on this machine may receive a sign-in. Anything else would be an open redirect.
export function allowedReturnTo(value: string | null): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    return url.protocol === "http:" && local && url.pathname === "/auth/done" && !url.username ? url : null;
  } catch {
    return null;
  }
}

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// A plain page of the server (the demo sign-in link), in the invite page's look.
const page = (title: string, body: string, status = 200, headers: Record<string, string> = {}) => invitePage({ title, body, status, headers });

export function exchangeApi(dir: Directory, opts: { github?: GitHubConfig; publicUrl: () => string; hooks: ApiHooks; log: (line: string) => void }) {
  const linkUrl = (code: string) => `${opts.publicUrl()}/join/${code}`;
  const states = new Map<string, { returnTo: URL; clientState: string; expires: number }>();

  const session = (req: Request) => {
    const token = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
    const login = token ? dir.sessionLogin(token) : null;
    return login ? { token: token!, login } : null;
  };

  const body = async (req: Request): Promise<Record<string, unknown>> => {
    try {
      return ((await req.json()) ?? {}) as Record<string, unknown>;
    } catch {
      return {};
    }
  };

  // A demo person's one-time link, once opened, lets this browser's next sign-in (within 10 minutes) be that person's
  // instead of a GitHub account. Kept in memory only, by a random cookie value; used once.
  const demoGrants = new Map<string, { login: string; expires: number }>();
  const DEMO_COOKIE = "patio_demo";
  const demoGrantOf = (req: Request) => {
    const v = new RegExp(`(?:^|; )${DEMO_COOKIE}=([^;]+)`).exec(req.headers.get("cookie") ?? "")?.[1];
    const g = v ? demoGrants.get(v) : undefined;
    if (v) demoGrants.delete(v);
    return g && g.expires > Date.now() ? g.login : null;
  };
  const clearDemo = `${DEMO_COOKIE}=; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=0`;

  const demoLink = (token: string) => {
    const login = dir.takeDemoSignIn(token);
    if (!login) return page("Sign-in link used", `<h1>This sign-in link no longer works</h1><p>It was used already, or it is older than 10 minutes. Ask the server's operator for a new one.</p>`, 410);
    for (const [k, v] of demoGrants) if (v.expires < Date.now()) demoGrants.delete(k);
    const grant = crypto.randomUUID();
    demoGrants.set(grant, { login, expires: Date.now() + 10 * 60_000 });
    opts.log(`demo person @${login} opened their one-time sign-in link`);
    const secure = opts.publicUrl().startsWith("https:") ? "; Secure" : "";
    return page(
      `Sign in as @${login}`,
      `<h1>Sign in as @${esc(login)} <span class="tag">demo</span></h1><p>Now open the patio web app on the computer you use as @${esc(login)} (<span class="mono">patio status</span> prints its address, and <span class="mono">patio join</span> opens it) and sign in there. This browser signs in as @${esc(login)} instead of GitHub, once, in the next 10 minutes.</p>`,
      200,
      { "set-cookie": `${DEMO_COOKIE}=${grant}; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=600${secure}` },
    );
  };

  // The web app gets the result of a sign-in, or why it was refused.
  const backTo = (returnTo: URL, clientState: string, result: { code: string } | { error: string }, headers: Record<string, string> = {}) => {
    const back = new URL(returnTo);
    if ("code" in result) back.searchParams.set("code", result.code);
    else back.searchParams.set("error", result.error);
    back.searchParams.set("state", clientState);
    return new Response(null, { status: 302, headers: { location: back.toString(), ...headers } });
  };

  const signInStart = (req: Request, url: URL) => {
    const returnTo = allowedReturnTo(url.searchParams.get("return_to"));
    const demo = returnTo ? demoGrantOf(req) : null;
    if (returnTo && demo) {
      dir.signedIn({ login: demo, id: 0 }, true);
      opts.log(`demo person @${demo} signed in`);
      return backTo(returnTo, url.searchParams.get("state") ?? "", { code: dir.issueHandoff(demo) }, { "set-cookie": clearDemo });
    }
    if (!opts.github) return fail(503, "GitHub sign-in is not configured on this server");
    if (!returnTo) return fail(400, "return_to must be a patio web app on this computer (http://127.0.0.1:<port>/auth/done)");
    // Expired sign-ins are dropped here, so hitting this route cannot grow memory without bound (security audit S17).
    for (const [k, v] of states) if (v.expires < Date.now()) states.delete(k);
    if (states.size >= MAX_PENDING_SIGN_INS) return fail(429, "too many sign-ins are in progress; try again in a few minutes");
    const state = crypto.randomUUID();
    states.set(state, { returnTo, clientState: url.searchParams.get("state") ?? "", expires: Date.now() + 10 * 60_000 });
    const authorize = new URL(`${opts.github.webUrl}/login/oauth/authorize`);
    authorize.searchParams.set("client_id", opts.github.clientId);
    authorize.searchParams.set("redirect_uri", `${opts.publicUrl()}/auth/github/callback`);
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("allow_signup", "false");
    // GitHub treats `login` as a suggestion; the fake provider signs that user in directly.
    const hint = url.searchParams.get("login");
    if (hint) authorize.searchParams.set("login", hint);
    return Response.redirect(authorize.toString(), 302);
  };

  const signInCallback = async (url: URL) => {
    const gh = opts.github;
    if (!gh) return fail(503, "GitHub sign-in is not configured on this server");
    const state = url.searchParams.get("state") ?? "";
    const pending = states.get(state);
    states.delete(state);
    if (!pending || pending.expires < Date.now()) return fail(400, "this sign-in link has expired; start again from the web app");
    const code = url.searchParams.get("code");
    if (!code) return fail(400, url.searchParams.get("error_description") ?? "GitHub did not return a code");
    const tokenRes = await fetch(`${gh.webUrl}/login/oauth/access_token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: gh.clientId, client_secret: gh.clientSecret, code, redirect_uri: `${opts.publicUrl()}/auth/github/callback` }),
    });
    const token = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; error?: string };
    if (!token.access_token) return fail(502, `GitHub refused the code: ${token.error ?? tokenRes.status}`);
    const userRes = await fetch(`${gh.apiUrl}/user`, {
      headers: { authorization: `Bearer ${token.access_token}`, accept: "application/vnd.github+json", "user-agent": "patio-exchange" },
    });
    const user = (await userRes.json().catch(() => ({}))) as { login?: string; id?: number; name?: string };
    if (!userRes.ok || typeof user.login !== "string" || typeof user.id !== "number") return fail(502, "GitHub did not say who signed in");
    // The GitHub token is not kept: the exchange only needed to learn the login.
    try {
      dir.signedIn({ login: user.login, id: user.id, name: user.name });
    } catch (err) {
      if (!(err instanceof DirectoryError)) throw err;
      opts.log(`refused the GitHub sign-in of @${user.login}: ${err.message}`);
      return backTo(pending.returnTo, pending.clientState, { error: err.message });
    }
    opts.log(`@${user.login} signed in with GitHub`);
    return backTo(pending.returnTo, pending.clientState, { code: dir.issueHandoff(user.login) });
  };

  // Routes that need a signed-in human.
  const api = async (req: Request, url: URL, who: { token: string; login: string }) => {
    const parts = url.pathname.split("/").filter(Boolean).slice(1); // drop "api"
    const post = req.method === "POST";
    const [a, b, c, d, e] = parts;
    if (a === "me" && !b && !post)
      return json({
        login: who.login,
        devices: dir.allDevicesOf(who.login).map((d) => ({ ...d, online: !d.revoked_at && opts.hooks.online(d.id) })),
        agents: dir.agentsOf(who.login).map((ag) => ({ ...ag, workspaces: dir.agentWorkspaces(ag.name) })),
        workspaces: dir.workspacesOf(who.login),
        requests: dir.pendingRequests(who.login),
      });
    if (a === "logout" && post) {
      dir.endSession(who.token);
      return json({ ok: true });
    }
    if (a === "pair" && post) {
      const device = dir.confirmPairing(who.login, String((await body(req)).code ?? ""));
      opts.log(`device ${device.id.slice(0, 8)} (${device.label}) paired with @${who.login}`);
      opts.hooks.devicePaired(device.id, who.login);
      return json({ device: { id: device.id, label: device.label } });
    }
    if (a === "devices" && b && c === "revoke" && post) {
      const device = dir.revokeDevice(who.login, decodeURIComponent(b));
      opts.log(`@${who.login} revoked device ${device.id.slice(0, 8)} (${device.label})`);
      opts.hooks.deviceRevoked(device.id);
      return json({ device: { id: device.id, label: device.label, revoked_at: device.revoked_at } });
    }
    if (a === "agents" && b && post && (c === "approve" || c === "reject" || c === "revoke")) {
      const decision = c === "approve" ? "approved" : c === "reject" ? "rejected" : "revoked";
      const agent = dir.decideAgent(who.login, decodeURIComponent(b), decision);
      opts.log(`@${who.login} ${decision} agent ${agent.name}`);
      opts.hooks.agentsChanged(agent.device_id);
      return json({ agent: { name: agent.name, status: agent.status } });
    }
    if (a === "workspaces" && !b && post) return json({ workspace: dir.createWorkspace(who.login, String((await body(req)).name ?? "")) });
    if (a === "workspaces" && b && !c && !post) return json({ workspace: dir.workspace(who.login, b) });
    if (a === "workspaces" && b && c === "links" && !d && post) {
      const body_ = await body(req);
      const expiresIn = Number(body_.expires_in_ms ?? 0);
      const maxUses = body_.max_uses === undefined || body_.max_uses === null || body_.max_uses === "" ? null : Number(body_.max_uses);
      const link = dir.createInviteLink(who.login, b, { expiresAt: expiresIn > 0 ? Date.now() + expiresIn : null, maxUses });
      opts.log(`@${who.login} created an invite link to ${b}`);
      return json({ link: { ...link, url: linkUrl(link.code) } });
    }
    if (a === "links" && b && c === "revoke" && post) {
      const link = dir.revokeInviteLink(who.login, decodeURIComponent(b));
      opts.log(`@${who.login} revoked an invite link to ${link.workspace_id}`);
      return json({ ok: true });
    }
    if (a === "link-requests" && b && (c === "approve" || c === "reject") && post) {
      const { devices, ...res } = dir.decideLinkRequest(who.login, decodeURIComponent(b), c === "approve" ? "approved" : "rejected");
      opts.log(`@${who.login} ${c === "approve" ? "let" : "did not let"} ${res.agents.map((x) => x.name).join(", ") || "an agent"} join ${res.workspace} by link`);
      for (const d of devices) opts.hooks.agentsChanged(d);
      return json(res);
    }
    // The one confirmation of a first run started by an agent: this computer, its agent and the join, in one click.
    if (a === "setup" && !b && post) {
      const body_ = await body(req);
      const r = dir.confirmSetup(who.login, { code: String(body_.code ?? ""), link: String(body_.link ?? ""), agent: body_.agent ? String(body_.agent) : null, move: body_.move === true });
      opts.log(`@${who.login} confirmed computer ${r.device.id.slice(0, 8)} (${r.device.label}) with ${r.agent} joining ${r.workspace}${r.moved ? `, moved from ${r.moved.from}` : ""}`);
      opts.hooks.devicePaired(r.device.id, who.login);
      opts.hooks.agentsChanged(r.device.id);
      if (r.moved) opts.hooks.movedAway(r.moved);
      const moved = r.moved ? { agent: r.moved.agent, from: r.moved.from, revoked: r.moved.revoked } : null;
      return json({ device: { id: r.device.id, label: r.device.label }, agent: r.agent, workspace: r.workspace, channels: r.channels, moved });
    }
    // The owner adds their agent to, or takes it out of, a workspace (the Agents page).
    if (a === "agents" && b && c === "workspaces" && d && (e === "add" || e === "leave") && post) {
      const name = decodeURIComponent(b);
      const r = e === "add" ? dir.ownerAddAgent(who.login, name, decodeURIComponent(d)) : dir.ownerRemoveAgent(who.login, name, decodeURIComponent(d));
      opts.log(`@${who.login} ${e === "add" ? "put" : "took"} ${name} ${e === "add" ? "in" : "out of"} ${r.workspace.name}`);
      opts.hooks.agentsChanged(r.device);
      return json({ workspace: r.workspace, ...("channels" in r ? { channels: r.channels } : {}) });
    }
    if (a === "channels" && b && c === "default" && post) {
      const channel = dir.setChannelDefault(who.login, decodeURIComponent(b), (await body(req)).default === true);
      opts.log(`@${who.login} made #${channel.name} ${channel.is_default ? "a default channel" : "not a default channel"}`);
      return json({ channel });
    }
    if (a === "workspaces" && b && c === "agents" && d && (e === "approve" || e === "reject") && post) {
      const agent = dir.decideWorkspaceJoin(who.login, b, decodeURIComponent(d), e === "approve" ? "approved" : "rejected");
      opts.log(`@${who.login} ${e === "approve" ? "approved" : "rejected"} ${agent.name} joining workspace ${b}`);
      opts.hooks.agentsChanged(agent.device_id);
      return json({ ok: true });
    }
    if (a === "workspaces" && b && c === "channels" && !d && post) {
      const body_ = await body(req);
      const channel = dir.createChannel(who.login, b, String(body_.name ?? ""), body_.private === true);
      opts.log(`@${who.login} created ${channel.private ? "private " : ""}#${channel.name} in ${b}`);
      return json({ channel });
    }
    if (a === "channels" && b && c === "members" && d && (e === "approve" || e === "reject") && post) {
      const res = dir.decideChannelJoin(who.login, b, decodeURIComponent(d), e === "approve" ? "approved" : "rejected");
      opts.log(`@${who.login} ${e === "approve" ? "approved" : "rejected"} ${res.agent.name} joining channel ${b}: now ${res.member.status}`);
      return json({ status: res.member.status });
    }
    if (a === "workspaces" && b && c === "notices" && d && e === "dismiss" && post) {
      dir.dismissNotice(who.login, b, Number(d));
      return json({ ok: true });
    }
    if (a === "workspaces" && b && c === "members" && d && e === "revoke" && post) {
      dir.revoke(who.login, b, decodeURIComponent(d));
      opts.log(`@${who.login} revoked @${d} in ${b}`);
      return json({ ok: true });
    }
    return fail(404, "unknown endpoint");
  };

  // Returns null for paths this module does not own.
  return async (req: Request): Promise<Response | null> => {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/auth/github/start") return signInStart(req, url);
      const demo = /^\/auth\/demo\/([\w-]+)$/.exec(url.pathname);
      if (demo && req.method === "GET") return demoLink(demo[1]!);
      const join = /^\/join\/([\w-]+)$/.exec(url.pathname);
      if (join && req.method === "GET") {
        const info = dir.inviteInfo(join[1]!);
        const link = info ? dir.inviteLinkRow(join[1]!) : null;
        const error = !info ? LINK_ERRORS.unknown() : info.state !== "ok" ? LINK_ERRORS[info.state](link!) : null;
        return invitePage({ info, error, url: linkUrl(join[1]!), server: opts.publicUrl(), app: `patio://join/${join[1]}?server=${encodeURIComponent(opts.publicUrl())}` });
      }
      const invite = /^\/api\/invites\/([\w-]+)$/.exec(url.pathname);
      if (invite && req.method === "GET") {
        const info = dir.inviteInfo(invite[1]!);
        if (!info) return fail(404, LINK_ERRORS.unknown());
        if (info.state !== "ok") return Response.json({ ...info, error: LINK_ERRORS[info.state](dir.inviteLinkRow(invite[1]!)!) }, { status: 410 });
        return json({ ...info, url: linkUrl(info.code) });
      }
      if (url.pathname === "/auth/github/callback") return await signInCallback(url);
      if (url.pathname === "/api/session" && req.method === "POST") {
        const res = dir.redeemHandoff(String((await body(req)).code ?? ""));
        return res ? json(res) : fail(400, "that sign-in code is unknown, used or expired");
      }
      if (url.pathname.startsWith("/api/")) {
        const who = session(req);
        if (!who) return fail(401, "sign in with GitHub in the web app first");
        return await api(req, url, who);
      }
      return null;
    } catch (err) {
      if (err instanceof DirectoryError) return fail(err.status, err.message);
      throw err;
    }
  };
}
