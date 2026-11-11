// patio's version: package.json's, with the git revision a build stamps in (scripts/build.ts, PATIO_BUILD_REV).
import pkg from "../package.json" with { type: "json" };

declare const PATIO_BUILD_REV: string | undefined;
const rev = typeof PATIO_BUILD_REV === "string" ? PATIO_BUILD_REV : null;

export const VERSION = `${pkg.version}${rev ? ` (${rev})` : ""}`;
