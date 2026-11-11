// Scenario runner: a fresh instance, scripted steps through real patio CLI processes, checked
// expectations and a transcript (transcript.md + result.json) in the instance root.
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { readdirSync } from "node:fs";
import { advanceClock, cliCommand, FAKE_JEV_KEY, jevRequests, restartExchange, startAgent, startExchange, stop, stopAgent, stopExchange, up, type AgentSpec, type Manifest } from "./instance";
import { WebClient } from "./webclient";
import type { FakeJevFixture } from "../../test/fakes/fake-jev";

export type Label = "deterministic" | "live";

export type CliResult = { agent: string; args: string[]; code: number; stdout: string; stderr: string; ms: number };

export type Check = { name: string; ok: boolean; detail?: string };

export type Scenario = {
  name: string;
  description: string;
  label: Label;
  // An agentConfig function gets the agent's directory; its parent is the instance root.
  agents: () => AgentSpec[];
  // The fixture of the instance's fake Jev (default: everything benign). null: no Jev at all, so every
  // gatekeeper fails closed. The real key never reaches a deterministic instance.
  jev?: FakeJevFixture | null;
  // The exchange judges with the instance's fake Jev too, for agents without a key of their own (judge.ts).
  serverJudge?: boolean;
  run: (t: Transcript) => Promise<void>;
};

export { FAKE_JEV_KEY };

// A random marker to embed in a message's text and context, so a scan for plaintext cannot match by chance.
export const plaintextMarker = (label = "PT") => `${label}-${Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("hex")}`;

export class Transcript {
  readonly lines: string[] = [];
  readonly checks: Check[] = [];
  readonly calls: CliResult[] = [];
  constructor(readonly m: Manifest) {}

  // The instance's fake Jev and every request it has received so far.
  get jev() {
    const m = this.m;
    return m.jev ? { url: m.jev.url, get requests() { return jevRequests(m); } } : null;
  }

  note(text: string) {
    this.lines.push(text, "");
  }

  // Runs the real patio CLI as `agent`, records it and returns the result. `env` is extra environment.
  async cli(agent: string, args: string[], timeoutMs = 120_000, env: Record<string, string> = {}): Promise<CliResult> {
    return this.start(agent, args, timeoutMs, env).result;
  }

  // Starts the real patio CLI as `agent` in its own process group, so a scenario can kill it (and any agent it
  // started) mid-way, as a crash would. The result is recorded when the process ends.
  start(agent: string, args: string[], timeoutMs = 120_000, env: Record<string, string> = {}) {
    const { cmd, env: fullEnv, cwd } = cliCommand(this.m, agent, args, env);
    const started = Date.now();
    const proc = Bun.spawn(cmd, { env: fullEnv, cwd, stdout: "pipe", stderr: "pipe", timeout: timeoutMs, detached: true });
    const result = (async () => {
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      return this.record({ agent, args, code: await proc.exited, stdout: stdout.trim(), stderr: stderr.trim(), ms: Date.now() - started });
    })();
    const kill = () => {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {}
    };
    return { proc, result, kill };
  }

  // Runs the real patio CLI in a pseudo-terminal, as a person typing in their own terminal (stdin and stdout are TTYs).
  // `cmd` comes from cliCommand, or is built by the scenario for a home outside the manifest. `onLine` sees each line.
  async tty(label: string, run: { cmd: string[]; env: Record<string, string>; cwd: string }, onLine?: (line: string) => Promise<void> | void, timeoutMs = 60_000): Promise<CliResult> {
    const started = Date.now();
    let out = "";
    let pending = "";
    const lines: Promise<void>[] = [];
    const proc = Bun.spawn(run.cmd, {
      env: { ...run.env, TERM: "dumb" },
      cwd: run.cwd,
      timeout: timeoutMs,
      terminal: {
        cols: 200,
        rows: 50,
        data: (_t, data) => {
          const text = new TextDecoder().decode(data).replace(/\r/g, "");
          out += text;
          pending += text;
          const parts = pending.split("\n");
          pending = parts.pop()!;
          for (const line of parts) if (line.trim()) lines.push(Promise.resolve(onLine?.(line)));
        },
      },
    });
    const code = await proc.exited;
    await Bun.sleep(50);
    await Promise.all(lines);
    proc.terminal?.close();
    // In a terminal stdout and stderr are one stream: both are in `stdout`.
    return this.record({ agent: label, args: [...run.cmd.slice(2), "(in a terminal)"], code, stdout: out.trim(), stderr: "", ms: Date.now() - started });
  }

  private record(res: CliResult): CliResult {
    this.calls.push(res);
    this.lines.push(
      `### ${res.agent}$ patio ${res.args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`,
      "",
      `exit ${res.code} in ${res.ms} ms`,
      "",
      "```text",
      ...(res.stdout ? [`stdout: ${res.stdout}`] : []),
      ...(res.stderr ? [`stderr: ${res.stderr}`] : []),
      "```",
      "",
    );
    return res;
  }

