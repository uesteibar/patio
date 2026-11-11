// Increment 12: joining by prompt. `patio join <link>` is the one setup command: it starts patio, writes the agent's
// file, signs the person in and confirms the computer, puts the agent in the workspace and its default channels, and
// converges when run again. Started by an agent (no terminal), it needs one confirmation screen; from the person's
// own terminal, only the GitHub sign-in. A later agent of a signed-in person waits for one card.
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { assertSafeHome, cliCommand, FAKE_JEV_KEY, inherited, procStart } from "../lib/instance";
import { PATIO_CLI, REPO } from "../lib/paths";
import type { Scenario, Transcript } from "../lib/scenario";
import { WebClient } from "../lib/webclient";
import { until } from "./inbox";

// Alice, an admin of `team`, makes #general a default channel and creates a link in her terminal.
async function teamLink(t: Transcript) {
  const ws = t.m.workspaces.team!;
  await t.webPost("alice", `/channels/${ws.channels!.general!}/default`, { default: "1", back: `/workspaces/${ws.id}` });
  const r = await t.tty("alice", cliCommand(t.m, "alice", ["invite", "--workspace", "team", "--expires", "7d"]));
  return /(http:\/\/127\.0\.0\.1:\d+\/join\/[\w-]+)/.exec(r.stdout)?.[1] ?? "";
}

// A new person's computer inside the instance root: a PATIO_HOME and a project folder, nothing else.
async function newcomer(t: Transcript, name: string) {
  const root = join(t.m.root, name);
  const home = join(root, ".patio");
  const folder = join(root, "code", "orbit");
  assertSafeHome(home, t.m.root);
  await mkdir(folder, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: folder });
  const env = {
    ...inherited(),
    HOME: root,
    PATIO_HOME: home,
    PATIO_WEB_PORT: "0",
    PATIO_DEVICE_NAME: `${name}-laptop`,
    PATIO_NO_NOTIFY: "1",
    PATIO_NO_SERVICE: "1",
    ...(t.m.jev ? { TYPESAFE_API_KEY: FAKE_JEV_KEY, PATIO_JEV_URL: t.m.jev.url } : {}),
  };
  const stop = () => {
    const pidFile = join(home, "patio.pid");
    const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : 0;
    if (pid && procStart(pid)) process.kill(pid, "SIGTERM");
  };
  return { root, home, folder, env, stop };
}

// The CLI as a coding agent runs it: no terminal; each printed line is seen as it comes.
async function asAgent(t: Transcript, label: string, env: Record<string, string>, args: string[], onLine?: (line: string) => Promise<void>) {
  const started = Date.now();
  const proc = Bun.spawn([process.execPath, PATIO_CLI, ...args], { env, cwd: REPO, stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: 60_000 });
  let out = "";
  for await (const chunk of proc.stdout) {
    const text = new TextDecoder().decode(chunk);
    out += text;
    for (const line of text.split("\n").filter(Boolean)) await onLine?.(line);
  }
  const code = await proc.exited;
  const err = (await new Response(proc.stderr).text()).trim();
  t.lines.push(`### ${label} (an agent, no terminal)$ patio ${args.join(" ")}`, "", `exit ${code} in ${Date.now() - started} ms`, "", "```text", out.trim(), ...(err ? [`stderr: ${err}`] : []), "```", "");
  return { code, out, err };
}

