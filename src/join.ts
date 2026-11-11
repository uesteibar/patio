// `patio join <link> [--agent <name>] [--tool T] [--folder D] [--connect]`: the one setup command. It does whatever is
// missing, in order, and says for each step what it did (✓), that it was already so (·), or what the person still has
// to do (!), so running it again is safe and changes nothing:
//
//   1. patio runs on this computer (started in the background when it is not, logging to $PATIO_HOME/patio.log), on
//      the link's server (remembered in $PATIO_HOME/exchange);
//   2. the coding tool: detected from the running process (detect.ts), or --tool. Nothing detected: in a terminal it
//      asks once, from the tools installed; from an agent it stops with the command to run with --tool;
//   3. the agent exists: agents/<name>.yaml, with that tool and the folder given or detected. Its name defaults to
//      <login>-<workspace>, so on a computer not signed in yet the file is written once the login is known;
//   4. the person is signed in and this computer is confirmed;
//   5. the agent joins the workspace and its default channels;
//   6. with --connect, every coding tool installed (and the one detected) gets patio as an MCP server, as that agent,
//      in its folder; nothing global is written;
//   7. the `watch --answer` service, installed once for this computer (no contact's auto-answer is turned on);
//   8. with --connect, each tool's own listing command proves it lists patio. A trust or approval still pending in a
//      tool is a failure (JoinPending, exit 12) with the step to take; the same join run again then passes.
//
// From the person's own terminal (a TTY) only the GitHub sign-in needs the browser: what they start there is theirs.
// Started by an agent (no TTY), it prints one link and waits: on a first run the person signs in and confirms the
// computer, the agent and the join on one screen; for a later agent of a signed-in person, one card in the web app.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { appendFile, mkdir, open, writeFile } from "node:fs/promises";
import { join as joinPath } from "node:path";
import { agentPath, defaultAgentName, detectFolder, isGitRepo, newAgentText, ownsName, parseAgentFile, TEMPLATE_FILE, toolLabel, validName } from "./agent-file";
import { DEFAULT_SERVER, expandHome, rememberedExchange, tilde, type Config } from "./config";
import { applyConnect, checkTool, CONNECT_TOOLS, connectedTools, excludeProjectFiles, isConnectTool, planConnect, projectFile, type ConnectTool } from "./connect";
import { detectTool, HOW, installedTools, type Detected } from "./detect";
import { ACT, ACT_WORDS, ANSWER, answerFlags, answerLines, answersFor, answersOf, applyAnswers, ASK, ASK_WORDS, CapError, checkAnswers, DEFAULT_ANSWERS, questionLines, splitWidening, type Act, type Answer, type Answers, type Ask } from "./answers";
import { describeInvite, LinkError, previewLink, type InviteLink, type InvitePreview } from "./links";
import { DaemonError, daemon, type LinkJoin } from "./local";
import { ago } from "./clock";
import { ensureAnswerService, patioCommand } from "./service";
import { lockHolder } from "./lock";
import { preflight, preflightOff, recordChecks, serviceRunEnv } from "./preflight";
import type { Status } from "./status";

export type JoinOptions = {
  link: InviteLink;
  agent?: string;
  tool?: string;
  folder?: string;
  connect?: boolean;
  // Open the sign-in link in the browser (from a terminal). Default true.
  open?: boolean;
  timeoutSeconds?: number;
  // stdin and stdout are TTYs: the person's own terminal.
  interactive: boolean;
  // false: when the person has to confirm, print the link and stop (JoinWaiting, exit 5); the same command run again
  // picks up where it stopped. For agents whose shell shows output only once a command ends.
  wait?: boolean;
  // Where messages go (tests): console.log by default.
  say?: (line: string) => void;
  // Asks the person one question in their terminal (interactive only) and returns the answer.
  ask?: (question: string) => Promise<string>;
  // The command as typed, to say exactly what to run again.
  command?: string;
  // Which tool runs this command (tests); detectTool() by default.
  detect?: () => Detected | null;
  // The three answers (answers.ts): --ask, --act, --answer.
  answers?: { ask?: string; act?: string; answer?: string };
};

