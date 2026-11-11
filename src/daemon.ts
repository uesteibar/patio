// The gatekeeper (daemon): keeps this person connected to the exchange, holds the device keys, keeps the
// persistent inbox and serves the local socket that the CLI and MCP server use. Messages are sealed and signed
// here before they leave, and opened and verified here when they arrive (crypto.ts); the exchange only ever
// sees ciphertext.
//
// It receives, gates and stores; it never starts an agent. The input gate runs on what reaches its agents
// (before the inbox) and the output gate on what they send (before sealing), against the owner's grants.yaml
// or the default grant (gates.ts). Held messages wait for the owner's decision in the web app. Every gate
// decision is one JSON line in $PATIO_HOME/audit.jsonl. Consuming the inbox is the CLI's job: `patio answer`
// claims a message, runs the owner's agent and hands its reply back here (answer.ts), and `patio watch` does
// that, or runs a command, for each new message.
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Config } from "./config";
import { EnvelopeError, loadOrCreateDevice, openForSelf, openMessage, publicDevice, sealForSelf, sealMessage, signChallenge, type Inner } from "./crypto";
import { actionSummary, CATEGORIES, HeldError, inputGate, jevFromEnv, outputGate, type GateDecision, type Judge } from "./gates";
import { autoAnswerInKey, autoAnswers, grantFor, type Widening } from "./grants";
import { agentPath, EMPTY_AGENT, fileWidenings, parseAgentFile, rulesOf, type AgentFile } from "./agent-file";
import { loadLiveConfig } from "./live-config";
import { clockFromEnv, formatDuration, messageTtlMs, sweepMs, type Clock } from "./clock";
import { AmbiguousId, openInbox, publicItem, ReplyRule, type InboxItem, type ListFilter } from "./inbox";
import {
  KINDS,
  newId,
  PROTOCOL_VERSION,
  validateOutgoing,
  type ClientFrame,
  type DeliveredEnvelope,
  type Kind,
  type Message,
  type Outgoing,
  type PublicDevice,
  type RelayFrame,
  type AgentInfo,
  type ChannelRef,
  type MembershipStatus,
  type UndeliverableReason,
  type Roster,
} from "./protocol";
import { hostname } from "node:os";
import { startWebApp } from "./webapp";
import { withAttention, type AgentRow, type StatusReport } from "./status";
import { checkToolAsync, CONNECT_TOOLS, connectedTools, type ConnectTool, type ToolState } from "./connect";
import { readChecks, recordChecks } from "./preflight";
import { expandHome } from "./config";
import { serverJudge } from "./judge";
import { guideText } from "./guide";
import { answerSentences, answersFor, answersSay, applyAnswers, wideningSentences, type Answers } from "./answers";
import { appendAudit, readAudit } from "./audit";
import { acquireLock } from "./lock";
import { notify as desktopNotify } from "./notify";
import { answer as answerWithAgent } from "./answer";
import type { DryRun, DryRunInput } from "./dryrun";

export type SendResult =
  | { ok: true; status: "delivered" | "queued"; message: Message; recipients?: number; answers?: "self" | "owner"; owner?: string }
  // The output gate held it for the owner's approval; `reason` is the category.
  | { ok: true; status: "held"; message: Message; reason: string }
  // The exchange was unreachable: it passed the output gate and waits, encrypted, in this gatekeeper's outbox.
  | { ok: true; status: "outbox"; message: Message }
  | { ok: false; reason: "relay_down" | "blocked" | "keys_blocked" | UndeliverableReason; detail?: string };

// A message a local agent sends, before sealing.
type Draft = Outgoing & { from: string; in_reply_to?: string; channel?: ChannelRef };

export type DaemonOptions = {
  log?: (line: string) => void;
  // Port for the local web app on 127.0.0.1 (0: any free port). Defaults to PATIO_WEB_PORT, then 0.
  webPort?: number;
  // Called when an envelope fails decryption, signature or envelope checks (tests use it).
  onReject?: (env: DeliveredEnvelope, reason: string) => void;
  // The gates' judge. Defaults to Jev with this computer's own TYPESAFE_API_KEY (PATIO_JEV_URL, PATIO_JEV_MODEL), and
  // without one to the server's judge (judge.ts). null: none, so every gated message waits for the owner.
  judge?: Judge | null;
  // How long a claim lasts without renewal. Defaults to PATIO_CLAIM_LEASE_SECONDS, then 120 s.
  claimLeaseMs?: number;
  // The time expiries use (tests move it forward). Defaults to the real clock, or PATIO_TEST_CLOCK.
  clock?: Clock;
};

