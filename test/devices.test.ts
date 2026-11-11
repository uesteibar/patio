// Increment 9: device revocation in the web app, and web sessions and in-progress sign-ins that survive a restart
// of the gatekeeper (stored in its database: 7 days for a session, 10 minutes for a sign-in).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { openInbox } from "../src/inbox";
import { daemon, DaemonError, waitForReply } from "../src/local";
import { startWorld, until, WebClient, type World } from "./helpers/world";
import { SERVER_MS } from "./helpers/timeouts";

let world: World;
beforeAll(async () => {
  process.env.PATIO_NO_NOTIFY = "1";
  world = await startWorld();
}, SERVER_MS);
afterAll(() => world.stop(), SERVER_MS);

const errorOf = (p: Promise<unknown>) => p.then(() => null, (e) => e as DaemonError);
const freePort = () => {
  const s = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = s.port!;
  s.stop(true);
  return port;
};

test("revoking a device: the exchange stops delivering to it, drops what it queued, and refuses it; this device needs a confirmation", async () => {
  const alice = await world.person("alice");
  const bob = await world.person("bob");
  // Bob's second gatekeeper, paired from his first one's web app.
  const spare = await world.gatekeeper();
  expect((await bob.web.post("/pair", { code: (await daemon.pair(spare.cfg)).code })).ok).toContain("is now your computer, @bob");
  await until("paired", () => spare.d.login() === "bob");
  await spare.web.signIn("bob");

  // Bob's first device: a message to Alice waits at the exchange while she is offline; one from Alice waits for Bob.
  const toAlice = { home: alice.home };
  await alice.stop();
  const queuedFromBob = await daemon.send(bob.cfg, { to: alice.agent, kind: "question", text: "Sent before the revoke" });
  expect(queuedFromBob.status).toBe("queued");
  await bob.stop();

  // The Devices page lists both, each with a revoke button; revoking another device needs no confirmation.
  const page = await (await spare.web.get("/computers")).text();
  expect(page).toContain(`action="/computers/${bob.d.device.id}/revoke"`);
  expect(page).toContain(`action="/computers/${spare.d.device.id}/revoke"`);
  const revoked = await spare.web.post(`/computers/${bob.d.device.id}/revoke`, {});
  expect(revoked.ok).toContain("Revoked");
  expect(await (await spare.web.get("/computers")).text()).toContain("Revoked");

  // Bob's agent lived on the revoked device: the exchange no longer delivers to it.
  const alice2 = await world.gatekeeper(toAlice.home);
  const cfgA = { ...alice2.cfg, handle: alice.agent };
  expect((await errorOf(daemon.send(cfgA, { to: bob.agent, kind: "question", text: "still there?" })))?.code).toBe("unreachable");
  // What the revoked device queued is not delivered: its signature is no longer accepted.
  expect(await waitForReply(cfgA, queuedFromBob.convo, 1)).toBeNull();
  expect((await daemon.inbox(cfgA, { filter: "all" })).messages.map((m) => m.text)).not.toContain("Sent before the revoke");
  // The revoked device itself is refused when it connects.
  const back = await world.gatekeeper(bob.home).catch((e: Error) => e);
  expect(back instanceof Error ? back.message : "connected").toContain("timed out waiting for the gatekeeper to connect");

  // This gatekeeper's own device: the first post asks for a confirmation; confirming revokes it and it disconnects.
  const self = await spare.web.post(`/computers/${spare.d.device.id}/revoke`, {});
  expect(self.location?.pathname).toBe(`/computers/${spare.d.device.id}/revoke`);
  const confirm = await (await spare.web.get(`/computers/${spare.d.device.id}/revoke`)).text();
  expect(confirm).toContain("This is the computer serving this page");
  expect(confirm).toContain('name="confirm" value="yes"');
  expect((await spare.web.post(`/computers/${spare.d.device.id}/revoke`, { confirm: "yes" })).ok).toContain("Revoked");
  await until("the revoked gatekeeper to disconnect", () => !spare.d.isConnected());
  await Bun.sleep(1500);
  expect(spare.d.isConnected()).toBe(false);
  await spare.stop();
  await alice2.stop();
}, 30_000);

