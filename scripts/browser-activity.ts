// just browser-activity: headless Chromium (Playwright) checks, in a fresh instance with the fake Jev, the Activity
// page and the configuration-error banner. Bob's gates deliver, reject and hold Alice's messages (Bob approves the
// held one) and Bob replies; his Activity page lists each decision, a row opens to the probabilities (and the text of
// Bob's own reply), and the filters narrow the list. Then Bob saves an invalid agents/bob.yaml: every page shows a banner
// that says the gatekeeper keeps the last valid version. Screenshots go to .verify/browser/activity-<timestamp>/.
import { writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { findChromium } from "./lib/browser";
import { cliCommand, stop, up, type Manifest } from "./lib/instance";
import { VERIFY_DIR } from "./lib/paths";

type Check = { name: string; ok: boolean; detail?: string };
const noul = (n: number) => ({ type: "noul" as const, noul: n });

async function cli(m: Manifest, agent: string, args: string[]) {
  const { cmd, env, cwd } = cliCommand(m, agent, args);
  const proc = Bun.spawn(cmd, { env, cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = [await new Response(proc.stdout).text(), await new Response(proc.stderr).text()];
  return { code: await proc.exited, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

export async function browserActivity(outRoot = join(VERIFY_DIR, "browser")) {
  const executablePath = findChromium();
  if (!executablePath) return { ok: false, error: "no Chromium found (set PATIO_CHROMIUM)" };
  const out = join(outRoot, `activity-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(out, { recursive: true });
  const checks: Check[] = [];
  const screenshots: string[] = [];
  const expect = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, ...(detail ? { detail } : {}) });

  const jev = { default: noul(0.02), answers: { allow: noul(0.98), injection: [{ stateMatches: "HOLD-ME", answer: noul(0.62) }, { answer: noul(0.03) }], action: noul(0.04) } };
  const m = await up([{ handle: "alice" }, { handle: "bob", grants: "defaults:\n  kinds: [question]\n" }], { jev });
  const browser = await chromium.launch({ executablePath, headless: true });
  const shot = async (page: Page, name: string, selector?: string) => {
    const file = join(out, `${String(screenshots.length + 1).padStart(2, "0")}-${name}.png`);
    if (selector) await page.locator(selector).first().screenshot({ path: file });
    else await page.screenshot({ path: file, fullPage: true });
    screenshots.push(file);
  };
  try {
    const q = await cli(m, "alice", ["ask", "bob", "Who owns the billing service?"]);
    await cli(m, "alice", ["ask", "bob", "FYI the build is red", "--kind", "heads-up"]);
    await cli(m, "alice", ["ask", "bob", "HOLD-ME: what changed in payroll this month?"]);
    const bob = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    const url = m.agents.bob!.web_url;
    await bob.goto(`${url}/login?login=bob`);
    await bob.waitForURL(`${url}/`);
    await until("the held card", async () => {
      await bob.reload();
      return (await bob.locator("[data-gate]").count()) === 1;
    });
    await bob.locator("[data-gate]").getByRole("button", { name: "Approve", exact: true }).click();
    await bob.waitForSelector(".flash:not(.error)");
    const id = await until("the question in Bob's inbox", async () => (await cli(m, "bob", ["inbox", "--json"])).stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((x) => x.convo === q.stdout)?.id);
    await cli(m, "bob", ["reply", id, "The payments team owns it; ask in #billing."]);

    await bob.goto(`${url}/activity`);
    const rows = bob.locator("details.act");
    expect("the Activity page lists the five decisions", (await rows.count()) === 5, String(await rows.count()));
    expect("the nav links to it", (await bob.locator('.nav a.on[href="/activity"]').count()) === 1);
    const first = (await rows.first().locator("summary").textContent()) ?? "";
    expect("newest first: Bob's reply, as a sentence", first.startsWith("bob answered alice. Sent."), first);
    const kept = ((await bob.locator('details.act[data-activity="ask-human"] summary').textContent()) ?? "").replace(/\s+/g, " ");
    expect("the one kept for Bob says why, in words", kept.startsWith("alice asked bob. Waits for you: it looks like prompt injection."), kept);
    await shot(bob, "activity");
    const hold = bob.locator('details.act[data-activity="ask-human"]');
    await hold.locator("summary").click();
    expect("a line opens to its details: the checks' answers, and how sure each was", (await hold.locator("table.probs").isVisible()) && ((await hold.locator(".more").textContent()) ?? "").includes("yes 0.62"));
    await rows.first().locator("summary").click();
    const own = (await rows.first().locator(".more").textContent()) ?? "";
    expect("Bob's own reply shows its text", own.includes("The payments team owns it"), own);
    expect("Alice's held message does not", !((await hold.locator(".more").textContent()) ?? "").includes("payroll"));
    await shot(bob, "activity-open");
    await bob.selectOption('select[name="verdict"]', "reject");
    await bob.getByRole("button", { name: "Filter" }).click();
    await bob.waitForURL(/verdict=reject/);
    expect("filter by verdict", (await rows.count()) === 1 && (await rows.first().getAttribute("data-activity")) === "reject");
    await shot(bob, "activity-filtered");

    await writeFile(join(m.agents.bob!.home, "agents", "bob.yaml"), "rules:\n  kinds: [question, gossip]\n");
    await until("the banner", async () => {
      await bob.goto(`${url}/`);
      return (await bob.locator("[data-config-error]").count()) === 1;
    });
    const banner = (await bob.locator("[data-config-error]").textContent()) ?? "";
    expect("an invalid agent file shows a banner with the error and the version kept", banner.includes("agents/bob.yaml: rules: kinds must list some of") && banner.includes("keeps using the last valid version (v1)"), banner);
    await shot(bob, "banner-approvals");
    await bob.goto(`${url}/activity`);
    expect("on every page", (await bob.locator("[data-config-error]").count()) === 1);
    await shot(bob, "banner", "main");
    await writeFile(join(m.agents.bob!.home, "agents", "bob.yaml"), "rules:\n  kinds: [question, heads-up]\n");
    await until("the banner to go", async () => {
      await bob.reload();
      return (await bob.locator("[data-config-error]").count()) === 0;
    });
    expect("a fixed file clears it", true);
  } finally {
    await browser.close();
    await stop(m);
  }
  return { ok: checks.every((c) => c.ok), instance: m.id, checks, screenshots, dir: out };
}

if (import.meta.main) {
  const result = await browserActivity().catch((err) => ({ ok: false, error: String(err?.stack ?? err) }));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