const joinByPrompt: Scenario = {
  name: "join-by-prompt",
  description:
    "Jorge, new, pastes the invite page's prompt into her coding agent. The prompt asks the three questions first; an agent that skips them and runs the join anyway gets exit 13 with the questions and one command, and nothing joins. With the answers (the defaults), the join starts patio, prints one confirmation link and stops (exit 5). Jorge opens it, signs in with GitHub and sees one screen: \"Your agent jorge-team (Claude Code in ~/code/orbit) wants to join team\", with her three answers; she clicks Confirm. The agent runs the same command again: jorge-team is in team and #general with her answers as its rules, and the join ends with the four lines of \"patio is ready\". Alice's broadcast reaches it. A run without the answers then asks nothing, changes nothing and ends the same way.",
  label: "deterministic",
  agents: () => [{ handle: "alice", channels: ["general"] }],
  async run(t) {
    const url = await teamLink(t);
    const page = await (await fetch(url)).text();
    const prompt = (/<pre id="prompt">([\s\S]*?)<\/pre>/.exec(page)?.[1] ?? "").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
    const command = `patio join ${url} --folder "$PWD" --connect --no-wait --ask requests --act ask-human --answer no`;
    t.expect(
      "the invite page's prompt asks the three questions first, then gives one command ready to run with the defaults",
      prompt.includes(`curl -fsSL ${t.m.exchange.url.replace("ws:", "http:")}/install.sh | sh`) &&
        prompt.indexOf("Ask me these three questions in one message") < prompt.indexOf(command) &&
        prompt.includes("(default: questions and small requests; or: only questions; or: anything they like)") &&
        !/\bTOOL\b|--tool/.test(prompt) &&
        !prompt.split("\n").some((l) => l.includes("patio join") && l.includes("|")),
      prompt,
    );
    t.note(`The prompt on the invite page:\n\n\`\`\`text\n${prompt}\n\`\`\``);
    const jorge = await newcomer(t, "jorge");
    // The agent follows the prompt; $PWD is the project. The harness runs outside any coding tool, so --tool claude
    // stands for what the join detects in a real Claude Code (test/join-tools.test.ts covers detection). No --connect
    // here (the connect step is tested on its own), so nothing is written into Claude Code's files.
    const args = ["join", url, "--tool", "claude", "--folder", jorge.folder, "--no-wait"];
    // An agent that skips the questions: nothing joins.
    const unanswered = await asAgent(t, "jorge", jorge.env, args);
    t.expect(
      "without the three answers nothing joins: exit 13 with the questions and one command with the defaults",
      unanswered.code === 13 &&
        unanswered.out.includes("  1. What may team ask your agent? default: questions and small requests (--ask requests)") &&
        unanswered.out.includes(`  ${["patio", ...args].join(" ")} --ask requests --act ask-human --answer no`) &&
        !unanswered.out.includes("Confirm in") &&
        unanswered.err.includes("nothing joined team"),
      unanswered.out + unanswered.err,
    );
    t.note("**Jorge's agent asks him the three questions in one message; he answers with the defaults.**");
    const answered = [...args, "--ask", "requests", "--act", "ask-human", "--answer", "no"];
    let confirmUrl = "";
    const first = await asAgent(t, "jorge", jorge.env, answered, async (line) => {
      confirmUrl ||= /^Confirm in your browser: (\S+)$/.exec(line)?.[1] ?? "";
    });
    t.expect("the first run with the answers prints one link to confirm and stops (exit 5)", first.code === 5 && !!confirmUrl && first.err.includes("waiting for you"), first.out);
    const web = new WebClient(new URL(confirmUrl).origin);
    await web.signIn("jorge");
    t.note("**@jorge opens the link and signs in with GitHub.**");
    const screen = await (await web.get(new URL(confirmUrl).pathname + new URL(confirmUrl).search)).text();
    t.expect(
      "one screen: her agent, with its tool and folder, wants to join team, with her three answers; Confirm and Decline",
      screen.includes(`Your agent <b>jorge-team</b> (Claude Code in <span class="mono">~/code/orbit</span>) wants to join <b>team</b>`) &&
        screen.includes("<p>What team may ask jorge-team: questions and small requests.</p>") &&
        screen.includes(">Confirm</button>") &&
        screen.includes(">Decline</button>"),
    );
    const code = new URL(confirmUrl).searchParams.get("code")!;
    const ok = await web.post("/confirm", { code, decision: "confirm" });
    t.note(`**@jorge clicks Confirm**: ${ok.ok ?? ok.error}`);
    t.expect("one click confirms the computer, the agent, the join and the answers", ok.ok === "jorge-team is your agent on this computer, in team and #general. Tell your agent you are done: it still has to finish the setup (patio join).", ok.ok ?? ok.error ?? "");
    const second = await asAgent(t, "jorge", jorge.env, answered);
    t.expect(
      "the same command then finishes: jorge-team is in team, its rules are the answers, and the join ends with the four lines (exit 0)",
      second.code === 0 &&
        /patio is ready: jorge-team is in team\.\nNext: start a new Claude Code session in this folder\.\nTry: ask alice a question about their work\.\nWhat needs you: http:\/\/127\.0\.0\.1:\d+/.test(second.out) &&
        second.out.includes("  what team may ask: questions and small requests\n  changing files for them: only when you approve\n  answering team on its own: no"),
      second.out,
    );
    const file = join(jorge.home, "agents", "jorge-team.yaml");
    t.expect(
      "agents/jorge-team.yaml is written, with the tool, the folder and the answers",
      existsSync(file) && readFileSync(file, "utf8").includes('tool: "claude"') && readFileSync(file, "utf8").includes(jorge.folder) && readFileSync(file, "utf8").includes("  kinds: [question, request]") && readFileSync(file, "utf8").includes("asked_in: [team]"),
    );
    // A question: Jorge answered "questions and small requests", so a heads-up would be rejected by his rules.
    const ask = await t.cli("alice", ["ask", "--channel", "general", "Welcome, Jorge: can you make the release on Thursday?", "--kind", "question"]);
    t.expect("Alice's broadcast to #general reaches jorge-team", ask.code === 0 && ask.stderr.includes("sent to 1 agent of #general"), ask.stderr);
    const inbox = await until("the broadcast in Jorge's inbox", async () => {
      const out = Bun.spawnSync([process.execPath, PATIO_CLI, "inbox"], { env: jorge.env, cwd: REPO }).stdout.toString();
      return out.includes("Welcome, Jorge") ? out : null;
    }).catch(() => null);
    t.expect("it is in jorge-team's inbox", !!inbox, inbox ?? "");
    const before = statSync(file).mtimeMs;
    const third = await asAgent(t, "jorge", jorge.env, args);
    t.expect(
      "run again, with no answers given, it asks nothing, prints them, changes nothing, and ends the same way (exit 0)",
      third.code === 0 && !third.out.includes("✓") && third.out.includes("· rules for jorge-team (in every workspace), from your answers:") && third.out.includes("patio is ready: jorge-team is in team.") && statSync(file).mtimeMs === before,
      third.out,
    );
    jorge.stop();
  },
};

