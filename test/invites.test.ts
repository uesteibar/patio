// Invite links, joining with one, default channels, and who confirms what. An admin creates a link in the web app;
// the server serves a page for it with a prompt for a coding agent; an agent joins with it and enters the default
// channels. From the person's own terminal nothing waits for a second confirmation; from an agent it waits for them:
// one card, one click, which covers a new agent's identity too.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { daemon } from "../src/local";
import { startWorld, until, WebClient, type World } from "./helpers/world";
import { SERVER_MS } from "./helpers/timeouts";

let world: World;
let admin: WebClient;
let wsId: string;
let general: string;
beforeAll(async () => {
  process.env.PATIO_NO_NOTIFY = "1";
  world = await startWorld({ extraUsers: ["ines", "olga", "pere"] });
  const unai = await world.person("unai", { team: false });
  admin = unai.web;
  const created = await admin.post("/workspaces", { name: "orbit" });
  wsId = decodeURIComponent(created.location!.pathname.split("/").pop()!);
  await world.joinByLink(unai, await world.inviteLink(admin, wsId));
  general = await world.channel(admin, wsId, "general");
  await world.channel(admin, wsId, "random");
  await world.channel(admin, wsId, "secret", true);
}, SERVER_MS);
afterAll(() => world.stop(), SERVER_MS);

const createLink = async (fields: Record<string, string> = { expires: "7d" }) => {
  const res = await admin.post(`/workspaces/${wsId}/links`, fields);
  expect(res.error).toBeNull();
  const url = /Created an invite link: (\S+)$/.exec(res.ok ?? "")?.[1];
  expect(url).toStartWith(`${world.exchangeUrl}/join/`);
  return { url: url!, code: url!.split("/").pop()! };
};
const page = async (path: string) => (await (await admin.get(path)).text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("an admin marks a public channel as default in the web app; a private one cannot be", async () => {
  const on = await admin.post(`/channels/${general}/default`, { default: "1", back: `/workspaces/${wsId}` });
  expect(on.ok).toBe("#general is a default channel: agents that join the workspace enter it.");
  const html = await (await admin.get(`/workspaces/${wsId}`)).text();
  expect(html).toMatch(/data-channel="general"[\s\S]*?data-default>Default</);
  const secret = /href="\/channels\/([^"]+)">#secret</.exec(html)![1]!;
  const off = await admin.post(`/channels/${decodeURIComponent(secret)}/default`, { default: "1" });
  expect(off.error).toBe("a private channel cannot be a default channel");
}, SERVER_MS);