export class JoinError extends Error {}
// It needs the person, and was asked not to wait (--no-wait): run it again once they confirmed.
export class JoinWaiting extends JoinError {}
// Everything is set up, but a coding tool does not list patio yet: a trust or approval step is the person's (exit 12).
export class JoinPending extends JoinError {}
// Everything is set up but the agent's rules: they wait for the person's three answers (exit 13).
export class JoinNeedsAnswers extends JoinError {}

// http(s) for the health check, ws(s) for patio's connection.
export function exchangeUrls(raw: string) {
  const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
  const secure = url.protocol === "https:" || url.protocol === "wss:";
  const host = url.host + url.pathname.replace(/\/$/, "");
  return { http: `${secure ? "https" : "http"}://${host}`, ws: `${secure ? "wss" : "ws"}://${host}` };
}

async function until<T>(fn: () => Promise<T | null | undefined | false>, seconds: number, what: string): Promise<T> {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await Bun.sleep(500);
  }
  throw new JoinError(`timed out after ${seconds} s waiting for ${what}; run the same patio join again to pick up where it stopped`);
}

function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  if (!Bun.which(cmd)) return false;
  Bun.spawn([cmd, url], { stdout: "ignore", stderr: "ignore" });
  return true;
}

// Starts patio in the background on `cfg.home`, connected to `ws`, and waits until it is connected. When another patio
// already holds this home (lock.ts), it is reused: one patio per home.
export async function startBackground(cfg: Config, ws: string): Promise<{ pid: number; log: string; reused: boolean }> {
  await mkdir(cfg.home, { recursive: true, mode: 0o700 });
  const log = joinPath(cfg.home, "patio.log");
  const holder = lockHolder(cfg.home);
  if (holder) {
    await until(async () => (await daemon.status(cfg).catch(() => null))?.connected, 30, `the patio already running (pid ${holder}) to answer (see ${log})`);
    return { pid: holder, log, reused: true };
  }
  await appendFile(log, "");
  const out = await open(log, "a");
  const proc = Bun.spawn([...patioCommand(), "up"], {
    // patio itself speaks for no agent in particular.
    env: { ...process.env, PATIO_HOME: cfg.home, PATIO_RELAY: ws, PATIO_AGENT: undefined },
    stdout: out.fd,
    stderr: out.fd,
    stdin: "ignore",
    detached: true,
  });
  proc.unref();
  await out.close();
  await until(async () => (await daemon.status(cfg).catch(() => null))?.connected, 30, `patio to connect (see ${log})`);
  // Another start won the lock meanwhile: the one that answers is the one that runs.
  return { pid: lockHolder(cfg.home) ?? proc.pid, log, reused: false };
}

