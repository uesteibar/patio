// Deterministic data-loss checks for the output gate: secrets and tokens, absolute local paths, and personal
// data (email addresses and phone numbers). Pattern-based on purpose: these never depend on a model, and a
// match is reported, never silently rewritten. A finding carries a short redacted sample, never a whole secret.

export type FindingKind = "secret" | "path" | "personal";
export type Finding = { kind: FindingKind; what: string; sample: string };

type Pattern = { kind: FindingKind; what: string; re: RegExp };

// Not preceded by something that makes it part of a URL, a relative path or a word.
const START = String.raw`(?<![\w.~/:-])`;

const PATTERNS: Pattern[] = [
  { kind: "secret", what: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { kind: "secret", what: "AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "secret", what: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g },
  { kind: "secret", what: "API key", re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g },
  { kind: "secret", what: "Slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: "secret", what: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "secret", what: "Stripe key", re: /\b[rs]k_(?:live|test)_[0-9A-Za-z]{16,}/g },
  { kind: "secret", what: "JSON web token", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { kind: "secret", what: "credentials in a URL", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi },
  {
    kind: "secret",
    what: "assigned secret",
    re: /\b(?:api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key|client[_-]?secret)\b["']?\s*[:=]\s*["']?[^\s"',;]{8,}/gi,
  },
  { kind: "path", what: "file URL", re: /\bfile:\/\/\S+/g },
  { kind: "path", what: "local path", re: new RegExp(`${START}(?:/(?:home|Users|root|tmp|var|etc|private|opt|mnt|srv|Volumes)/[^\\s)\\]>"'\`]+)`, "g") },
  { kind: "path", what: "home-relative path", re: new RegExp(`${START}~/[^\\s)\\]>"'\`]+`, "g") },
  { kind: "path", what: "Windows path", re: /\b[A-Z]:\\[^\s)\]>"'`]+/g },
  { kind: "personal", what: "email address", re: /\b[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g },
  { kind: "personal", what: "phone number", re: /(?<![\w+])(?:\+\d{1,3}[ .-]?\d(?:[ .-]?\d){7,12}|\(?\b\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b)/g },
];

const redact = (kind: FindingKind, match: string) => (kind === "secret" ? `${match.slice(0, 4)}…(${match.length} chars)` : match.length > 80 ? match.slice(0, 79) + "…" : match);

// Zero-width and other format characters (zero-width space and joiners, word joiner, soft hyphen, bidi controls, the
// BOM) and compatibility forms (fullwidth letters) are invisible or look the same to a reader, and would split a
// token or a path so no pattern matches. They are removed and folded before scanning (security audit S4).
export const normalize = (text: string) => text.normalize("NFKC").replace(/\p{Cf}/gu, "");

export function scan(raw: string): Finding[] {
  const text = normalize(raw);
  const found: Finding[] = [];
  const taken: [number, number][] = [];
  for (const p of PATTERNS) {
    for (const m of text.matchAll(p.re)) {
      const start = m.index!;
      const end = start + m[0].length;
      // A credentials URL is not also an email address, a file URL not also a local path.
      if (taken.some(([s, e]) => start < e && end > s)) continue;
      taken.push([start, end]);
      found.push({ kind: p.kind, what: p.what, sample: redact(p.kind, m[0]) });
    }
  }
  return found;
}
