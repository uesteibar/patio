// A test world: the fake GitHub provider, an exchange configured for it, and gatekeepers onboarded through
// the same flows a human uses: sign in with GitHub in the gatekeeper's web app, pair with a code, register
// an agent and approve it in the web app, and put it in a shared workspace with an invite link.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config";
import { startDaemon, type DaemonOptions } from "../../src/daemon";
import { startExchange } from "../../src/exchange";
import { daemon } from "../../src/local";
import { FAKE_USERS, startFakeGitHub } from "../fakes/fake-github";
import { WebClient } from "../../scripts/lib/webclient";
import { jevJudge, type Judge } from "../../src/gates";
import { startFakeJev } from "../fakes/fake-jev";
import { writeAgentFile, type AgentFileSpec } from "./agent-file";

export { WebClient };

const quiet = () => {};

// A wait inside a test: long enough for a loaded machine, shorter than SERVER_MS so a real hang names what it waited for.
export const until = async (what: string, fn: () => Promise<boolean> | boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
};

export type Gatekeeper = {
  cfg: Config;
  d: Awaited<ReturnType<typeof startDaemon>>;
  home: string;
  web: WebClient;
  stop: () => Promise<void>;
};

export type Person = {
  login: string;
  agent: string;
  cfg: Config;
  home: string;
  web: WebClient;
  d: Awaited<ReturnType<typeof startDaemon>>;
  stop: () => Promise<void>;
};