export async function join(cfg: Config, o: JoinOptions): Promise<{ agent: string; changed: boolean }> {
  const say = o.say ?? ((line: string) => console.log(line));
  let changed = false;
  const done = (what: string) => ((changed = true), say(`✓ ${what}`));
  const skip = (what: string) => say(`· ${what}`);
  const timeout = o.timeoutSeconds ?? 600;
  if (o.agent !== undefined && !validName(o.agent)) throw new JoinError(`${o.agent} is not an agent name: lowercase letters, digits, - and _ (up to 32)`);

  // 1. The server, and patio on this computer.
  const urls = exchangeUrls(o.link.server ?? process.env.PATIO_SERVER ?? rememberedExchange(cfg.home) ?? DEFAULT_SERVER);
  let invite: InvitePreview;
  try {
    invite = await previewLink(urls.http, o.link.code);
  } catch (err) {
    throw err instanceof LinkError ? new JoinError(err.message) : err;
  }
  say(`· invite: ${describeInvite(invite)}`);
  // The three answers, checked against their caps before anything is written.
  let given: Partial<Answers>;
  try {
    given = checkAnswers(o.answers ?? {}, invite.workspace.name);
  } catch (err) {
    throw err instanceof CapError ? new JoinError(`${err.message}. Nothing was changed.`) : err;
  }
  await mkdir(cfg.home, { recursive: true, mode: 0o700 });
  const remembered = joinPath(cfg.home, "exchange");
  if (!existsSync(remembered) || rememberedExchange(cfg.home) !== urls.ws) await writeFile(remembered, `${urls.ws}\n`, { mode: 0o600 });
  cfg = { ...cfg, relay: urls.ws };
  let status: Status | null = await daemon.status(cfg).catch(() => null);
  if (status) {
    if (status.relay !== urls.ws) throw new JoinError(`patio on this computer uses the server ${status.relay}; this invite link is for ${urls.http}. Stop it (kill $(cat ${tilde(joinPath(cfg.home, "patio.pid"))})) to switch`);
    skip("patio: running on this computer");
  } else {
    const { pid, log, reused } = await startBackground(cfg, urls.ws);
    status = await daemon.status(cfg);
    if (reused) skip(`patio: running on this computer (pid ${pid})`);
    else done(`patio: started on this computer (pid ${pid}, log ${tilde(log)})`);
  }

  // 2. The coding tool: the one running this command, or --tool.
  const detected = (o.detect ?? (() => detectTool({ flag: o.tool })))();
  const installed = installedTools();
  if (detected) say(`· tool: ${toolLabel(detected.tool)} (${HOW[detected.how]})`);
  else say(`· tool: none detected; installed: ${installed.map(toolLabel).join(", ") || "none of Claude Code, Codex and Pi"}`);
  const workspace = invite.workspace.name;
  const folder = expandHome(o.folder ?? detectFolder());
  let name = o.agent ?? (status.login ? defaultAgentName(status.login, workspace) : null);
  if (name && status.login && !ownsName(status.login, name))
    throw new JoinError(`${name} is not a name for an agent of @${status.login}: an agent's name starts with its owner's login and a hyphen; try ${defaultAgentName(status.login, name)}`);
  // The agent's own tool, which answers for it: its file's when it has one, else the one detected, else asked.
  const fileTool = name && existsSync(agentPath(cfg.home, name)) ? (parseAgentFile(await Bun.file(agentPath(cfg.home, name)).text(), name).tool ?? null) : null;
  const tool = fileTool ?? detected?.tool ?? (await chooseTool(o, installed));
  if (fileTool && detected && fileTool !== detected.tool) say(`  note: ${name}'s file says ${toolLabel(fileTool)} answers for it; patio keeps that (edit ${tilde(agentPath(cfg.home, name!))} to change it)`);

  // 2b. The three answers come first: from an agent (no terminal) without them, nothing joins (exit 13). In the
  // person's terminal they are asked once the agent's name is known, before it enters the workspace.
  const complete = (a: Partial<Answers>): a is Answers => !!(a.ask && a.act && a.answer);
  const recorded = !!name && recordedAnswers(cfg.home, name, workspace) !== null;
  if (!complete(given) && !recorded && !(o.interactive && o.ask)) {
    const base = (o.command ?? "patio join <link>").replace(/ --(?:ask|act|answer)(?:=| )\S+/g, "");
    const d = { ...DEFAULT_ANSWERS, ...given, ...(firstAgentAnswers(cfg.home, name ?? "") ?? {}) };
    say(`Three answers needed first: ask your person these three questions in one message, then run the command with their answers.`);
    for (const l of questionLines(workspace, d)) say(l);
    say(`With the defaults, run:`);
    say(`  ${base} ${answerFlags({ ...d, ...given } as Answers)}`);
    throw new JoinNeedsAnswers(`not finished: nothing joined ${workspace}. Your agent's rules wait for your three answers (--ask, --act, --answer).`);
  }

  const ensureFile = async (agent: string) => {
    const file = agentPath(cfg.home, agent);
    if (existsSync(file)) return skip(`agent ${agent}: ${tilde(file)}`);
    await mkdir(joinPath(cfg.home, "agents"), { recursive: true, mode: 0o700 });
    const templateFile = joinPath(cfg.home, TEMPLATE_FILE);
    const template = existsSync(templateFile) ? await Bun.file(templateFile).text() : null;
    const text = newAgentText({ name: agent, tool, folder, workspace }, template);
    parseAgentFile(text, agent);
    await writeFile(file, text, { mode: 0o600 });
    done(`agent ${agent}: ${toolLabel(tool)} in ${tilde(folder)} (${tilde(file)})`);
    if (!isGitRepo(folder)) say(`  note: ${tilde(folder)} is not a git repository, so ${agent} answers in it directly, not in a disposable copy`);
  };
  if (name) await ensureFile(name);

  // 3. Signed in, and this computer confirmed.
  if (status.login) skip(`signed in as @${status.login}`);
  else {
    const join = o.interactive ? undefined : { link: o.link.code, workspace, inviter: invite.inviter, agent: name, tool, folder, answers: complete(given) ? given : null };
    const p = await daemon.pair(cfg, { interactive: o.interactive, join });
    if (o.interactive) {
      say(`Sign in with GitHub to confirm this computer: ${p.url}`);
      if (o.open !== false && openBrowser(p.url)) say("  (opened in your browser)");
    } else {
      say(`Confirm in your browser: ${p.url}`);
      say(`  sign in with GitHub, then confirm that ${name ?? `your agent`} (${toolLabel(tool)} in ${tilde(folder)}) joins ${workspace}, with your three answers.${o.wait === false ? "" : " Waiting…"}`);
      if (o.wait === false) throw new JoinWaiting("waiting for you: open the link above, sign in and confirm; then run the same patio join again");
    }
    status = await until(
      async () => {
        const s = await daemon.status(cfg);
        if (s.setup?.state === "declined") throw new JoinError("you declined it in the browser; nothing joined");
        return s.login && (o.interactive || s.setup?.state === "confirmed") ? s : null;
      },
      timeout,
      o.interactive ? "the sign-in in the browser" : "your confirmation in the browser",
    );
    done(`signed in as @${status.login}${o.interactive ? "" : ", and confirmed this computer"}`);
    if (!name) {
      name = status.setup?.agent ?? defaultAgentName(status.login!, workspace);
      await ensureFile(name);
    }
  }
  const agent = name!;

  // 3b. The agent's rules, from the person's three answers: written before it enters the workspace.
  const rules = await rulesStep(cfg, o, { agent, workspace, given, say, done, skip });

  // 4. The agent in the workspace and its default channels.
  const inWorkspace = (s: Status) => s.agents.find((a) => a.name === agent && a.status === "approved")?.workspaces.includes(workspace);
  // Confirmed with Move on the one screen: the agent came from another computer of the person's.
  let movedFrom = status.setup?.state === "confirmed" && status.setup.agent === agent ? (status.setup.moved ?? null) : null;
  if (inWorkspace(status)) skip(`agent ${agent}: in ${workspace}`);
  else {
    const r = await joinOrMove(cfg, o, agent);
    const mine = r.agents.find((a) => a.name === agent);
    const moved = r.moved?.find((m) => m.agent === agent);
    if (moved) movedFrom = moved.from;
    const channels = mine?.channels.length ? ` and ${mine.channels.map((c) => `#${c}`).join(", ")}` : "";
    if (r.status === "joined" && mine?.status === "approved") {
      done(`agent ${agent}: ${moved ? `moved here from ${moved.from}, ` : ""}in ${workspace}${channels}`);
      if (moved?.revoked) say(`  ${moved.from} had no other agent, so it is revoked`);
    }
    else {
      say(`Confirm in your web app: ${r.web_url}`);
      say(`  one card there: ${agent} wants to join ${workspace}, with your three answers.${o.wait === false ? "" : " Waiting…"}`);
      if (o.wait === false) throw new JoinWaiting("waiting for you: confirm it in the web app; then run the same patio join again");
      await until(async () => inWorkspace(await daemon.status(cfg)), timeout, `your confirmation in the web app (${r.web_url})`);
      done(`agent ${agent}: in ${workspace}`);
    }
  }
  // 4b. "Yes, answer it on its own", once the agent is in the workspace: the person's answer turns it on.
  if (rules.turnOn) {
    const list = parseAgentFile(await Bun.file(agentPath(cfg.home, agent)).text(), agent).rules.defaults.auto_answer_in ?? [];
    if (list.length) {
      const said = await turnOnAnswerIn(cfg, agent, list, "join");
      if (said !== true) say(`  answering on its own waits for you in the web app (${said})`);
    }
  }

  // 6. Every coding tool installed (and the one running this), connected as the agent in its folder.
  const checks: ConnectTool[] = [];
  const file = parseAgentFile(await Bun.file(agentPath(cfg.home, agent)).text(), agent);
  const where = expandHome(file.folder ?? folder);
  const own = file.tool ?? tool;
  if (o.connect) {
    const tools = CONNECT_TOOLS.filter((t) => t === own || t === detected?.tool || installed.includes(t));
    if (!isConnectTool(own)) say(`· connect: patio connects Claude Code, Codex and Pi; add \`patio mcp --as ${agent}\` to ${toolLabel(own)} by hand`);
    if (!tools.length) say(`· connect: no coding tool found (claude, codex, pi on PATH)`);
    else say(`· connect: ${tools.map(toolLabel).join(", ")} (every coding tool found), as ${agent} in ${tilde(where)}`);
    for (const t of tools) {
      checks.push(t);
      if (connectedTools(agent, where).includes(t)) skip(`${toolLabel(t)}: runs patio as ${agent} in ${tilde(where)}`);
      else {
        const plan = planConnect({ tool: t, agent, folder: where, patio: patioCommand() });
        await applyConnect(plan);
        done(`${toolLabel(t)}: ${plan.say.replace(where, tilde(where))}`);
      }
    }
    // The project files are this computer's: out of the team's repository.
    const ex = await excludeProjectFiles(where, checks.map(projectFile));
    const stay = (xs: string[]) => `${andList(xs)} ${xs.length === 1 ? "stays" : "stay"} out of your repository`;
    if (ex?.added.length) done(`git: ${stay(ex.added)} (listed in .git/info/exclude)`);
    else if (ex?.already.length) skip(`git: ${stay(ex.already)} (.git/info/exclude)`);
    for (const t of ex?.tracked ?? [])
      say(`  warning: ${t} is tracked in this repository: patio's entry in it (${agent}, and a path on this computer) reaches your team when you commit it. patio left it as it is.`);
  }

  // 7. The answer service: one per computer, installed once.
  if (process.env.PATIO_NO_SERVICE === "1") skip("answering: no service (PATIO_NO_SERVICE=1)");
  else {
    try {
      const svc = await ensureAnswerService(cfg);
      if (svc.state === "installed") {
        done(`answering: the service will answer for your agents (${tilde(svc.file)})`);
        say("  it answers on its own only what you said yes to (the third question) or turned on in the web app; nothing else");
      } else if (svc.state === "updated") done(`answering: the service is written again, with the environment it needs now (${tilde(svc.file)})`);
      else if (svc.state === "present") skip("answering: the service will answer for your agents");
      else if (svc.state === "other-home") say(`· answering: ${tilde(svc.file)} answers for another patio (${tilde(svc.home)}); left as it is`);
      else say(`· answering: no service on ${process.platform}; run \`patio watch --answer\` yourself`);
    } catch (err) {
      say(`· answering: the service could not be installed (${(err as Error).message}); run \`patio service install --answer\``);
    }
  }

  // 7b. Proof that the service can answer: the answer path's preflight, in the service's own environment.
  let answering: string | null = null;
  if (process.env.PATIO_NO_SERVICE === "1") {
  } else if (preflightOff()) skip("answering: not checked (PATIO_NO_PREFLIGHT=1)");
  else {
    const r = await preflight(agent, { tool: own, folder: file.folder ?? folder, model: file.model, effort: file.effort }, serviceRunEnv(cfg));
    await recordChecks(cfg.home, (c) => void (c.preflight[agent] = { ok: r.ok, ...(r.ok ? {} : { reason: r.reason }), at: Date.now() }));
    if (r.ok) skip("answering: checked");
    else answering = r.reason;
  }

  // 8. Proof: each tool's own listing command shows patio. Only the agent's own tool must: another tool that waits for
  // the person's trust is said, and does not stop the join.
  const results = checks.map((t) => checkTool(t, where));
  await recordChecks(cfg.home, (c) => {
    c.tools[agent] = { ...(c.tools[agent] ?? {}) };
    for (const r of results) c.tools[agent]![r.tool] = { ok: r.ok, said: r.said, ...(r.ok ? {} : { step: r.step }), at: Date.now() };
  });
  const blocking = results.find((r) => r.tool === own && !r.ok);
  for (const r of results) {
    if (r.ok) skip(`${toolLabel(r.tool)}: lists patio`);
    else if (r.tool !== own) skip(`${toolLabel(r.tool)}: written; trust this folder in ${toolLabel(r.tool)} to use patio there`);
  }
  if (blocking && !blocking.ok) {
    say(`! ${toolLabel(blocking.tool)}: ${blocking.step.replaceAll(where, tilde(where))}`);
    say(`  (${toolLabel(blocking.tool)} says: ${blocking.said.replaceAll(where, tilde(where))})`);
  }
  if (answering) say(`! answering: ${toolLabel(own)} does not start for the answer service: ${answering}`);
  if (blocking || answering) {
    const why = [blocking && `${toolLabel(blocking.tool)} does not list patio yet`, answering && `the answer service cannot start ${toolLabel(own)}`].filter(Boolean).join(", and ");
    throw new JoinPending(`not finished: ${agent} is in ${workspace}, but ${why}. Do the step${blocking && answering ? "s" : ""} above, then run the same patio join again.`);
  }

  // The one ending, the same on a first run and on a run that changed nothing.
  const teammate = await teammateOf(cfg, workspace, status.login, invite.inviter);
  say(`patio is ready: ${agent} is in ${workspace}.`);
  say(`Next: start a new ${isConnectTool(own) ? toolLabel(own) : "coding tool"} session in this folder.`);
  if (movedFrom) say("Your teammates' patio will ask them to trust this computer's new keys before your messages reach them.");
  say(teammate ? `Try: ask ${teammate} a question about their work.` : `Try: once a teammate's agent joins ${workspace}, ask it a question about their work.`);
  say(`What needs you: ${status.web_url}`);
  return { agent, changed };
}

