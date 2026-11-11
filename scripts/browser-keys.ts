// just browser-keys: headless Chromium (Playwright) checks, in a fresh instance, the keys-changed card and the Devices
// page. Alice pins Bob's keys at first contact; the exchange's directory then says Bob's agent lives on his second
// device (bob-2), so Alice's next question is held. Alice sees the card (pinned and new fingerprints, the note that a
// device addition looks the same, Block / Trust the new keys) and trusts the new keys. Then Bob, on his Devices page,
// revokes his second device, and starts to revoke the one serving the page, which asks for a confirmation first.
// Screenshots go to .verify/browser/keys-<timestamp>/.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { findChromium } from "./lib/browser";
import { cliCommand, stop, up, type Manifest } from "./lib/instance";
import { VERIFY_DIR } from "./lib/paths";
import { swapAtExchange } from "./scenarios/keys";

type Check = { name: string; ok: boolean; detail?: string };

async function cli(m: Manifest, agent: string, args: string[]) {
  const { cmd, env, cwd } = cliCommand(m, agent, args);
  const proc = Bun.spawn(cmd, { env, cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = [await new Response(proc.stdout).text(), await new Response(proc.stderr).text()];
  return { code: await proc.exited, stdout: stdout.trim(), stderr: stderr.trim() };
}

export async function browserKeys(outRoot = join(VERIFY_DIR, "browser")) {
  const executablePath = findChromium();
  if (!executablePath) return { ok: false, error: "no Chromium found (set PATIO_CHROMIUM)" };
  const out = join(outRoot, `keys-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(out, { recursive: true });
  const checks: Check[] = [];
  const screenshots: string[] = [];
  const expect = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, ...(detail ? { detail } : {}) });

  const m = await up([{ handle: "alice" }, { handle: "bob" }, { handle: "bob-2", login: "bob" }]);
  const browser = await chromium.launch({ executablePath, headless: true });
  const shot = async (page: Page, name: string, selector?: string) => {
    const file = join(out, `${String(screenshots.length + 1).padStart(2, "0")}-${name}.png`);
    if (selector) await page.locator(selector).first().screenshot({ path: file });
    else await page.screenshot({ path: file, fullPage: true });
    screenshots.push(file);
  };
  try {
    // Alice pins Bob's keys, then the exchange swaps them.
    expect("first contact is sent", (await cli(m, "alice", ["ask", "bob", "First contact: is PR 812 merging?"])).code === 0);
    swapAtExchange(m, "bob", "bob-2");
    const held = await cli(m, "alice", ["ask", "bob", "Who reviews the migration?"]);
    expect("the next question is held (exit 7)", held.code === 7, `${held.code} ${held.stderr}`);

    const alice = await (await browser.newContext({ viewport: { width: 1180, height: 900 } })).newPage();
    const aliceUrl = m.agents.alice!.web_url;
    await alice.goto(`${aliceUrl}/login?login=alice`);
    await alice.waitForURL(`${aliceUrl}/`);
    const card = alice.locator("[data-keys]");
    expect("Alice sees one keys-changed card", (await card.count()) === 1, String(await card.count()));
    const text = (await card.textContent()) ?? "";
    expect("it names the contact and shows both fingerprints", text.includes("other keys for bob") && text.includes("Pinned") && text.includes("New") && (text.match(/encryption key/g) ?? []).length === 2, text);
    expect("it says a device addition looks the same, and how to check", text.includes("adds or moves to a new computer") && text.includes("Check the new fingerprint with the owner"), text);
    const buttons = await card.locator("button").allTextContents();
    expect("its decisions: block, trust the new keys", buttons.join("|") === "Block|Trust the new keys", buttons.join("|"));
    await shot(alice, "keys-changed-card", "[data-keys]");
    await shot(alice, "keys-changed-approvals");
    await card.getByRole("button", { name: "Trust the new keys" }).click();
    await alice.waitForSelector(".flash:not(.error)");
    const flash = (await alice.locator(".flash").textContent()) ?? "";
    expect("trusting releases the held question", flash === "Trusted bob's new keys. Released 0 incoming and 1 outgoing message.", flash);
    expect("no card is left", (await alice.locator("[data-keys]").count()) === 0);
    await shot(alice, "keys-trusted");

    // Bob's Devices page: both of his devices, each with Revoke.
    const bob = await (await browser.newContext({ viewport: { width: 1180, height: 900 } })).newPage();
    const bobUrl = m.agents.bob!.web_url;
    await bob.goto(`${bobUrl}/login?login=bob`);
    await bob.waitForURL(`${bobUrl}/`);
    await bob.goto(`${bobUrl}/computers`);
    const rows = bob.locator("[data-device]");
    expect("Bob's Computers page lists his two devices", (await rows.count()) === 2, String(await rows.count()));
    expect("each with a Revoke button", (await bob.locator("[data-device] button:has-text('Revoke')").count()) === 2);
    await shot(bob, "devices");
    const other = bob.locator("[data-device]:not(:has-text('this computer'))");
    await other.getByRole("button", { name: "Revoke" }).click();
    await bob.waitForSelector(".flash:not(.error)");
    const revoked = (await bob.locator(".flash").textContent()) ?? "";
    expect("revoking the other device needs no confirmation", revoked.startsWith("Revoked bob-2-gatekeeper"), revoked);
    expect("it is listed as revoked", ((await other.textContent()) ?? "").includes("Revoked"));
    await shot(bob, "devices-revoked");
    await bob.locator("[data-device]:has-text('this computer')").getByRole("button", { name: "Revoke" }).click();
    await bob.waitForURL(/\/computers\/[^/]+\/revoke$/);
    const confirm = (await bob.locator("main").textContent()) ?? "";
    expect("revoking this computer asks for a confirmation", confirm.includes("This is the computer serving this page") && confirm.includes("Revoke this computer"), confirm.slice(0, 200));
    await shot(bob, "devices-confirm-this-gatekeeper");
    await bob.getByRole("link", { name: "Cancel" }).click();
    await bob.waitForURL(`${bobUrl}/computers`);
    expect("cancel keeps it", ((await bob.locator("[data-device]:has-text('this computer')").textContent()) ?? "").includes("Revoke"));
  } finally {
    await browser.close();
    await stop(m);
  }
  return { ok: checks.every((c) => c.ok), instance: m.id, checks, screenshots, dir: out };
}

if (import.meta.main) {
  const result = await browserKeys().catch((err) => ({ ok: false, error: String(err?.stack ?? err) }));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