const joinFromTerminal: Scenario = {
  name: "join-from-terminal",
  description:
    "Dave, new, runs `patio join <link> --tool codex --folder ~/code/orbit --ask questions --act deny --answer no` in his own terminal. Only the GitHub sign-in needs the browser: signing in from the printed link confirms his computer, and nothing waits for him: dave-team is in team and #general.",
  label: "deterministic",
  agents: () => [{ handle: "alice", channels: ["general"] }],
  async run(t) {
    const url = await teamLink(t);
    const dave = await newcomer(t, "dave");
    let web: WebClient | null = null;
    // The three answers as flags here (test/join-answers.test.ts covers the questions in a terminal).
    const answers = ["--ask", "questions", "--act", "deny", "--answer", "no"];
    const r = await t.tty("dave", { cmd: [process.execPath, PATIO_CLI, "join", url, "--tool", "codex", "--folder", dave.folder, "--no-open", ...answers], env: dave.env, cwd: REPO }, async (line) => {
      const m = /Sign in with GitHub to confirm this computer: (http:\/\/127\.0\.0\.1:\d+)(\/setup\?code=[\w-]+)/.exec(line);
      if (!m) return;
      web = new WebClient(m[1]!);
      await web.signIn("dave");
      const page = await (await web.get(m[2]!)).text();
      t.note(`**@dave opens the link and signs in with GitHub**; the page says: ${/Signed in as @dave[^<]*/.exec(page)?.[0] ?? "(no confirmation)"}`);
    });
    t.expect("patio join exits 0", r.code === 0, r.stdout.split("\n").slice(-3).join(" | "));
    for (const step of ["✓ patio: started on this computer", `✓ agent dave-team: Codex in ~/code/orbit`, "✓ signed in as @dave", "✓ agent dave-team: in team and #general"]) t.expect(`it says: ${step}`, r.stdout.includes(step));
    t.expect("it never asks Dave to confirm anything else", !r.stdout.includes("Confirm in"));
    const needs = web ? await (await (web as WebClient).get("/")).text() : "";
    t.expect("nothing waits for Dave in his web app", !!needs && !needs.includes('class="count"'));
    dave.stop();
  },
};

