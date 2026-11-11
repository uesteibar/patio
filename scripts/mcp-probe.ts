// just mcp-probe <id> <agent>: starts `patio mcp` as that agent and talks to it with the generic MCP SDK
// client (no specific coding agent): lists the tools, checks the expected ones are there, and calls `who`, `status`
// (read-only: running, connected, what waits for the owner) and `inbox`. Then another agent of the instance sends it a request through the CLI, and the client finds it with
// `inbox`, closes it with `dismiss`, and sees it dismissed; and sends it a question, which the client declines
// with `reject` and a reason, and the sender gets the rejection with that reason. Prints JSON; exit 0 only when
// all of that works.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cliCommand, readManifest, type Manifest } from "./lib/instance";

const EXPECTED_TOOLS = ["ask", "channels", "dismiss", "guide", "inbox", "join_channel", "join_workspace", "leave_channel", "read", "reject", "reply", "status", "wait_for_reply", "who", "whoami"];
// Approval is for humans in the web app only, and an agent must not start other agents (answer, watch are CLI only).
const FORBIDDEN_TOOLS = /approv|decide|pair|invite|revoke|answer|watch|claim/;

export async function probe(m: Manifest, agent: string) {
  const { cmd, env, cwd } = cliCommand(m, agent, ["mcp"]);
  const transport = new StdioClientTransport({ command: cmd[0]!, args: cmd.slice(1), env, cwd, stderr: "pipe" });
  const client = new Client({ name: "patio-mcp-probe", version: "0.1.0" });
  const started = Date.now();
  try {
    await client.connect(transport);
    const server = client.getServerVersion();
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    const who = await client.callTool({ name: "who", arguments: {} });
    const text = (who.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("");
    let online: unknown = null;
    try {
      online = JSON.parse(text);
    } catch {}
    const statusRes = await client.callTool({ name: "status", arguments: {} });
    let status: { running?: boolean; connected?: boolean; waiting_for_owner?: unknown } | null = null;
    try {
      status = JSON.parse(textOf(statusRes));
    } catch {}
    const inbox = await client.callTool({ name: "inbox", arguments: { unread_only: false } });
    const inboxText = (inbox.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("");
    const missing = EXPECTED_TOOLS.filter((t) => !tools.includes(t));
    const forbidden = tools.filter((t) => FORBIDDEN_TOOLS.test(t));
    const dismiss = await probeDismiss(m, agent, client);
    const reject = await probeReject(m, agent, client);
    const ok =
      !who.isError &&
      Array.isArray(online) &&
      online.some((o: { agent?: string }) => o.agent === agent) &&
      status?.running === true &&
      status.connected === true &&
      !!status.waiting_for_owner &&
      !inbox.isError &&
      !missing.length &&
      !forbidden.length &&
      dismiss.ok &&
      reject.ok;
    return {
      ok,
      instance: m.id,
      agent,
      server,
      tools,
      missing_tools: missing,
      forbidden_tools: forbidden,
      who: { isError: !!who.isError, text, online },
      status,
      inbox: { isError: !!inbox.isError, text: inboxText },
      dismiss,
      reject,
      ms: Date.now() - started,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

const textOf = (r: unknown) => (((r as { content?: unknown }).content ?? []) as Array<{ text?: string }>).map((c) => c.text ?? "").join("");

// Another agent of the instance sends `agent` a request (one of the default kinds); the MCP client dismisses it and checks its state.
async function probeDismiss(m: Manifest, agent: string, client: Client) {
  const peer = Object.keys(m.agents).find((a) => a !== agent);
  if (!peer) return { ok: false, error: "the instance needs a second agent to send a message to dismiss" };
  const marker = `mcp-probe request ${crypto.randomUUID().slice(0, 8)}`;
  const { cmd, env, cwd } = cliCommand(m, peer, ["ask", agent, marker, "--kind", "request"]);
  const sent = Bun.spawnSync(cmd, { env, cwd });
  if (sent.exitCode !== 0) return { ok: false, error: `${peer} could not send: ${sent.stderr.toString().trim()}` };
  let id: string | undefined;
  for (let i = 0; i < 50 && !id; i++) {
    const listed = textOf(await client.callTool({ name: "inbox", arguments: { unread_only: true } }));
    id = listed.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)).find((x) => x.preview === marker)?.id;
    if (!id) await Bun.sleep(100);
  }
  if (!id) return { ok: false, error: "the request never showed up in inbox" };
  const res = await client.callTool({ name: "dismiss", arguments: { id } });
  const closed = textOf(await client.callTool({ name: "inbox", arguments: { include_closed: true } }));
  const state = closed.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)).find((x) => x.id === id)?.state;
  const open = textOf(await client.callTool({ name: "inbox", arguments: {} }));
  return { ok: !res.isError && state === "dismissed" && !open.includes(id), from: peer, id, result: textOf(res), state_after: state };
}

// Another agent asks `agent` a question; the MCP client declines it with `reject` and a reason; the sender's
// `wait` gets "declined by the recipient" with that reason.
async function probeReject(m: Manifest, agent: string, client: Client) {
  const peer = Object.keys(m.agents).find((a) => a !== agent);
  if (!peer) return { ok: false, error: "the instance needs a second agent" };
  const marker = `mcp-probe question ${crypto.randomUUID().slice(0, 8)}`;
  const ask = cliCommand(m, peer, ["ask", agent, marker]);
  const sent = Bun.spawnSync(ask.cmd, { env: ask.env, cwd: ask.cwd });
  if (sent.exitCode !== 0) return { ok: false, error: `${peer} could not send: ${sent.stderr.toString().trim()}` };
  const convo = sent.stdout.toString().trim();
  let id: string | undefined;
  for (let i = 0; i < 50 && !id; i++) {
    const listed = textOf(await client.callTool({ name: "inbox", arguments: { unread_only: true } }));
    id = listed.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)).find((x) => x.preview === marker)?.id;
    if (!id) await Bun.sleep(100);
  }
  if (!id) return { ok: false, error: "the question never showed up in inbox" };
  const reason = "Not my area; ask carol.";
  const res = await client.callTool({ name: "reject", arguments: { id, reason } });
  const again = await client.callTool({ name: "reject", arguments: { id } });
  const wait = cliCommand(m, peer, ["wait", convo, "--timeout", "5"]);
  const got = Bun.spawnSync(wait.cmd, { env: wait.env, cwd: wait.cwd }).stdout.toString().trim();
  const expected = `${agent}: ${agent} declined your message: declined by the recipient. Reason: ${reason}`;
  return { ok: !res.isError && !!again.isError && textOf(again).startsWith("already_rejected") && got === expected, from: peer, id, result: textOf(res), again: textOf(again), sender_got: got };
}

if (import.meta.main) {
  const [id, agent] = process.argv.slice(2);
  if (!id || !agent) {
    console.error("usage: just mcp-probe <id> <agent>");
    process.exit(1);
  }
  const result = await probe(await readManifest(id), agent).catch((err) => ({ ok: false, instance: id, agent, error: String(err?.message ?? err) }));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