  // The responder audit from what `patio answer` (or `watch --answer`) wrote to stderr: session mode, tool
  // calls and permission answers. The agent runs in that CLI process, never in the gatekeeper.
  audit(agent: string, stderr: string): { mode: string[]; tools: string[]; permissions: string[] } {
    const lines = stderr.split("\n");
    const agentLines = lines.map((l) => /\[agent\] (.*)$/.exec(l)?.[1]).filter((l): l is string => !!l);
    const audit = {
      mode: agentLines.filter((l) => l.startsWith("mode") || l.startsWith("WARNING: mode")),
      tools: agentLines.filter((l) => l.startsWith("tool ")),
      permissions: agentLines.filter((l) => l.startsWith("permission ")),
    };
    this.lines.push(
      `### ${agent}'s responder audit (stderr of patio answer)`,
      "",
      "```text",
      ...(audit.mode.length ? audit.mode : ["(no mode line)"]),
      ...(audit.tools.length ? audit.tools : ["(no tool calls)"]),
      ...audit.permissions,
      "```",
      "",
    );
    return audit;
  }

  private webs = new Map<string, WebClient>();

  // The owner of `handle`, signed in to the web app of that agent's gatekeeper (as `login` if given).
  async web(handle: string, login?: string): Promise<WebClient> {
    const entry = this.m.agents[handle];
    if (!entry) throw new Error(`no agent ${handle}`);
    const key = `${handle}:${login ?? entry.login}:${entry.web_url}`;
    let web = this.webs.get(key);
    if (!web) {
      web = new WebClient(entry.web_url);
      await web.signIn(login ?? entry.login);
      this.webs.set(key, web);
      this.note(`**@${login ?? entry.login} signs in with GitHub** in the web app of ${handle}'s gatekeeper (${entry.web_url}).`);
    }
    return web;
  }

  // A form submitted in the web app, recorded with the app's answer.
  async webPost(handle: string, path: string, fields: Record<string, string>, login?: string) {
    const web = await this.web(handle, login);
    const res = await web.post(path, fields);
    const shown = Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(" ");
    this.lines.push(
      `### @${login ?? this.m.agents[handle]!.login} (web app) POST ${path} ${shown}`,
      "",
      "```text",
      res.ok ? `ok: ${res.ok}` : res.error ? `error: ${res.error}` : `HTTP ${res.res.status}`,
      "```",
      "",
    );
    return res;
  }

