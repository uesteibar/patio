// Increment 9: device revocation in the web app, and web sessions that survive a gatekeeper restart.
import type { Scenario } from "../lib/scenario";

const revoke: Scenario = {
  name: "device-revoke",
  description:
    "Bob revokes the device his agent lives on, from that gatekeeper's own Devices page: the first click asks for a confirmation, the second revokes it. The exchange disconnects it and stops delivering to it: Alice's next question to Bob's agent exits 3.",
  label: "deterministic",
  agents: () => [{ handle: "alice" }, { handle: "bob" }],
  async run(t) {
    const before = await t.cli("alice", ["ask", "bob", "Are you there?"]);
    t.expect("before: Alice reaches Bob", before.code === 0, `exit ${before.code}`);
    const device = /data-device="([^"]+)"/.exec((await t.webGet("bob", "/computers")).html)?.[1] ?? "";
    t.expect("the Devices page has a revoke button for Bob's device", (await t.webGet("bob", "/computers")).html.includes(`action="/computers/${device}/revoke"`));
    const first = await t.webPost("bob", `/computers/${device}/revoke`, {});
    t.expect("revoking the gatekeeper serving the page asks for a confirmation first", first.location?.pathname === `/computers/${device}/revoke`, first.location?.toString());
    const page = await t.webGet("bob", `/computers/${device}/revoke`);
    t.expect("the confirmation says what it does", page.text.includes("This is the computer serving this page"), page.text.slice(0, 300));
    const done = await t.webPost("bob", `/computers/${device}/revoke`, { confirm: "yes" });
    t.expect("confirming revokes it", done.ok?.startsWith("Revoked bob-gatekeeper") ?? false, done.ok ?? done.error ?? "");
    await Bun.sleep(1500);
    const status = await t.cli("bob", ["status"]);
    t.expect("Bob's gatekeeper is cut off from the exchange", status.stdout.includes("(not connected)"), status.stdout);
    const after = await t.cli("alice", ["ask", "bob", "And now?"]);
    t.expect("after: the exchange no longer delivers to it (exit 3)", after.code === 3, `exit ${after.code} ${after.stderr}`);
  },
};

const sessionRestart: Scenario = {
  name: "web-session-restart",
  description: "Bob signs in to his web app; his gatekeeper restarts (web app on the same port). His browser session still works: no new sign-in.",
  label: "deterministic",
  agents: () => [{ handle: "alice" }, { handle: "bob" }],
  async run(t) {
    const before = await t.webGet("bob", "/computers");
    t.expect("signed in before the restart", before.text.includes("Signed in as @bob"));
    const port = new URL(t.m.agents.bob!.web_url).port;
    await t.stopAgent("bob");
    await t.startAgent("bob", { PATIO_WEB_PORT: port });
    const signIns = t.lines.filter((l) => l.includes("signs in with GitHub")).length;
    const after = await t.webGet("bob", "/computers");
    t.expect("the same browser session works after the restart", after.text.includes("Signed in as @bob") && after.text.includes("Your computers"), after.text.slice(0, 200));
    t.expect("without signing in again", t.lines.filter((l) => l.includes("signs in with GitHub")).length === signIns);
  },
};

export const DEVICE_SCENARIOS = [revoke, sessionRestart];
