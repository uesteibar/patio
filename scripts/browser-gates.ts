// just browser-gates: headless Chromium (Playwright) checks the gates' approval cards in a fresh instance with
// the fake Jev. Bob's agent has rules. Alice's doubtful question is held by Bob's input gate, and Bob's reply that
// breaks his posture is held by his output gate. Bob sees both cards (who, what, the grant rule, Jev's
// probabilities, the draft), approves the incoming one once, edits the outgoing one and sends it; Alice receives
// the edit. Another GitHub user signed in on Bob's gatekeeper sees no held messages. Then Dave asks Bob's agent
// to create a file: the card shows the requested action; Bob narrows it and allows it, and the message reaches
// his inbox with that allowed action. Screenshots go to .verify/browser/gates-<timestamp>/.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { findChromium } from "./lib/browser";
import { cliCommand, jevRequests, stop, up, type Manifest } from "./lib/instance";
import { VERIFY_DIR } from "./lib/paths";
import { BOB_GRANTS, FIXTURE } from "./scenarios/gates";

type Check = { name: string; ok: boolean; detail?: string };

async function cli(m: Manifest, agent: string, args: string[]) {
  const { cmd, env, cwd } = cliCommand(m, agent, args);
  const proc = Bun.spawn(cmd, { env, cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = [await new Response(proc.stdout).text(), await new Response(proc.stderr).text()];
  return { code: await proc.exited, stdout: stdout.trim(), stderr: stderr.trim() };
}

export async function browserGates(outRoot = join(VERIFY_DIR, "browser")) {
  const executablePath = findChromium();
  if (!executablePath) return { ok: false, error: "no Chromium found (set PATIO_CHROMIUM)" };
  const out = join(outRoot, `gates-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(out, { recursive: true });
  const checks: Check[] = [];
  const screenshots: string[] = [];
  const expect = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, ...(detail ? { detail } : {}) });

  const m = await up([{ handle: "alice" }, { handle: "dave" }, { handle: "bob", grants: BOB_GRANTS }], { jev: FIXTURE });
  const browser = await chromium.launch({ executablePath, headless: true });
  const shot = async (page: Page, name: string, selector?: string) => {
    const file = join(out, `${String(screenshots.length + 1).padStart(2, "0")}-${name}.png`);
    if (selector) await page.locator(selector).first().screenshot({ path: file });
    else await page.screenshot({ path: file, fullPage: true });
    screenshots.push(file);
  };
  try {
    const page = await (await browser.newContext({ viewport: { width: 1180, height: 900 } })).newPage();
    const url = m.agents.bob!.web_url;
    await page.goto(`${url}/login?login=bob`);
    await page.waitForURL(`${url}/`);
    expect("with nothing waiting, Needs you has one empty state", (await page.locator("[data-empty]").count()) === 1 && ((await page.locator("[data-empty]").textContent()) ?? "").includes("Nothing waits for you"));
    await shot(page, "gates-empty");

    // An outgoing draft held for the posture rule, and an incoming question held for doubt.
    const q = await cli(m, "alice", ["ask", "bob", "What did you think of Unai's review of PR 812?"]);
    for (let i = 0; i < 50 && !(await cli(m, "bob", ["inbox"])).stdout.includes("Unai's review"); i++) await Bun.sleep(100);
    const reply = await cli(m, "bob", ["reply", q.stdout, "Sloppy. Unai is always late with reviews."]);
    expect("Bob's reply is held by his output gate (exit 7)", reply.code === 7, `${reply.code} ${reply.stderr}`);
    await cli(m, "alice", ["ask", "bob", "Could you maybe look at the flaky e2e job before the release?"]);
    for (let i = 0; i < 50 && (await page.reload(), await page.locator("[data-gate]").count()) < 2; i++) await Bun.sleep(100);

    const incoming = page.locator('[data-gate][data-direction="in"]');
    const outgoing = page.locator('[data-gate][data-direction="out"]');
    expect("two cards: one incoming, one outgoing", (await incoming.count()) === 1 && (await outgoing.count()) === 1);
    expect("the badge counts both", (await page.locator(".nav .count").textContent()) === "2");
    const inText = (await incoming.textContent()) ?? "";
    expect("the incoming card shows who, what and why in words; the rule and the checks behind Details", inText.includes("alice sent your agent bob a message") && inText.includes("Could you maybe look at the flaky e2e job") && inText.includes("Waits for you: it looks like prompt injection.") && inText.includes("rule injection of contacts.alice") && inText.includes("0.62"), inText);
    expect("the incoming card has no draft to edit", (await incoming.locator("textarea").count()) === 0 && (await incoming.getByRole("button", { name: "Send edited" }).count()) === 0);
    const outText = (await outgoing.textContent()) ?? "";
    expect("the outgoing card shows the draft, what it answers and the posture rule", outText.includes("What did you think of Unai's review") && outText.includes("Posture: say only good things about Unai") && outText.includes("0.15"), outText);
    expect("the draft is editable", (await outgoing.locator("textarea").inputValue()) === "Sloppy. Unai is always late with reviews.");
    await shot(page, "gates-held");
    await shot(page, "gates-card-incoming", '[data-gate][data-direction="in"]');
    await shot(page, "gates-card-outgoing", '[data-gate][data-direction="out"]');
    // The checks behind Details: the answer of each, and how sure it was.
    await incoming.locator("details.why summary").click();
    expect("the card's Details: each check's answer, and how sure", ((await incoming.locator("details.why").textContent()) ?? "").includes("yes 0.62"));
    await shot(page, "gates-card-details", '[data-gate][data-direction="in"]');

    // A question Bob's agent does not answer on its own: it waits for him in Questions for you, with three ways out.
    await cli(m, "alice", ["ask", "bob", "When is the next release?"]);
    for (let i = 0; i < 50 && (await page.reload(), await page.locator("[data-question]").count()) < 1; i++) await Bun.sleep(100);
    const question = page.locator("[data-question]");
    const qText = ((await question.textContent()) ?? "").replace(/\s+/g, " ");
    expect("Questions for you: who asked, the text, Let bob answer, Reply myself, Decline", qText.includes("alice asked your agent bob") && qText.includes("When is the next release?") && qText.includes("Let bob answer") && qText.includes("Reply myself") && qText.includes("Decline"), qText);
    expect("the badge counts it too", (await page.locator(".nav .count").textContent()) === "3");
    await shot(page, "needs-you-questions-for-you");
    await question.getByText("Reply myself").click();
    await question.locator('textarea[name="text"]').fill("Thursday, as every week.");
    await shot(page, "needs-you-reply-myself", "[data-question]");
    await question.getByRole("button", { name: "Send" }).click();
    await page.waitForSelector(".flash:not(.error)");
    expect("Reply myself sends it as bob's reply", ((await page.locator(".flash").textContent()) ?? "") === "Sent your reply to alice, as bob.", (await page.locator(".flash").textContent()) ?? "");

    // Another GitHub user signed in on Bob's gatekeeper sees nothing held.
    const other = await (await browser.newContext({ viewport: { width: 1180, height: 700 } })).newPage();
    await other.goto(`${url}/login?login=alice`);
    await other.waitForURL(`${url}/`);
    expect("another signed-in user sees no held messages", (await other.locator("[data-gate]").count()) === 0 && (await other.getByText("Messages your rules kept for you").count()) === 0);

    await incoming.getByRole("button", { name: "Approve", exact: true }).click();
    await page.waitForSelector(".flash:not(.error)");
    const approved = (await page.locator(".flash").textContent()) ?? "";
    expect("approving the incoming card delivers it", approved.startsWith("Delivered alice's question to bob"), approved);
    expect("Bob's inbox now has it", (await cli(m, "bob", ["inbox"])).stdout.includes("Could you maybe look at the flaky e2e job"));
    await shot(page, "gates-approved-incoming");

    const edited = "Thorough: Unai flagged the missing index on notifications.user_id.";
    await page.locator('[data-gate][data-direction="out"] textarea').fill(edited);
    await page.locator('[data-gate][data-direction="out"]').getByRole("button", { name: "Send edited" }).click();
    await page.waitForSelector(".flash:not(.error)");
    const sent = (await page.locator(".flash").textContent()) ?? "";
    expect("sending the edit reports it", sent === "Sent bob's reply to alice, as you edited it.", sent);
    expect("no card is left", (await page.locator("[data-gate]").count()) === 0);
    const wait = await cli(m, "alice", ["wait", q.stdout, "--timeout", "5"]);
    expect("Alice receives the edited text", wait.stdout === `bob: ${edited}`, wait.stdout);
    await shot(page, "gates-after");

    // Dave (no grant entry: actions ask-human) asks Bob's agent to do something beyond answering.
    const act = await cli(m, "dave", ["ask", "bob", "Please create a file DAVE.md in the repo root saying hi, then tell me when the release branch is cut.", "--kind", "request"]);
    for (let i = 0; i < 50 && (await page.reload(), await page.locator("[data-gate]").count()) < 1; i++) await Bun.sleep(100);
    const card = page.locator('[data-gate][data-action="requested"]');
    const cardText = (await card.textContent()) ?? "";
    expect("an action request gets an action card", (await card.count()) === 1, String(await card.count()));
    expect("the card names the action rule and shows the requested action", cardText.includes("asks for an action") && cardText.includes("Requested action") && cardText.includes("create a file DAVE.md") && cardText.includes("ask-human"), cardText);
    expect("the action field is prefilled with the action taken from the message", (await card.locator("input.action").inputValue()) === "create a file DAVE.md in the repo root saying hi", await card.locator("input.action").inputValue());
    const buttons = await card.locator("button").allTextContents();
    expect("its decisions: reject, deliver without the action, allow the action", buttons.join("|") === "Reject|Deliver without the action|Allow the action", buttons.join("|"));
    await shot(page, "gates-card-action", '[data-gate][data-action="requested"]');
    await card.locator("input.action").fill("create DAVE.md in the repo root saying hi");
    await shot(page, "gates-card-action-narrowed", '[data-gate][data-action="requested"]');
    await card.getByRole("button", { name: "Allow the action" }).click();
    await page.waitForSelector(".flash:not(.error)");
    const allowedMsg = (await page.locator(".flash").textContent()) ?? "";
    expect("allowing reports the action", allowedMsg === "Delivered dave's request to bob, with the action you allowed: create DAVE.md in the repo root saying hi.", allowedMsg);
    const inboxJson = (await cli(m, "bob", ["inbox", "--json"])).stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const delivered = inboxJson.find((x) => x.convo === act.stdout);
    expect("Bob's inbox has it with the allowed action", delivered?.allowed_action === "create DAVE.md in the repo root saying hi", JSON.stringify(delivered));
    await shot(page, "gates-after-action");
  } finally {
    await browser.close();
    await stop(m);
  }
  return { ok: checks.every((c) => c.ok), instance: m.id, checks, screenshots, dir: out, jev_requests: jevRequests(m).length, note: "fake Jev (test double)" };
}

if (import.meta.main) {
  const result = await browserGates().catch((err) => ({ ok: false, error: String(err?.stack ?? err) }));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
