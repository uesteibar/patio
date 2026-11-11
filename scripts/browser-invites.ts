// just browser-invites: headless Chromium (Playwright) checks, in a fresh instance, the invite and default-channel
// controls in the web app and the server's invite page. Alice, admin of `team`, makes #general a default channel and
// creates an invite link (7 days, 5 uses); the link's page shows who invited you to what and how many agents are
// there, a prompt to copy into a coding agent (Copy prompt puts it in the clipboard), the command for your own
// terminal and the patio:// button. Carol, signed in, has a second agent ask to join with the link from a command
// that is not a terminal: her Needs you page shows one waiting card, one click. A revoked link's page says so.
// Screenshots go to .verify/browser/invites-<timestamp>/.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { findChromium } from "./lib/browser";
import { cliCommand, stop, up, type Manifest } from "./lib/instance";
import { VERIFY_DIR } from "./lib/paths";

type Check = { name: string; ok: boolean; detail?: string };

async function cli(m: Manifest, agent: string, args: string[]) {
  const { cmd, env, cwd } = cliCommand(m, agent, args);
  const proc = Bun.spawn(cmd, { env, cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = [await new Response(proc.stdout).text(), await new Response(proc.stderr).text()];
  return { code: await proc.exited, stdout: stdout.trim(), stderr: stderr.trim() };
}

export async function browserInvites(outRoot = join(VERIFY_DIR, "browser")) {
  const executablePath = findChromium();
  if (!executablePath) return { ok: false, error: "no Chromium found (set PATIO_CHROMIUM)" };
  const out = join(outRoot, `invites-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(out, { recursive: true });
  const checks: Check[] = [];
  const screenshots: string[] = [];
  const expect = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, ...(detail ? { detail } : {}) });

  const m = await up([{ handle: "alice", channels: ["general", "random"] }, { handle: "carol", workspace: null }]);
  const browser = await chromium.launch({ executablePath, headless: true });
  const shot = async (page: Page, name: string, selector?: string) => {
    const file = join(out, `${String(screenshots.length + 1).padStart(2, "0")}-${name}.png`);
    if (selector) await page.locator(selector).first().screenshot({ path: file });
    else await page.screenshot({ path: file, fullPage: true });
    screenshots.push(file);
  };
  try {
    const alice = await (await browser.newContext({ viewport: { width: 1180, height: 900 } })).newPage();
    const aliceUrl = m.agents.alice!.web_url;
    await alice.goto(`${aliceUrl}/login?login=alice`);
    await alice.waitForURL(`${aliceUrl}/`);
    await alice.goto(`${aliceUrl}/workspaces/${m.workspaces.team!.id}`);
    expect("the admin sees the invite links section", (await alice.locator("h2:has-text('Invite links')").count()) === 1);
    const general = alice.locator('[data-channel="general"]');
    expect("each public channel has a Make default button", (await alice.locator("[data-channel] button:has-text('Make default')").count()) === 2);
    await shot(alice, "workspace-before");

    await general.getByRole("button", { name: "Make default" }).click();
    await alice.waitForSelector(".flash:not(.error)");
    expect("#general is a default channel", ((await alice.locator(".flash").textContent()) ?? "").startsWith("#general is a default channel"));
    expect("it carries the Default label", (await alice.locator('[data-channel="general"] [data-default]').count()) === 1);

    await alice.locator("select[name=expires]").selectOption("7d");
    await alice.getByLabel("Use limit").fill("5");
    await alice.getByRole("button", { name: "Create link" }).click();
    await alice.waitForSelector(".flash:not(.error)");
    const flash = (await alice.locator(".flash").textContent()) ?? "";
    const url = /(http:\/\/\S+\/join\/[\w-]+)/.exec(flash)?.[1] ?? "";
    expect("creating a link shows it", !!url, flash);
    const row = alice.locator("[data-link]").first();
    expect("the link is listed with its uses and expiry, and Copy and Revoke", ((await row.textContent()) ?? "").includes("0 of 5 uses · until") && (await row.locator("button").allTextContents()).join("|") === "Copy|Revoke", (await row.textContent()) ?? "");
    await shot(alice, "workspace-link-and-default");
    await shot(alice, "invite-links-card", "h2:has-text('Invite links') + .card");

    const inviteCtx = await browser.newContext({ viewport: { width: 900, height: 1000 }, permissions: ["clipboard-read", "clipboard-write"] });
    const invite = await inviteCtx.newPage();
    const res = await invite.goto(url);
    const text = (await invite.locator("main").textContent()) ?? "";
    const server = m.exchange.url.replace(/^ws/, "http");
    expect("the invite page answers 200", res?.status() === 200, String(res?.status()));
    expect("it says who invited you to which workspace", text.includes("@alice invited you to team"), text);
    expect(
      "above the prompt: what patio is, what it installs and writes, what you decide",
      text.includes("What it is") && text.includes("What it installs and writes") && text.includes("~/.local/bin") && text.includes("kept out of git") && text.includes("What you decide") && text.includes("one Confirm"),
      text,
    );
    expect("the workspace's agents, with their owners", text.includes("Agents in team") && /alice\S* · @alice/.test(text.replace(/\s+/g, " ")), text);
    const prompt = (await invite.locator("#prompt").textContent()) ?? "";
    expect("its main element is the prompt for a coding agent", prompt.includes(`curl -fsSL ${server}/install.sh | sh`) && prompt.includes(`patio join ${url} --folder "$PWD" --connect --no-wait --ask requests --act ask-human --answer no`) && !/\bTOOL\b|--tool/.test(prompt), prompt);
    await invite.getByRole("button", { name: "Copy prompt" }).click();
    const copied = await invite.evaluate(() => (navigator as unknown as { clipboard: { readText(): Promise<string> } }).clipboard.readText());
    expect("Copy prompt puts the prompt in the clipboard", copied === prompt && (await invite.getByRole("button", { name: "Copied" }).count()) === 1, copied.slice(0, 80));
    expect("then the command for your own terminal", ((await invite.locator("#cmd").textContent()) ?? "") === `curl -fsSL ${server}/install.sh | sh; patio join ${url} --connect`);
    expect("no button for an app that does not exist yet", (await invite.getByRole("link", { name: /patio app/ }).count()) === 0 && !(await invite.content()).includes("patio://"));
    expect("the terminal command wraps instead of scrolling sideways", await invite.locator("#cmd").evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
    await shot(invite, "invite-page");
    // Its step 2: the three questions first, in one message, the defaults in words; then one command to run.
    expect(
      "the prompt asks the three questions first, the defaults in words, then gives one command and the words to change",
      prompt.indexOf("2. Ask me these three questions in one message") < prompt.indexOf("patio join ") &&
        prompt.includes("1. What may team ask you? (default: questions and small requests; or: only questions; or: anything they like)") &&
        prompt.includes('- "never": --act deny instead of --act ask-human') &&
        !prompt.split("\n").some((l) => l.includes("patio join") && l.includes("|")),
      prompt,
    );
    await invite.locator("#prompt").evaluate((el) => {
      const i = el.textContent!.indexOf("2. Ask me these three questions");
      el.scrollTop = (el.scrollHeight * i) / el.textContent!.length - 20;
    });
    await shot(invite, "invite-prompt-three-questions", ".prompt");
    // The prompt as a person copies it, next to the screenshots.
    await writeFile(join(out, "invite-prompt.txt"), `${prompt}\n`);

    const asked = await cli(m, "carol", ["join", url, "--agent", "carol-side", "--tool", "pi", "--folder", m.agents.carol!.home, "--no-wait", "--ask", "requests", "--act", "ask-human", "--answer", "no"]);
    expect("Carol's second agent asks to join with the link: it waits for her (exit 5)", asked.code === 5, `${asked.code} ${asked.stdout}`);
    const carol = await (await browser.newContext({ viewport: { width: 1180, height: 900 } })).newPage();
    const carolUrl = m.agents.carol!.web_url;
    await carol.goto(`${carolUrl}/login?login=carol`);
    await carol.waitForURL(`${carolUrl}/`);
    const card = carol.locator('[data-request="link:team"]');
    const cardText = ((await card.textContent()) ?? "").replace(/\s+/g, " ");
    expect("Carol's Needs you page shows one waiting card: carol-side (Pi in …) wants to join team", cardText.includes("carol-side (Pi in") && cardText.includes("wants to join team") && (await carol.locator("[data-request]").count()) === 1, cardText);
    expect("the card shows the agent's three answers: the one click covers them too", cardText.includes("Others may ask carol-side questions and small requests; never for secrets."), cardText);
    await shot(carol, "needs-you-waiting-card");
    await card.getByRole("button", { name: "Confirm" }).click();
    await carol.waitForSelector(".flash:not(.error)");
    const joined = (await carol.locator(".flash").textContent()) ?? "";
    expect("one click: carol-side is in team and #general", joined === "carol-side is in team and #general.", joined);

    await alice.goto(`${aliceUrl}/workspaces/${m.workspaces.team!.id}`);
    expect("the link now counts one use", ((await alice.locator("[data-link]").first().textContent()) ?? "").includes("1 of 5 uses"));
    await alice.locator("[data-link]").first().getByRole("button", { name: "Revoke" }).click();
    await alice.waitForSelector(".flash:not(.error)");
    expect("a revoked link is labelled Revoked", ((await alice.locator("[data-link]").first().textContent()) ?? "").includes("Revoked"));
    const gone = await invite.goto(url);
    expect("its page says it was revoked (410)", gone?.status() === 410 && ((await invite.locator("main").textContent()) ?? "").includes("This invite link was revoked"));
    await shot(invite, "invite-page-revoked");
  } finally {
    await browser.close();
    await stop(m);
  }
  return { ok: checks.every((c) => c.ok), instance: m.id, checks, screenshots, dir: out };
}

if (import.meta.main) {
  const result = await browserInvites().catch((err) => ({ ok: false, error: String(err?.stack ?? err) }));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