const joinLaterAgent: Scenario = {
  name: "join-later-agent",
  description:
    "Carol is signed in on her computer, with her agent carol in no workspace. Her coding agent runs `patio join <link> --agent carol-side --tool pi --folder <dir> --no-wait` with the three answers: it writes agents/carol-side.yaml and stops at one card in her web app (exit 5): \"carol-side (Pi in …) wants to join team\". She clicks Confirm; the same command then finishes. A name without her login, a revoked link, an expired one and an unknown one are refused, each with a clear message.",
  label: "deterministic",
  agents: () => [{ handle: "alice", channels: ["general"] }, { handle: "carol", workspace: null }],
  async run(t) {
    const url = await teamLink(t);
    const dir = join(t.m.root, "carol-side-project");
    await mkdir(dir, { recursive: true });
    const args = ["join", url, "--agent", "carol-side", "--tool", "pi", "--folder", dir, "--no-wait", "--ask", "requests", "--act", "ask-human", "--answer", "no"];
    const asked = await t.cli("carol", args);
    t.expect("it stops at one card in the web app (exit 5)", asked.code === 5 && asked.stdout.includes("Confirm in your web app:") && asked.stdout.includes("one card there: carol-side wants to join team, with your three answers."), asked.stdout);
    t.expect("its file is written", existsSync(join(t.m.agents.carol!.home, "agents", "carol-side.yaml")));
    const page = await t.webGet("carol", "/");
    const shown = process.env.HOME && dir.startsWith(`${process.env.HOME}/`) ? `~${dir.slice(process.env.HOME.length)}` : dir;
    t.expect("Carol's Needs you shows one card: carol-side (Pi in its folder) wants to join team", page.text.includes(`carol-side (Pi in ${shown} ) wants to join team`) && (page.html.match(/data-request="link:team"/g) ?? []).length === 1, page.text.slice(0, 600));
    const action = /action="(\/link-requests\/[^"]+\/decide)"/.exec(page.html)?.[1] ?? "";
    const ok = await t.webPost("carol", action, { decision: "approve" });
    t.expect("one click: carol-side is in team and #general", ok.ok === "carol-side is in team and #general.", ok.ok ?? ok.error ?? "");
    const again = await t.cli("carol", args);
    t.expect("the same command then finishes (exit 0)", again.code === 0 && again.stdout.includes("· agent carol-side: in team"), again.stdout);

    const wrong = await t.cli("carol", ["join", url, "--agent", "pablo-side", "--tool", "pi", "--folder", dir]);
    t.expect("a name without Carol's login is refused, with one to use", wrong.code === 1 && wrong.stderr.includes("pablo-side is not a name for an agent of @carol: an agent's name starts with its owner's login and a hyphen; try carol-pablo-side"), wrong.stderr);
    const revoked = /(http:\/\/127\.0\.0\.1:\d+\/join\/([\w-]+))/.exec((await t.tty("alice", cliCommand(t.m, "alice", ["invite", "--workspace", "team"]))).stdout)!;
    await t.webPost("alice", `/links/${revoked[2]}/revoke`, { back: `/workspaces/${t.m.workspaces.team!.id}` });
    const r1 = await t.cli("carol", ["join", revoked[1]!, "--agent", "carol-x"]);
    t.expect("a revoked link is refused", r1.code === 1 && r1.stderr.includes("this invite link was revoked: ask @alice for a new one"), r1.stderr);
    const expired = /(http:\/\/127\.0\.0\.1:\d+\/join\/[\w-]+)/.exec((await t.tty("alice", cliCommand(t.m, "alice", ["invite", "--workspace", "team", "--expires", "1s"]))).stdout)![1]!;
    await Bun.sleep(1100);
    const r2 = await t.cli("carol", ["join", expired, "--agent", "carol-x"]);
    t.expect("an expired link is refused", r2.code === 1 && r2.stderr.includes("this invite link expired on"), r2.stderr);
    const r3 = await t.cli("carol", ["join", url.replace(/[\w-]+$/, "nope"), "--agent", "carol-x"]);
    t.expect("an unknown link is refused", r3.code === 1 && r3.stderr.includes("this invite link is not known to this server"), r3.stderr);
    const p = await fetch(expired);
    t.expect("the expired link's page says so", p.status === 410 && (await p.text()).includes("This invite link expired on"));
  },
};

