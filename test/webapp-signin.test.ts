// Signing in to the web app in a real browser (headless Chromium), with the fake GitHub's pages under another
// site (localhost instead of 127.0.0.1), so the sign-in comes back through a cross-site redirect chain the way
// it does from github.com.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { findChromium } from "../scripts/lib/browser";
import { startWorld, type World } from "./helpers/world";
import { SERVER_MS } from "./helpers/timeouts";

const executablePath = findChromium();
let world: World;
let browser: Browser;
// After the GitHub page: wait until the browser is back on the web app past /auth/done, wherever that is.
const backOn = async (page: Page, web: string) => {
  await page.waitForURL((u) => u.origin === web && u.pathname !== "/auth/done", { timeout: 5000 }).catch(() => {});
  await page.waitForLoadState("networkidle");
};
const signedInAs = async (page: Page) => /Signed in as <b>@([^<]+)<\/b>/.exec(await page.content())?.[1] ?? null;
beforeAll(async () => {
  process.env.PATIO_NO_NOTIFY = "1";
  world = await startWorld({ githubHost: "localhost" });
  if (executablePath) browser = await chromium.launch({ executablePath, headless: true });
}, SERVER_MS);
afterAll(async () => {
  await browser?.close();
  await world.stop();
}, SERVER_MS);

test.skipIf(!executablePath)("the page after a GitHub sign-in is signed in, and a pairing link keeps its code", async () => {
  const g = await world.gatekeeper();
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${g.d.webUrl}/setup?code=ABCD-EFGH`);
  await page.waitForURL(/^http:\/\/localhost:\d+\/login\/oauth\/authorize/);
  await page.getByRole("button", { name: "Sign in as carol" }).click();
  await backOn(page, g.d.webUrl);
  expect(page.url()).toBe(`${g.d.webUrl}/setup?code=ABCD-EFGH`);
  expect(await signedInAs(page)).toBe("carol");
  expect(await page.locator("main").textContent()).toContain("code ABCD-EFGH");
  await g.stop();
}, 30_000);

test.skipIf(!executablePath)("two gatekeepers on one machine keep separate sessions in one browser", async () => {
  const a = await world.gatekeeper();
  const b = await world.gatekeeper();
  const page = await (await browser.newContext()).newPage();
  const signIn = async (web: string, login: string) => {
    await page.goto(web);
    await page.getByRole("link", { name: "Sign in with GitHub" }).click();
    await page.getByRole("button", { name: `Sign in as ${login}` }).click();
    await backOn(page, web);
    expect(page.url()).toBe(`${web}/`);
    expect(await signedInAs(page)).toBe(login);
  };
  await signIn(a.d.webUrl, "alice");
  await signIn(b.d.webUrl, "dave");
  await page.goto(`${a.d.webUrl}/computers`);
  expect(page.url()).toBe(`${a.d.webUrl}/computers`);
  expect(await signedInAs(page)).toBe("alice");
  await page.goto(`${b.d.webUrl}/computers`);
  expect(await signedInAs(page)).toBe("dave");
  await a.stop();
  await b.stop();
}, 30_000);
