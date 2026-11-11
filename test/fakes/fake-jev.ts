#!/usr/bin/env bun
// A fake of TypeSafe `POST /v1/systemone` (Jev), for deterministic tests. It is a local HTTP server
// that matches the documented request and response shape closely enough for @typesafe-ai/sdk, which
// takes a `baseURL`, so the real SDK can talk to it unchanged:
//
//   const fake = startFakeJev({ answers: { injection: { type: "noul", noul: 0.9 } } });
//   const client = new TypeSafeClient({ apiKey: "k", baseURL: fake.url, retry: { maxRetries: 0 } });
//
// Fixture: `answers` maps a question id to an answer, or to a list of conditional answers
// `[{ stateMatches?: "regex", answer }]` of which the first whose regex matches the request state
// (JSON-serialised) wins. An answer is the API's own shape: `{type:"noul",noul}`,
// `{type:"choice",choice,confidence?,probabilities?}`, `{type:"score",score,confidence?}`.
// A question without a fixture answer gets a 400 that names it, so a test cannot pass by accident, unless the
// fixture sets `default` (an answer for any question without its own entry): instances use that for the
// gates' prompt-injection check, which runs on every message.
//
// As a process: `fake-jev.ts --fixture f.json [--log requests.jsonl] [--api-key k] [--port n]` prints
// "fake Jev listening on <url>" and appends each accepted request body to the log as one JSON line.
// Not implemented: image assets (multipart requests get a 400).
import { gunzipSync } from "node:zlib";

type Json = unknown;
export type FakeAnswer = { type: "noul"; noul: number } | { type: "choice"; choice: string; confidence?: number; probabilities?: Record<string, number> } | { type: "score"; score: number; confidence?: number; probabilities?: Record<string, number> };
export type Conditional = { stateMatches?: string; answer: FakeAnswer };

export type FakeJevFixture = {
  model?: string;
  latencyMs?: number;
  answers: Record<string, FakeAnswer | Conditional[]>;
  default?: FakeAnswer | Conditional[];
};

export type FakeJevOptions = { apiKey?: string; port?: number; onRequest?: (body: unknown) => void };
export type RecordedRequest = { path: string; authorization: string | null; body: any };

const error = (status: number, message: string) => Response.json({ error: { message } }, { status });

function pick(entry: FakeAnswer | Conditional[], stateText: string): FakeAnswer | undefined {
  if (!Array.isArray(entry)) return entry;
  return entry.find((c) => !c.stateMatches || new RegExp(c.stateMatches, "i").test(stateText))?.answer;
}

// Turns a fixture answer into the response shape for the question that was asked, or explains why not.
function shape(name: string, q: any, a: FakeAnswer): { ok: Json } | { problem: string } {
  if (a.type !== q.type) return { problem: `fixture answer for "${name}" is ${a.type}, the question is ${q.type}` };
  if (a.type === "noul") return { ok: { type: "noul", noul: a.noul } };
  const labels: string[] = a.type === "choice" ? Object.keys(q.criteria ?? {}) : (q.criteria ?? []).map((_: unknown, i: number) => String(i));
  if (a.type === "choice") {
    if (!labels.includes(a.choice)) return { problem: `fixture choice "${a.choice}" for "${name}" is not one of ${labels.join(", ")}` };
    const rest = (1 - (a.confidence ?? 0.9)) / Math.max(1, labels.length - 1);
    const probabilities = a.probabilities ?? Object.fromEntries(labels.map((l) => [l, l === a.choice ? (a.confidence ?? 0.9) : rest]));
    return { ok: { type: "choice", choice: a.choice, confidence: a.confidence ?? 0.9, probabilities } };
  }
  const probabilities = a.probabilities ?? Object.fromEntries(labels.map((l) => [l, l === String(Math.round(a.score)) ? 1 : 0]));
  const legend = Object.fromEntries((q.criteria ?? []).map((c: Json, i: number) => [String(i), c]));
  return { ok: { type: "score", score: a.score, confidence: a.confidence ?? 0.9, legend, probabilities } };
}

async function readJson(req: Request): Promise<{ body: any } | { problem: string }> {
  if ((req.headers.get("content-type") ?? "").startsWith("multipart/")) return { problem: "fake Jev does not implement image assets" };
  const encoding = req.headers.get("content-encoding");
  let bytes: Uint8Array = new Uint8Array(await req.arrayBuffer());
  try {
    if (encoding === "zstd") bytes = Bun.zstdDecompressSync(bytes);
    else if (encoding === "gzip") bytes = gunzipSync(bytes);
    else if (encoding) return { problem: `unsupported content-encoding ${encoding}` };
    return { body: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { problem: "request body is not valid JSON" };
  }
}

export function startFakeJev(fixture: FakeJevFixture, opts: FakeJevOptions = {}) {
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path !== "/v1/systemone") return error(404, `no route ${req.method} ${path}`);
      if (req.method !== "POST") return error(405, "use POST");
      // Read the body before anything else: answering a request that is still being sent resets the connection.
      const parsed = await readJson(req);
      const authorization = req.headers.get("authorization");
      if (!authorization?.startsWith("Bearer ") || (opts.apiKey && authorization !== `Bearer ${opts.apiKey}`))
        return error(401, "invalid or missing API key");

      if ("problem" in parsed) return error(400, parsed.problem);
      const { body } = parsed;
      requests.push({ path, authorization, body });
      opts.onRequest?.(body);

      if (typeof body?.model !== "string" || !body.model) return error(400, "model is required");
      if (body.state === undefined || body.state === null) return error(400, "state is required");
      const questions = body.questions;
      if (typeof questions !== "object" || questions === null || Array.isArray(questions) || !Object.keys(questions).length)
        return error(400, "questions must be a non-empty object");

      const stateText = JSON.stringify(body.state);
      const answers: Record<string, Json> = {};
      for (const [name, q] of Object.entries<any>(questions)) {
        if (!["noul", "choice", "score", "box"].includes(q?.type)) return error(400, `question "${name}" has unknown type ${q?.type}`);
        if (q.type === "box") return error(400, "fake Jev does not implement box questions");
        if ((q.type === "choice" || q.type === "score") && !q.criteria) return error(400, `question "${name}" needs criteria`);
        const entry = fixture.answers[name] ?? fixture.default;
        const answer = entry && pick(entry, stateText);
        if (!answer) return error(400, `fake Jev has no fixture answer for question "${name}"`);
        const shaped = shape(name, q, answer);
        if ("problem" in shaped) return error(400, shaped.problem);
        answers[name] = shaped.ok;
      }

      if (fixture.latencyMs) await Bun.sleep(fixture.latencyMs);
      const inputTokens = Math.ceil((stateText.length + JSON.stringify(questions).length) / 4);
      return Response.json(
        { model: fixture.model ?? body.model, answers, usage: { input_tokens: inputTokens, output_tokens: Object.keys(answers).length } },
        { headers: { "x-typesafe-request-id": `fake-${requests.length}` } },
      );
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) };
}

if (import.meta.main) {
  const { appendFileSync } = await import("node:fs");
  const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
  const file = arg("--fixture");
  if (!file) throw new Error("usage: fake-jev.ts --fixture fixture.json [--log requests.jsonl] [--api-key k] [--port n]");
  const log = arg("--log");
  const fake = startFakeJev(JSON.parse(await Bun.file(file).text()), {
    apiKey: arg("--api-key"),
    port: Number(arg("--port") ?? 0),
    onRequest: log ? (body) => appendFileSync(log, JSON.stringify(body) + "\n") : undefined,
  });
  console.log(`fake Jev listening on ${fake.url}`);
}