  // A page of the web app, as text with tags stripped (for checks) and the raw HTML.
  async webGet(handle: string, path: string, login?: string) {
    const web = await this.web(handle, login);
    const html = await (await web.get(path)).text();
    const text = html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/\s+/g, " ").trim();
    return { html, text };
  }

  // The gate decisions in an agent's audit log ($PATIO_HOME/audit.jsonl), recorded in the transcript.
  gateLog(agent: string, record = true): Record<string, any>[] {
    const file = join(this.m.agents[agent]!.home, "audit.jsonl");
    const lines = existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : [];
    if (record) this.lines.push(`### ${agent}'s gate audit log (audit.jsonl)`, "", "```json", ...(lines.length ? lines : ["(empty)"]), "```", "");
    // Gate decisions only: the owner turning a rule on (direction "config") is not one.
    return lines.map((l) => JSON.parse(l)).filter((e) => e.direction !== "config");
  }

  // The ids of the messages held on an agent's approval page, oldest first, with each card's text.
  async held(agent: string): Promise<{ id: string; direction: string; text: string }[]> {
    const { html } = await this.webGet(agent, "/");
    const cards = [...html.matchAll(/<div class="gate" data-gate="([^"]+)" data-direction="(in|out)"[^>]*>([\s\S]*?)<\/form><\/div>/g)].map((m) => ({
      id: m[1]!,
      direction: m[2]!,
      text: m[3]!.replace(/<[^>]+>/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/\s+/g, " ").trim(),
    }));
    this.lines.push(`### ${agent}'s held messages (web app, Approvals)`, "", "```text", ...(cards.length ? cards.map((c) => `[${c.direction}] ${c.id}: ${c.text}`) : ["(none)"]), "```", "");
    return cards;
  }

  async stopAgent(handle: string) {
    await stopAgent(this.m, handle);
    this.note(`**${handle}'s gatekeeper stopped** (home, keys and inbox kept).`);
  }

  async startAgent(handle: string, env?: Record<string, string>, opts: { connected?: boolean } = {}) {
    await startAgent(this.m, handle, env, opts);
    this.note(`**${handle}'s gatekeeper started** again on the same home${env?.PATIO_WEB_PORT ? `, its web app on the same port (${env.PATIO_WEB_PORT})` : ""}${opts.connected === false ? " (the exchange is down: it does not connect)" : ""}.`);
  }

  async stopExchange() {
    await stopExchange(this.m);
    this.note("**Exchange stopped** (an outage).");
  }

  async startExchange() {
    await startExchange(this.m);
    this.note(`**Exchange started** again on port ${this.m.exchange.port} with the same database; running gatekeepers reconnected.`);
  }

  // Moves every process's clock forward (hold timeouts, message TTLs), then gives the sweepers a moment.
  async advanceClock(ms: number, label: string) {
    await advanceClock(this.m, ms);
    this.note(`**The instance clock moves forward ${label}** (test clock; nothing sleeps).`);
    await Bun.sleep(700);
  }

  async restartExchange() {
    await restartExchange(this.m);
    this.note(`**Exchange restarted** on port ${this.m.exchange.port} with the same database; running gatekeepers reconnected.`);
  }

  // Reads every file of the exchange's SQLite database (main file, WAL, shared memory) and checks that none
  // of the given strings appears. Returns the strings that were found. Probes must be distinctive markers
  // (plaintextMarker()): a short string such as "812" turns up by chance in hex ids and ciphertext.
  scanExchangeDb(plaintexts: string[]): string[] {
    const short = plaintexts.filter((p) => p.length < 16);
    if (short.length) throw new Error(`plaintext probes must be distinctive markers of 16+ characters, not ${short.map((p) => JSON.stringify(p)).join(", ")}`);
    const dir = dirname(this.m.exchange.db);
    const base = basename(this.m.exchange.db);
    const files = readdirSync(dir).filter((f) => f.startsWith(base));
    const bytes = Buffer.concat(files.map((f) => readFileSync(join(dir, f))));
    const found = plaintexts.filter((p) => bytes.includes(p));
    this.note(`Scanned ${files.join(", ")} (${bytes.length} bytes) for ${plaintexts.length} plaintext strings: ${found.length ? `FOUND ${found.join(", ")}` : "none found"}.`);
    return found;
  }

  expect(name: string, ok: boolean, detail?: string) {
    this.checks.push({ name, ok, detail });
    this.lines.push(`- [${ok ? "x" : " "}] ${name}${detail ? ` (${detail})` : ""}`, "");
  }

  get ok() {
    return this.checks.length > 0 && this.checks.every((c) => c.ok);
  }
}

const tail = (file: string, n = 60) =>
  existsSync(file) ? readFileSync(file, "utf8").trimEnd().split("\n").slice(-n).join("\n") : "(no log)";

export type ScenarioResult = {
  scenario: string;
  label: Label;
  ok: boolean;
  instance: string;
  transcript: string;
  checks: Check[];
  ms: number;
  error?: string;
};

export async function runScenario(s: Scenario, opts: { instancesDir?: string; keep?: boolean } = {}): Promise<ScenarioResult> {
  const started = Date.now();
  let m: Manifest | undefined;
  let t: Transcript | undefined;
  let error: string | undefined;
  try {
    m = await up(s.agents(), { instancesDir: opts.instancesDir, jev: s.jev, serverJudge: s.serverJudge });
    t = new Transcript(m);
    await s.run(t);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    if (m && !opts.keep) await stop(m);
  }

  const ok = !error && !!t?.ok;
  const transcript = m ? join(m.root, "transcript.md") : "";
  if (m) {
    const doc = [
      `# Scenario ${s.name} (${s.label}): ${ok ? "PASS" : "FAIL"}`,
      "",
      s.description,
      "",
      `Instance \`${m.id}\`, revision \`${m.revision.slice(0, 12)}\`${m.dirty ? " (dirty)" : ""}, exchange ${m.exchange.url}, ${Date.now() - started} ms.`,
      "",
      ...(m.jev ? [`Jev: the fake Jev (test double, not live evidence) at ${m.jev.url}; ${jevRequests(m).length} request(s).`, ""] : ["Jev: none in this instance.", ""]),
      ...(error ? [`**Error:** ${error}`, ""] : []),
      "## Steps",
      "",
      ...(t?.lines ?? []),
      "## Logs",
      "",
      ...[["exchange", m.exchange.log] as const, ...Object.values(m.agents).map((a) => [`${a.handle} daemon`, a.log] as const)].flatMap(
        ([name, file]) => [`### ${name}`, "", "```text", tail(file), "```", ""],
      ),
    ].join("\n");
    await writeFile(transcript, doc);
  }
  const result: ScenarioResult = {
    scenario: s.name,
    label: s.label,
    ok,
    instance: m?.id ?? "",
    transcript,
    checks: t?.checks ?? [],
    ms: Date.now() - started,
    ...(error ? { error } : {}),
  };
  if (m) await writeFile(join(m.root, "result.json"), JSON.stringify(result, null, 2) + "\n");
  return result;
}
