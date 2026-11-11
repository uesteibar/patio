// just browser-check: headless Chromium through Playwright loads a local page (served by Bun on a free
// port) and saves a screenshot under .verify/browser/. Proves readiness for the later web app.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { findChromium } from "./lib/browser";
import { VERIFY_DIR } from "./lib/paths";

const PAGE = `<!doctype html><html><head><title>patio browser check</title></head>
<body style="font-family: sans-serif; padding: 2rem">
<h1 id="title">patio browser check</h1>
<p id="status">waiting for script</p>
<script>document.getElementById("status").textContent = "script ran at " + new Date().toISOString();</script>
</body></html>`;

export async function browserCheck(outDir = join(VERIFY_DIR, "browser")) {
  const executablePath = findChromium();
  if (!executablePath) return { ok: false, error: "no Chromium found (set PATIO_CHROMIUM)" };
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(PAGE, { headers: { "content-type": "text/html" } }) });
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 400 } });
    const url = `http://127.0.0.1:${server.port}/`;
    await page.goto(url);
    const title = await page.title();
    const status = await page.locator("#status").textContent();
    await mkdir(outDir, { recursive: true });
    const screenshot = join(outDir, `browser-check-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
    await page.screenshot({ path: screenshot });
    const ok = title === "patio browser check" && !!status?.startsWith("script ran");
    return { ok, url, title, status, screenshot, chromium: executablePath, browser_version: browser.version() };
  } finally {
    await browser.close();
    server.stop(true);
  }
}

if (import.meta.main) {
  const result = await browserCheck().catch((err) => ({ ok: false, error: String(err?.message ?? err) }));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
