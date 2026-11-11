// just browser-channels: headless Chromium (Playwright) checks the read-only channel and DM views in a fresh
// instance. Alice broadcasts to #release, Bob and Carol answer, Bob also gets a DM. Alice's web app shows the
// broadcast with both replies grouped under it, the DM thread, and no way to write. Along the way it captures
// the empty states and the approval cards for workspace and channel requests. Screenshots go to .verify/browser/.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { findChromium } from "./lib/browser";
import { cliCommand, joinChannel, stop, up, type Manifest } from "./lib/instance";
import { VERIFY_DIR } from "./lib/paths";

type Check = { name: string; ok: boolean; detail?: string };

async function cli(m: Manifest, agent: string, args: string[]) {
  const { cmd, env, cwd } = cliCommand(m, agent, args);
  const proc = Bun.spawn(cmd, { env, cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = [await new Response(proc.stdout).text(), await new Response(proc.stderr).text()];
  return { code: await proc.exited, stdout: stdout.trim(), stderr: stderr.trim() };
}

export async function browserChannels(outRoot = join(VERIFY_DIR, "browser")) {
  const executablePath = findChromium();
  if (!executablePath) return { ok: false, error: "no Chromium found (set PATIO_CHROMIUM)" };
  const out = join(outRoot, `channels-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(out, { recursive: true });
  const checks: Check[] = [];
  const screenshots: string[] = [];
  const expect = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, ...(detail ? { detail } : {}) });

  const m = await up([{ handle: "alice" }, { handle: "bob" }, { handle: "carol" }, { handle: "dave" }]);
  const browser = await chromium.launch({ executablePath, headless: true });
  const shot = async (page: Page, name: string) => {
    const file = join(out, `${String(screenshots.length + 1).padStart(2, "0")}-${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    screenshots.push(file);
  };
  try {
    const page = await (await browser.newContext({ viewport: { width: 1180, height: 820 } })).newPage();
    const url = m.agents.alice!.web_url;
    await page.goto(`${url}/login?login=alice`);
    await page.waitForURL(`${url}/`);

    // Empty states before anything was said.
    await page.getByRole("link", { name: "Conversations" }).click();
    expect("the conversations view starts empty", (await page.locator(".empty").first().textContent())?.includes("No channel messages") ?? false);
    await shot(page, "conversations-empty");

    // Alice, Bob and Carol join #release through the instance; Dave's agent asks, and Dave approves it in his
    // web app (the approval card is one of the screenshots).
    for (const h of ["alice", "bob", "carol"]) await joinChannel(m, m.agents[h]!, "release");
    const daveJoin = await cli(m, "dave", ["join", "release"]);
    expect("dave's request is pending (exit 5)", daveJoin.code === 5, daveJoin.stdout);
    const dave = await (await browser.newContext({ viewport: { width: 1180, height: 760 } })).newPage();
    const daveUrl = m.agents.dave!.web_url;
    await dave.goto(`${daveUrl}/login?login=dave`);
    await dave.waitForURL(`${daveUrl}/`);
    expect("Dave sees the channel request as a card under Needs you", (await dave.locator('[data-request="ch:dave:release"]').textContent())?.includes("wants to join") ?? false);
    await shot(dave, "needs-you-channel-request");
    await dave.locator('[data-request="ch:dave:release"]').getByRole("button", { name: "Confirm" }).click();
    await dave.waitForSelector(".flash:not(.error)");
    expect("approving it makes dave a member", (await dave.locator(".flash").textContent()) === "dave joined the channel.");

    // Traffic: a broadcast with two replies, and a DM with its answer.
    const ask = await cli(m, "alice", ["ask", "--channel", "release", "Does PR 812 change the notifications schema?"]);
    expect("the broadcast reaches the three other members", ask.stderr.includes("sent to 3 agents of"), ask.stderr);
    await cli(m, "bob", ["reply", ask.stdout, "No, it only adds an index on notifications.user_id."]);
    await cli(m, "carol", ["reply", ask.stdout, "It also renames notifications.kind; see migration 0042."]);
    const dm = await cli(m, "alice", ["ask", "bob", "Can you review the migration before 17:00?"]);
    await cli(m, "bob", ["reply", dm.stdout, "Yes, on it."]);
    await cli(m, "alice", ["wait", ask.stdout, "--timeout", "2"]);

    await page.getByRole("link", { name: "Conversations" }).click();
    expect("the channel is listed", (await page.locator('a[href^="/channels/"]').first().textContent()) === "#release");
    const dmRow = ((await page.locator("[data-thread]").first().textContent()) ?? "").replace(/\s+/g, " ");
    expect("the direct message names the agent of Alice's involved", dmRow.includes("Your agent alice asked bob"), dmRow);
    await shot(page, "conversations-list");
    await page.locator('a[href^="/channels/"]').first().click();
    const thread = page.locator(".thread").first();
    expect("the broadcast heads the thread", (await thread.locator(":scope > .msg .body").textContent()) === "Does PR 812 change the notifications schema?");
    const replies = await thread.locator(".replies .msg").allTextContents();
    expect("both replies are grouped under it", replies.length === 2 && replies.some((r) => r.includes("bob")) && replies.some((r) => r.includes("carol")), replies.join(" | "));
    expect("the view is read-only: no text box or send button", (await page.locator("main textarea, main input[type=text]").count()) === 0 && (await page.getByText("Read-only").count()) === 1);
    await shot(page, "channel-thread");

    await page.getByRole("link", { name: "Conversations" }).click();
    await page.getByRole("link", { name: "Every direct message in full" }).click();
    const dmThread = page.locator(".thread").first();
    expect("the DM shows the question and its answer", !!(await dmThread.textContent())?.includes("Can you review the migration") && (await dmThread.locator(".replies .msg").count()) === 1);
    await shot(page, "direct-messages");

    // The workspace page lists the agents and the channel.
    await page.getByRole("link", { name: "Workspaces" }).click();
    await page.getByRole("link", { name: "team" }).click();
    expect("the workspace lists #release with four member agents", (await page.locator('[data-channel="release"]').textContent())?.includes("4 member agents") ?? false);
    await shot(page, "workspace-channels");
  } finally {
    await browser.close();
    await stop(m);
  }
  return { ok: checks.every((c) => c.ok), instance: m.id, checks, screenshots, dir: out };
}

if (import.meta.main) {
  const result = await browserChannels().catch((err) => ({ ok: false, error: String(err?.stack ?? err) }));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