test("the invite page says who invited you, what patio is, installs and asks, who is in it, then a prompt to copy and the command", async () => {
  const { url, code } = await createLink();
  const res = await fetch(url);
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("@unai invited you to <b>orbit</b></h1>");
  // Three short lines above the prompt: what it is, what it installs and writes, what you decide.
  expect(html).toContain("<dt>What it is</dt><dd>patio lets your coding agent ask your teammates' agents, and answer theirs from this repository.");
  expect(html).toContain('<dt>What it installs and writes</dt><dd>The patio binary in <span class="mono">~/.local/bin</span>, patio running in the background, an answer service, and the project files');
  expect(html).toContain("kept out of git.</dd>");
  expect(html).toContain("<dt>What you decide</dt><dd>Three questions about what orbit may ask your agent, and one Confirm in your browser.</dd>");
  // The workspace's agents, each with its owner.
  expect(html).toMatch(/<li><span class="mono">unai-\d+<\/span> <span class="faint">· @unai<\/span><\/li>/);
  expect(html).toContain(">Copy prompt</button>");
  // No button for an app that does not exist yet.
  expect(html).not.toContain("patio://");
  expect(html).not.toContain("patio app");
  const prompt = /<pre id="prompt">([\s\S]*?)<\/pre>/.exec(html)![1]!.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  expect(prompt).toContain(`curl -fsSL ${world.exchangeUrl}/install.sh | sh`);
  // No agent can know which tool it runs in: the prompt never asks, the join detects it.
  expect(prompt).not.toMatch(/\bTOOL\b|--tool/);
  expect(prompt).not.toMatch(/claude|codex/i);
  // The questions come first, before the join runs: one message, the defaults written as words.
  const ask = prompt.indexOf("2. Ask me these three questions in one message, then wait for my answer. Run nothing else until I answer.");
  const run = prompt.indexOf(`patio join ${url}`);
  expect(ask).toBeGreaterThan(0);
  expect(run).toBeGreaterThan(ask);
  expect(prompt).toContain("1. What may orbit ask you? (default: questions and small requests; or: only questions; or: anything they like)");
  expect(prompt).toContain("2. May you change files for them? (default: only when I approve; or: never)");
  expect(prompt).toContain("3. Should you answer orbit on your own? (default: no; or: yes)");
  // One full command ready to run with the defaults, and a mapping for the other answers.
  expect(prompt).toContain(`   patio join ${url} --folder "$PWD" --connect --no-wait --ask requests --act ask-human --answer no\n`);
  expect(prompt).toContain('- "never": --act deny instead of --act ask-human');
  // Never a|b|c in a line a model may run, and nothing called bold in plain text.
  for (const line of prompt.split("\n").filter((l) => l.includes("patio join"))) expect(line).not.toContain("|");
  expect(prompt).not.toMatch(/[a-z]\|[a-z]/);
  expect(prompt).not.toContain("bold");
  expect(prompt).toContain('lines that start with "!"');
  expect(prompt).toContain('starts with "Confirm in"');
  // The one ending the join prints.
  expect(prompt).toContain('6. When it prints a line that starts with "patio is ready", show me that line and the three lines after it ("Next:", "Try:", "What needs you:") exactly as printed, and stop.');
  expect(html).toContain(`patio join ${url} --connect`);
  const info = (await (await fetch(`${world.exchangeUrl}/api/invites/${code}`)).json()) as { workspace: { name: string }; inviter: string; people: number; state: string };
  expect(info).toMatchObject({ workspace: { name: "orbit" }, inviter: "unai", people: 1, agents: 1, state: "ok" });
  // The admin sees the link, with its uses and expiry, and can revoke it.
  expect(await page(`/workspaces/${wsId}`)).toContain("by @unai · 0 uses · until");
}, SERVER_MS);

test("from the person's own terminal: they join, their agent joins and enters the default channels, nothing waits", async () => {
  const { code } = await createLink();
  const ines = await world.person("ines", { team: false });
  const r = await daemon.joinLink(ines.cfg, code, [ines.agent], true);
  expect(r).toMatchObject({ status: "joined", workspace: { name: "orbit" }, inviter: "unai", people: 2, agents: [{ name: ines.agent, status: "approved", channels: ["general"] }] });
  // Nothing waits for Ines in her web app.
  expect(await (await ines.web.get("/")).text()).not.toContain('class="count"');
  // Her agent is in #general: a broadcast there reaches it.
  const unai = await world.person("unai", { team: false });
  await world.joinByLink(unai, code);
  expect((await daemon.join(unai.cfg, { channel: "orbit/general", interactive: true })).status).toBe("approved");
  await daemon.send(unai.cfg, { channel: "orbit/general", kind: "question", text: "Welcome to orbit" });
  await until("the broadcast in Ines's inbox", async () => (await daemon.inbox(ines.cfg)).messages.some((m) => m.text === "Welcome to orbit"));
  // The admin got a notice, and the link counts one use.
  expect(await page(`/workspaces/${wsId}`)).toContain("@ines joined");
}, SERVER_MS);