const andList = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

// Another person's agent in the workspace, to try a first question on: one that is online (the inviter's first, then one
// that answers on its own), else the inviter's agent; never an offline one when one is online.
export function pickTeammate(roster: { agent: string; owner: string; answers?: "self" | "owner" }[], online: string[], login: string | null, inviter: string): string | null {
  const others = roster.filter((a) => a.owner !== login);
  const rank = (a: (typeof others)[number]) => (a.owner === inviter ? 0 : 2) + (a.answers === "self" ? 0 : 1);
  const up = others.filter((a) => online.includes(a.agent)).sort((a, b) => rank(a) - rank(b));
  return up[0]?.agent ?? others.find((a) => a.owner === inviter)?.agent ?? others[0]?.agent ?? null;
}

async function teammateOf(cfg: Config, workspace: string, login: string | null, inviter: string): Promise<string | null> {
  const who = await daemon.who(cfg).catch(() => null);
  const roster = who?.workspaces?.find((r) => r.workspace === workspace);
  return roster ? pickTeammate(roster.agents, who?.online ?? [], login, inviter) : null;
}

// The agent joins by the link. When it lives on another computer of the person's: in their terminal, they are asked
// whether to move it here; from an agent, the join stops and says how.
async function joinOrMove(cfg: Config, o: JoinOptions, agent: string): Promise<LinkJoin> {
  try {
    return await daemon.joinLink(cfg, o.link.code, [agent], o.interactive);
  } catch (err) {
    if (!(err instanceof DaemonError) || err.code !== "agent_elsewhere" || !err.elsewhere) throw err;
    const e = err.elsewhere;
    const where = `${e.label} (${e.online ? "online now" : `last seen ${ago(e.last_seen_at)}`})`;
    if (!o.interactive || !o.ask)
      throw new JoinError(`${agent} lives on your other computer ${where}. To move it to this computer, run the same patio join in your own terminal and answer yes; or give this computer's agent another name with --agent.`);
    const answer = (await o.ask(`${agent} lives on your other computer ${where}. Move it to this computer? [y/N] `)).trim();
    if (!/^y(es)?$/i.test(answer)) throw new JoinError(`nothing joined: ${agent} stays on ${e.label}. For a new agent on this computer, run patio join again with --agent <another name>.`);
    return daemon.joinLink(cfg, o.link.code, [agent], true, true);
  }
}

