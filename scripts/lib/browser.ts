// Finds a Chromium for Playwright. The host's Chromium is used; no browser download happens here.
import { existsSync } from "node:fs";

const CANDIDATES = ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome"];

export function findChromium(env = process.env): string | null {
  if (env.PATIO_CHROMIUM) return existsSync(env.PATIO_CHROMIUM) ? env.PATIO_CHROMIUM : null;
  for (const name of CANDIDATES) {
    const found = Bun.which(name);
    if (found) return found;
  }
  return null;
}
