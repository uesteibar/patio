// Increment 4: deterministic DLP for the output gate.
import { expect, test } from "bun:test";
import { scan } from "../src/dlp";

const kinds = (text: string) => [...new Set(scan(text).map((f) => f.kind))].sort();

test("finds secrets and tokens", () => {
  for (const text of [
    "the key is AKIAIOSFODNN7EXAMPLE",
    "use ghp_abcdefghijklmnopqrstuvwxyz0123456789 for the API",
    "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----",
    "password: hunter2hunter2",
    "connect with postgres://admin:s3cretpass@db.internal:5432/app",
    "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    "slack xoxb-1234567890-abcdefghij",
  ])
    expect(kinds(text), text).toContain("secret");
});

test("finds absolute local paths, including the Markdown link a live Codex run leaked", () => {
  for (const text of [
    "See [release.md](/home/devbox/code/sandbox-repo/docs/release.md) for details.",
    "It lives in /Users/jorge/code/orbit/.env",
    "check ~/notes/salary.txt",
    "open file:///home/bob/report.pdf",
    "logs are in /var/log/patio/daemon.log",
    "C:\\Users\\jorge\\Documents\\taxes.xlsx",
    "under /tmp/patio-123/inbox.db",
  ])
    expect(kinds(text), text).toEqual(["path"]);
});

test("finds email addresses and phone numbers", () => {
  expect(kinds("write to jorge.perez@example.com")).toEqual(["personal"]);
  expect(kinds("call me on +34 612 345 678")).toEqual(["personal"]);
  expect(kinds("call (415) 555-0132 after lunch")).toEqual(["personal"]);
});

test("ordinary technical replies are clean", () => {
  for (const text of [
    "PR 812 only adds an index on notifications.user_id; see migration 0042.",
    "The endpoint is GET /api/v1/users/:id and it returns 404 when missing.",
    "Merged on 2026-11-08 at 14:05, build 1731081600 is green.",
    "Look at src/daemon.ts and docs/poc/plan.md in the repo.",
    "https://github.com/ppazosp/patio/pull/812 is ready; the token budget is fine.",
    "Version 1.4.4 of Bun, 3 of 10 runs used.",
  ])
    expect(scan(text), text).toEqual([]);
});

test("a finding names what it found but never carries a secret in full", () => {
  const [f] = scan("use ghp_abcdefghijklmnopqrstuvwxyz0123456789 now");
  expect(f!.kind).toBe("secret");
  expect(f!.what).toBe("GitHub token");
  expect(f!.sample).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
});

// Security audit S4: zero-width, format and compatibility characters must not split a secret or a path apart.
test("secrets and paths hidden with zero-width or fullwidth characters are still found", () => {
  for (const text of [
    "OPENAI_API_KEY=sk-\u200bproj-abcdefghijklmnopqrstuvwxyz123456", // zero-width space
    "the key is AKIA\u2060IOSFODNN7EXAMPLE", // word joiner
    "use ghp_abc\u200ddefghijklmnopqrstuvwxyz0123456789", // zero-width joiner
    "\u202etoken xoxb-1234567890-abcdefghij", // right-to-left override
    "password: hunter2\u00adhunter2", // soft hyphen
    "ＯＰＥＮＡＩ_ＡＰＩ_ＫＥＹ＝ｓｋ-ｐｒｏｊ-ａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ１２３４５６", // fullwidth
  ])
    expect(kinds(text), JSON.stringify(text)).toContain("secret");
  for (const text of ["It lives in /Users\u200b/jorge/code/orbit/.env", "check ~\u2060/notes/salary.txt", "see ／home／devbox／code／x.md".replaceAll("／", "/\u200b")])
    expect(kinds(text), JSON.stringify(text)).toContain("path");
  expect(kinds("write to jorge\u200b.perez@example\u200b.com")).toEqual(["personal"]);
});

test("normalization does not create findings in clean text", () => {
  expect(scan("naïve café résumé — fine")).toEqual([]);
  expect(scan("PR 812 only adds an index\u200b on notifications.user_id")).toEqual([]);
});
