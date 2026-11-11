// The exchange: humans sign in with GitHub (exchange-api.ts), devices (gatekeepers) connect over a WebSocket
// and prove they hold their device key, agents get identities their owners approve, and sealed envelopes are
// stored and forwarded between agents whose owners share a workspace. It routes on recipient, message id and
// conversation id; it never sees a message's kind, text or context.
import type { ServerWebSocket } from "bun";
import { clockFromEnv, messageTtlMs, sweepMs, type Clock } from "./clock";
import { verifyChallenge } from "./crypto";
import { AgentElsewhere, DirectoryError, openDirectory, type Moved } from "./directory";
import { exchangeApi, type GitHubConfig } from "./exchange-api";
import { jevFromEnv, type Judge } from "./gates";
import { judgePerDay, judgeRoute } from "./judge";
import { installRoutes } from "./install";
import { SELF_REVOKE_PATH, selfRevokeRoute } from "./self-revoke";
import { CHANNEL_ADDRESS_RE, HANDLE_RE, PROTOCOL_VERSION, type ClientFrame, type DeliveredEnvelope, type OutgoingEnvelope, type RelayFrame } from "./protocol";

type Conn = { nonce: string; device?: string };

export type ExchangeOptions = {
  port?: number;
  hostname?: string;
  // SQLite file for the directory and the mailbox. ":memory:" keeps nothing across restarts.
  db?: string;
  github?: GitHubConfig;
  // The exchange's own base URL as a browser reaches it (for the GitHub callback). Defaults to http://host:port.
  publicUrl?: string;
  log?: (line: string) => void;
  // How long an undelivered message is kept (default PATIO_MESSAGE_TTL, then 7 days), and the clock it is measured with.
  ttlMs?: number;
  clock?: Clock;
  // The server's judge (judge.ts): Jev with the server's key. Defaults to TYPESAFE_API_KEY (PATIO_JEV_URL,
  // PATIO_JEV_MODEL); null: none, and /judge answers 503. `judgePerDay`: checks per computer per UTC day.
  judge?: Judge | null;
  judgePerDay?: number;
  // The built binaries served with /install.sh (install.ts).
  dist?: string;
};

const ID_RE = /^[\w-]{1,100}$/;
const MAX_COPY = 96_000; // base64 of a sealed 32 000-character message, with room for the JSON around it

export function githubFromEnv(env = process.env): GitHubConfig | undefined {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return undefined;
  return {
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET,
    webUrl: (env.PATIO_GITHUB_WEB_URL ?? "https://github.com").replace(/\/$/, ""),
    apiUrl: (env.PATIO_GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, ""),
  };
}

function validateEnvelope(env: unknown): string | null {
  if (typeof env !== "object" || env === null) return "envelope must be an object";
  const e = env as Record<string, unknown>;
  if (typeof e.id !== "string" || !ID_RE.test(e.id)) return "id is required";
  if (typeof e.convo !== "string" || !ID_RE.test(e.convo)) return "convo is required";
  if (typeof e.from !== "string" || !HANDLE_RE.test(e.from)) return "from must be an agent name";
  if (typeof e.to !== "string" || !(HANDLE_RE.test(e.to) || CHANNEL_ADDRESS_RE.test(e.to))) return "to must be an agent name or #<channel id>";
  // A channel whose only member is the sender has nobody to send copies to.
  if (typeof e.copies !== "object" || e.copies === null || Array.isArray(e.copies) || (!Object.keys(e.copies).length && !CHANNEL_ADDRESS_RE.test(e.to)))
    return "copies must map recipient device ids to ciphertext";
  for (const [id, c] of Object.entries(e.copies))
    if (!ID_RE.test(id) || typeof c !== "string" || !c || c.length > MAX_COPY) return `copy for device ${id} is invalid or too large`;
  return null;
}