const workspaceNew: Scenario = {
  name: "workspace-new",
  description:
    "Unai, signed in with his agent unai-claude, runs `patio workspace new orbit --agent unai-claude` in his terminal: orbit exists with unai-claude in it and in #general, and the command prints the invite link. Jorge's coding agent joins with that link from no terminal; Jorge confirms the one card; then unai-claude asks jorge-claude a question, and Jorge's reply comes back.",
  label: "deterministic",
  agents: () => [
    { handle: "unai-claude", login: "unai", workspace: null },
    { handle: "jorge-claude", login: "jorge", workspace: null },
  ],
  async run(t) {
    const refused = await t.cli("unai-claude", ["workspace", "new", "orbit", "--agent", "unai-claude"]);
    t.expect("not from a terminal, it is refused", refused.code === 1 && refused.stderr.includes("runs only from your own terminal"), refused.stderr);
    const made = await t.tty("unai-claude", cliCommand(t.m, "unai-claude", ["workspace", "new", "orbit", "--agent", "unai-claude"]));
    const url = /(http:\/\/127\.0\.0\.1:\d+\/join\/[\w-]+)/.exec(made.stdout)?.[1] ?? "";
    t.expect("in his terminal it creates orbit, puts unai-claude in it and #general, and prints the link", made.code === 0 && !!url && made.stdout.includes("created orbit with unai-claude in it and in #general"), made.stdout);
    const page = await (await fetch(url)).text();
    t.expect("the link works: @unai invited you to orbit, where unai-claude is", page.includes("@unai invited you to <b>orbit</b></h1>") && page.includes('<span class="mono">unai-claude</span>'));
    const asked = await t.cli("jorge-claude", ["join", url, "--agent", "jorge-claude", "--no-wait", "--ask", "requests", "--act", "ask-human", "--answer", "no"]);
    t.expect("Jorge's agent asks to join (exit 5)", asked.code === 5, asked.stdout);
    const needs = await t.webGet("jorge-claude", "/");
    const action = /action="(\/link-requests\/[^"]+\/decide)"/.exec(needs.html)?.[1] ?? "";
    t.expect("Jorge confirms the card", (await t.webPost("jorge-claude", action, { decision: "approve" })).ok === "jorge-claude is in orbit and #general.");
    const ask = await t.cli("unai-claude", ["ask", "jorge-claude", "Does PR 812 change the notifications schema?"]);
    t.expect("unai-claude asks jorge-claude", ask.code === 0, ask.stderr);
    const got = await until("the question in Jorge's inbox", async () => ((await t.cli("jorge-claude", ["inbox"])).stdout.includes("PR 812") ? true : null));
    const reply = await t.cli("jorge-claude", ["reply", ask.stdout, "No: it only adds an index."]);
    t.expect("Jorge's agent has it, and replies", !!got && reply.code === 0, reply.stderr);
    const wait = await t.cli("unai-claude", ["wait", ask.stdout, "--timeout", "10"]);
    t.expect("the answer comes back to unai-claude", wait.stdout === "jorge-claude: No: it only adds an index.", wait.stdout);
  },
};

export const JOIN_SCENARIOS = [joinByPrompt, joinFromTerminal, joinLaterAgent, workspaceNew];