// Nothing detected: in the person's terminal, one question with the installed tools and the first as the default;
// from an agent, the command to run again with --tool.
async function chooseTool(o: JoinOptions, installed: string[]): Promise<string> {
  const choices = installed.length ? installed : [...CONNECT_TOOLS];
  if (o.interactive && o.ask) {
    const answer = (await o.ask(`Which coding tool answers for your agent? (${choices.join(", ")}) [${choices[0]}] `)).trim().toLowerCase();
    if (!answer) return choices[0]!;
    if (choices.includes(answer) || isConnectTool(answer)) return answer;
    throw new JoinError(`${answer} is not one of ${choices.join(", ")}; run the same patio join again, or add --tool <tool>`);
  }
  const again = `${o.command ?? "patio join <link>"} --tool ${choices[0]}`;
  throw new JoinError(`patio could not tell which coding tool runs this command. Run it again with the tool that answers for your agent (${choices.join(", ")}):\n  ${again}`);
}

// ---- the rules, from the three answers -----------------------------------------------------------------------------

// A second agent's defaults: the answers of the person's first agent asked at a join (the oldest such file).
export function firstAgentAnswers(home: string, except: string): Answers | null {
  const dir = joinPath(home, "agents");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") && f !== `${except}.yaml`)
    .map((f) => ({ name: f.slice(0, -5), path: joinPath(dir, f) }))
    .sort((a, b) => statSync(a.path).mtimeMs - statSync(b.path).mtimeMs);
  for (const f of files) {
    try {
      const text = readFileSync(f.path, "utf8");
      const parsed = parseAgentFile(text, f.name);
      if (!parsed.asked_in?.length) continue;
      const a = answersOf(parsed.rules);
      return { ask: a.ask ?? DEFAULT_ANSWERS.ask, act: a.act ?? DEFAULT_ANSWERS.act, answer: a.answerIn.length ? "yes" : "no" };
    } catch {}
  }
  return null;
}