test("from an agent (not a terminal), the join waits for the person: one card, one click, a new agent's identity included", async () => {
  const { code } = await createLink();
  const olga = await world.person("olga", { team: false });
  const r = await daemon.joinLink(olga.cfg, code, [olga.agent], false);
  expect(r).toMatchObject({ status: "pending", agents: [{ name: olga.agent, status: "pending" }] });
  const approvals = await (await olga.web.get("/")).text();
  expect(approvals).toContain(`<b>${olga.agent}</b> wants to join <b>orbit</b>`);
  expect(approvals).toContain("With an invite link from @unai");
  const action = /action="(\/link-requests\/[^"]+\/decide)"/.exec(approvals)![1]!;
  expect((await olga.web.post(action, { decision: "approve" })).ok).toBe(`${olga.agent} is in orbit and #general.`);
  const again = await daemon.joinLink(olga.cfg, code, [olga.agent], false);
  expect(again).toMatchObject({ status: "joined", agents: [{ name: olga.agent, status: "approved" }] });

  // A second agent of Olga's, new, asks with the same link from an agent: its identity and its join are one card.
  const side = await daemon.joinLink(olga.cfg, code, ["olga-side"], false);
  expect(side).toMatchObject({ status: "pending", agents: [{ name: "olga-side", status: "pending" }] });
  const cards = await (await olga.web.get("/")).text();
  expect(cards.match(/data-request="link:orbit"/g)?.length).toBe(1);
  expect(cards).toContain("<b>olga-side</b> wants to join <b>orbit</b>");
  expect(cards).not.toContain("asks to be your agent");
  expect(cards).toContain('<span class="count" aria-label="1 waiting for you">1</span>');
  const sideAction = /action="(\/link-requests\/[^"]+\/decide)"/.exec(cards)![1]!;
  expect((await olga.web.post(sideAction, { decision: "approve" })).ok).toBe("olga-side is in orbit and #general.");
  await until("olga-side is approved and in orbit", () => !!olga.d.agents().find((a) => a.name === "olga-side" && a.status === "approved")?.workspaces?.includes("orbit"));
}, SERVER_MS);

test("register, join a workspace by name and join a channel: from a terminal at once, from an agent waiting for the person", async () => {
  const pere = await world.person("pere", { team: false });
  const g = await world.gatekeeper();
  await g.web.signIn("pere");
  const { code } = await daemon.pair(g.cfg);
  await g.web.post("/pair", { code });
  await until("the pairing", () => g.d.login() === "pere");
  expect((await daemon.register(g.cfg, "pere-mcp")).agent.status).toBe("pending");
  expect((await daemon.register(g.cfg, "pere-tty", true)).agent.status).toBe("approved");
  const link = await createLink();
  expect((await daemon.joinLink(pere.cfg, link.code, [pere.agent], true)).status).toBe("joined");
  const cfg = { ...g.cfg, handle: "pere-tty" };
  const ws = await daemon.join(cfg, { workspace: "orbit" });
  expect(ws.status).toBe("pending");
  expect((await daemon.join(cfg, { workspace: "orbit", interactive: true })).status).toBe("approved");
  expect((await daemon.join(cfg, { channel: "orbit/random" })).status).toBe("pending");
  expect((await daemon.join(cfg, { channel: "orbit/random", interactive: true })).status).toBe("approved");
  // A private channel still needs its owner, even from Pere's terminal.
  const secret = await daemon.join(cfg, { channel: "orbit/secret", interactive: true });
  expect(secret).toMatchObject({ status: "pending", needs: ["@unai (owner of the private channel)"] });
}, SERVER_MS);

test("an expired, revoked or used-up link is refused with a clear message, on the page and when joining", async () => {
  const expired = await createLink({ expires: "1s" });
  const revoked = await createLink();
  const once = await createLink({ expires: "7d", uses: "1" });
  expect((await admin.post(`/links/${revoked.code}/revoke`, { back: `/workspaces/${wsId}` })).ok).toBe("Revoked the invite link; it no longer works.");
  await Bun.sleep(1100);
  const res = await fetch(expired.url);
  expect(res.status).toBe(410);
  expect(await res.text()).toContain("This invite link expired on");
  expect(await (await fetch(revoked.url)).text()).toContain("This invite link was revoked: ask @unai for a new one.");
  const p1 = await world.person("alice", { team: false });
  const p2 = await world.person("bob", { team: false });
  expect((await daemon.joinLink(p1.cfg, once.code, [p1.agent], true)).status).toBe("joined");
  await expect(daemon.joinLink(p2.cfg, once.code, [p2.agent], true)).rejects.toThrow("this invite link has been used 1 time, its limit: ask @unai for a new one");
  await expect(daemon.joinLink(p2.cfg, expired.code, [p2.agent], true)).rejects.toThrow("this invite link expired on");
  await expect(daemon.joinLink(p2.cfg, revoked.code, [p2.agent], true)).rejects.toThrow("this invite link was revoked");
  await expect(daemon.joinLink(p2.cfg, "nope", [p2.agent], true)).rejects.toThrow("this invite link is not known to this server");
  expect((await fetch(`${world.exchangeUrl}/join/nope`)).status).toBe(404);
  expect(await page(`/workspaces/${wsId}`)).toMatch(/Revoked/);
}, SERVER_MS);