// `githubHost`: another name for 127.0.0.1 (localhost) to reach the fake GitHub by, so a browser test can make
// the sign-in cross-site the way github.com is.
// `judge`: the server's judge (judge.ts), e.g. a fake Jev; none by default. `exchangeLog` receives the server's log.
export async function startWorld(opts: { extraUsers?: string[]; githubHost?: string; judge?: Judge | null; judgePerDay?: number; exchangeLog?: (line: string) => void } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "patio-world-"));
  const users = [...FAKE_USERS, ...(opts.extraUsers ?? []).map((login, i) => ({ login, id: 5000 + i, name: login }))];
  const gh = startFakeGitHub({ clientId: "patio-test", clientSecret: "patio-test-secret", users });
  const github = { clientId: "patio-test", clientSecret: "patio-test-secret", webUrl: opts.githubHost ? gh.webUrl.replace("127.0.0.1", opts.githubHost) : gh.webUrl, apiUrl: gh.apiUrl };
  const dbPath = join(dir, "exchange.db");
  let port = 0;
  const exchangeOpts = { db: dbPath, github, log: opts.exchangeLog ?? quiet, judge: opts.judge ?? null, judgePerDay: opts.judgePerDay };
  let exchange = startExchange({ port, ...exchangeOpts });
  port = exchange.port;
  const running = new Set<{ stop: () => Promise<void> }>();
  // The gates always run; unless a test brings its own judge, a fake Jev finds everything benign.
  const jev = startFakeJev({ default: { type: "noul", noul: 0.02 }, answers: { allow: { type: "noul", noul: 0.98 } } }, { apiKey: "world-key" });
  const benignJudge = jevJudge({ apiKey: "world-key", baseURL: jev.url });
  let counter = 0;
  // The "team" workspace belongs to @unai, signed in on a gatekeeper of his own that tests never stop.
  let team: Promise<{ admin: WebClient; id: string; link: string }> | null = null;

  const world = {
    dir,
    dbPath,
    // The fake Jev behind the gates of every gatekeeper (and the server's judge, when a test gives it this one).
    jev,
    benignJudge,
    gh,
    get port() {
      return port;
    },
    get exchangeUrl() {
      return `http://127.0.0.1:${port}`;
    },
    restartExchange() {
      exchange.stop(true);
      exchange = startExchange({ port, ...exchangeOpts });
    },

    // A bare gatekeeper on `home` (a new one when omitted), not signed in, paired or registered.
    // `files`: agents' files (agents/<name>.yaml) written before it starts. `relay`: reach the exchange through this
    // URL (a test proxy) instead of directly.
    async gatekeeper(home?: string, files?: Record<string, AgentFileSpec>, dopts: DaemonOptions = {}, relay?: string): Promise<Gatekeeper> {
      home ??= await mkdtemp(join(dir, "gk-"));
      for (const [name, spec] of Object.entries(files ?? {})) await writeAgentFile(home, name, spec);
      const cfg: Config = { home, handle: "", relay: relay ?? `ws://127.0.0.1:${port}`, socket: join(home, "daemon.sock") };
      const d = await startDaemon(cfg, { log: quiet, judge: benignJudge, ...dopts });
      running.add(d);
      await until("the gatekeeper to connect", () => d.isConnected());
      const stop = async () => {
        if (!running.delete(d)) return;
        await d.stop();
      };
      return { cfg, d, home, web: new WebClient(d.webUrl), stop };
    },

    // Signs `web` in, pairs the gatekeeper with a code, registers `agent` and approves it in the web app.
    async onboard(g: Gatekeeper, login: string, agent: string): Promise<void> {
      await g.web.signIn(login);
      const { code } = await daemon.pair(g.cfg);
      const paired = await g.web.post("/pair", { code });
      if (!paired.ok) throw new Error(`pairing failed: ${paired.error}`);
      await until("the pairing to reach the gatekeeper", () => g.d.login() === login);
      const asked = await daemon.register(g.cfg, agent);
      if (asked.agent.status !== "approved") {
        const approved = await g.web.post(`/agents/${agent}/decide`, { decision: "approve" });
        if (!approved.ok) throw new Error(`approval failed: ${approved.error}`);
        await until(`${agent} to be approved`, () => g.d.agents().some((a) => a.name === agent && a.status === "approved"));
      }
    },

    // A person with one gatekeeper and one approved agent, in the shared "team" workspace unless `team: false`.
    // `agent` defaults to a unique name derived from the login, so tests can start the same person many times.
    // `grants`: the agent's rules, in the old rules.yaml shape; `file`: more of its file (tool, folder, workspaces).
    async person(login: string, o: { agent?: string; grants?: string; file?: AgentFileSpec; turnOnRules?: boolean; team?: boolean; home?: string; dopts?: DaemonOptions } = {}): Promise<Person> {
      const agent = o.agent ?? `${login}-${++counter}`;
      const spec = o.grants || o.file ? { [agent]: { ...o.file, rules: o.grants ?? o.file?.rules } } : undefined;
      const g = await world.gatekeeper(o.home, spec, o.dopts);
      await world.onboard(g, login, agent);
      const p: Person = { login, agent, cfg: { ...g.cfg, handle: agent }, home: g.home, web: g.web, d: g.d, stop: g.stop };
      // Like a person who writes auto_answer or allowed actions in the agent's rules, then turns them on in the web app.
      if (spec && o.turnOnRules !== false) await world.turnOnRules(p.web);
      if (o.team !== false) {
        const t = await world.team();
        await world.joinByLink(p, t.link);
      }
      return p;
    },

    // An admin's invite link (a web client signed in as an admin of the workspace): its code.
    async inviteLink(admin: WebClient, workspaceId: string): Promise<string> {
      const res = await admin.post(`/workspaces/${workspaceId}/links`, { expires: "" });
      const code = /\/join\/([\w-]+)/.exec(res.ok ?? "")?.[1];
      if (!code) throw new Error(`creating an invite link failed: ${res.error ?? res.ok}`);
      return code;
    },

    // The person's agent joins the link's workspace from their own terminal (no confirmation), and its default channels.
    async joinByLink(p: { cfg: Config; agent: string }, code: string) {
      const r = await daemon.joinLink(p.cfg, code, [p.agent], true);
      if (r.status !== "joined") throw new Error(`joining by link failed: ${JSON.stringify(r)}`);
    },

    // The owner turns on, in the web app, every setting of rules.yaml that widens what others can do. Returns their keys.
    async turnOnRules(web: WebClient): Promise<string[]> {
      const page = await (await web.get("/")).text();
      const keys = [...page.matchAll(/data-rule="([^"]+)"/g)].map((m) => m[1]!.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))));
      for (const key of keys) {
        const res = await web.post("/rules/confirm", { key });
        if (!res.ok) throw new Error(`turning on ${key} failed: ${res.error}`);
      }
      return keys;
    },

    // The agent asks to join a workspace its owner already has agents in; its owner approves in the web app.
    async joinWorkspace(p: Person, workspaceId: string) {
      const asked = await daemon.join(p.cfg, { workspace: workspaceId });
      if (asked.status === "approved") return;
      const res = await p.web.post(`/workspaces/${workspaceId}/agents/${p.agent}/decide`, { decision: "approve" });
      if (!res.ok) throw new Error(`approving ${p.agent} in the workspace failed: ${res.error}`);
    },

    // A channel created by `owner` (a signed-in web client) in a workspace; returns its id.
    async channel(owner: WebClient, workspaceId: string, name: string, isPrivate = false) {
      const res = await owner.post(`/workspaces/${workspaceId}/channels`, { name, ...(isPrivate ? { private: "1" } : {}) });
      if (!res.ok) throw new Error(`creating #${name} failed: ${res.error}`);
      const page = await (await owner.get(`/workspaces/${workspaceId}`)).text();
      const id = new RegExp(`href="/channels/([^"]+)">#${name}<`).exec(page)?.[1];
      if (!id) throw new Error(`#${name} not listed`);
      return decodeURIComponent(id);
    },

    // The agent asks to join; its owner approves (and the channel owner too, when given, for a private channel).
    async joinChannel(p: Person, channel: string, channelOwner?: WebClient) {
      const asked = await daemon.join(p.cfg, { channel });
      if (asked.status === "approved") return;
      const id = channel.startsWith("ch_") ? channel : null;
      const approve = async (web: WebClient) => {
        const page = await (await web.get("/")).text();
        const action = new RegExp(`action="(/channels/[^"]+/members/${p.agent}/decide)"`).exec(page)?.[1] ?? (id ? `/channels/${id}/members/${p.agent}/decide` : null);
        if (!action) throw new Error(`no pending channel request for ${p.agent}`);
        const res = await web.post(action, { decision: "approve" });
        if (!res.ok) throw new Error(`approving ${p.agent} in ${channel} failed: ${res.error}`);
      };
      await approve(p.web);
      if (channelOwner && channelOwner !== p.web) await approve(channelOwner);
    },

    // Created once, even when several people are started at the same time, with a reusable invite link.
    team(): Promise<{ admin: WebClient; id: string; link: string }> {
      team ??= (async () => {
        const g = await world.gatekeeper();
        await g.web.signIn("unai");
        const res = await g.web.post("/workspaces", { name: "team" });
        const id = decodeURIComponent(res.location!.pathname.split("/").pop()!);
        return { admin: g.web, id, link: await world.inviteLink(g.web, id) };
      })();
      return team;
    },

    async stop() {
      for (const d of [...running]) await d.stop();
      running.clear();
      exchange.stop(true);
      gh.stop();
      jev.stop();
    },
  };
  return world;
}

export type World = Awaited<ReturnType<typeof startWorld>>;