test("a web session survives a gatekeeper restart, for 7 days", async () => {
  const port = freePort();
  const home = await mkdtemp(join(world.dir, "web-"));
  const g = await world.gatekeeper(home, undefined, { webPort: port });
  await g.web.signIn("carol");
  const cookie = g.web.cookie;
  await g.stop();
  const again = await world.gatekeeper(home, undefined, { webPort: port });
  const web = new WebClient(again.d.webUrl);
  web.cookie = cookie;
  const page = await (await web.get("/computers")).text();
  expect(page).toContain("Signed in as <b>@carol</b>");
  await again.stop();
}, SERVER_MS);

test("a sign-in started before a restart finishes after it", async () => {
  const port = freePort();
  const home = await mkdtemp(join(world.dir, "web-"));
  const g = await world.gatekeeper(home, undefined, { webPort: port });
  // Follow the sign-in through the exchange and the GitHub provider, up to the redirect back to the web app.
  let url = `${g.d.webUrl}/login?login=dave`;
  for (let hop = 0; hop < 10 && !url.startsWith(`${g.d.webUrl}/auth/done`); hop++) {
    const res = await fetch(url, { redirect: "manual" });
    url = new URL(res.headers.get("location")!, url).toString();
  }
  expect(url.startsWith(`${g.d.webUrl}/auth/done`)).toBe(true);
  await g.stop();
  const again = await world.gatekeeper(home, undefined, { webPort: port });
  const done = await fetch(url, { redirect: "manual" });
  expect(done.status).toBe(200);
  expect(await done.text()).toContain('http-equiv="refresh" content="0;url=/"');
  expect(done.headers.get("set-cookie")).toContain("Max-Age=604800");
  await again.stop();
}, SERVER_MS);

test("sessions expire after 7 days and sign-ins after 10 minutes; a sign-in is used once", async () => {
  const home = await mkdtemp(join(world.dir, "store-"));
  const inbox = openInbox(home);
  const t0 = Date.UTC(2026, 10, 9);
  inbox.addWebSession("id1", { login: "erin", token: "tok", csrf: "c" }, t0);
  expect(inbox.webSession("id1", t0 + 7 * 86_400_000 - 1)).toMatchObject({ login: "erin", token: "tok", csrf: "c" });
  expect(inbox.webSession("id1", t0 + 7 * 86_400_000)).toBeNull();
  inbox.addSignIn("s1", "/setup?code=X", t0);
  inbox.addSignIn("s2", "/", t0);
  expect(inbox.takeSignIn("s1", t0 + 10 * 60_000 - 1)).toEqual({ next: "/setup?code=X" });
  expect(inbox.takeSignIn("s1", t0)).toBeNull();
  expect(inbox.takeSignIn("s2", t0 + 10 * 60_000)).toBeNull();
  inbox.dropWebSession("id1");
  expect(inbox.webSession("id1", t0)).toBeNull();
  inbox.close();
}, SERVER_MS);

test("a revoked device's agent name can be registered again on another device of the same owner", async () => {
  const alice = await world.person("alice");
  const bob = await world.person("bob");
  const spare = await world.gatekeeper();
  expect((await bob.web.post("/pair", { code: (await daemon.pair(spare.cfg)).code })).ok).toContain("is now your computer, @bob");
  await until("paired", () => spare.d.login() === "bob");
  await spare.web.signIn("bob");
  // While the old device stands, the name lives there.
  expect((await errorOf(daemon.register(spare.cfg, bob.agent)))?.message).toContain("lives on another of your computers");
  expect((await spare.web.post(`/computers/${bob.d.device.id}/revoke`, {})).ok).toContain("Revoked");
  await bob.stop();
  // Revoked: the name is free again for Bob, on his new device, once he approves it there.
  const asked = await daemon.register(spare.cfg, bob.agent);
  expect(asked.agent.status).toBe("pending");
  expect((await spare.web.post(`/agents/${bob.agent}/decide`, { decision: "approve" })).ok).toContain("approved");
  await until("approved on the new device", () => spare.d.agents().some((a) => a.name === bob.agent && a.status === "approved"));
  // And the agent is reachable there, with the workspace memberships it had.
  const cfgSpare = { ...spare.cfg, handle: bob.agent };
  const sent = await daemon.send(alice.cfg, { to: bob.agent, kind: "question", text: "On your new device?" });
  expect(sent.status).toBe("delivered");
  await until("delivered to the new device", async () => (await daemon.inbox(cfgSpare)).messages.some((m) => m.text === "On your new device?"));
  await spare.stop();
  await alice.stop();
}, 30_000);