// What the person types for each question: the value, or the design's words for it; Enter keeps the default.
export const fromWords = <T extends string>(input: string, values: readonly T[], words: Partial<Record<T, string>>, fallback: T): T | null => {
  const t = input.trim().toLowerCase();
  if (!t) return fallback;
  if ((values as readonly string[]).includes(t)) return t as T;
  return (Object.entries(words) as [T, string][]).find(([, w]) => w === t)?.[0] ?? null;
};

// The answers a file records for a workspace (its join asked them), or null.
export function recordedAnswers(home: string, agent: string, workspace: string): Answers | null {
  const path = agentPath(home, agent);
  if (!existsSync(path)) return null;
  try {
    const f = parseAgentFile(readFileSync(path, "utf8"), agent);
    return f.asked_in?.includes(workspace) ? answersFor(f.rules, workspace) : null;
  } catch {
    return null;
  }
}

// Writes the answers into the agent's file, before it enters the workspace: given as flags, or asked in the terminal.
// The join's first answers apply as given (the person just gave them). Run again with answers that widen the recorded
// ones: from the person's terminal they apply; from an agent, the widening waits for the person as a card in the web
// app, and what narrows applies at once. `turnOn`: the answer "yes" is the person's, to turn on once the agent is in.
async function rulesStep(
  cfg: Config,
  o: JoinOptions,
  c: { agent: string; workspace: string; given: Partial<Answers>; say: (l: string) => void; done: (l: string) => void; skip: (l: string) => void },
): Promise<{ turnOn: boolean }> {
  const { agent, workspace, given } = c;
  const path = agentPath(cfg.home, agent);
  const text = await Bun.file(path).text();
  const held = recordedAnswers(cfg.home, agent, workspace);
  const title = `rules for ${agent} (in every workspace), from your answers`;
  const change = `  change them: patio rules ${agent} --ask … --act … --answer …`;
  if (held && !Object.keys(given).length) {
    c.skip(`${title}:`);
    for (const l of answerLines(held, workspace)) c.say(l);
    c.say(change);
    return { turnOn: false };
  }
  let answers: Answers;
  let card: Partial<Answers> = {};
  if (held) {
    // A run again with answers: what widens is the person's to confirm, unless they run it in their own terminal.
    const split = splitWidening(held, given);
    answers = o.interactive ? { ...held, ...given } : split.now;
    if (!o.interactive) card = split.wider;
  } else if (given.ask && given.act && given.answer) answers = given as Answers;
  else {
    // In the person's terminal (the agent path without them stopped before): one question each, Enter keeps the default.
    const d = { ...DEFAULT_ANSWERS, ...(firstAgentAnswers(cfg.home, agent) ?? {}), ...given };
    c.say(`Three questions about what ${workspace} may do with ${agent} (Enter keeps the default in brackets):`);
    const ask =
      given.ask ??
      fromWords(await o.ask!(`1. What may ${workspace} ask ${agent}? ${ASK.map((a) => `${ASK_WORDS[a]} (${a})`).join(", ")} [${d.ask}] `), ASK, ASK_WORDS, d.ask);
    if (!ask) throw new JoinError(`that is not one of ${ASK.join(", ")}. Nothing was changed; run the same patio join again`);
    const act = given.act ?? fromWords(await o.ask!(`2. May ${agent} change files for them? ${ACT.map((a) => `${ACT_WORDS[a]} (${a})`).join(", ")} [${d.act}] `), ACT, { ...ACT_WORDS, deny: "never" } as Record<Act, string>, d.act);
    if (!act) throw new JoinError(`that is not one of ${ACT.join(", ")}. Nothing was changed; run the same patio join again`);
    const answer = given.answer ?? fromWords(await o.ask!(`3. Should ${agent} answer ${workspace} on its own? (${ANSWER.join(", ")}) [${d.answer}] `), ANSWER, {} as Record<Answer, string>, d.answer as Answer);
    if (!answer) throw new JoinError(`that is not yes or no. Nothing was changed; run the same patio join again`);
    answers = { ask: ask as Ask, act: act as Act, answer: answer as Answer };
  }
  const next = applyAnswers(text, agent, answers, workspace);
  if (next === text) c.skip(`${title}:`);
  else {
    await writeFile(path, next, { mode: 0o600 });
    c.done(`${title} (${tilde(path)}):`);
  }
  for (const l of answerLines(answers, workspace)) c.say(l);
  if (Object.keys(card).length) {
    const r = await daemon.ruleRequest(cfg, { agent, workspace, answers: card, by: "join" });
    c.say(`  waits for you in the web app (${r.web_url}): ${r.sentences.join("; ")}`);
  }
  return { turnOn: answers.answer === "yes" && (!held || held.answer !== "yes") };
}

// Turns the agent's auto_answer_in list on (the person's answer), once patio has read the new file. True, or why not.
export async function turnOnAnswerIn(cfg: Config, agent: string, list: string[], by: "join" | "rules"): Promise<true | string> {
  let last = "";
  for (let i = 0; i < 20; i++) {
    try {
      await daemon.answerRule(cfg, agent, list, by);
      return true;
    } catch (err) {
      last = (err as Error).message;
      if (!/does not list exactly/.test(last)) return last;
      await Bun.sleep(250);
    }
  }
  return last;
}