export function startExchange(opts: ExchangeOptions = {}) {
  const log = opts.log ?? ((line: string) => console.log(`[exchange] ${line}`));
  const dir = openDirectory(opts.db ?? ":memory:");
  const online = new Map<string, ServerWebSocket<Conn>>(); // device id -> its one live connection
  const clock = opts.clock ?? clockFromEnv();
  const ttlMs = opts.ttlMs ?? messageTtlMs();

  const send = (ws: ServerWebSocket<Conn>, frame: RelayFrame): void => {
    ws.send(JSON.stringify(frame));
  };

  // The approved agent `name`, if this connection's device hosts it.
  const hostedAgent = (ws: ServerWebSocket<Conn>, name: string) => {
    const agent = dir.agent(name);
    return agent && agent.device_id === ws.data.device && agent.status === "approved" ? agent : null;
  };

  const hello = (ws: ServerWebSocket<Conn>, frame: Extract<ClientFrame, { type: "hello" }>) => {
    if (ws.data.device) return send(ws, { type: "error", message: "already introduced" });
    if (frame.v !== PROTOCOL_VERSION) {
      send(ws, { type: "error", message: `protocol ${frame.v} not supported, exchange speaks ${PROTOCOL_VERSION}` });
      return ws.close(4000, "version");
    }
    const d = frame.device;
    if (!d || typeof d.box_pk !== "string" || !verifyChallenge(d, ws.data.nonce, String(frame.sig))) {
      send(ws, { type: "error", message: "device signature does not verify" });
      return ws.close(4004, "device");
    }
    const label = String(frame.label ?? "").slice(0, 60) || "computer";
    const known = dir.device(d.id);
    if (known && (known.sign_pk !== d.sign_pk || known.box_pk !== d.box_pk)) {
      send(ws, { type: "error", message: "device keys changed" });
      return ws.close(4004, "device");
    }
    if (known?.revoked_at) {
      send(ws, { type: "error", message: "this computer was revoked" });
      return ws.close(4003, "revoked");
    }
    const row = dir.seenDevice(d, label);
    if (!known) log(`new device ${d.id.slice(0, 8)} (${label})`);
    online.get(d.id)?.close(4005, "replaced by a new connection");
    ws.data.device = d.id;
    online.set(d.id, ws);
    log(`device ${d.id.slice(0, 8)} online${row.login ? ` (@${row.login})` : " (not paired)"}`);
    send(ws, { type: "welcome", device: d.id, login: row.login, agents: dir.agentsOfDevice(d.id) });
    let delivered = 0;
    for (const row of dir.pending(d.id)) if (deliver(ws, d.id, row)) delivered++;
    if (delivered) log(`delivered ${delivered} queued message(s) to device ${d.id.slice(0, 8)}`);
    for (const e of dir.expiriesFor(d.id)) tellExpired(ws, e);
  };

  // Tells a sender's device that its message to `to_agent` was dropped undelivered.
  const tellExpired = (ws: ServerWebSocket<Conn>, e: { msg_id: string; convo: string; to_agent: string; channel_id: string | null }) =>
    send(ws, { type: "expired", id: e.msg_id, convo: e.convo, to: e.to_agent, channel: e.channel_id, after_ms: ttlMs });

  // Undelivered copies older than the TTL are dropped; their senders are told now, or when they next connect.
  const sweep = () => {
    const gone = dir.expire(clock() - ttlMs, clock());
    for (const e of gone) {
      log(`expired undelivered: ${e.msg_id.slice(0, 8)} to ${e.to_agent} (older than ${Math.round(ttlMs / 1000)} s)`);
      const ws = online.get(e.from_device);
      if (ws) tellExpired(ws, e);
    }
  };
  const sweeper = setInterval(() => {
    try {
      sweep();
    } catch (err) {
      log(`expiry sweep failed: ${(err as Error).message}`);
    }
  }, sweepMs());

  // Delivers one stored copy, unless the memberships it depended on have changed since it was sent (a revoke,
  // a channel leave): then it is deleted unseen.
  const deliver = (ws: ServerWebSocket<Conn>, device: string, row: DeliveredEnvelope & { channel_id: string | null }) => {
    if (!dir.stillDeliverable(row)) {
      dir.ack(device, row.id);
      log(`dropped ${row.from} -> ${row.to} convo=${row.convo.slice(0, 8)}: no longer allowed (membership changed, or a device was revoked)`);
      return false;
    }
    const { channel_id, ...env } = row;
    send(ws, { type: "deliver", env: channel_id ? env : { ...env, workspaces: dir.sharedWorkspaces(row.from, row.agent) } });
    return true;
  };

  const onSend = (ws: ServerWebSocket<Conn>, env: OutgoingEnvelope) => {
    const id = typeof env?.id === "string" ? env.id : "";
    const problem = validateEnvelope(env);
    if (problem) return send(ws, { type: "undeliverable", id, reason: "invalid", detail: problem });
    const sender = hostedAgent(ws, env.from);
    if (!sender) return send(ws, { type: "undeliverable", id, reason: "invalid", detail: `${env.from} is not an agent of this computer` });
    // Which agent each device's copy is for, and the channel, if any.
    const agentFor = new Map<string, string>();
    let channelId: string | null = null;
    if (CHANNEL_ADDRESS_RE.test(env.to)) {
      channelId = env.to.slice(1);
      if (!dir.isChannelMember(channelId, env.from))
        return send(ws, { type: "undeliverable", id, reason: "not_allowed", detail: `${env.from} is not a member of that channel` });
      for (const m of dir.channelRecipients(env.from, channelId).members) if (!agentFor.has(m.device.id)) agentFor.set(m.device.id, m.agent);
    } else {
      const route = dir.route(env.from, env.to);
      if ("error" in route) return send(ws, { type: "undeliverable", id, reason: route.error });
      for (const d of route.devices) agentFor.set(d.id, env.to);
    }
    const stray = Object.keys(env.copies).filter((d) => !agentFor.has(d));
    if (stray.length) return send(ws, { type: "undeliverable", id, reason: "invalid", detail: `not a recipient device: ${stray.join(", ")}` });

    const ts = clock();
    dir.db.transaction(() => {
      for (const [device, ciphertext] of Object.entries(env.copies))
        dir.store(device, env, agentFor.get(device)!, channelId, ws.data.device!, ciphertext, ts);
    })();
    let delivered = false;
    for (const device of Object.keys(env.copies)) {
      const target = online.get(device);
      const row = target && dir.one(device, env.id);
      if (target && row && deliver(target, device, row)) delivered = true;
    }
    const copies = Object.keys(env.copies).length;
    log(`${env.from} -> ${env.to} convo=${env.convo.slice(0, 8)} ${channelId ? `${copies} member(s), ` : ""}${delivered || (channelId && !copies) ? "delivered" : "queued"}`);
    send(ws, { type: "sent", id, status: delivered || (channelId !== null && !copies) ? "delivered" : "queued", ...(channelId ? { recipients: copies } : {}) });
  };

  const onFrame = (ws: ServerWebSocket<Conn>, frame: ClientFrame) => {
    const rid = "rid" in frame ? String(frame.rid) : "";
    switch (frame.type) {
      case "who": {
        // Online agents that one of this device's agents may write to.
        const mine = dir.agentsOfDevice(ws.data.device!).filter((a) => a.status === "approved").map((a) => a.name);
        const visible = new Set<string>(mine);
        for (const [deviceId] of online)
          for (const a of dir.agentsOfDevice(deviceId))
            if (a.status === "approved" && mine.some((m) => dir.agentsMayExchange(m, a.name))) visible.add(a.name);
        const names = [...visible].sort();
        return send(ws, { type: "presence", online: names, owners: Object.fromEntries(names.map((n) => [n, dir.agent(n)?.login ?? ""])), workspaces: dir.workspaceRosters(ws.data.device!) });
      }
      case "channel_keys": {
        const me = hostedAgent(ws, String(frame.from));
        if (!me) return send(ws, { type: "failed", rid, error: `${frame.from} is not an agent of this computer` });
        return send(ws, { type: "channel_keys", rid, recipients: dir.channelRecipients(me.name, String(frame.channel)) });
      }
      case "join": {
        const agent = String(frame.agent);
        const byOwner = frame.by_owner === true;
        if (frame.workspace) {
          const r = dir.requestWorkspaceJoin(ws.data.device!, agent, String(frame.workspace), byOwner);
          log(`${agent} asks to join workspace ${r.workspace.name}: ${r.status}`);
          agentsChanged(ws.data.device!);
          return send(ws, { type: "membership", rid, kind: "workspace", target: r.workspace.name, status: r.status, needs: r.status === "pending" ? ["its owner"] : [] });
        }
        const r = dir.requestChannelJoin(ws.data.device!, agent, String(frame.channel ?? ""), byOwner);
        log(`${agent} asks to join #${r.channel.name} in ${r.channel.workspace}: ${r.status}`);
        return send(ws, { type: "membership", rid, kind: "channel", target: `${r.channel.workspace}/${r.channel.name}`, status: r.status, needs: r.needs });
      }
      case "leave_workspace": {
        const r = dir.leaveWorkspace(ws.data.device!, String(frame.agent), String(frame.workspace ?? ""));
        log(`${frame.agent} left workspace ${r.workspace.name}`);
        agentsChanged(ws.data.device!);
        return send(ws, { type: "membership", rid, kind: "workspace", target: r.workspace.name, status: "left", needs: [] });
      }
      case "workspace_new": {
        if (frame.by_owner !== true) return send(ws, { type: "failed", rid, error: "patio workspace new runs only from your own terminal" });
        const r = dir.createWorkspaceWithAgent(ws.data.device!, String(frame.name ?? ""), String(frame.agent ?? ""));
        log(`workspace ${r.workspace.name} created from a terminal, with ${r.agent}`);
        agentsChanged(ws.data.device!);
        return send(ws, { type: "invite_link", rid, url: `${publicUrl()}/join/${r.link.code}`, expires_at: null, max_uses: null, workspace: r.workspace.name, channels: r.channels });
      }
      case "leave": {
        const r = dir.leaveChannel(ws.data.device!, String(frame.agent), String(frame.channel));
        log(`${frame.agent} left #${r.channel.name}`);
        return send(ws, { type: "membership", rid, kind: "channel", target: `${r.channel.workspace}/${r.channel.name}`, status: "left", needs: [] });
      }
      case "join_link": {
        const names = Array.isArray(frame.agents) ? frame.agents.map(String) : [];
        const byOwner = frame.by_owner === true;
        const r = dir.joinByLink(ws.data.device!, String(frame.code ?? ""), names, byOwner, byOwner && frame.move === true);
        log(`${names.join(", ")} join${names.length === 1 ? "s" : ""} workspace ${r.workspace.name} by link: ${r.status}`);
        agentsChanged(ws.data.device!);
        const moved = "moved" in r ? r.moved : [];
        for (const m of moved) movedAway(m);
        return send(ws, { type: "link_joined", rid, ...r, moved: moved.map(({ agent, from, revoked }) => ({ agent, from, revoked })) });
      }
      case "invite": {
        const login = dir.device(ws.data.device!)?.login;
        if (!login) return send(ws, { type: "failed", rid, error: "sign in on this computer first (patio join <link>)" });
        const expires = Number(frame.expires_ms ?? 0);
        const link = dir.createInviteLink(login, String(frame.workspace ?? ""), { expiresAt: expires > 0 ? Date.now() + expires : null, maxUses: frame.max_uses ?? null });
        const name = dir.inviteInfo(link.code)!.workspace.name;
        log(`@${login} created an invite link to ${name} from their terminal`);
        return send(ws, { type: "invite_link", rid, url: `${publicUrl()}/join/${link.code}`, expires_at: link.expires_at, max_uses: link.max_uses, workspace: name });
      }
      case "pair": {
        const p = dir.startPairing(ws.data.device!);
        log(`pairing code issued for device ${ws.data.device!.slice(0, 8)}`);
        return send(ws, { type: "pairing", rid, ...p });
      }
      case "register": {
        const name = String(frame.name ?? "");
        if (!HANDLE_RE.test(name)) return send(ws, { type: "failed", rid, error: "an agent name is lowercase letters, digits, - and _ (up to 32)" });
        const agent = dir.requestAgent(ws.data.device!, name, frame.by_owner === true);
        agentsChanged(ws.data.device!);
        if (agent.status === "pending") log(`agent ${name} requested by device ${ws.data.device!.slice(0, 8)}; waiting for its owner`);
        else if (frame.by_owner) log(`agent ${name} registered by its owner from their terminal on device ${ws.data.device!.slice(0, 8)}`);
        return send(ws, { type: "registered", rid, agent });
      }
      case "keys": {
        const me = hostedAgent(ws, String(frame.from));
        if (!me) return send(ws, { type: "keys", rid, to: String(frame.to), devices: [], error: "invalid" });
        const route = dir.route(me.name, String(frame.to));
        if ("error" in route) return send(ws, { type: "keys", rid, to: String(frame.to), devices: [], error: route.error });
        const shared = dir.sharedWorkspaces(me.name, String(frame.to));
        const self = dir.answersIn(String(frame.to)).some((w) => shared.includes(w));
        return send(ws, { type: "keys", rid, to: String(frame.to), ...route, workspaces: shared, answers: self ? "self" : "owner", owner: dir.agent(String(frame.to))?.login ?? "" });
      }
      case "revoke_self": {
        const d = dir.device(ws.data.device!);
        if (!d?.login) return send(ws, { type: "failed", rid, error: "this computer is not signed in: nothing to revoke" });
        const device = dir.revokeDevice(d.login, d.id);
        log(`device ${device.id.slice(0, 8)} (${device.label}) of @${d.login} revoked itself (patio uninstall)`);
        send(ws, { type: "revoked_self", rid, label: device.label });
        ws.close(4003, "revoked");
        return;
      }
      case "channels": {
        const me = hostedAgent(ws, String(frame.agent));
        if (!me) return send(ws, { type: "failed", rid, error: `${frame.agent} is not an agent of this computer` });
        return send(ws, { type: "channel_list", rid, channels: dir.channelsForAgent(me.name) });
      }
      case "answering":
        for (const a of Array.isArray(frame.agents) ? frame.agents : []) dir.setAnswering(ws.data.device!, String(a.agent), Array.isArray(a.workspaces) ? a.workspaces.map(String) : []);
        return;
      case "ack":
        if (typeof frame.id === "string") dir.ack(ws.data.device!, frame.id);
        return;
      case "ack_expired":
        if (typeof frame.id === "string") dir.ackExpiry(ws.data.device!, frame.id);
        return;
      case "send":
        return onSend(ws, frame.env);
    }
    send(ws, { type: "error", message: "unknown frame type" });
  };

  // The device's agents, and the workspaces they are in, changed: it is told over its connection.
  const agentsChanged = (deviceId: string) => {
    const ws = online.get(deviceId);
    if (ws) send(ws, { type: "agents", agents: dir.agentsOfDevice(deviceId) });
  };

  // An agent moved to another computer of its owner: the one it left is told, or closed when it was revoked.
  const movedAway = (m: Moved) => {
    log(`${m.agent} moved off device ${m.from_device.slice(0, 8)} (${m.from})${m.revoked ? ", which had no agent left and is revoked" : ""}`);
    if (m.revoked) {
      const ws = online.get(m.from_device);
      if (!ws) return;
      send(ws, { type: "error", message: "this computer was revoked" });
      ws.close(4003, "revoked");
    } else agentsChanged(m.from_device);
  };

  const publicUrl = () => (opts.publicUrl ?? `http://${server.hostname}:${server.port}`).replace(/\/$/, "");
  const http = exchangeApi(dir, {
    github: opts.github,
    publicUrl: () => publicUrl(),
    log,
    hooks: {
      devicePaired: (deviceId, login) => {
        const ws = online.get(deviceId);
        if (ws) send(ws, { type: "paired", login });
      },
      agentsChanged,
      movedAway,
      online: (deviceId) => online.has(deviceId),
      deviceRevoked: (deviceId) => {
        const ws = online.get(deviceId);
        if (!ws) return;
        send(ws, { type: "error", message: "this computer was revoked" });
        ws.close(4003, "revoked");
      },
    },
  });

  const judge = opts.judge !== undefined ? opts.judge : jevFromEnv();
  const perDay = opts.judgePerDay ?? judgePerDay();
  const judgeHttp = judgeRoute(dir, { judge, perDay, log });
  const selfRevoke = selfRevokeRoute(dir, {
    log,
    revoked: (deviceId) => {
      const ws = online.get(deviceId);
      if (!ws) return;
      send(ws, { type: "error", message: "this computer was revoked" });
      ws.close(4003, "revoked");
    },
  });
  const install = installRoutes(opts.dist, () => publicUrl());

  const server = Bun.serve<Conn>({
    port: opts.port ?? 7777,
    hostname: opts.hostname ?? "127.0.0.1",
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/health") return new Response("ok");
      if (url.pathname === "/judge") return judgeHttp(req);
      if (url.pathname === SELF_REVOKE_PATH) return selfRevoke(req);
      const installing = install(url);
      if (installing) return installing;
      const handled = await http(req);
      if (handled) return handled;
      if (srv.upgrade(req, { data: { nonce: crypto.randomUUID() } })) return;
      return new Response("patio server: connect with a WebSocket, or sign in through your patio web app", { status: 426 });
    },
    websocket: {
      idleTimeout: 120,
      sendPings: true,
      open(ws) {
        send(ws, { type: "challenge", nonce: ws.data.nonce });
      },
      message(ws, raw) {
        let frame: ClientFrame;
        try {
          frame = JSON.parse(String(raw));
        } catch {
          return send(ws, { type: "error", message: "frames must be JSON" });
        }
        if (frame.type === "hello") return hello(ws, frame);
        if (!ws.data.device) return send(ws, { type: "error", message: "say hello first" });
        try {
          onFrame(ws, frame);
        } catch (err) {
          const message = err instanceof DirectoryError ? err.message : "internal error";
          if (!(err instanceof DirectoryError)) log(`error handling ${frame.type}: ${(err as Error).message}`);
          if ("rid" in frame && err instanceof AgentElsewhere) {
            const { device_id, ...e } = err.elsewhere;
            send(ws, { type: "failed", rid: String(frame.rid), error: message, code: "agent_elsewhere", elsewhere: { ...e, online: online.has(device_id) } });
          } else if ("rid" in frame) send(ws, { type: "failed", rid: String(frame.rid), error: message });
          else send(ws, { type: "error", message });
        }
      },
      close(ws) {
        const device = ws.data.device;
        if (!device || online.get(device) !== ws) return;
        online.delete(device);
        dir.deviceOffline(device);
        log(`device ${device.slice(0, 8)} offline`);
      },
    },
  });

  if (!opts.github) log("GitHub sign-in is not configured (GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET): nobody can sign in or pair");
  log(judge ? `judge: on, ${perDay} checks per computer per day` : "judge: off (no TYPESAFE_API_KEY): /judge answers 503");
  log(`mailbox ${opts.db ?? ":memory:"}`);
  log(`listening on ws://${server.hostname}:${server.port}`);
  return {
    port: server.port!,
    hostname: server.hostname,
    url: `http://${server.hostname}:${server.port}`,
    stop: (closeActive = true) => {
      clearInterval(sweeper);
      server.stop(closeActive);
      dir.db.close();
    },
  };
}