export async function startDaemon(cfg: Config, opts: DaemonOptions = {}) {
  const log = opts.log ?? ((line: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`));
  const clock: Clock = opts.clock ?? clockFromEnv();
  // A desktop notification for what waits for the person; a click opens the web app on Needs you (notify.ts).
  const notify = (title: string, body: string) => desktopNotify(title, body, `${web.url}/`);
  const leaseMs = opts.claimLeaseMs ?? Number(process.env.PATIO_CLAIM_LEASE_SECONDS ?? 120) * 1000;
  // The agents' files (agents/<name>.yaml), reloaded while running (live-config.ts). An invalid file stops patio here,
  // at start, with the file's error; an invalid edit later keeps the last valid version and is reported. An agent
  // without a file has the default rules: every kind, the prompt-injection check, ask the human on doubt.
  await mkdir(cfg.home, { recursive: true, mode: 0o700 });
  // One patio per home (lock.ts): a second start stops here, before it touches the socket. PATIO_TEST_NO_LOCK=1 (tests
  // only) runs without the lock, as patio before increment 15 did, so patio uninstall can be tested against one.
  const releaseLock = process.env.PATIO_TEST_NO_LOCK === "1" ? () => {} : acquireLock(cfg.home);
  const config = (() => {
    try {
      return loadLiveConfig(cfg.home, { log, clock });
    } catch (err) {
      releaseLock();
      throw err;
    }
  })();
  try {
    await mkdir(dirname(cfg.socket), { recursive: true, mode: 0o700 });
    await assertPrivateDir(dirname(cfg.socket));
    const running = await fetch("http://daemon/status", { unix: cfg.socket } as RequestInit).catch(() => null);
    if (running?.ok) throw new Error(`patio is already running on ${cfg.socket}`);
  } catch (err) {
    releaseLock();
    throw err;
  }
  await rm(cfg.socket, { force: true });
  const device = await loadOrCreateDevice(cfg.home);
  // A local key wins (development, self-hosting); without one, the server's judge. Either way the gates fail closed.
  const serverUrl = cfg.relay.replace(/^ws(s?):/, "http$1:").replace(/\/$/, "");
  const localJudge = opts.judge !== undefined ? opts.judge : jevFromEnv();
  const judgeKind: StatusReport["judge"] =
    localJudge ? { kind: "local" } : opts.judge === null ? { kind: "none" } : { kind: "server", url: serverUrl };
  const judge: Judge | null = localJudge ?? (judgeKind.kind === "server" ? serverJudge({ url: serverUrl, keys: device }) : null);

  // ---- exchange connection ------------------------------------------------
  let ws: WebSocket | null = null;
  let connected = false;
  let stopped = false;
  let revoked = false;
  const pendingSends = new Map<string, (r: SendResult) => void>();
  type KeysReply = { devices: PublicDevice[]; error?: UndeliverableReason; workspaces?: string[]; answers?: "self" | "owner"; owner?: string };
  const pendingKeys = new Map<string, (reply: KeysReply | null) => void>();
  type Who = { online: string[]; owners: Record<string, string>; workspaces: Roster[] | null };
  const pendingWho: Array<(r: Who) => void> = [];
  const pendingRid = new Map<string, { resolve: (frame: RelayFrame) => void }>();
  // What the exchange says about this device: who it is paired with, and the agents it hosts.
  let login: string | null = null;
  let agents: AgentInfo[] = [];
  const label = process.env.PATIO_DEVICE_NAME || hostname();
  const ready = () => agents.filter((a) => a.status === "approved").map((a) => a.name);

  const sendFrame = (frame: ClientFrame) => ws?.send(JSON.stringify(frame));

  const connect = () => {
    if (stopped) return;
    ws = new WebSocket(cfg.relay);
    ws.onmessage = (ev) => {
      try {
        onRelayFrame(JSON.parse(String(ev.data)) as RelayFrame);
      } catch (err) {
        log(`ignored a bad frame from the server: ${(err as Error).message}`);
      }
    };
    ws.onclose = (ev) => {
      if (connected) log("disconnected from the server");
      connected = false;
      // The owner revoked this device: the exchange will refuse it from now on, so stop trying.
      if (ev.code === 4003 && !revoked) {
        revoked = true;
        log("this computer was revoked by its owner: the server refuses it. Set patio up again with a new PATIO_HOME (patio join <link>) to continue.");
      }
      for (const [, resolve] of pendingSends) resolve({ ok: false, reason: "relay_down" });
      pendingSends.clear();
      for (const [, resolve] of pendingKeys) resolve(null);
      pendingKeys.clear();
      for (const resolve of pendingWho.splice(0)) resolve({ online: [], owners: {}, workspaces: null });
      for (const [, p] of pendingRid) p.resolve({ type: "failed", rid: "", error: NOT_CONNECTED });
      pendingRid.clear();
      if (!stopped && !revoked) setTimeout(connect, 1000);
    };
    ws.onerror = () => {};
  };

  const onRelayFrame = (frame: RelayFrame) => {
    switch (frame.type) {
      case "challenge":
        sendFrame({ type: "hello", v: PROTOCOL_VERSION, device: publicDevice(device), label, sig: signChallenge(device, frame.nonce) });
        return;
      case "welcome":
        connected = true;
        login = frame.login;
        agents = frame.agents;
        inbox.setKv("identity", { login, agents });
        log(
          `connected to ${cfg.relay} as computer ${frame.device.slice(0, 8)} (${label}); ` +
            (login ? `signed in as @${login}; agents: ${agents.map((a) => `${a.name} (${a.status})`).join(", ") || "none"}` : "not signed in yet: patio join <link> signs in"),
        );
        // Messages whose input gate has not decided: stored before a restart while it was deciding, or waiting for
        // the exchange to confirm their channel. Those being gated right now are skipped.
        for (const item of inbox.gated("checking")) void gateIncoming(item);
        void flushOutbox();
        lastAnswering = "";
        publishAnswering();
        return;
      case "paired":
        login = frame.login;
        inbox.setKv("identity", { login, agents });
        log(`paired with @${login}`);
        return;
      case "agents":
        for (const a of frame.agents) {
          const before = agents.find((x) => x.name === a.name)?.status;
          if (before !== a.status) log(`agent ${a.name} is ${a.status}`);
        }
        agents = frame.agents;
        inbox.setKv("identity", { login, agents });
        publishAnswering();
        return;
      case "pairing":
      case "registered":
      case "channel_keys":
      case "membership":
      case "link_joined":
      case "invite_link":
      case "channel_list":
      case "revoked_self":
      case "failed":
        pendingRid.get(frame.rid)?.resolve(frame);
        pendingRid.delete(frame.rid);
        return;
      case "error":
        log(`server error: ${frame.message}`);
        return;
      case "sent":
        // `message` is filled in by relaySend once the exchange has accepted it.
        pendingSends.get(frame.id)?.({ ok: true, status: frame.status, message: undefined as never });
        pendingSends.delete(frame.id);
        return;
      case "undeliverable":
        pendingSends.get(frame.id)?.({ ok: false, reason: frame.reason, detail: frame.detail });
        pendingSends.delete(frame.id);
        return;
      case "keys":
        pendingKeys.get(frame.rid)?.(frame);
        pendingKeys.delete(frame.rid);
        return;
      case "presence":
        pendingWho.shift()?.({ online: frame.online, owners: frame.owners ?? {}, workspaces: frame.workspaces ?? null });
        return;
      case "deliver":
        onDeliver(frame.env);
        return;
      case "expired":
        onExpired(frame);
        return;
    }
  };

  const keysOf = (from: string, to: string) => {
    if (!connected) return Promise.resolve(null);
    const rid = newId();
    return new Promise<KeysReply | null>((resolve) => {
      pendingKeys.set(rid, resolve);
      sendFrame({ type: "keys", rid, from, to });
    });
  };

  // A request to the exchange answered by a frame with the same rid.
  const ask = (frame: ClientFrame & { rid: string }): Promise<RelayFrame> => {
    if (!connected) return Promise.resolve({ type: "failed", rid: frame.rid, error: NOT_CONNECTED });
    return new Promise((resolve) => {
      pendingRid.set(frame.rid, { resolve });
      sendFrame(frame);
    });
  };

  // Seals the message for every recipient device, signs it, and hands it to the exchange. A message to a
  // channel (`channel` given, or `to` = `#<id>`) goes to every current member agent except the sender.
  // What was sent is recorded, so the replies to it can be recognised.
  //
  // Contact key pinning: every recipient's keys are checked against the ones pinned at first use. Nothing is sealed
  // for keys that changed: the message (for a broadcast, that member's copy) is held until the owner trusts or
  // blocks the new keys in the web app. `only`: send a broadcast's copy to that member alone (a held copy, released).
  const relaySend = async (
    msg: Outgoing & { from: string; in_reply_to?: string; channel?: ChannelRef },
    channelRef?: string,
    only?: string,
  ): Promise<SendResult> => {
    if (!connected) return { ok: false, reason: "relay_down" };
    let members: { agent: string; device: PublicDevice }[];
    let recipients: number | undefined;
    // A direct message: whether the recipient answers on its own, or its owner does (the server's word).
    let answers: { answers: "self" | "owner"; owner: string } | undefined;
    if (channelRef || msg.to.startsWith("#")) {
      const res = await ask({ type: "channel_keys", rid: newId(), from: msg.from, channel: channelRef ?? msg.to.slice(1) });
      if (res.type === "failed") return { ok: false, reason: res.error.includes("not a member") ? "not_allowed" : "invalid", detail: res.error };
      if (res.type !== "channel_keys") return { ok: false, reason: "relay_down" };
      msg = { ...msg, to: `#${res.recipients.channel.id}`, channel: res.recipients.channel };
      members = res.recipients.members.filter((m) => !only || m.agent === only);
      recipients = res.recipients.members.length;
    } else {
      const keys = await keysOf(msg.from, msg.to);
      if (keys === null) return { ok: false, reason: "relay_down" };
      if (keys.error) return { ok: false, reason: keys.error };
      if (!keys.devices.length) return { ok: false, reason: "unknown_recipient" };
      members = keys.devices.map((d) => ({ agent: msg.to, device: d }));
      if (keys.answers) answers = { answers: keys.answers, owner: keys.owner ?? "" };
    }
    const inner: Inner = { ...msg, sent_at: Date.now() };
    if (inner.context === undefined || Object.values(inner.context).every((v) => v === undefined)) delete inner.context;
    const problem = validateOutgoing(inner);
    if (problem) return { ok: false, reason: "invalid", detail: problem };
    // Each recipient agent's whole key set is checked at once.
    const byAgent = new Map<string, PublicDevice[]>();
    for (const m of members) byAgent.set(m.agent, [...(byAgent.get(m.agent) ?? []), m.device]);
    const held: string[] = [];
    const devices = new Map<string, PublicDevice>();
    for (const [agent, keys] of byAgent) {
      const k = keyCheck(agent, keys, "to");
      if (k === "ok") for (const d of keys) devices.set(d.id, d);
      else if (k === "changed") {
        inbox.holdSend(msg, msg.channel ? (channelRef ?? msg.to.slice(1)) : null, agent);
        audit({ message_id: msg.id, convo: msg.convo, direction: "out", from: msg.from, to: agent, kind: msg.kind, rule: "keys", verdict: "held", reason: KEYS_CHANGED });
        held.push(agent);
      } else if (!msg.channel) return { ok: false, reason: "keys_blocked", detail: `${agent}'s keys changed and you blocked the new ones; nothing was sent` };
      else log(`not sending ${msg.id.slice(0, 8)} to ${agent} in #${msg.channel.name}: you blocked its new keys`);
    }
    const { sent_at, ...rest } = inner;
    const message: Message = { ...rest, ts: sent_at };
    // A direct message to keys that changed waits, unsent.
    if (!msg.channel && held.length) return { ok: true, status: "held", message, reason: `${msg.to}'s keys changed; trust or block them in the web app` };
    const sealed = sealMessage(inner, device, [...devices.values()]);
    if (!connected) return { ok: false, reason: "relay_down" };
    const result = await new Promise<SendResult>((resolve) => {
      pendingSends.set(msg.id, resolve);
      sendFrame({ type: "send", env: { id: msg.id, convo: msg.convo, from: msg.from, to: msg.to, copies: sealed.copies } });
    });
    if (!result.ok) return result;
    inbox.sent(message, msg.from, msg.kind !== "reply" && msg.channel ? (recipients ?? 0) : null);
    return { ...result, message, ...(recipients !== undefined ? { recipients } : {}), ...(answers ?? {}) };
  };

  // Checks a contact's keys against the pins; a change is recorded for the owner (logged and notified once).
  const keyCheck = (agent: string, keys: PublicDevice[] | { id: string; sign_pk: string; label?: string; owner?: string }, dir: "to" | "from") => {
    const k = Array.isArray(keys) ? inbox.checkPins(agent, keys) : inbox.checkSender(agent, keys);
    if (k === "changed" && inbox.recordKeyChange(agent, Array.isArray(keys) ? keys : [{ ...keys, box_pk: null }])) {
      log(`the keys of ${agent} changed (seen ${dir === "to" ? "sending to" : "receiving from"} it): its messages wait for your decision in the web app`);
      notify(`keys changed: ${agent}`, "Trust or block the new keys: it waits for you");
    }
    return k;
  };

  // The owner's decision on a contact's new keys, from the web app. Trust: they become the pins, held incoming
  // messages go through the input gate, held outgoing ones are sent. Block: the old pins stay, held messages are
  // dropped, and the blocked keys get nothing and are accepted from no more.
  const decideKeys = async (agent: string, decision: "trust" | "block", by: string): Promise<string> => {
    const change = inbox.keyChange(agent);
    if (!change || change.state !== "pending") throw new HeldError(`No key change of ${agent} is waiting for a decision.`);
    const incoming = inbox.gated("keys").filter((m) => m.from === agent);
    const outgoing = inbox.heldSends(agent);
    audit({ direction: "in", from: agent, rule: "keys", verdict: decision === "trust" ? "trusted" : "blocked", devices: change.devices.map((d) => d.id), by: `@${by}` });
    if (decision === "block") {
      inbox.blockKeys(agent);
      for (const m of incoming) inbox.setGate(m.id, "rejected", "its sender's keys changed; blocked by the owner", null);
      for (const h of outgoing) {
        inbox.settleSend(h.id, agent, "dropped");
        if (h.msg.kind === "reply") {
          const original = inbox.get(h.msg.in_reply_to!);
          if (original?.state === "claimed" && original.claim_until === null) inbox.settle(original.id, "failed", `${agent}'s keys changed and the owner blocked them`);
        }
      }
      return `Blocked ${agent}'s new keys. Dropped ${incoming.length} incoming and ${outgoing.length} outgoing message${outgoing.length === 1 ? "" : "s"}.`;
    }
    inbox.trustKeys(agent);
    for (const m of incoming) {
      inbox.setGate(m.id, "checking", null, null);
      void gateIncoming(inbox.get(m.id)!);
    }
    let sent = 0;
    for (const h of outgoing) {
      const res = await relaySend(h.msg, h.channel_ref ?? undefined, h.msg.channel || h.channel_ref ? agent : undefined);
      if (!res.ok || res.status === "held") {
        log(`could not send ${h.id.slice(0, 8)} to ${agent} after trusting its keys: ${res.ok ? res.reason : (res.detail ?? res.reason)}`);
        continue;
      }
      sent++;
      inbox.settleSend(h.id, agent, "sent");
      if (h.msg.kind === "reply") inbox.settle(h.msg.in_reply_to!, "answered", null);
    }
    return `Trusted ${agent}'s new keys. Released ${incoming.length} incoming and ${sent} outgoing message${sent === 1 ? "" : "s"}.`;
  };

  // What the keys-changed cards show: each pending change with the pinned and the new fingerprints.
  const keyCards = () =>
    inbox.keyChanges().filter((c) => c.state === "pending").map((c) => ({
      agent: c.agent,
      // Whose agent, and the computer the new keys are on, as the exchange says.
      owner: c.devices.find((d) => d.owner)?.owner ?? null,
      computers: [...new Set(c.devices.map((d) => d.label).filter((l): l is string => !!l))],
      pinned: inbox.pins(c.agent),
      devices: c.devices,
      detected_at: c.detected_at,
      held_in: inbox.gated("keys").filter((m) => m.from === c.agent).length,
      held_out: inbox.heldSends(c.agent).length,
    }));

  const relayWho = (): Promise<Who> => {
    if (!connected) return Promise.resolve({ online: [], owners: {}, workspaces: null });
    return new Promise((resolve) => {
      pendingWho.push(resolve);
      sendFrame({ type: "who" });
    });
  };

  // ---- local state: the persistent inbox, on this machine only -----------
  const inbox = openInbox(cfg.home);
  // Who this device is and hosts, as the exchange last said: lets a gatekeeper started while the exchange is
  // unreachable queue what its agents send. The exchange's word replaces it as soon as it connects.
  const cached = inbox.getKv<{ login: string | null; agents: AgentInfo[] }>("identity");
  if (cached) [login, agents] = [cached.login, cached.agents];
  const waiters = new Map<string, Array<() => void>>();
  const watchers = new Set<ReadableStreamDefaultController<string>>();

  const onDeliver = (env: DeliveredEnvelope) => {
    let inner: Inner;
    try {
      if (!agents.some((a) => a.name === env.agent && a.status === "approved")) throw new EnvelopeError(`${env.agent} is not an agent of this computer`);
      if (!env.to.startsWith("#") && env.to !== env.agent) throw new EnvelopeError("a direct message must be for the agent it was delivered to");
      inner = openMessage(env, device, env.to);
    } catch (err) {
      if (!(err instanceof EnvelopeError)) throw err;
      // Dropped for good: acknowledging stops the exchange from delivering it again.
      log(`rejected message ${String(env.id).slice(0, 8)} from ${env.from}: ${err.message}`);
      sendFrame({ type: "ack", id: env.id });
      opts.onReject?.(env, err.message);
      return;
    }
    const { sent_at, ...rest } = inner;
    const msg: Message = { ...rest, ts: sent_at };
    // The sender's device must be the one pinned for that contact. From keys the owner blocked, it is dropped; from
    // keys that changed, it is held (out of the inbox, not gated) until the owner decides.
    const keys = keyCheck(env.from, { id: env.from_device, sign_pk: env.sender_sign_pk, ...(env.from_label ? { label: env.from_label } : {}), ...(env.from_owner ? { owner: env.from_owner } : {}) }, "from");
    if (keys === "blocked") {
      log(`dropped ${String(env.id).slice(0, 8)} from ${env.from}: it comes from keys you blocked`);
      audit({ message_id: msg.id, convo: msg.convo, direction: "in", from: msg.from, to: msg.to, kind: msg.kind, rule: "keys", verdict: "dropped", reason: "keys blocked by the owner" });
      sendFrame({ type: "ack", id: env.id });
      opts.onReject?.(env, "keys blocked by the owner");
      return;
    }
    // Stored before it is acknowledged, so a crash in between means a redelivery, not a loss. It is stored out
    // of the inbox until the input gate decides (and is gated again after a restart).
    const added = inbox.add(msg, env.agent, keys === "changed" ? "keys" : "checking", env.workspaces);
    sendFrame({ type: "ack", id: env.id });
    if (added !== "added") {
      if (added !== "duplicate") {
        const why = { reply_to_reply: "it answers a reply", second_reply: `${msg.from} already answered that message`, unknown_target: "it answers a message this computer never saw", wrong_sender: "it answers a message that was not sent to it, or in another channel" }[added];
        log(`dropped reply ${msg.id.slice(0, 8)} from ${msg.from}: ${why}`);
        opts.onReject?.(env, why);
      }
      return;
    }
    if (keys === "changed") {
      audit({ message_id: msg.id, convo: msg.convo, direction: "in", from: msg.from, to: msg.to, kind: msg.kind, rule: "keys", verdict: "held", reason: KEYS_CHANGED });
      return;
    }
    void gateIncoming(inbox.get(msg.id)!);
  };

  // The exchange dropped a message this gatekeeper sent, undelivered: its recipient did not connect within the TTL.
  // A direct message is marked expired, and whoever waits for its answer is told.
  const onExpired = (f: Extract<RelayFrame, { type: "expired" }>) => {
    const sent = inbox.get(f.id);
    const reason = `expired undelivered: ${f.to}'s computer did not connect within ${formatDuration(f.after_ms)}`;
    if (sent?.direction === "out" && !f.channel) inbox.expireSent(f.id, reason);
    audit({ message_id: f.id, convo: f.convo, direction: "out", from: sent?.from, to: f.to, kind: sent?.kind, ...(f.channel ? { channel: f.channel } : {}), rule: "ttl", verdict: "expired", reason, by: "exchange" });
    log(`${sent?.kind ?? "message"} ${f.id.slice(0, 8)} to ${f.to} ${reason}`);
    sendFrame({ type: "ack_expired", id: f.id });
    wake(f.convo);
  };

  // A message that passed the input gate: watchers see it, and a reply wakes whoever waits for it. Nothing
  // starts an agent here.
  const deliver = (item: InboxItem) => {
    for (const w of watchers) w.enqueue(JSON.stringify(publicItem(inbox.get(item.id)!)) + "\n");
    if (item.kind === "reply") {
      // A reply never starts an agent: it goes to the inbox and to whoever waits for it.
      log(`reply from ${item.from} on ${item.convo.slice(0, 8)}${item.channel ? ` in #${item.channel.name}` : ""}${item.rejected ? ` (rejected: ${item.rejected.reason})` : ""}`);
      for (const wake of [...(waiters.get(item.convo) ?? [])]) wake();
      return;
    }
    log(`${item.kind} from ${item.from} on ${item.convo.slice(0, 8)} in the inbox: ${oneLine(item.text)}`);
    // Only what waits for the person: a question nobody answers on its own. What the answer service answers, it does not.
    const now = inbox.get(item.id);
    if (now && waitsForPerson(now)) notify(`${item.from} asked ${now.local_agent || now.to}`, item.text);
  };

  // ---- rules that widen what others can do -----------------------------------------------------------
  // auto_answer and lists of allowed actions in an agent's rules apply only once the owner turns them on in the web
  // app, per agent (grants.ts widenings). The confirmed keys live in inbox.db; keys no longer in any
  // file are forgotten, so a setting removed and added back is confirmed again.
  const fileOf = (agent: string): AgentFile => config.agent(agent) ?? EMPTY_AGENT;
  const allWidenings = () => config.names().flatMap((name) => fileWidenings(name, fileOf(name)));
  const confirmed = () => {
    const keys = inbox.getKv<string[]>("confirmed_rules") ?? [];
    const current = new Set(allWidenings().map((w) => w.key));
    const kept = keys.filter((k) => current.has(k));
    if (kept.length !== keys.length) inbox.setKv("confirmed_rules", kept);
    return new Set(kept);
  };
  // The grant for one message to or from `agent`: its own rules, whatever the workspace the message comes from.
  const grantOf = (agent: string, who: { contact: string } | { channel: ChannelRef }) => grantFor(rulesOf(agent, fileOf(agent), confirmed()), who);
  const pendingRules = (): Widening[] => {
    const c = confirmed();
    return allWidenings().filter((w) => !c.has(w.key));
  };
  const confirmRule = async (key: string, by: string): Promise<string> => {
    const w = pendingRules().find((x) => x.key === key);
    if (!w) throw new HeldError("That setting is no longer waiting in the agent's file.");
    inbox.setKv("confirmed_rules", [...confirmed(), key]);
    audit({ direction: "config", rule: "rules", verdict: "confirmed", key, by: `@${by}` });
    log(`@${by} turned on ${key} in the web app`);
    return `Turned on: ${w.text}.`;
  };

  // The person's answer to the join's third question ("should it answer <workspace> on its own?"): the agent's
  // auto_answer_in list, turned on by that answer (patio join, patio rules <agent> --answer). Capped: only the exact
  // list in the agent's file, and only workspaces the agent is in.
  const answerRule = (agent: string, list: string[], by: string): string => {
    const mine = agents.find((a) => a.name === agent && a.status === "approved");
    if (!mine) throw new HeldError(`${agent} is not an agent of this computer`);
    const outside = list.filter((w) => !(mine.workspaces ?? []).includes(w));
    if (outside.length) throw new HeldError(`${agent} is not in ${outside.join(", ")}: it answers on its own only the workspaces it is in`);
    const key = autoAnswerInKey(agent, list);
    if (confirmed().has(key)) return `already on: ${agent} answers the agents of ${list.join(", ")} on its own`;
    const w = pendingRules().find((x) => x.key === key);
    if (!w) throw new HeldError(`${agent}'s file does not list exactly ${list.join(", ")} in auto_answer_in`);
    inbox.setKv("confirmed_rules", [...confirmed(), key]);
    audit({ direction: "config", rule: "rules", verdict: "confirmed", key, by });
    log(`${by} turned on ${key}`);
    return `Turned on: ${w.text}.`;
  };

  // A change of an agent's three answers that widens what others can do, asked from outside the person's terminal (a
  // join run again by an agent, `patio rules` from an agent): it waits here, as a card, until the person confirms it
  // in the web app. Confirming writes it into the agent's file, and turns "yes, answer it on its own" on.
  type RuleRequest = { id: string; agent: string; workspace: string; answers: Partial<Answers>; by: "join" | "rules"; at: number; sentences: string[] };
  const ruleRequests = () => inbox.getKv<RuleRequest[]>("rule_requests") ?? [];
  const requestRule = (agent: string, workspace: string, answers: Partial<Answers>, by: "join" | "rules"): RuleRequest => {
    const sentences = wideningSentences(agent, workspace, answers);
    if (!sentences.length) throw new HeldError("that change does not widen anything: it applies at once");
    const r: RuleRequest = { id: newId(), agent, workspace, answers, by, at: clock(), sentences };
    inbox.setKv("rule_requests", [...ruleRequests().filter((x) => !(x.agent === agent && x.workspace === workspace)), r]);
    audit({ direction: "config", rule: "rules", verdict: "requested", agent, workspace, answers, by });
    log(`${agent} asks to widen its rules (${sentences.join("; ")}): it waits for you in the web app`);
    notify(`waits for you: ${agent}'s rules`, sentences.join("; "));
    return r;
  };
  const decideRuleRequest = async (id: string, decision: "approve" | "reject", by: string): Promise<string> => {
    const r = ruleRequests().find((x) => x.id === id);
    if (!r) throw new HeldError("That change is no longer waiting for you.");
    inbox.setKv("rule_requests", ruleRequests().filter((x) => x.id !== id));
    audit({ direction: "config", rule: "rules", verdict: decision === "approve" ? "confirmed" : "declined", agent: r.agent, workspace: r.workspace, answers: r.answers, by: `@${by}` });
    if (decision === "reject") return `Declined: ${r.agent}'s rules stay as they were.`;
    const path = agentPath(cfg.home, r.agent);
    const text = await Bun.file(path).text();
    const file = parseAgentFile(text, r.agent);
    const answers = { ...answersFor(file.rules, r.workspace), ...r.answers };
    await Bun.write(path, applyAnswers(text, r.agent, answers, r.workspace));
    if (answers.answer === "yes") {
      const list = parseAgentFile(await Bun.file(path).text(), r.agent).rules.defaults.auto_answer_in ?? [];
      const key = autoAnswerInKey(r.agent, list);
      if (pendingRules().some((w) => w.key === key)) inbox.setKv("confirmed_rules", [...confirmed(), key]);
    }
    log(`@${by} confirmed in the web app: ${r.sentences.join("; ")}`);
    return `Done: ${r.sentences.map((x) => x.replace(" wants to ", " may now ").replace(" wants others to ask it ", ": others may now ask it ")).join("; ")}.`;
  };

  // ---- what waits for the person --------------------------------------------------------------------------------
  // A question or request the rules let in, that nothing answers on its own (no auto_answer for it), or that failed,
  // or that nobody reviewed in time: it waits for the person in Needs you ("Questions for you"), who lets the agent
  // answer it, replies, or declines it.
  const waitsForPerson = (m: InboxItem) =>
    m.direction === "in" &&
    m.gate === null &&
    (m.kind === "question" || m.kind === "request") &&
    (m.state === "unread" || m.state === "read" || m.state === "failed") &&
    !answeringNow.has(m.id) &&
    (m.not_reviewed || m.state === "failed" || !autoAnswers(grantOf(m.local_agent || m.to, m.channel ? { channel: m.channel } : { contact: m.from }), m));
  // A question whose reply waits for the person (held by the rules, outgoing) is counted once, as that reply.
  const questionsForYou = () => {
    const replying = new Set(inbox.heldDrafts().map((d) => d.msg.in_reply_to).filter(Boolean));
    return inbox.list({ filter: "open", limit: 1000 }).filter((m) => waitsForPerson(m) && !replying.has(m.id)).reverse();
  };
  // Messages the web app is having an agent answer right now (`patio answer`, from this process).
  const answeringNow = new Set<string>();
  const questionOf = (id: string) => {
    const m = inbox.get(id);
    if (!m || !waitsForPerson(m)) throw new HeldError("That question no longer waits for you.");
    return m;
  };
  const questions = {
    list: () => questionsForYou().map((m) => ({ id: m.id, from: m.from, to: m.local_agent || m.to, kind: m.kind, text: m.text, channel: m.channel ?? null, at: m.received_at, failed: m.state === "failed" ? m.state_reason : null })),
    // The same path as `patio answer`, run here: the agent's own tool, folder and rules (outgoing).
    answer: (id: string, by: string) => {
      const m = questionOf(id);
      const agent = m.local_agent || m.to;
      answeringNow.add(m.id);
      audit({ message_id: m.id, convo: m.convo, direction: "in", from: m.from, to: agent, kind: m.kind, rule: "owner", verdict: "let-agent-answer", by: `@${by}` });
      log(`@${by} lets ${agent} answer ${m.id.slice(0, 8)} from ${m.from}`);
      void answerWithAgent({ ...cfg, handle: "" }, m.id, { log: (l) => log(`answer ${m.id.slice(0, 8)}: ${l}`) })
        .then((r) => {
          log(`answer ${m.id.slice(0, 8)}: ${r.result}${r.reason ? ` (${r.reason})` : ""}`);
          if (r.result !== "answered") notify(`${agent} could not answer ${m.from}`, r.reason ?? r.result);
        })
        .catch((err) => log(`answer ${m.id.slice(0, 8)} failed: ${(err as Error).message}`))
        .finally(() => answeringNow.delete(m.id));
      return `${agent} is answering ${m.from}'s ${m.kind} with its tool. Its reply goes through your rules (outgoing).`;
    },
    // The person's own words, sent as the agent's reply, through the rules (outgoing).
    reply: async (id: string, text: string, by: string) => {
      const m = questionOf(id);
      const body = text.trim();
      if (!body) throw new HeldError("Write the reply before you send it.");
      const agent = m.local_agent || m.to;
      try {
        inbox.checkReply(m.id, agent);
      } catch (err) {
        if (err instanceof ReplyRule) throw new HeldError(err.message);
        throw err;
      }
      const sent = await replyTo(m, body);
      if (!sent.ok) throw new HeldError(sent.reason === "blocked" ? `Not sent: your rules (outgoing) block it: ${sent.detail}` : `Not sent: ${sent.detail ?? sent.reason}`);
      inbox.markRead(m.id);
      if (sent.status !== "held" && sent.status !== "outbox") inbox.settle(m.id, "answered", null);
      audit({ message_id: m.id, convo: m.convo, direction: "in", from: m.from, to: agent, kind: m.kind, rule: "owner", verdict: "replied", by: `@${by}` });
      if (sent.status === "held") return `Your reply waits for you below: your rules (outgoing) kept it (${sent.reason}).`;
      return `Sent your reply to ${m.from}, as ${agent}.`;
    },
    // The same as `patio reject`, with the person's reason.
    decline: async (id: string, reason: string, by: string) => {
      const m = questionOf(id);
      const note = reason.trim() || null;
      if (note && note.length > 1000) throw new HeldError("Write the reason in at most 1000 characters.");
      const r = await rejectDelivered(m, note);
      if (!r.ok) throw new HeldError("It can no longer be declined.");
      audit({ message_id: m.id, convo: m.convo, direction: "in", from: m.from, to: m.local_agent || m.to, kind: m.kind, rule: "owner", verdict: "declined", by: `@${by}` });
      return `Declined ${m.from}'s ${m.kind}; ${m.from} was told${note ? ", with your reason" : ""}.`;
    },
  };

  // What the server tells an asker: the workspaces each agent of this computer answers on its own (its rules, with only
  // what the owner turned on). Sent when it changes; the asker's ask, wait and who say "answers on its own" or
  // "answered by @owner, may take hours".
  let lastAnswering = "";
  const answeringList = () =>
    ready().map((name) => {
      const ws = agents.find((a) => a.name === name)?.workspaces ?? [];
      const d = rulesOf(name, fileOf(name), confirmed()).defaults;
      return { agent: name, workspaces: d.auto_answer_in ? ws.filter((w) => d.auto_answer_in!.includes(w)) : d.auto_answer ? ws : [] };
    });
  const publishAnswering = () => {
    if (!connected) return;
    const list = answeringList();
    const text = JSON.stringify(list);
    if (text === lastAnswering) return;
    lastAnswering = text;
    sendFrame({ type: "answering", agents: list });
  };
  const publisher = setInterval(() => {
    if (!stopped) publishAnswering();
  }, 2000);

  // ---- the gates ------------------------------------------------------------
  // Incoming messages whose input gate is running: never gated twice at once.
  const gating = new Set<string>();
  const audit = (entry: Record<string, unknown>) => {
    try {
      appendAudit(cfg.home, entry);
    } catch (err) {
      log(`could not write the audit log: ${(err as Error).message}`);
    }
  };
  const auditDecision = (m: { id: string; convo: string; from: string; to: string; kind: string; channel?: ChannelRef }, d: GateDecision) =>
    audit({
      message_id: m.id,
      convo: m.convo,
      direction: d.direction,
      from: m.from,
      to: m.to,
      kind: m.kind,
      ...(m.channel ? { channel: `${m.channel.workspace}/${m.channel.name}` } : {}),
      grant: d.grant,
      rule: d.rule,
      reason: d.reason,
      verdict: d.verdict,
      probabilities: Object.fromEntries(d.scores.map((x) => [x.id, x.p])),
      ...(d.dlp.length ? { dlp: d.dlp.map((f) => ({ kind: f.kind, what: f.what })) } : {}),
      ...(d.action ? { action: d.action } : {}),
      jev: d.jev,
    });

  // What the exchange says about each channel this gatekeeper received from (S1): its name, its workspace, and its
  // members. A channel's name and workspace never change; a sender missing from the remembered members is asked
  // about again.
  const channelRecords = new Map<string, { name: string; workspace: string; members: Set<string> }>();
  // A channel message is gated, and shown, only under the channel the exchange has for its id: the name and
  // workspace inside the signed message are the sender's word. "offline": the exchange cannot answer now.
  const channelBinding = async (item: InboxItem): Promise<"ok" | "offline" | { reason: string }> => {
    const signed = item.channel!;
    const fits = (r: { name: string; workspace: string; members: Set<string> }) => r.name === signed.name && r.workspace === signed.workspace && r.members.has(item.from);
    const known = channelRecords.get(signed.id);
    if (known && fits(known)) return "ok";
    const res = await ask({ type: "channel_keys", rid: newId(), from: item.local_agent || item.to, channel: signed.id });
    if (res.type === "failed") return res.error === NOT_CONNECTED ? "offline" : { reason: `the server does not confirm its channel: ${res.error}` };
    if (res.type !== "channel_keys") return "offline";
    const real = { name: res.recipients.channel.name, workspace: res.recipients.channel.workspace, members: new Set(res.recipients.members.map((m) => m.agent)) };
    channelRecords.set(signed.id, real);
    if (real.name !== signed.name || real.workspace !== signed.workspace)
      return { reason: `it says it is in ${signed.workspace}/${signed.name}, but the server has that channel as ${real.workspace}/${real.name}` };
    if (!real.members.has(item.from)) return { reason: `${item.from} is not a member of ${real.workspace}/${real.name}` };
    return "ok";
  };

  // The input gate, for a message stored as `checking`: deliver, hold for the owner, or reject.
  const gateIncoming = async (item: InboxItem) => {
    if (gating.has(item.id)) return;
    gating.add(item.id);
    try {
      await gateChecking(item);
    } finally {
      gating.delete(item.id);
    }
  };
  const gateChecking = async (item: InboxItem) => {
    if (item.channel) {
      const bound = await channelBinding(item);
      // Undecided: it stays `checking` and is gated again when the exchange is reachable (or on the next start).
      if (stopped || bound === "offline") return;
      if (bound !== "ok") {
        // Rejected without a word to the sender: whoever lies about a channel learns nothing.
        inbox.setGate(item.id, "rejected", bound.reason, null);
        audit({ message_id: item.id, convo: item.convo, direction: "in", from: item.from, to: item.to, kind: item.kind, channel: `${item.channel.workspace}/${item.channel.name}`, rule: "channel-binding", verdict: "rejected", reason: bound.reason });
        log(`rejected ${item.kind} from ${item.from} ${item.id.slice(0, 8)}: ${bound.reason}`);
        return;
      }
    }
    const grant = grantOf(item.local_agent || item.to, item.channel ? { channel: item.channel } : { contact: item.from });
    const countToday = inbox.countToday(item.channel ? { channel: item.channel.id } : { from: item.from });
    const d = await inputGate({ ...item, to: item.local_agent || item.to, owner: login }, grant, { judge, countToday });
    // Stopped while Jev was deciding: the message stays `checking` and is gated again on the next start.
    if (stopped) return;
    auditDecision(item, d);
    log(`input gate: ${item.kind} from ${item.from} ${item.id.slice(0, 8)} -> ${d.verdict}${d.reason ? ` (${d.reason}; ${d.grant} ${d.rule})` : ""}`);
    if (d.verdict === "deliver") {
      inbox.setGate(item.id, null, null, d, d.action?.allowed ?? null);
      return deliver(item);
    }
    if (d.verdict === "ask-human") {
      inbox.setGate(item.id, "held", d.reason, d, null, clock());
      return notify(`waits for you: ${item.from} to ${item.local_agent || item.to}`, item.text);
    }
    inbox.setGate(item.id, "rejected", d.reason, d);
    // Nobody answers a reply, not even to reject it.
    if (item.kind !== "reply") await sendRejection(item, d.reason!);
  };

  // Tells the sender their message was rejected, with the category only. In a channel, only the sender is told.
  // `byRecipient`: the recipient declined it with `patio reject`, and `note` is the reason they wrote.
  const sendRejection = async (item: InboxItem, reason: string, byRecipient?: { note: string | null }) => {
    const from = item.local_agent || item.to;
    const text = byRecipient
      ? `${from} declined your message: ${reason}.${byRecipient.note ? ` Reason: ${byRecipient.note}` : ""}`
      : `${from}'s patio rejected your message: ${reason}.`;
    const res = await relaySend({
      id: newId(),
      convo: item.convo,
      from,
      to: item.from,
      kind: "reply",
      text,
      in_reply_to: item.id,
      rejected: { reason },
    }).catch((err: Error) => ({ ok: false as const, reason: "invalid" as const, detail: err.message }));
    if (!res.ok) log(`could not tell ${item.from} about the rejection of ${item.id.slice(0, 8)}: ${res.reason}${res.detail ? ` (${res.detail})` : ""}`);
  };

  // The output gate, for what a local agent sends: send it, hold it for the owner, or block it.
  // `answering` is the text a reply answers (Jev needs it to judge a posture).
  const sendGated = async (msg: Draft, channelRef?: string, answering?: string): Promise<SendResult> => {
    let channel = msg.channel;
    // Offline, a channel's grant is found by the name the agent gave; it is resolved at the exchange when sent.
    if (!channel && channelRef && !connected) channel = channelOf(channelRef);
    else if (!channel && channelRef) {
      const res = await ask({ type: "channel_keys", rid: newId(), from: msg.from, channel: channelRef });
      if (res.type === "failed") return { ok: false, reason: res.error.includes("not a member") ? "not_allowed" : "invalid", detail: res.error };
      if (res.type !== "channel_keys") return { ok: false, reason: "relay_down" };
      channel = res.recipients.channel;
    }
    const grant = grantOf(msg.from, channel ? { channel } : { contact: msg.to });
    const d = await outputGate({ to: msg.to, from: msg.from, owner: login, kind: msg.kind, text: msg.text, channel, answering }, grant, { judge });
    // A send is logged once the server took it: a message it refused is logged as not sent, with why.
    if (d.verdict !== "send") auditDecision({ ...msg, channel }, d);
    log(`output gate: ${msg.kind} from ${msg.from} ${msg.id.slice(0, 8)} -> ${d.verdict}${d.reason ? ` (${d.reason}; ${d.grant} ${d.rule})` : ""}`);
    if (d.verdict === "block") return { ok: false, reason: "blocked", detail: d.reason! };
    if (d.verdict === "ask-human") {
      inbox.addDraft(msg, channelRef ?? null, answering ?? null, d);
      notify(`waits for you: ${msg.from} to ${channel ? `#${channel.name}` : msg.to}`, msg.text);
      return { ok: true, status: "held", message: { ...msg, ...(channel ? { channel } : {}), ts: Date.now() }, reason: d.reason! };
    }
    // Sent in order: while anything waits in the outbox, this waits behind it.
    if (!connected || inbox.outbox().length) {
      auditDecision({ ...msg, channel }, d);
      return queue(msg, channelRef);
    }
    const res = await relaySend(msg, channelRef);
    if (!res.ok && res.reason === "relay_down") {
      auditDecision({ ...msg, channel }, d);
      return queue(msg, channelRef);
    }
    if (res.ok) auditDecision({ ...msg, channel }, d);
    else {
      const why =
        res.reason === "unknown_recipient"
          ? `no agent named ${msg.to}`
          : res.reason === "not_allowed"
            ? (res.detail ?? `${msg.from} and ${msg.to} share no workspace`)
            : (res.detail ?? res.reason);
      audit({ message_id: msg.id, convo: msg.convo, direction: "out", from: msg.from, to: msg.to, kind: msg.kind, ...(channel ? { channel: `${channel.workspace}/${channel.name}` } : {}), rule: "server", verdict: "not-sent", reason: why });
    }
    return res;
  };

  // ---- the outbox: sends that wait for the exchange ---------------------------------------------
  // What passed the output gate while the exchange was unreachable waits here, sealed for this device, and is sent
  // in order when it is reachable again; it survives a restart. `patio outbox` lists it, `patio outbox cancel` takes
  // one back, and one older than the message TTL expires unsent.
  type Queued = { msg: Draft; channel_ref: string | null };
  const queue = (msg: Draft, channelRef?: string): SendResult => {
    if (!inbox.outboxItem(msg.id)) {
      inbox.queue({ ...msg, to: channelRef ? `#${channelRef}` : msg.to }, sealForSelf(device, { msg, channel_ref: channelRef ?? null } satisfies Queued), clock());
      audit({ message_id: msg.id, convo: msg.convo, direction: "out", from: msg.from, to: msg.to, kind: msg.kind, rule: "outbox", verdict: "queued", reason: "the server is not reachable" });
      log(`${msg.kind} from ${msg.from} ${msg.id.slice(0, 8)} queued in the outbox: the server is not reachable`);
    }
    if (connected) void flushOutbox();
    return { ok: true, status: "outbox", message: { ...msg, ts: Date.now() } };
  };

  // A reply that waited in the outbox: its message is answered once it is sent, and free to answer again if it is not.
  const settleOriginal = (q: { kind: string; in_reply_to: string | null }, sent: boolean, why?: string) => {
    if (q.kind !== "reply" || !q.in_reply_to) return;
    if (sent) return void inbox.settle(q.in_reply_to, "answered", null);
    const original = inbox.get(q.in_reply_to);
    if (original?.state === "claimed" && original.claim_until === null) inbox.settle(original.id, "failed", why ?? "the reply was not sent");
  };

  let flushing = false;
  const flushOutbox = async () => {
    if (flushing) return;
    flushing = true;
    try {
      for (const row of inbox.outbox()) {
        if (!connected) return;
        const { msg, channel_ref } = openForSelf<Queued>(device, row.sealed);
        const res = await relaySend(msg, channel_ref ?? undefined);
        if (!res.ok && res.reason === "relay_down") return;
        const entry = { message_id: msg.id, convo: msg.convo, direction: "out", from: msg.from, to: msg.to, kind: msg.kind, rule: "outbox" };
        if (res.ok) {
          inbox.settleOutbox(row.id, res.status === "held" ? "held" : "sent", res.status === "held" ? res.reason : null);
          audit({ ...entry, verdict: res.status === "held" ? "held" : "sent", ...(res.status === "held" ? { reason: res.reason } : {}) });
          log(`sent ${msg.kind} ${msg.id.slice(0, 8)} from the outbox (${res.status})`);
          if (res.status !== "held") settleOriginal(row, true);
        } else {
          const why = res.detail ?? res.reason;
          inbox.settleOutbox(row.id, "failed", why);
          audit({ ...entry, verdict: "failed", reason: why });
          log(`could not send ${msg.kind} ${msg.id.slice(0, 8)} from the outbox: ${why}`);
          settleOriginal(row, false, `the reply could not be sent from the outbox: ${why}`);
          wake(msg.convo);
        }
      }
    } catch (err) {
      log(`outbox: ${(err as Error).message}`);
    } finally {
      flushing = false;
    }
  };

  // The owner's decision on a held message, from the web app (the only place that can call this).
  // On an incoming card, `allow` delivers it with the action the owner allows (`text`, prefilled on the card).
  const decideHeld = async (id: string, decision: "approve" | "allow" | "reject" | "edit", by: string, text?: string): Promise<string> => {
    const incoming = inbox.get(id);
    if (incoming?.direction === "in" && incoming.gate === "held") {
      if (decision === "edit") throw new HeldError("Only an outgoing draft can be edited.");
      if (decision === "allow") {
        if (!incoming.gate_decision?.action?.requested) throw new HeldError("This message asks for no action; approve it to deliver it.");
        const action = String(text ?? "").replace(/\s+/g, " ").trim();
        if (!action) throw new HeldError("Write the action you allow before you allow it.");
        if (action.length > 300) throw new HeldError("Describe the action in at most 300 characters.");
        audit({ message_id: id, convo: incoming.convo, direction: "in", from: incoming.from, to: incoming.to, kind: incoming.kind, rule: "owner", verdict: "approved-with-action", allowed_action: action, by: `@${by}` });
        inbox.setGate(id, null, null, incoming.gate_decision, action);
        deliver(inbox.get(id)!);
        return `Delivered ${incoming.from}'s ${incoming.kind} to ${incoming.local_agent || incoming.to}, with the action you allowed: ${action}.`;
      }
      if (decision === "reject" && incoming.kind === "reply") {
        inbox.setGate(id, "rejected", "declined by the owner", incoming.gate_decision);
        audit({ message_id: id, convo: incoming.convo, direction: "in", from: incoming.from, to: incoming.to, kind: incoming.kind, rule: "owner", verdict: "rejected", by: `@${by}` });
        return `Rejected ${incoming.from}'s reply; it stays out of the inbox.`;
      }
      audit({ message_id: id, convo: incoming.convo, direction: "in", from: incoming.from, to: incoming.to, kind: incoming.kind, rule: "owner", verdict: decision === "approve" ? "approved" : "rejected", by: `@${by}` });
      if (decision === "approve") {
        inbox.setGate(id, null, null, incoming.gate_decision);
        deliver(inbox.get(id)!);
        return `Delivered ${incoming.from}'s ${incoming.kind} to ${incoming.local_agent || incoming.to}.`;
      }
      inbox.setGate(id, "rejected", "declined by the owner", incoming.gate_decision);
      await sendRejection(incoming, "declined by the owner");
      return `Rejected ${incoming.from}'s ${incoming.kind}; ${incoming.from} was told it was declined.`;
    }
    const draft = inbox.draft(id);
    if (!draft || draft.state !== "held") throw new HeldError("That message is no longer waiting for a decision.");
    const where = draft.msg.channel ? `#${draft.msg.channel.name}` : draft.channel_ref ? `#${draft.channel_ref}` : draft.msg.to;
    const entry = { message_id: id, convo: draft.msg.convo, direction: "out", from: draft.msg.from, to: draft.msg.to, kind: draft.msg.kind, rule: "owner", by: `@${by}` };
    if (decision === "reject") {
      inbox.decideDraft(id, "rejected", by, null);
      audit({ ...entry, verdict: "rejected" });
      // An `answer` that waited for this decision fails, so the message can be answered again.
      const original = draft.msg.kind === "reply" ? inbox.get(draft.msg.in_reply_to!) : null;
      if (original?.state === "claimed" && original.claim_until === null) inbox.settle(original.id, "failed", "the owner rejected the reply");
      return `Rejected ${draft.msg.from}'s ${draft.msg.kind} to ${where}; it was not sent.`;
    }
    const finalText = decision === "edit" ? String(text ?? "").trim() : draft.msg.text;
    if (!finalText) throw new HeldError("The edited text is empty.");
    if (draft.msg.kind === "reply") {
      try {
        inbox.checkReply(draft.msg.in_reply_to!, draft.msg.from);
      } catch (err) {
        if (err instanceof ReplyRule) throw new HeldError(err.message);
        throw err;
      }
    }
    const res = await relaySend({ ...draft.msg, text: finalText }, draft.channel_ref ?? undefined);
    if (!res.ok) throw new HeldError(`Could not send it: ${res.detail ?? res.reason}. It still waits for you.`);
    inbox.decideDraft(id, "sent", by, finalText);
    audit({ ...entry, verdict: decision === "edit" ? "approved-with-edit" : "approved" });
    if (res.status === "held") return `Approved; it now waits for your decision on ${draft.msg.to}'s changed keys.`;
    if (draft.msg.kind === "reply") inbox.settle(draft.msg.in_reply_to!, "answered", null);
    return `Sent ${draft.msg.from}'s ${draft.msg.kind} to ${where}${decision === "edit" ? ", as you edited it" : ""}.`;
  };

  // The recipient declines a delivered message (`patio reject`, CLI or MCP): its state becomes rejected and the
  // sender is told, with the category and the reason the owner (or the owner's agent) wrote.
  const rejectDelivered = async (item: InboxItem, note: string | null) => {
    const r = inbox.reject(item.id, note ?? CATEGORIES_RECIPIENT);
    if (!r.ok) return r;
    audit({ message_id: item.id, convo: item.convo, direction: "in", from: item.from, to: item.to, kind: item.kind, rule: "recipient", verdict: "rejected", ...(note ? { note } : {}) });
    log(`rejected ${item.id.slice(0, 8)} from ${item.from}${note ? `: ${oneLine(note)}` : ""}`);
    await sendRejection(item, CATEGORIES_RECIPIENT, { note });
    return r;
  };

  // What the approval cards show: held incoming messages and held outgoing drafts, oldest first.
  const heldCards = () => [
    ...inbox.gated("held").map((m) => ({
      id: m.id,
      direction: "in" as const,
      from: m.from,
      to: m.local_agent || m.to,
      kind: m.kind,
      channel: m.channel ?? null,
      text: m.text,
      answering: null,
      at: m.received_at,
      decision: m.gate_decision!,
      // The card's "action you allow" starts from the action the message asks for, when patio can find it.
      action_summary: m.gate_decision?.action?.requested ? actionSummary(m.text) : null,
    })),
    ...inbox.heldDrafts().map((d) => ({
      id: d.id,
      direction: "out" as const,
      from: d.msg.from,
      to: d.msg.channel ? `#${d.msg.channel.name}` : d.channel_ref ? `#${d.channel_ref}` : d.msg.to,
      kind: d.msg.kind,
      channel: d.msg.channel ?? null,
      text: d.msg.text,
      answering: d.answering,
      at: d.created_at,
      decision: d.decision,
      action_summary: null,
    })),
  ].sort((a, b) => a.at - b.at);

  // ---- expiry: what the owner did not review in time ------------------------------------------
  // A held message waits at most its grant's hold_timeout (the grant as it is now). Then an incoming one is
  // rejected ("not reviewed in time") or delivered marked "not reviewed" (on_timeout), and an outgoing draft is not
  // sent; whoever waits for its answer is told.
  const wake = (convo: string) => {
    for (const w of [...(waiters.get(convo) ?? [])]) w();
  };
  const sweep = async () => {
    const now = clock();
    for (const item of inbox.gated("held")) {
      const grant = grantOf(item.local_agent || item.to, item.channel ? { channel: item.channel } : { contact: item.from });
      if (now < (item.held_at ?? item.received_at) + grant.hold_timeout_ms) continue;
      const base = { message_id: item.id, convo: item.convo, direction: "in", from: item.from, to: item.local_agent || item.to, kind: item.kind, grant: grant.source, rule: "timeout", by: "timeout" };
      if (grant.on_timeout === "inbox") {
        if (!inbox.deliverUnreviewed(item.id)) continue;
        audit({ ...base, verdict: "delivered-unreviewed", reason: "not reviewed in time; delivered to the inbox marked not reviewed" });
        log(`held ${item.kind} from ${item.from} ${item.id.slice(0, 8)} was not reviewed in time: delivered, marked not reviewed`);
        deliver(inbox.get(item.id)!);
        continue;
      }
      inbox.setGate(item.id, "rejected", CATEGORIES.timeout, item.gate_decision);
      audit({ ...base, verdict: "rejected", reason: CATEGORIES.timeout });
      log(`held ${item.kind} from ${item.from} ${item.id.slice(0, 8)} was not reviewed in time: rejected`);
      if (item.kind !== "reply") await sendRejection(item, CATEGORIES.timeout);
    }
    for (const d of inbox.heldDrafts()) {
      const ch = d.msg.channel ?? (d.channel_ref ? channelOf(d.channel_ref) : null);
      const grant = grantOf(d.msg.from, ch ? { channel: ch } : { contact: d.msg.to });
      if (now < d.created_at + grant.hold_timeout_ms) continue;
      if (!inbox.decideDraft(d.id, "expired", "timeout", null)) continue;
      audit({ message_id: d.id, convo: d.msg.convo, direction: "out", from: d.msg.from, to: d.msg.to, kind: d.msg.kind, grant: grant.source, rule: "timeout", verdict: "not-sent", reason: CATEGORIES.timeout, by: "timeout" });
      log(`held ${d.msg.kind} from ${d.msg.from} ${d.id.slice(0, 8)} was not reviewed in time: not sent`);
      const original = d.msg.kind === "reply" ? inbox.get(d.msg.in_reply_to!) : null;
      if (original?.state === "claimed" && original.claim_until === null) inbox.settle(original.id, "failed", "the reply was not reviewed in time; it was not sent");
      wake(d.msg.convo);
    }
    expireOutbox();
  };
  const expireOutbox = () => {
    const ttl = messageTtlMs();
    for (const row of inbox.outbox()) {
      if (clock() < row.created_at + ttl) continue;
      const why = `expired in the outbox: the server was not reachable within ${formatDuration(ttl)}`;
      if (!inbox.settleOutbox(row.id, "expired", why)) continue;
      audit({ message_id: row.id, convo: row.convo, direction: "out", from: row.from_agent, to: row.to_ref, kind: row.kind, rule: "ttl", verdict: "expired", reason: why, by: "timeout" });
      log(`${row.kind} ${row.id.slice(0, 8)} to ${row.to_ref} ${why}`);
      settleOriginal(row, false, `the reply was not sent: ${why}`);
      wake(row.convo);
    }
  };

  // A channel named as the agent wrote it (`backend` or `orbit/backend`), for its grant; the id is not needed.
  const channelOf = (ref: string): ChannelRef => {
    const [ws, name] = ref.includes("/") ? ref.replace(/^#/, "").split("/", 2) : [null, ref.replace(/^#/, "")];
    return inbox.channels().map((c) => c.channel).find((c) => c.id === ref || (c.name === name && (!ws || c.workspace === ws))) ?? { id: ref, name: name!, workspace: ws ?? "" };
  };
  let sweeping = false;
  const sweeper = setInterval(() => {
    if (sweeping || stopped) return;
    sweeping = true;
    sweep()
      .catch((err) => log(`expiry sweep failed: ${(err as Error).message}`))
      .finally(() => (sweeping = false));
  }, sweepMs());

  // Answers `original` as the local agent it reached, through the output gate. In a channel the reply goes to
  // every member and hangs from the broadcast; in a DM it goes back to the sender.
  const replyTo = async (original: InboxItem, text: string): Promise<SendResult> => {
    const from = original.local_agent || original.to;
    inbox.checkReply(original.id, from);
    const to = original.channel ? `#${original.channel.id}` : original.from;
    const msg: Draft = { id: newId(), convo: original.convo, from, to, kind: "reply", text, in_reply_to: original.id, ...(original.channel ? { channel: original.channel } : {}) };
    return sendGated(msg, undefined, original.text);
  };

  // ---- local socket for the CLI and the MCP server ------------------------

  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const fail = (status: number, code: string, error: string) => json({ code, error }, status);

  // Which local agent speaks: the one asked for (--as, PATIO_AGENT), else the only approved one. With several agents
  // and none named, the call fails: an agent never picks another agent's identity by accident.
  const speaker = (as: string | undefined | null): { name: string } | { error: Response } => {
    const names = ready();
    // patio itself has no default agent: the CLI and the MCP server say which one (--as, PATIO_AGENT).
    const wanted = as;
    if (wanted) {
      if (names.includes(wanted)) return { name: wanted };
      return { error: fail(400, "no_identity", `${wanted} is not an agent of this computer (patio agents lists them; patio join <link> --agent ${wanted} sets one up)`) };
    }
    if (names.length === 1) return { name: names[0]! };
    if (!names.length) return { error: fail(400, "no_identity", "this computer has no agent yet: patio join <link> sets one up") };
    return {
      error: fail(400, "choose_agent", `this computer hosts ${names.join(", ")}: say which agent this is with --as <agent> (patio mcp --as <agent>, or PATIO_AGENT=<agent>)`),
    };
  };
  // An optional `as` scopes a call to one agent's messages: given, it must be an agent here; absent, every agent's.
  const scopeOf = (as: string | undefined | null): { name: string | null } | { error: Response } => (as ? speaker(as) : { name: null });
  const mine = (scope: { name: string | null }, m: InboxItem | null | undefined) => !!m && (!scope.name || (m.local_agent || m.to) === scope.name);

  const answer = (res: SendResult, to: string, from: string) => {
    if (res.ok && res.status === "held")
      return json({ id: res.message.id, convo: res.message.convo, status: "held", reason: res.reason, web_url: web.url, ...(res.message.channel ? { channel: res.message.channel } : {}) });
    if (!res.ok && res.reason === "blocked") return fail(422, "blocked", `blocked by your rules (outgoing): ${res.detail}`);
    if (!res.ok && res.reason === "keys_blocked") return fail(409, "keys_blocked", res.detail ?? "the recipient's keys are blocked");
    if (res.ok && res.status === "outbox") return json({ id: res.message.id, convo: res.message.convo, status: "outbox" });
    if (res.ok)
      return json({
        id: res.message.id,
        convo: res.message.convo,
        status: res.status,
        ...(res.recipients !== undefined ? { recipients: res.recipients, channel: res.message.channel } : {}),
        ...(res.answers ? { answers: answersSay(to, res.answers, res.owner) } : {}),
      });
    if (res.reason === "unknown_recipient") return fail(404, "unreachable", `${to} is not an agent on the server`);
    if (res.reason === "not_allowed")
      return fail(403, "not_allowed", res.detail ?? `${from} and ${to} share no workspace: both agents must be members of one`);
    if (res.reason === "relay_down") return fail(503, "relay_down", "not connected to the server");
    return fail(400, res.reason, res.detail ?? "message rejected");
  };

  const sendFromLocal = async (from: string, to: string, kind: Kind, text: string, context: Message["context"], convo?: string, channel?: string) => {
    const res = await sendGated({ id: newId(), convo: convo ?? newId(), from, to: channel ? "#" : to, kind, text, context }, channel);
    return answer(res, channel ? `#${channel}` : to, from);
  };

  const membership = async (frame: ClientFrame & { rid: string }) => {
    const res = await ask(frame);
    if (res.type === "failed") return fail(400, "membership_failed", res.error);
    if (res.type !== "membership") return fail(500, "error", "unexpected answer from the server");
    return json({ kind: res.kind, target: res.target, status: res.status as MembershipStatus, needs: res.needs, web_url: web.url });
  };

  // One id: a message by its id, or by its conversation's id (the message that started it), or a unique prefix of either.
  const incoming = (ref: string): InboxItem | null => inbox.find(ref) ?? inbox.original(ref);

  const lookup = <T>(fn: () => T) => {
    try {
      return { ok: true as const, value: fn() };
    } catch (err) {
      if (err instanceof AmbiguousId) return { ok: false as const, res: fail(400, "ambiguous", err.message) };
      if (err instanceof ReplyRule) return { ok: false as const, res: fail(409, err.code, err.message) };
      throw err;
    }
  };

  // One row per agent of this computer: the server's word (status, workspaces) and its file (tool, folder), with the
  // coding tools that run patio as it.
  // Each coding tool's state for an agent: from what is written, and the last check of its own listing command
  // ($PATIO_HOME/checks.json). A check older than 10 minutes is run again in the background, never on the page's time.
  const toolChecking = new Set<string>();
  const refreshTool = (name: string, tool: ConnectTool, folder: string) => {
    const key = `${name}:${tool}`;
    if (toolChecking.has(key) || stopped) return;
    toolChecking.add(key);
    void checkToolAsync(tool, folder)
      .then((r) => recordChecks(cfg.home, (c) => void (c.tools[name] = { ...(c.tools[name] ?? {}), [tool]: { ok: r.ok, said: r.said, ...(r.ok ? {} : { step: r.step }), at: Date.now() } })))
      .catch(() => {})
      .finally(() => toolChecking.delete(key));
  };
  const toolStates = (name: string, folder: string | null): Record<string, ToolState> => {
    const written = connectedTools(name, folder);
    const last = readChecks(cfg.home).tools[name] ?? {};
    const out: Record<string, ToolState> = {};
    for (const t of CONNECT_TOOLS) {
      const w = written.some((c) => c.split(" ")[0] === t);
      const c = last[t];
      out[t] = !w ? "not set up" : c?.ok ? "listed" : "written";
      if (w && folder && (!c || Date.now() - c.at > 10 * 60_000)) refreshTool(name, t, folder);
    }
    return out;
  };

  const agentRows = (): AgentRow[] => {
    const files = new Map(config.summary().map((f) => [f.agent, f]));
    const names = [...new Set([...agents.map((a) => a.name), ...files.keys()])].sort();
    return names.map((name) => {
      const a = agents.find((x) => x.name === name);
      const f = config.agent(name);
      const folder = f?.folder ? expandHome(f.folder) : null;
      return {
        tools: toolStates(name, folder),
        answered: !!f && ((f.asked_in ?? []).some((w) => (a?.workspaces ?? []).includes(w)) || !(a?.workspaces ?? []).length),
        name,
        status: a?.status ?? "not registered",
        workspaces: a?.workspaces ?? [],
        tool: f?.tool ?? null,
        folder: f?.folder ?? null,
        in_place: f?.in_place ?? false,
        file: files.has(name),
        error: files.get(name)?.error?.message ?? null,
        connected: connectedTools(name, f?.folder ? expandHome(f.folder) : null),
      };
    });
  };

  // The three answers of the join as sentences, from the agent's file; an auto_answer_in list not turned on says so.
  const answerSentencesOf = (name: string) =>
    answerSentences(name, fileOf(name).rules, (list) => confirmed().has(autoAnswerInKey(name, list)));

  // The agent's guide (guide.ts): who it is, its rules as the gates apply them, and who is in its workspaces.
  const guideOf = async (name: string) => {
    const row = agentRows().find((a) => a.name === name);
    const who = await relayWho();
    return guideText({
      agent: name,
      owner: login,
      tool: row?.tool ?? null,
      folder: row?.folder ?? null,
      workspaces: row?.workspaces ?? [],
      rules: rulesOf(name, fileOf(name), confirmed()),
      answers: answerSentencesOf(name),
      rosters: who.workspaces,
    });
  };

  const statusReport = () =>
    withAttention({
      connected,
      relay: cfg.relay,
      device: device.id,
      label,
      login,
      revoked,
      agents: agentRows(),
      web_url: web.url,
      unread: inbox.unreadCount(),
      files: config.summary(),
      judge: judgeKind,
      pending: {
        held_in: inbox.gated("held").length,
        held_out: inbox.heldDrafts().length,
        keys: inbox.keyChanges().filter((c) => c.state === "pending").length,
        identities: agents.filter((a) => a.status === "pending").length,
        rules: pendingRules().length,
        questions: questionsForYou().length,
        rule_requests: ruleRequests().length,
      },
      inbox: inbox.counts(),
      outbox: inbox.outbox().length,
      setup: setup ? { state: setup.state, agent: setup.agent, url: setupUrl(setup), moved: setup.moved ?? null } : null,
    });

  // ---- the first run: this computer's sign-in --------------------------------------------------------------------
  // `patio join <link>` asks for a pairing code. From the person's own terminal, signing in on /setup?code= confirms
  // this computer (it is theirs: they asked for it here). Started by an agent, the code comes with the join it is
  // for, and /confirm?code= is the one screen where the person confirms the computer, the agent and the join at once.
  type Setup = {
    code: string;
    expires_at: number;
    interactive: boolean;
    join: { link: string; workspace: string; inviter: string; agent: string | null; tool: string | null; folder: string | null; answers?: Answers | null } | null;
    state: "waiting" | "confirmed" | "declined";
    agent: string | null;
    // Confirmed with Move: the other computer the agent moved here from.
    moved?: string | null;
  };
  let setup: Setup | null = null;
  const setupUrl = (s: Setup) => `${web.url}/${s.join && !s.interactive ? "confirm" : "setup"}?code=${encodeURIComponent(s.code)}`;

  // The socket is created owner-only from the start, not just chmod-ed afterwards.
  const previousUmask = process.umask(0o077);
  const local = Bun.serve({
    unix: cfg.socket,
    // Long-polls and the watch stream stay open with no traffic. Bun honours this on unix sockets,
    // but its types only allow it for TCP.
    ...({ idleTimeout: 0 } as {}),
    routes: {
      // `patio status`: the whole picture, and what needs the owner (status.ts).
      "/status": () => json(statusReport()),
      "/pair": {
        POST: async (req) => {
          const b = ((await req.json().catch(() => ({}))) ?? {}) as { interactive?: boolean; join?: Setup["join"] };
          if (login) return fail(409, "already_paired", `this computer is already signed in as @${login}`);
          // The same join asked again (patio join run again before the person confirmed): the same link to confirm.
          if (setup && setup.state === "waiting" && setup.expires_at > clock() && setup.interactive === (b.interactive === true) && setup.join?.link === b.join?.link && setup.join?.agent === (b.join?.agent ?? null))
            return json({ code: setup.code, expires_at: setup.expires_at, web_url: web.url, url: setupUrl(setup), device: device.id, label });
          const res = await ask({ type: "pair", rid: newId() });
          if (res.type === "failed") return fail(400, "pair_failed", res.error);
          if (res.type !== "pairing") return fail(500, "error", "unexpected answer from the server");
          setup = { code: res.code, expires_at: res.expires_at, interactive: b.interactive === true, join: b.join ?? null, state: "waiting", agent: b.join?.agent ?? null };
          return json({ code: res.code, expires_at: res.expires_at, web_url: web.url, url: setupUrl(setup), device: device.id, label });
        },
      },
      "/register": {
        POST: async (req) => {
          // `interactive`: the owner ran it in their own terminal (the CLI checks stdin and stdout are TTYs), so it is
          // theirs at once. The MCP server never says so.
          const { name, interactive } = (await req.json()) as { name: string; interactive?: boolean };
          const res = await ask({ type: "register", rid: newId(), name: String(name ?? ""), by_owner: interactive === true });
          if (res.type === "failed") return fail(400, "register_failed", res.error);
          if (res.type !== "registered") return fail(500, "error", "unexpected answer from the server");
          agents = [...agents.filter((a) => a.name !== res.agent.name), res.agent];
          return json({ agent: res.agent, web_url: web.url });
        },
      },
      // Every agent of the workspaces this computer's agents are in, online or not, each with its owner and whether it
      // answers on its own (an offline agent still gets what is sent to it, once it connects).
      "/who": async () => {
        const w = await relayWho();
        const members = new Map<string, { agent: string; owner: string; online: boolean; answers: "self" | "owner"; workspaces: string[]; yours: boolean }>();
        for (const r of w.workspaces ?? [])
          for (const a of r.agents) {
            const m = members.get(a.agent) ?? { agent: a.agent, owner: a.owner, online: w.online.includes(a.agent), answers: "owner" as const, workspaces: [], yours: ready().includes(a.agent) };
            m.workspaces.push(r.workspace);
            if (a.answers === "self") m.answers = "self";
            members.set(a.agent, m);
          }
        for (const name of w.online) if (!members.has(name)) members.set(name, { agent: name, owner: w.owners[name] ?? "", online: true, answers: "owner", workspaces: [], yours: ready().includes(name) });
        return json({ ...w, connected, members: [...members.values()].sort((a, b) => Number(b.yours) - Number(a.yours) || a.agent.localeCompare(b.agent)) });
      },
      // `patio contacts`: each contact's pinned device keys, and a change waiting for the owner (or blocked).
      "/contacts": () => {
        const agents = [...new Set([...inbox.allPins().map((p) => p.agent), ...inbox.keyChanges().map((c) => c.agent)])].sort();
        return json({
          contacts: agents.map((agent) => {
            const c = inbox.keyChange(agent);
            return {
              agent,
              devices: inbox.pins(agent),
              change: c
                ? { state: c.state, devices: c.devices, detected_at: c.detected_at, held_in: inbox.gated("keys").filter((m) => m.from === agent).length, held_out: inbox.heldSends(agent).length }
                : null,
            };
          }),
          web_url: web.url,
        });
      },
      "/join": {
        POST: async (req) => {
          const b = (await req.json()) as { as?: string; workspace?: string; channel?: string; interactive?: boolean };
          const who = speaker(b.as);
          if ("error" in who) return who.error;
          if (!b.workspace === !b.channel) return fail(400, "invalid", "join either a workspace or a channel");
          return membership({ type: "join", rid: newId(), agent: who.name, by_owner: b.interactive === true, ...(b.workspace ? { workspace: b.workspace } : { channel: b.channel }) });
        },
      },
      // `patio join <link>`: these agents of this computer join the link's workspace (and are registered when new).
      "/join-link": {
        POST: async (req) => {
          const b = (await req.json()) as { code?: string; agents?: string[]; interactive?: boolean; move?: boolean };
          const byOwner = b.interactive === true;
          const res = await ask({ type: "join_link", rid: newId(), code: String(b.code ?? ""), agents: (b.agents ?? []).map(String), by_owner: byOwner, move: byOwner && b.move === true });
          if (res.type === "failed" && res.code === "agent_elsewhere") return json({ code: "agent_elsewhere", error: res.error, elsewhere: res.elsewhere }, 409);
          if (res.type === "failed") return fail(400, "join_failed", res.error);
          if (res.type !== "link_joined") return fail(500, "error", "unexpected answer from the server");
          const { type: _t, rid: _r, ...rest } = res;
          return json({ ...rest, web_url: web.url });
        },
      },
      // `patio invite`: an admin's invite link, only from their own terminal.
      "/invite": {
        POST: async (req) => {
          const b = (await req.json()) as { workspace?: string; expires_ms?: number; max_uses?: number; interactive?: boolean };
          if (b.interactive !== true) return fail(403, "not_interactive", "patio invite runs only from your own terminal; or create the link in the web app");
          const res = await ask({ type: "invite", rid: newId(), workspace: String(b.workspace ?? ""), expires_ms: b.expires_ms, max_uses: b.max_uses });
          if (res.type === "failed") return fail(400, "invite_failed", res.error);
          if (res.type !== "invite_link") return fail(500, "error", "unexpected answer from the server");
          const { type: _t, rid: _r, ...rest } = res;
          return json(rest);
        },
      },
      // `patio agents remove <agent> <workspace>`: the agent leaves the workspace and its channels there.
      "/leave-workspace": {
        POST: async (req) => {
          const b = (await req.json()) as { as?: string; workspace?: string };
          const who = speaker(b.as);
          if ("error" in who) return who.error;
          return membership({ type: "leave_workspace", rid: newId(), agent: who.name, workspace: String(b.workspace ?? "") });
        },
      },
      // `patio workspace new <name> --agent <agent>`: only from the person's own terminal.
      "/workspace-new": {
        POST: async (req) => {
          const b = (await req.json()) as { name?: string; agent?: string; interactive?: boolean };
          if (b.interactive !== true) return fail(403, "not_interactive", "patio workspace new runs only from your own terminal; or create the workspace in the web app");
          const res = await ask({ type: "workspace_new", rid: newId(), name: String(b.name ?? ""), agent: String(b.agent ?? ""), by_owner: true });
          if (res.type === "failed") return fail(400, "workspace_failed", res.error);
          if (res.type !== "invite_link") return fail(500, "error", "unexpected answer from the server");
          const { type: _t, rid: _r, ...rest } = res;
          return json(rest);
        },
      },
      // Which agent a call speaks as (the MCP server asks before every tool call).
      // The answer to the join's third question turns on the agent's auto_answer_in list (answerRule).
      "/rules/answer": {
        POST: async (req) => {
          const b = (await req.json()) as { agent?: string; list?: string[]; by?: string };
          try {
            return json({ said: answerRule(String(b.agent ?? ""), Array.isArray(b.list) ? b.list.map(String) : [], `your answer to ${b.by === "rules" ? "patio rules" : "patio join"}`) });
          } catch (err) {
            if (err instanceof HeldError) return fail(409, "not_turned_on", err.message);
            throw err;
          }
        },
      },
      // `patio agents add <agent> <workspace>` for an agent that waits for its owner: the add waits with the agent's card,
      // and the one click on it confirms both.
      "/pending-add": {
        POST: async (req) => {
          const b = (await req.json()) as { agent?: string; workspace?: string };
          const agent = String(b.agent ?? "");
          const workspace = String(b.workspace ?? "");
          const adds = inbox.getKv<{ agent: string; workspace: string }[]>("pending_adds") ?? [];
          if (!adds.some((a) => a.agent === agent && a.workspace === workspace)) inbox.setKv("pending_adds", [...adds, { agent, workspace }]);
          return json({ web_url: web.url });
        },
      },
      // A widening of an agent's three answers, from outside the person's terminal: a card in the web app.
      "/rules/request": {
        POST: async (req) => {
          const b = (await req.json()) as { agent?: string; workspace?: string; answers?: Partial<Answers>; by?: string };
          try {
            const r = requestRule(String(b.agent ?? ""), String(b.workspace ?? ""), b.answers ?? {}, b.by === "join" ? "join" : "rules");
            return json({ web_url: web.url, sentences: r.sentences });
          } catch (err) {
            if (err instanceof HeldError) return fail(409, "not_wider", err.message);
            throw err;
          }
        },
      },
      // `patio guide --as <agent>` and the MCP tool `guide`.
      "/guide": async (req) => {
        const who = speaker(new URL(req.url).searchParams.get("as"));
        return "error" in who ? who.error : json({ agent: who.name, text: await guideOf(who.name) });
      },
      // `patio uninstall`: this computer revokes itself at the server. Final.
      "/revoke-self": {
        POST: async () => {
          const res = await ask({ type: "revoke_self", rid: newId() });
          if (res.type === "failed") return fail(400, "revoke_failed", res.error);
          if (res.type !== "revoked_self") return fail(500, "error", "unexpected answer from the server");
          return json({ label: res.label });
        },
      },
      // The channels of the agent's workspaces, and whether it is in each (the MCP tool channels).
      "/channels": async (req) => {
        const who = speaker(new URL(req.url).searchParams.get("as"));
        if ("error" in who) return who.error;
        const res = await ask({ type: "channels", rid: newId(), agent: who.name });
        if (res.type === "failed") return fail(res.error === NOT_CONNECTED ? 503 : 400, res.error === NOT_CONNECTED ? "relay_down" : "channels_failed", res.error);
        if (res.type !== "channel_list") return fail(500, "error", "unexpected answer from the server");
        return json({ agent: who.name, channels: res.channels });
      },
      "/speaker": (req) => {
        const who = speaker(new URL(req.url).searchParams.get("as"));
        return "error" in who ? who.error : json({ name: who.name });
      },
      "/leave": {
        POST: async (req) => {
          const b = (await req.json()) as { as?: string; channel: string };
          const who = speaker(b.as);
          if ("error" in who) return who.error;
          return membership({ type: "leave", rid: newId(), agent: who.name, channel: String(b.channel ?? "") });
        },
      },
      "/inbox": (req) => {
        const url = new URL(req.url);
        const filter = url.searchParams.get("unread") === "1" ? "unread" : ((url.searchParams.get("filter") ?? "open") as ListFilter);
        if (!["open", "unread", "all", "rejected"].includes(filter)) return fail(400, "invalid", "filter is open, unread, all or rejected");
        const scope = scopeOf(url.searchParams.get("as"));
        if ("error" in scope) return scope.error;
        const limit = Number(url.searchParams.get("limit") ?? 50);
        return json({ messages: inbox.list({ filter, limit: scope.name ? 1000 : limit }).filter((m) => mine(scope, m)).slice(0, limit).map(publicItem) });
      },
      // What `patio watch` has to deal with: unread messages and claims whose lease ran out, oldest first, each
      // with whether its grant allows answering it automatically.
      "/pending": (req) => {
        const scope = scopeOf(new URL(req.url).searchParams.get("as"));
        if ("error" in scope) return scope.error;
        return json({
          messages: inbox.pending().filter((m) => mine(scope, m)).map((m) => ({
            ...publicItem(m),
            // auto_answer, and with auto_answer_in only from those workspaces (grants.ts autoAnswers).
            auto_answer: m.kind !== "reply" && autoAnswers(grantOf(m.local_agent || m.to, m.channel ? { channel: m.channel } : { contact: m.from }), m),
          })),
        });
      },
      // `patio answer`: claim a message for one consumer, with a lease the consumer renews while its agent runs.
      "/claim": {
        POST: async (req) => {
          const b = (await req.json()) as { id: string; as?: string };
          const scope = scopeOf(b.as);
          if ("error" in scope) return scope.error;
          const found = lookup(() => incoming(String(b.id ?? "")));
          if (!found.ok) return found.res;
          if (!found.value || !mine(scope, found.value)) return fail(404, "unknown_message", "no delivered message with that id in the inbox");
          const c = inbox.claim(found.value.id, leaseMs);
          if (!c.ok) {
            const why = {
              unknown_message: "no delivered message with that id in the inbox",
              already_claimed: c.until === null ? "its reply is waiting for the owner's decision in the web app" : "another consumer is answering it",
              already_replied: "it has already been answered",
              already_rejected: "it was rejected",
              reply_to_reply: "it is a reply; nobody answers an answer",
            }[c.code];
            return fail(c.code === "unknown_message" ? 404 : 409, c.code, `cannot claim ${found.value.id.slice(0, 8)}: ${why}`);
          }
          log(`claimed ${found.value.id.slice(0, 8)} for ${leaseMs / 1000}s`);
          // The receiving agent's last valid file: an invalid edit does not stop `patio answer`.
          const agent = found.value.local_agent || found.value.to;
          const { rules: _r, ...choice } = fileOf(agent);
          return json({ message: publicItem(inbox.get(found.value.id)!), token: c.token, lease_ms: leaseMs, agent, agent_config: choice, owner: login });
        },
      },
      "/claim/renew": {
        POST: async (req) => {
          const b = (await req.json()) as { id: string; token: string };
          if (!inbox.renew(b.id, b.token, leaseMs)) return fail(409, "lost_claim", "this consumer no longer holds the claim");
          return json({ ok: true, lease_ms: leaseMs });
        },
      },
      "/claim/release": {
        POST: async (req) => {
          const b = (await req.json()) as { id: string; token: string };
          return json({ ok: inbox.release(b.id, b.token) });
        },
      },
      "/claim/fail": {
        POST: async (req) => {
          const b = (await req.json()) as { id: string; token: string; reason: string };
          const reason = oneLine(String(b.reason ?? "failed"));
          if (!inbox.settle(b.id, "failed", reason, b.token)) return fail(409, "lost_claim", "this consumer no longer holds the claim");
          log(`answer of ${b.id.slice(0, 8)} failed: ${reason}`);
          return json({ ok: true });
        },
      },
      // The claimed message's reply, from the owner's agent: through the output gate, then answered, held
      // (the claim stays, without expiry, until the owner decides) or failed (blocked).
      "/claim/complete": {
        POST: async (req) => {
          const b = (await req.json()) as { id: string; token: string; text: string };
          if (!inbox.renew(b.id, b.token, leaseMs)) return fail(409, "lost_claim", "this consumer no longer holds the claim (its lease ran out)");
          const original = inbox.get(b.id)!;
          let sent: SendResult;
          try {
            sent = await replyTo(original, String(b.text ?? ""));
          } catch (err) {
            if (!(err instanceof ReplyRule)) throw err;
            inbox.settle(b.id, "answered", null, b.token);
            return fail(409, err.code, err.message);
          }
          const res = answer(sent, original.channel ? `#${original.channel.name}` : original.from, original.local_agent);
          if (sent.ok && sent.status === "held") inbox.hold(b.id, b.token, `reply waiting for the owner: ${sent.reason}`);
          else if (sent.ok && sent.status === "outbox") inbox.hold(b.id, b.token, "the reply waits in the outbox until the server is reachable");
          else if (sent.ok) inbox.settle(b.id, "answered", null, b.token);
          else inbox.settle(b.id, "failed", sent.reason === "blocked" ? `blocked by your rules (outgoing): ${sent.detail}` : `could not send the reply: ${sent.detail ?? sent.reason}`, b.token);
          return res;
        },
      },
      "/dismiss": {
        POST: async (req) => {
          const b = (await req.json()) as { id: string; as?: string };
          const scope = scopeOf(b.as);
          if ("error" in scope) return scope.error;
          const found = lookup(() => incoming(String(b.id ?? "")));
          if (!found.ok) return found.res;
          if (!found.value || !mine(scope, found.value)) return fail(404, "unknown_message", "no delivered message with that id in the inbox");
          const d = inbox.dismiss(found.value.id);
          if (!d.ok) return fail(409, d.code, { already_claimed: "another consumer is answering it", already_rejected: "it was rejected", already_replied: "it has already been answered", unknown_message: "no delivered message with that id in the inbox" }[d.code]);
          return json({ id: found.value.id, state: "dismissed" });
        },
      },
      "/reject": {
        POST: async (req) => {
          const b = (await req.json()) as { id: string; reason?: string | null; as?: string };
          const note = String(b.reason ?? "").trim() || null;
          if (note && note.length > 1000) return fail(400, "invalid", "the reason is at most 1000 characters");
          const scope = scopeOf(b.as);
          if ("error" in scope) return scope.error;
          const found = lookup(() => incoming(String(b.id ?? "")));
          if (!found.ok) return found.res;
          if (!found.value || !mine(scope, found.value)) return fail(404, "unknown_message", "no delivered message with that id in the inbox");
          const r = await rejectDelivered(found.value, note);
          if (!r.ok) {
            const why = {
              unknown_message: "no delivered message with that id in the inbox",
              already_claimed: "another consumer is answering it, or its reply is waiting for the owner's decision",
              already_replied: "it has already been answered",
              already_rejected: "it was already rejected",
              already_dismissed: "it was dismissed",
            }[r.code];
            return fail(r.code === "unknown_message" ? 404 : 409, r.code, `cannot reject ${found.value.id.slice(0, 8)}: ${why}`);
          }
          return json({ id: found.value.id, state: "rejected" });
        },
      },
      // `patio grants test`: a gate as a dry run, with this gatekeeper's grants and judge. Nothing is sent, stored
      // or written to the audit log.
      "/rules/test": {
        POST: async (req) => {
          const b = (await req.json()) as DryRunInput;
          const text = String(b.text ?? "");
          if (!text.trim()) return fail(400, "invalid", "give the text to test");
          const kind = (b.kind ?? (b.outgoing ? "reply" : "question")) as Kind;
          if (!KINDS.includes(kind)) return fail(400, "invalid", `kind must be one of ${KINDS.join(", ")}`);
          // A channel by name or <workspace>/<name>; one this gatekeeper has seen keeps its id (for per_day).
          let channel: ChannelRef | undefined;
          if (b.channel) {
            const [ws, name] = b.channel.includes("/") ? b.channel.replace(/^#/, "").split("/", 2) : [null, b.channel.replace(/^#/, "")];
            const known = inbox.channels().map((c) => c.channel).find((c) => c.name === name && (!ws || c.workspace === ws));
            channel = known ?? { id: `dry-run-${name}`, name: name!, workspace: ws ?? "" };
          }
          const who = channel ? { channel } : null;
          // Whose rules: the agent named, else the only agent of this computer (with a file, or on the server).
          const known = [...new Set([...ready(), ...config.names()])];
          const agent = b.as || (known.length === 1 ? known[0]! : "");
          if (!agent) return fail(400, "choose_agent", known.length ? `whose rules? this computer has ${known.join(", ")}: patio rules <agent> test …` : "this computer has no agent yet");
          if (!known.includes(agent)) return fail(404, "no_identity", `${agent} is not an agent of this computer`);
          if (!b.outgoing) {
            if (!b.from && !channel) return fail(400, "invalid", "say who the message is from: --from <agent> (or --channel)");
            const from = b.from ?? "someone";
            const grant = grantOf(agent, who ?? { contact: from });
            const countToday = inbox.countToday(channel ? { channel: channel.id } : { from });
            const decision = await inputGate({ from, to: agent, owner: login, kind, text, channel }, grant, { judge, countToday });
            return json({ direction: "in", grant, checks: { kind: { kind, allowed: kind === "reply" || grant.kinds.includes(kind) }, per_day: { count: countToday, limit: grant.per_day } }, decision } satisfies DryRun);
          }
          if (!b.to && !channel) return fail(400, "invalid", "say who the message is for: --to <agent> (or --channel)");
          const grant = grantOf(agent, who ?? { contact: b.to! });
          const decision = await outputGate({ to: b.to ?? `#${channel!.name}`, from: agent, owner: login, kind, text, channel }, grant, { judge });
          return json({ direction: "out", grant, checks: null, decision } satisfies DryRun);
        },
      },
      // `patio outbox`: what waits for the exchange, oldest first (the order it is sent in).
      "/outbox": () =>
        json({
          connected,
          ttl_ms: messageTtlMs(),
          items: inbox.outbox().map((r) => {
            const { msg } = openForSelf<Queued>(device, r.sealed);
            return { id: r.id, convo: r.convo, from: r.from_agent, to: r.to_ref, kind: r.kind, text: msg.text, queued_at: r.created_at, expires_at: r.created_at + messageTtlMs() };
          }),
        }),
      "/outbox/cancel": {
        POST: async (req) => {
          const b = (await req.json()) as { id: string };
          const found = lookup(() => inbox.outboxFind(String(b.id ?? "")));
          if (!found.ok) return found.res;
          const row = found.value;
          if (!row || !inbox.settleOutbox(row.id, "cancelled", "cancelled")) return fail(404, "unknown_message", "nothing with that id waits in the outbox");
          audit({ message_id: row.id, convo: row.convo, direction: "out", from: row.from_agent, to: row.to_ref, kind: row.kind, rule: "outbox", verdict: "cancelled" });
          log(`cancelled ${row.kind} ${row.id.slice(0, 8)} in the outbox`);
          settleOriginal(row, false, "the reply was cancelled in the outbox");
          wake(row.convo);
          return json({ id: row.id, state: "cancelled" });
        },
      },
      "/read": (req) => {
        const url = new URL(req.url);
        const id = url.searchParams.get("id") ?? "";
        const scope = scopeOf(url.searchParams.get("as"));
        if ("error" in scope) return scope.error;
        const found = lookup(() => incoming(id));
        if (!found.ok) return found.res;
        if (!found.value || !mine(scope, found.value)) return fail(404, "unknown_message", "no message with that id in the inbox");
        inbox.markRead(found.value.id);
        return json({ message: publicItem(inbox.get(found.value.id)!) });
      },
      "/send": {
        POST: async (req) => {
          const b = (await req.json()) as { to?: string; channel?: string; as?: string; kind?: Kind; text: string; context?: Message["context"]; convo?: string };
          const kind = b.kind ?? "question";
          if (!KINDS.includes(kind) || kind === "reply") return fail(400, "invalid", "use /reply to answer a message");
          if (!b.to === !b.channel) return fail(400, "invalid", "send to an agent or to a channel");
          const from = speaker(b.as);
          if ("error" in from) return from.error;
          return sendFromLocal(from.name, b.to ?? "", kind, b.text, b.context, b.convo, b.channel);
        },
      },
      "/reply": {
        POST: async (req) => {
          const b = (await req.json()) as { convo: string; text: string; as?: string };
          const scope = scopeOf(b.as);
          if ("error" in scope) return scope.error;
          const found = lookup(() => inbox.original(b.convo));
          if (!found.ok) return found.res;
          const original = found.value;
          if (!original || !mine(scope, original)) return fail(404, "unknown_convo", "no incoming message with that conversation or message id");
          // The reply comes from the local agent the message reached; the reply rules are checked first.
          const allowed = lookup(() => inbox.checkReply(original.id, original.local_agent || original.to));
          if (!allowed.ok) return allowed.res;
          const sent = await replyTo(original, b.text);
          const res = answer(sent, original.channel ? `#${original.channel.name}` : original.from, original.local_agent);
          if (sent.ok) {
            inbox.markRead(original.id);
            if (sent.status !== "held" && sent.status !== "outbox") inbox.settle(original.id, "answered", null);
          }
          return res;
        },
      },
      "/wait": async (req) => {
        const url = new URL(req.url);
        const ref = url.searchParams.get("convo") ?? "";
        // One id: the conversation's, or the message's (or a unique prefix of either).
        const direct = lookup(() => inbox.sentDirect(ref));
        if (!direct.ok) return direct.res;
        const convo = direct.value?.convo ?? inbox.sentBroadcast(ref)?.convo ?? ref;
        const seconds = Math.min(Number(url.searchParams.get("timeout") ?? 50), 55);
        // A broadcast this gatekeeper sent: return the replies that arrived (each member answers at most once).
        const broadcast = inbox.sentBroadcast(convo);
        // The message never left (its draft was not reviewed in time, or the owner rejected it), or the exchange
        // dropped it undelivered: there will be no reply, and `wait` says why.
        type Got = InboxItem | { replies: InboxItem[]; total: number } | { not_sent: string } | null;
        const take = (): Got => {
          if (!broadcast) {
            const reply = inbox.takeReply(convo);
            if (reply) return reply;
            const why = inbox.notSent(convo);
            return why ? { not_sent: why } : null;
          }
          const got = inbox.takeBroadcastReplies(broadcast.id);
          return got.replies.length ? got : null;
        };
        // Nothing yet on a direct message: who it waits for, and whether they answer on their own.
        const waitingOn = async () => {
          const to = direct.value?.to;
          if (!to) return {};
          const who = await relayWho();
          const entry = who.workspaces?.flatMap((r) => r.agents).find((a) => a.agent === to);
          return entry ? { waiting_on: { agent: to, owner: entry.owner, answers: entry.answers ?? "owner", say: answersSay(to, entry.answers ?? "owner", entry.owner) } } : {};
        };
        const shape = async (r: Got) => {
          if (r && "not_sent" in r) return json({ reply: null, not_sent: r.not_sent });
          if (!broadcast) return json({ reply: r, ...(r ? {} : await waitingOn()) });
          const got = (r as { replies: InboxItem[]; total: number } | null) ?? { replies: [], total: inbox.takeBroadcastReplies(broadcast.id).total };
          return json({ broadcast: { id: broadcast.id, convo: broadcast.convo, expected: broadcast.expected ?? 0 }, replies: got.replies, total: got.total });
        };
        const now = take();
        if (now) return shape(now);
        if (broadcast && (broadcast.expected ?? 0) <= inbox.takeBroadcastReplies(broadcast.id).total) return shape(null);
        const result = await new Promise<Got>((resolve) => {
          const list = waiters.get(broadcast?.convo ?? convo) ?? [];
          waiters.set(broadcast?.convo ?? convo, list);
          const done = (m: Got) => {
            clearTimeout(timer);
            const i = list.indexOf(wake);
            if (i >= 0) list.splice(i, 1);
            if (!list.length) waiters.delete(broadcast?.convo ?? convo);
            resolve(m);
          };
          const wake = () => {
            const got = take();
            if (got) done(got);
          };
          const timer = setTimeout(() => done(null), seconds * 1000);
          list.push(wake);
          req.signal.addEventListener("abort", () => done(null));
        });
        return shape(result);
      },
      "/watch": (req) => {
        let ctrl: ReadableStreamDefaultController<string>;
        const body = new ReadableStream<string>({
          start: (c) => void watchers.add((ctrl = c)),
          cancel: () => void watchers.delete(ctrl),
        });
        req.signal.addEventListener("abort", () => watchers.delete(ctrl));
        return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
      },
    },
    fetch: () => fail(404, "not_found", "unknown endpoint"),
  });
  process.umask(previousUmask);
  await chmod(cfg.socket, 0o600);

  const web = startWebApp({
    port: opts.webPort ?? Number(process.env.PATIO_WEB_PORT ?? 0),
    exchangeUrl: cfg.relay.replace(/^ws(s?):/, "http$1:").replace(/\/$/, ""),
    gatekeeper: {
      device: { id: device.id, label },
      login: () => login,
      connected: () => connected,
      inbox,
      gates: { held: heldCards, decide: decideHeld },
      keys: { changes: keyCards, decide: decideKeys },
      rules: { pending: pendingRules, confirm: confirmRule, requests: ruleRequests, decide: decideRuleRequest },
      questions,
      pendingAdds: {
        of: (agent: string) => (inbox.getKv<{ agent: string; workspace: string }[]>("pending_adds") ?? []).filter((a) => a.agent === agent).map((a) => a.workspace),
        clear: (agent: string) => inbox.setKv("pending_adds", (inbox.getKv<{ agent: string; workspace: string }[]>("pending_adds") ?? []).filter((a) => a.agent !== agent)),
      },
      activity: {
        entries: () => readAudit(cfg.home),
        // What became of an incoming message the rules let in, for its line: it waits for you, was answered…
        fate: (id: string) => {
          const m = inbox.get(id);
          if (!m) return null;
          if (waitsForPerson(m)) return "waits";
          return m.state === "answered" ? "answered" : m.state === "rejected" ? "declined" : m.state === "dismissed" ? "dismissed" : "delivered";
        },
        // Only what this gatekeeper's own agents sent: delivered, still held, or waiting in the outbox.
        ownText: (id: string) => {
          const m = inbox.get(id);
          if (m) return m.direction === "out" ? m.text : null;
          const d = inbox.draft(id);
          if (d) return d.final_text ?? d.msg.text;
          const o = inbox.outboxItem(id);
          return o ? openForSelf<Queued>(device, o.sealed).msg.text : null;
        },
      },
      configErrors: () =>
        config
          .summary()
          .filter((f) => f.error)
          .map((f) => `${f.error!.message}. patio keeps using the last valid version${f.version ? ` (v${f.version})` : " (the default rules)"}; fix the file and it is reloaded when you save it.`),
      agents: {
        rows: agentRows,
        file: (name: string) => config.agent(name),
        rules: (name: string) => rulesOf(name, fileOf(name), confirmed()),
        guide: (name: string) => guideOf(name),
        answers: (name: string) => answerSentencesOf(name),
        // The agent left a workspace: what it was asked from there and has not answered closes.
        closeOpen: (name: string, workspace: string) => {
          let n = 0;
          for (const m of inbox.list({ filter: "open", limit: 1000 })) {
            if ((m.local_agent || m.to) !== name || m.kind === "reply") continue;
            const from = m.channel ? [m.channel.workspace] : (m.workspaces ?? []);
            if (!from.includes(workspace) || (m.workspaces && m.workspaces.length > 1 && !m.channel)) continue;
            if (inbox.dismiss(m.id).ok) n++;
          }
          if (n) log(`${name} left ${workspace}: ${n} open message${n === 1 ? "" : "s"} closed`);
          return n;
        },
      },
      setup: {
        current: () => setup,
        settle: (state: "confirmed" | "declined", agent: string | null, moved?: string | null) => {
          if (!setup) return;
          setup.state = state;
          if (agent) setup.agent = agent;
          if (moved) setup.moved = moved;
        },
      },
    },
    log,
  });

  config.watch();
  connect();
  log(`local socket ${cfg.socket}; device ${device.id.slice(0, 8)}; ${inbox.unreadCount()} unread; claims last ${leaseMs / 1000}s`);
  log(
    `rules on (${config.names().length ? `agents/: ${config.names().join(", ")}` : "no agent files: the default rules"}; reloaded on change); ` +
      `judge: ${judgeKind.kind === "local" ? "this computer's key" : judgeKind.kind === "server" ? `the server's (${serverUrl}/judge)` : "none: every message waits for the owner"}`,
  );
  log(`web app at ${web.url}`);

  return {
    stop: async () => {
      stopped = true;
      clearInterval(sweeper);
      clearInterval(publisher);
      config.stop();
      ws?.close();
      local.stop(true);
      web.stop();
      inbox.close();
      await rm(cfg.socket, { force: true });
      releaseLock();
    },
    isConnected: () => connected,
    webUrl: web.url,
    login: () => login,
    agents: () => agents,
    device: publicDevice(device),
    // Tests use this to hand the exchange an envelope they built themselves.
    sendRaw: (frame: ClientFrame) => sendFrame(frame),
  };
}

// Someone else could have created the socket's directory first, or swapped it for a symlink.
async function assertPrivateDir(dir: string) {
  const st = await lstat(dir);
  const uid = process.getuid?.();
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} is not a plain directory`);
  if (uid !== undefined && st.uid !== uid) throw new Error(`${dir} is owned by another user`);
  if ((st.mode & 0o077) !== 0) throw new Error(`${dir} is readable or writable by other users; run chmod 700 on it`);
}


const CATEGORIES_RECIPIENT = "declined by the recipient";
const KEYS_CHANGED = "the contact's keys changed";
// What a request to the exchange answers while there is no connection.
const NOT_CONNECTED = "not connected to the server";

function oneLine(text: string) {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 80 ? line.slice(0, 79) + "…" : line;
}

