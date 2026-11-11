#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join as joinPath } from "node:path";
import { expandHome, loadConfig, tilde, type Config } from "./config";
import { startDaemon } from "./daemon";
import { checkGrants, formatGrantsCheck } from "./grants-check";
import { daemon, DaemonError, formatContacts, notRunning, waitForReplies, type SendStatus } from "./local";
import { answer, ANSWER_EXIT } from "./answer";
import { inboxTable, watch } from "./watch";
import { startMcp } from "./mcp";
import type { Kind } from "./protocol";
import { githubFromEnv, startExchange } from "./exchange";
import { dryRunExit, formatDryRun } from "./dryrun";
import { firstAgentAnswers, fromWords, join, JoinError, JoinNeedsAnswers, JoinPending, JoinWaiting, turnOnAnswerIn } from "./join";
import { ACT, ACT_WORDS, ANSWER, answerLines, answersFor, answerSentences, applyAnswers, ASK, ASK_WORDS, CapError, checkAnswers, DEFAULT_ANSWERS, splitWidening } from "./answers";
import { looksLikeLink, parseInviteLink } from "./links";
import { openDirectory } from "./directory";
import { parseDuration } from "./clock";
import { agentsTable, connectWarnings, formatStatus, type Status } from "./status";
import { installService, patioCommand } from "./service";
import { detectTool, installedTools } from "./detect";
import { agentPath, defaultAgentName, detectFolder, EMPTY_AGENT, isGitRepo, newAgentText, ownsName, parseAgentFile, rulesOf, TEMPLATE_FILE, toolLabel, validName } from "./agent-file";
import { applyConnect, CONNECT_TOOLS, isConnectTool, planConnect } from "./connect";
import { VERSION } from "./version";
import { canonical, helpFor, isHelpFlag, OVERVIEW } from "./help";

async function main() {
  const [given, ...rest] = process.argv.slice(2);
  // Help: patio, patio --help, patio help <command>, patio <command> --help (or -h).
  if (!given || given === "help" || isHelpFlag(given)) return console.log((given === "help" && rest[0] && helpFor(rest[0])) || OVERVIEW);
  if (rest.some(isHelpFlag) && helpFor(given)) return console.log(helpFor(given));
  const command = canonical(given);
  const cfg = loadConfig();

  switch (command) {
    case "server": {
      if (rest[0] === "demo-person") {
        // On the server's host: only its operator can open its database. Prints a one-time sign-in link.
        const { values, positionals } = parseArgs({ args: rest.slice(1), allowPositionals: true, options: { db: { type: "string" }, "public-url": { type: "string" } } });
        const [login] = positionals;
        if (!login || positionals.length > 1) throw new Usage("patio server demo-person <login> --db PATH [--public-url URL]");
        const db = expandHome(values.db ?? process.env.PATIO_EXCHANGE_DB ?? "~/.patio/exchange.db");
        if (!(await Bun.file(db).exists())) throw new Error(`no server database at ${db}: give the one the server uses with --db`);
        const dir = openDirectory(db);
        try {
          const d = dir.demoPerson(login);
          const base = (values["public-url"] ?? process.env.PATIO_EXCHANGE_PUBLIC_URL ?? "http://127.0.0.1:7777").replace(/\/$/, "");
          console.error(`${d.created ? "created" : "marked as demo"} @${login.replace(/^@/, "")}: labelled demo wherever others see them; a GitHub account with that login cannot sign in here`);
          console.error("one-time sign-in link, valid 10 minutes: open it, then sign in to that person's patio web app in the same browser");
          console.log(`${base}/auth/demo/${d.token}`);
        } finally {
          dir.db.close();
        }
        return;
      }
      const { values } = parseArgs({
        args: rest,
        options: { port: { type: "string" }, host: { type: "string" }, db: { type: "string" }, "public-url": { type: "string" }, dist: { type: "string" } },
      });
      const dist = values.dist ?? process.env.PATIO_DIST;
      startExchange({
        dist: dist ? expandHome(dist) : undefined,
        port: Number(values.port ?? process.env.PORT ?? 7777),
        hostname: values.host ?? "127.0.0.1",
        db: expandHome(values.db ?? process.env.PATIO_EXCHANGE_DB ?? "~/.patio/exchange.db"),
        github: githubFromEnv(),
        publicUrl: values["public-url"] ?? process.env.PATIO_EXCHANGE_PUBLIC_URL,
      });
      return;
    }
    case "status": {
      const { values } = parseArgs({ args: rest, options: { json: { type: "boolean" } } });
      const s = await daemon.status(cfg).catch((err) => {
        if (!(err instanceof DaemonError) || err.code !== "no_daemon") throw err;
        return null;
      });
      if (!s) {
        const local = await localAgents(cfg);
        const down = { running: false, healthy: false, agents: local, attention: [notRunning(cfg)] };
        console.log(values.json ? JSON.stringify(down) : `patio: not running\n\n${agentsTable(local, "this computer")}\n\nstatus: needs attention\n  - ${down.attention[0]}`);
        process.exit(1);
      }
      // The steps that are the person's: each agent's own coding tool lists patio, and the answer service can start it.
      const steps = await statusSteps(cfg, s);
      const s2 = { ...s, agents: (await daemon.status(cfg)).agents, steps, healthy: s.healthy && !steps.length };
      console.log(values.json ? JSON.stringify({ running: true, ...s2 }) : `${formatStatus(s2)}${steps.length ? `\n${steps.join("\n")}` : ""}`);
      process.exit(s2.healthy ? 0 : 1);
    }
    case "code": {
      const p = await daemon.pair(cfg, { interactive: interactive() });
      console.log(p.code);
      console.error(`Open ${p.web_url}/computers, sign in with GitHub and enter ${p.code} to confirm ${p.label} as your computer. The code expires in 10 minutes.`);
      return;
    }
    case "join":
    case "leave": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          as: { type: "string" },
          // With an invite link: the agent, its tool and folder, connecting the tool, and the waits.
          agent: { type: "string" },
          tool: { type: "string" },
          folder: { type: "string" },
          connect: { type: "boolean" },
          // The three answers (answers.ts).
          ask: { type: "string" },
          act: { type: "string" },
          answer: { type: "string" },
          "no-open": { type: "boolean" },
          "no-wait": { type: "boolean" },
          timeout: { type: "string" },
        },
      });
      const [target] = positionals;
      if (command === "join" && target && looksLikeLink(target)) return joinWithLink(cfg, target, values);
      // A word that is not a link, on a computer patio never set up: it cannot be a channel of yours.
      if (command === "join" && target && !existsSync(joinPath(cfg.home, "device.json"))) throw new Error("This is not an invite link. Paste the link from your invite page.");
      if (values.agent || values.tool || values.folder || values.connect || values["no-open"] || values["no-wait"] || values.timeout || values.ask || values.act || values.answer)
        throw new Usage("--agent, --tool, --folder, --connect, --ask, --act, --answer, --no-open, --no-wait and --timeout go with patio join <invite link>");
      if (!target || positionals.length > 1) throw new Usage(command === "leave" ? "patio leave <channel> [--as A]" : "patio join <invite link> [--agent NAME] … | patio join <channel> [--as A]");
      const as = values.as ?? (cfg.handle || undefined);
      const m = command === "leave" ? await daemon.leave(cfg, { as, channel: target }) : await daemon.join(cfg, { as, interactive: interactive(), channel: target });
      const what = `#${m.target}`;
      if (m.status === "approved") return console.log(`${what}: member`);
      if (m.status === "left") return console.log(`${what}: left`);
      if (m.status === "pending") {
        console.log(`${what}: waiting for you`);
        console.error(`Waiting for ${m.needs.join(" and ") || "you"} in the web app: ${m.web_url}`);
        process.exit(5);
      }
      console.log(`${what}: ${m.status}`);
      process.exit(1);
    }
    case "invite": {
      const { values } = parseArgs({ args: rest, options: { workspace: { type: "string" }, expires: { type: "string" }, uses: { type: "string" } } });
      if (!values.workspace) throw new Usage("patio invite --workspace <name> [--expires 7d] [--uses N]");
      if (!interactive()) throw new Error("patio invite runs only from your own terminal (an agent cannot create invite links); or create the link in the web app");
      const r = await daemon.invite(cfg, {
        workspace: values.workspace,
        expires_ms: values.expires ? (parseDuration(values.expires) ?? usage(`--expires is a duration like 7d, 12h or 30m, not ${values.expires}`)) : undefined,
        max_uses: values.uses ? Number(values.uses) : undefined,
        interactive: true,
      });
      console.log(r.url);
      console.error(`an invite link to ${r.workspace}${r.expires_at ? `, valid until ${new Date(r.expires_at).toISOString().slice(0, 16).replace("T", " ")} UTC` : ", with no expiry"}${r.max_uses ? `, for ${r.max_uses} use${r.max_uses === 1 ? "" : "s"}` : ""}. Revoke it in the web app.`);
      return;
    }
    case "agents":
      return agentsCommand(cfg, rest);
    case "connect": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { as: { type: "string" }, user: { type: "boolean" }, "dry-run": { type: "boolean" } } });
      const [tool] = positionals;
      const agent = values.as ?? (cfg.handle || undefined);
      if (!tool || positionals.length > 1 || !agent) throw new Usage(`patio connect <${CONNECT_TOOLS.join("|")}> --as <agent> [--user] [--dry-run]`);
      if (!isConnectTool(tool)) throw new Error(`patio connects ${CONNECT_TOOLS.join(", ")}; for another tool, add \`patio mcp --as ${agent}\` to its MCP servers by hand`);
      const file = await readAgentFile(cfg, agent);
      if (!file.folder && !values.user) throw new Error(`${agent} has no folder: set folder in ${agentPath(cfg.home, agent)}, or use --user`);
      const plan = planConnect({ tool, agent, folder: expandHome(file.folder ?? "."), user: values.user, patio: patioCommand() });
      console.log(`${toolLabel(tool)} runs patio as ${agent}: ${plan.say}`);
      if (plan.scope === "folder") console.log(`${plan.replaces ? "it replaces the patio entry there; " : ""}the file will read:\n${plan.text.trimEnd()}`);
      else for (const c of plan.commands) console.log(`  ${c.join(" ")}`);
      if (values["dry-run"]) return console.error("dry run: nothing written");
      await applyConnect(plan);
      console.error(`done: start a new ${toolLabel(tool)} session${plan.scope === "folder" ? ` in ${file.folder}` : ""} to use it${tool === "codex" && plan.scope === "folder" ? " (Codex reads a project's .codex/config.toml once you trust the project)" : tool === "pi" && plan.scope === "folder" ? " (Pi reads a project's .pi/mcp.json once you trust the project)" : ""}`);
      return;
    }
    case "workspace": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { agent: { type: "string" }, tool: { type: "string" }, folder: { type: "string" } } });
      const [sub, name] = positionals;
      if (sub !== "new" || !name || positionals.length > 2 || !values.agent) throw new Usage("patio workspace new <name> --agent <agent> [--tool T] [--folder D]");
      if (!interactive()) throw new Error("patio workspace new runs only from your own terminal (it creates an invite link); or create the workspace in the web app");
      const s = await daemon.status(cfg);
      if (!s.login) throw new Error("sign in on this computer first: patio join <link>, or patio code");
      if (!ownsName(s.login, values.agent)) throw new Error(`${values.agent} is not a name for an agent of @${s.login}; try ${defaultAgentName(s.login, values.agent)}`);
      await ensureAgentFile(cfg, values.agent, { tool: values.tool, folder: values.folder });
      const r = await daemon.workspaceNew(cfg, { name, agent: values.agent, interactive: true });
      console.log(r.url);
      console.error(`created ${r.workspace} with ${values.agent} in it${r.channels?.length ? ` and in ${r.channels.map((c) => `#${c}`).join(", ")}` : ""}. Share the invite link above; its page has the prompt to paste into a coding agent.`);
      return;
    }
    case "update": {
      if (rest.length) throw new Usage("patio update");
      const { update } = await import("./lifecycle");
      await update(cfg);
      return;
    }
    case "uninstall": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { binary: { type: "boolean" }, yes: { type: "boolean" } } });
      if (positionals.length) throw new Usage("patio uninstall [--binary] [--yes]");
      if (!values.yes) {
        if (!interactive()) throw new Error("patio uninstall takes patio off this computer for good: run it in your own terminal, or add --yes");
        process.stdout.write(
          `This stops patio and its answer service, takes your agents out of their workspaces, revokes this computer at the server, and removes the project entries patio wrote${values.binary ? ", and the patio binary" : ""}. Go on? [y/N] `,
        );
        const answer = await stdinLines.next();
        if (answer.done || !/^y(es)?$/i.test(answer.value.trim())) {
          console.log("nothing was changed");
          process.exit(1);
        }
      }
      const { uninstall } = await import("./lifecycle");
      const r = await uninstall(cfg, { binary: values.binary });
      process.exit(r.ok ? 0 : 1);
    }
    case "up": {
      const d = await startDaemon(cfg);
      const stop = async () => {
        await d.stop();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return;
    }
    case "mcp": {
      const { values } = parseArgs({ args: rest, options: { as: { type: "string" } } });
      return startMcp({ ...cfg, handle: values.as ?? cfg.handle });
    }
    case "guide": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { as: { type: "string" } } });
      if (positionals.length) throw new Usage("patio guide --as <agent>");
      console.log((await daemon.guide(cfg, values.as ?? (cfg.handle || undefined))).text);
      return;
    }
    case "version":
      return console.log(`patio ${VERSION}`);
    case "rules": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          from: { type: "string" },
          to: { type: "string" },
          channel: { type: "string" },
          kind: { type: "string" },
          outgoing: { type: "boolean" },
          json: { type: "boolean" },
          // The three answers of the join (answers.ts), to change them.
          ask: { type: "string" },
          act: { type: "string" },
          answer: { type: "string" },
          workspace: { type: "string" },
        },
      });
      const [agent, sub, ...words] = positionals;
      const usage =
        'patio rules <agent> [--ask questions|requests|anything] [--act ask-human|deny] [--answer yes|no [--workspace W]] | patio rules <agent> test "<text>" --from <agent> [--channel C] [--kind K] | patio rules <agent> test "<text>" --outgoing --to <agent> […]';
      if (!agent || !validName(agent)) throw new Usage(usage);
      if (!sub && (values.ask || values.act || values.answer)) return changeAnswers(cfg, agent, values);
      if (values.workspace) throw new Usage(usage);
      if (!sub) {
        // Reads the agent's file itself: patio need not run, and no judge is asked. A file with an error fails loudly.
        // An agent this computer does not have is an error, not the default rules of a name.
        const known = existsSync(agentPath(cfg.home, agent)) || !!(await daemon.status(cfg).catch(() => null))?.agents.some((a) => a.name === agent);
        if (!known) throw new Error(`no agent named ${agent} on this computer (patio agents)`);
        const file = await readAgentFile(cfg, agent);
        const r = checkGrants(rulesOf(agent, file, ALL_CONFIRMED));
        const path = agentPath(cfg.home, agent);
        if (values.json) console.log(JSON.stringify({ ...r, agent, path: existsSync(path) ? path : null }));
        else {
          console.log(`rules for ${agent} (in every workspace), in three sentences:`);
          for (const line of answerSentences(agent, file.rules)) console.log(`  ${line}`);
          console.log(`change them: patio rules ${agent} --ask … --act … --answer … (--ask ${ASK.join(", ")}; --act ${ACT.join(", ")}; --answer ${ANSWER.join(", ")})\n`);
          console.log(`in full, from ${existsSync(path) ? tilde(path) : "the default rules (no file): the join's defaults"}; auto_answer, auto_answer_in and lists of actions apply once you turn them on (in the web app, or with your answer to patio join):`);
          console.log(formatGrantsCheck({ ...r, file: true }));
          console.error(`edit ${path}; patio reloads it when you save it`);
        }
        process.exit(r.warnings.length ? 1 : 0);
      }
      if (sub !== "test" || !words.length) throw new Usage(usage);
      if (values.outgoing ? values.from : values.to) throw new Usage(usage);
      const r = await daemon.grantsTest(cfg, {
        text: words.join(" "),
        as: agent,
        from: values.from,
        to: values.to,
        channel: values.channel,
        kind: values.kind as Kind | undefined,
        outgoing: values.outgoing,
      });
      console.log(values.json ? JSON.stringify(r) : formatDryRun(r));
      process.exit(dryRunExit(r));
    }
    case "service": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { answer: { type: "boolean" }, uninstall: { type: "boolean" }, name: { type: "string" } },
      });
      if (positionals[0] !== "install" || positionals.length > 1) throw new Usage("patio service install [--answer] [--uninstall] [--name N]");
      console.log(await installService(cfg, { answer: values.answer, uninstall: values.uninstall, name: values.name }));
      return;
    }
    case "outbox": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { json: { type: "boolean" } } });
      const [sub, id] = positionals;
      if (sub === "cancel") {
        if (!id) throw new Usage("patio outbox cancel <id>");
        const r = await daemon.cancelOutbox(cfg, id);
        console.error(`cancelled ${r.id.slice(0, 8)}; it will not be sent`);
        return;
      }
      if (sub) throw new Usage("patio outbox [--json] | patio outbox cancel <id>");
      const o = await daemon.outbox(cfg);
      if (values.json) return o.items.forEach((i) => console.log(JSON.stringify(i)));
      if (!o.items.length) return console.log("the outbox is empty");
      for (const i of o.items) {
        const text = i.text.replace(/\s+/g, " ");
        console.log(`${i.id.slice(0, 8)}  ${i.convo.slice(0, 8)}  ${i.to}  [${i.kind}]  queued ${new Date(i.queued_at).toISOString().slice(0, 16).replace("T", " ")}  ${text.length > 60 ? text.slice(0, 59) + "…" : text}`);
      }
      console.error(o.connected ? "sending now" : `waiting for the server; each expires unsent ${Math.round(o.ttl_ms / 86_400_000)} days after it was queued`);
      return;
    }
    case "contacts": {
      const { values } = parseArgs({ args: rest, options: { json: { type: "boolean" } } });
      const { contacts, web_url } = await daemon.contacts(cfg);
      if (values.json) return contacts.forEach((c) => console.log(JSON.stringify(c)));
      if (!contacts.length) return console.log("no contacts yet: keys are pinned the first time you write to or hear from an agent");
      console.log(formatContacts(contacts, web_url));
      return;
    }
    case "who": {
      // Every agent of your agents' workspaces: pablo-orbit · @pablo · online · answers on its own.
      const { members, connected } = await daemon.who(cfg);
      if (!connected) console.error("not connected to the server: this list is missing");
      if (!members.length) return console.log("nobody yet: your agents are in no workspace with other agents");
      for (const m of members)
        console.log(`${m.agent} · @${m.owner} · ${m.yours ? "yours" : `${m.online ? "online" : "offline"} · ${m.answers === "self" ? "answers on its own" : `answered by @${m.owner}, may take hours`}`}`);
      return;
    }
    case "ask": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          kind: { type: "string", default: "question" },
          as: { type: "string" },
          channel: { type: "string" },
          repo: { type: "string" },
          pr: { type: "string" },
          file: { type: "string", multiple: true },
          wait: { type: "boolean" },
          timeout: { type: "string", default: "600" },
        },
      });
      const [to, ...words] = values.channel ? [undefined, ...positionals] : positionals;
      if ((!to && !values.channel) || !words.length) throw new Usage("patio ask <to> <text…> | patio ask --channel <channel> <text…>");
      const sent = await daemon.send(cfg, {
        ...(values.channel ? { channel: values.channel } : { to }),
        as: values.as ?? (cfg.handle || undefined),
        kind: values.kind as Kind,
        text: words.join(" "),
        context: { repo: values.repo, pr: values.pr, files: values.file },
      });
      const { convo, status } = sent;
      if (status === "held") return held(sent);
      if (sent.channel) console.error(`sent to ${sent.recipients} agent${sent.recipients === 1 ? "" : "s"} of #${sent.channel.name} in ${sent.channel.workspace}`);
      else if (status === "queued") console.error(`${to} is offline; queued at the server until they connect`);
      else if (status === "outbox") console.error(OUTBOX_SAYS);
      if (sent.answers) console.error(sent.answers);
      if (!values.wait) return console.log(convo);
      console.error(`${status}; waiting for ${sent.channel ? "replies" : to} (convo ${convo})`);
      return printReplies(await waitForReplies(cfg, convo, Number(values.timeout)));
    }
    case "wait": {
      // --as like the other agent commands; the wait itself is on the conversation, whoever sent it.
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { timeout: { type: "string", default: "600" }, as: { type: "string" } },
      });
      const convo = positionals[0];
      if (!convo) throw new Usage("patio wait <id> [--as A] [--timeout secs]");
      return printReplies(await waitForReplies(cfg, convo, Number(values.timeout)));
    }
    case "reply": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { as: { type: "string" } } });
      const [ref, ...words] = positionals;
      if (!ref || !words.length) throw new Usage("patio reply <convo|id> <text…> [--as A]");
      const sent = await daemon.reply(cfg, ref, words.join(" "), values.as ?? (cfg.handle || undefined));
      if (sent.status === "held") return held(sent);
      if (sent.status === "queued") console.error("the sender is offline; queued at the server until they connect");
      if (sent.status === "outbox") console.error(OUTBOX_SAYS);
      return;
    }
    case "inbox": {
      const { values } = parseArgs({
        args: rest,
        options: { as: { type: "string" }, unread: { type: "boolean" }, all: { type: "boolean" }, rejected: { type: "boolean" }, json: { type: "boolean" } },
      });
      const filter = values.rejected ? "rejected" : values.unread ? "unread" : values.all ? "all" : "open";
      const { messages } = await daemon.inbox(cfg, { filter, as: values.as ?? (cfg.handle || undefined) });
      if (values.json) return messages.forEach((m) => console.log(JSON.stringify(m)));
      if (!messages.length)
        return console.log({ unread: "no unread messages", rejected: "no rejected messages", all: "inbox is empty", open: "inbox is empty" }[filter]);
      console.log(inboxTable(messages));
      return;
    }
    case "answer": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { as: { type: "string" }, tool: { type: "string" }, folder: { type: "string" }, "in-place": { type: "boolean" } },
      });
      const [id] = positionals;
      if (!id) throw new Usage("patio answer <id> [--as A] [--tool T] [--folder D] [--in-place]");
      const r = await answer(cfg, id, { as: values.as ?? (cfg.handle || undefined), tool: values.tool, folder: values.folder, ...(values["in-place"] ? { in_place: true } : {}) });
      const say = {
        answered: r.status === "outbox" ? `the reply to ${r.id.slice(0, 8)} is ${OUTBOX_SAYS}` : `answered ${r.id.slice(0, 8)} (${r.status})`,
        held: r.reason?.includes("keys changed")
          ? `the reply to ${r.id.slice(0, 8)} is waiting for you: ${r.reason}: ${r.web_url}`
          : `the reply to ${r.id.slice(0, 8)} is waiting for you: your rules (outgoing) hold it (${r.reason}); decide in the web app: ${r.web_url}`,
        blocked: `the reply to ${r.id.slice(0, 8)} was ${r.reason}; the message is marked failed`,
        already_claimed: r.reason,
        already_replied: r.reason,
        agent_failed: `${r.reason}; the message is marked failed`,
        error: r.reason,
      }[r.result];
      console.error(say);
      process.exit(ANSWER_EXIT[r.result]);
    }
    case "dismiss": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { as: { type: "string" } } });
      const [id] = positionals;
      if (!id) throw new Usage("patio dismiss <id> [--as A]");
      const d = await daemon.dismiss(cfg, id, values.as ?? (cfg.handle || undefined));
      console.error(`dismissed ${d.id.slice(0, 8)}`);
      return;
    }
    case "reject": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { reason: { type: "string" }, as: { type: "string" } } });
      const [id] = positionals;
      if (!id || positionals.length > 1) throw new Usage("patio reject <id> [--as A] [--reason <text>]");
      const r = await daemon.reject(cfg, id, values.reason, values.as ?? (cfg.handle || undefined));
      console.error(`rejected ${r.id.slice(0, 8)}; the sender was told${values.reason ? ", with your reason" : ""}`);
      return;
    }
    case "read": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { as: { type: "string" } } });
      const [id] = positionals;
      if (!id) throw new Usage("patio read <id> [--as A]");
      const { message: m } = await daemon.read(cfg, id, values.as ?? (cfg.handle || undefined));
      const ctx = m.context;
      const about = [ctx?.repo && `repo ${ctx.repo}`, ctx?.pr && `PR ${ctx.pr}`, ctx?.files?.length && `files ${ctx.files.join(", ")}`].filter(Boolean);
      console.log(
        [
          `id: ${m.id}`,
          `convo: ${m.convo}`,
          `from: ${m.from}`,
          `kind: ${m.kind}`,
          ...(m.channel ? [`channel: #${m.channel.name} in ${m.channel.workspace} (as ${m.local_agent})`] : []),
          ...(m.in_reply_to ? [`in reply to: ${m.in_reply_to}`] : []),
          `sent: ${new Date(m.ts).toISOString()}`,
          ...(about.length ? [`about: ${about.join("; ")}`] : []),
          `state: ${m.state}${m.state_reason ? ` (${m.state_reason})` : ""}`,
          ...(m.not_reviewed ? ["not reviewed: it waited for you and nobody decided in time, so it was delivered unreviewed"] : []),
          ...(m.allowed_action ? [`allowed action: ${m.allowed_action}`] : []),
          "",
          m.text,
        ].join("\n"),
      );
      return;
    }
    case "watch": {
      const { values } = parseArgs({
        args: rest,
        options: {
          once: { type: "boolean" },
          json: { type: "boolean" },
          answer: { type: "boolean" },
          exec: { type: "string" },
          as: { type: "string" },
          tool: { type: "string" },
          folder: { type: "string" },
          "in-place": { type: "boolean" },
        },
      });
      if (values.answer && values.exec !== undefined) throw new Usage("patio watch takes --answer or --exec, not both");
      if ((values.tool || values.folder || values["in-place"]) && !values.answer) throw new Usage("--tool, --folder and --in-place go with patio watch --answer");
      const { "in-place": inPlace, as, ...rest_ } = values;
      process.exit(await watch(cfg, { ...rest_, as: as ?? (cfg.handle || undefined), ...(inPlace ? { in_place: true } : {}) }));
    }
    default:
      console.error(`unknown command: ${given}`);
      console.error(OVERVIEW);
      process.exit(1);
  }
}

class Usage extends Error {}
const usage = (text: string): never => {
  throw new Usage(text);
};

// The person's own interactive terminal: what they start here needs no second confirmation (README, who confirms
// what). An agent's command usually has no terminal; one that fakes it is the accepted weakness of this signal.
const interactive = () => !!process.stdin.isTTY && !!process.stdout.isTTY;

// Every widening setting counts as on, to show the rules as written (the web app says which are turned on).
const ALL_CONFIRMED = { has: () => true } as unknown as Set<string>;

// The agent's file, or the default rules when it has none. A file with an error fails loudly here.
async function readAgentFile(cfg: Config, agent: string) {
  const path = agentPath(cfg.home, agent);
  if (!existsSync(path)) return EMPTY_AGENT;
  return parseAgentFile(await Bun.file(path).text(), agent);
}

// Writes agents/<name>.yaml when it is missing (from ~/.patio/new-agent.yaml when there is one). Returns the path.
async function ensureAgentFile(cfg: Config, name: string, o: { tool?: string; folder?: string }) {
  const path = agentPath(cfg.home, name);
  if (existsSync(path)) {
    if (o.tool || o.folder) console.error(`${path} exists: patio keeps it (edit it to change the tool or folder)`);
    return { path, created: false };
  }
  const tool = o.tool ?? detectTool()?.tool ?? installedTools()[0];
  if (!tool) throw new Error(`which coding tool answers for ${name}? Say it with --tool (claude, codex, pi, hermes-docker, gemini, or an ACP command)`);
  const folder = expandHome(o.folder ?? detectFolder());
  const templatePath = joinPath(cfg.home, TEMPLATE_FILE);
  const template = existsSync(templatePath) ? await Bun.file(templatePath).text() : null;
  const text = newAgentText({ name, tool, folder }, template);
  parseAgentFile(text, name);
  await mkdir(joinPath(cfg.home, "agents"), { recursive: true, mode: 0o700 });
  await writeFile(path, text, { mode: 0o600 });
  console.error(`wrote ${path}: ${toolLabel(tool)} in ${folder}`);
  if (!isGitRepo(folder)) console.error(`note: ${folder} is not a git repository, so ${name} answers in it directly, not in a disposable copy`);
  return { path, created: true };
}

// The agents of this computer from their files alone (patio is not running).
async function localAgents(cfg: Config): Promise<Status["agents"]> {
  const { readdirSync } = await import("node:fs");
  const dir = joinPath(cfg.home, "agents");
  const names = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".yaml")).map((f) => f.slice(0, -5)).filter(validName) : [];
  const { connectedTools } = await import("./connect");
  return Promise.all(
    names.map(async (name) => {
      let file = EMPTY_AGENT;
      let error: string | null = null;
      try {
        file = await readAgentFile(cfg, name);
      } catch (err) {
        error = (err as Error).message;
      }
      return { name, status: "not registered" as const, workspaces: [], tool: file.tool ?? null, folder: file.folder ?? null, in_place: file.in_place ?? false, file: true, error, connected: connectedTools(name, file.folder ? expandHome(file.folder) : null) };
    }),
  );
}

// `patio status`: for each agent in a workspace, its own coding tool's listing (run now) and the answer service's
// preflight (run again when the last one failed or is older than 10 minutes). A "!" line for each step that is the
// person's; the results go to checks.json, which the web app reads.
async function statusSteps(cfg: Config, s: Status): Promise<string[]> {
  const { checkTool, connectedTools, isConnectTool } = await import("./connect");
  const { preflight, preflightOff, readChecks, recordChecks, serviceRunEnv } = await import("./preflight");
  const { answerServiceState } = await import("./service");
  const steps: string[] = [];
  const service = answerServiceState(cfg) === "present";
  for (const a of s.agents.filter((x) => x.status === "approved" && x.workspaces.length && x.tool)) {
    const folder = a.folder ? expandHome(a.folder) : null;
    if (isConnectTool(a.tool!) && folder) {
      if (!connectedTools(a.name, folder).some((c) => c.split(" ")[0] === a.tool)) steps.push(`! ${a.name}: ${toolLabel(a.tool!)} does not run patio in ${tilde(folder)}: patio connect ${a.tool} --as ${a.name}`);
      else {
        const r = checkTool(a.tool!, folder);
        await recordChecks(cfg.home, (c) => void (c.tools[a.name] = { ...(c.tools[a.name] ?? {}), [a.tool!]: { ok: r.ok, said: r.said, ...(r.ok ? {} : { step: r.step }), at: Date.now() } }));
        if (!r.ok) steps.push(`! ${a.name}: ${toolLabel(a.tool!)}: ${r.step.replaceAll(folder, tilde(folder))} (${toolLabel(a.tool!)} says: ${r.said.replaceAll(folder, tilde(folder))})`);
      }
    }
    if (!service || preflightOff()) continue;
    const last = readChecks(cfg.home).preflight[a.name];
    if (last?.ok && Date.now() - last.at < 10 * 60_000) continue;
    const file = await readAgentFile(cfg, a.name);
    const r = await preflight(a.name, { tool: a.tool!, folder: a.folder!, model: file.model, effort: file.effort }, serviceRunEnv(cfg));
    await recordChecks(cfg.home, (c) => void (c.preflight[a.name] = { ok: r.ok, ...(r.ok ? {} : { reason: r.reason }), at: Date.now() }));
    if (!r.ok) steps.push(`! ${a.name}: answering: ${toolLabel(a.tool!)} does not start for the answer service: ${r.reason}`);
  }
  return steps;
}

// `patio agents [new|add|remove]`.
async function agentsCommand(cfg: Config, args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { tool: { type: "string" }, folder: { type: "string" }, json: { type: "boolean" } } });
  const [sub, name, workspace] = positionals;
  const status = await daemon.status(cfg).catch((err) => {
    if (err instanceof DaemonError && err.code === "no_daemon") return null;
    throw err;
  });
  if (!sub) {
    const rows = status ? status.agents : await localAgents(cfg);
    if (values.json) return rows.forEach((r) => console.log(JSON.stringify(r)));
    console.log(agentsTable(rows, status?.label ?? "this computer"));
    for (const w of connectWarnings(rows)) console.error(`warning: ${w}`);
    if (!status) console.error(`${notRunning(cfg)}; until then the server's view (workspaces) is missing`);
    return;
  }
  if (sub === "new") {
    if (!name || positionals.length > 2) throw new Usage("patio agents new <name> [--tool T] [--folder D]");
    if (!validName(name)) throw new Error(`${name} is not an agent name: lowercase letters, digits, - and _ (up to 32)`);
    if (status?.login && !ownsName(status.login, name)) throw new Error(`${name} is not a name for an agent of @${status.login}: an agent's name starts with your login and a hyphen; try ${defaultAgentName(status.login, name)}`);
    const { path, created } = await ensureAgentFile(cfg, name, values);
    // In the person's terminal, a new agent asks the three questions, the first agent's answers as the defaults.
    if (created && interactive()) await askNewAgent(cfg, name, path);
    if (!status?.login) {
      console.log(`${name}: ${created ? "created" : "exists"} (${tilde(path)}); it joins a workspace with patio join <link> --agent ${name}`);
      process.exit(0);
    }
    const { agent, web_url } = await daemon.register(cfg, name, interactive());
    if (agent.status === "approved") {
      console.log(`${name}: your agent (${tilde(path)}), in no workspace yet; put it in one with patio agents add ${name} <workspace>`);
      process.exit(0);
    }
    if (agent.status === "pending") {
      console.log(`${name}: waiting for you`);
      console.error(`Confirm it in the web app: ${web_url}`);
      process.exit(5);
    }
    console.log(`${name}: ${agent.status}`);
    process.exit(1);
  }
  if (sub === "add" || sub === "remove") {
    if (!name || !workspace || positionals.length > 3) throw new Usage(`patio agents ${sub} <agent> <workspace>`);
    if (!status) throw new DaemonError(notRunning(cfg), "no_daemon");
    if (sub === "remove") {
      const m = await daemon.leaveWorkspace(cfg, { as: name, workspace });
      return console.log(`${name}: left ${m.target}`);
    }
    if (!status.agents.some((a) => a.name === name && a.status === "approved")) {
      if (!existsSync(agentPath(cfg.home, name))) throw new Error(`${name} is not an agent of this computer: patio agents new ${name} first`);
      const { agent } = await daemon.register(cfg, name, interactive());
      if (agent.status !== "approved") {
        // The add waits with the agent's own card: one click confirms the agent and its join of the workspace.
        await daemon.pendingAdd(cfg, name, workspace);
        console.log(`${name}: waiting for you`);
        console.error(`Confirm ${name} in the web app: one card covers it and its join of ${workspace}: ${status.web_url}`);
        process.exit(5);
      }
    }
    const m = await daemon.join(cfg, { as: name, workspace, interactive: interactive() });
    if (m.status === "approved") {
      await answerAdded(cfg, name, m.target);
      return console.log(`${name}: in ${m.target} and its default channels`);
    }
    if (m.status === "pending") {
      console.log(`${name}: waiting for you`);
      console.error(`Confirm it in the web app: ${m.web_url}`);
      process.exit(5);
    }
    console.log(`${name}: ${m.status} in ${m.target}`);
    process.exit(1);
  }
  throw new Usage("patio agents | patio agents new <name> [--tool T] [--folder D] | patio agents add|remove <agent> <workspace>");
}

// `patio agents new` in the person's terminal: the three questions, the first agent's answers as the defaults. The
// agent is in no workspace yet: the third answer applies to the workspaces `patio agents add` puts it in.
async function askNewAgent(cfg: Config, name: string, path: string) {
  const d = firstAgentAnswers(cfg.home, name) ?? DEFAULT_ANSWERS;
  console.log(`Three questions about what others may do with ${name} (Enter keeps the default in brackets):`);
  const line = async (q: string) => {
    process.stdout.write(q);
    const l = await stdinLines.next();
    return l.done ? "" : l.value;
  };
  const ask = fromWords(await line(`1. What may others ask ${name}? ${ASK.map((a) => `${ASK_WORDS[a]} (${a})`).join(", ")} [${d.ask}] `), ASK, ASK_WORDS, d.ask);
  if (!ask) throw new Error(`that is not one of ${ASK.join(", ")}; ${name} keeps the defaults (patio rules ${name} changes them)`);
  const act = fromWords(await line(`2. May ${name} change files for them? ${ACT.map((a) => `${ACT_WORDS[a]} (${a})`).join(", ")} [${d.act}] `), ACT, { ...ACT_WORDS, deny: "never" }, d.act);
  if (!act) throw new Error(`that is not one of ${ACT.join(", ")}; ${name} keeps the defaults (patio rules ${name} changes them)`);
  const answer = fromWords(await line(`3. Should ${name} answer on its own the workspaces you add it to? (${ANSWER.join(", ")}) [${d.answer}] `), ANSWER, {} as Record<(typeof ANSWER)[number], string>, d.answer);
  if (!answer) throw new Error(`that is not yes or no; ${name} keeps the defaults (patio rules ${name} changes them)`);
  const text = await Bun.file(path).text();
  await writeFile(path, applyAnswers(text, name, { ask, act, answer }, null), { mode: 0o600 });
  console.log(`rules for ${name} (in every workspace), from your answers:`);
  for (const l of answerLines({ ask, act, answer }, "the workspaces you add it to")) console.log(l);
}

// After `patio agents add`: the third answer of `patio agents new` ("yes") for this workspace, as the person gave it.
async function answerAdded(cfg: Config, name: string, workspace: string) {
  const path = agentPath(cfg.home, name);
  if (!existsSync(path)) return;
  const text = await Bun.file(path).text();
  const file = parseAgentFile(text, name);
  // Asked at patio agents new (answer_added says so): the workspace gets those answers. Never asked: it waits for them.
  if (file.answer_added === undefined || file.asked_in?.includes(workspace)) return;
  const next = applyAnswers(text, name, { ...answersFor(file.rules, workspace), answer: file.answer_added ? "yes" : "no" }, workspace);
  await writeFile(path, next, { mode: 0o600 });
  if (!file.answer_added) return;
  const list = parseAgentFile(next, name).rules.defaults.auto_answer_in ?? [];
  const on = await turnOnAnswerIn(cfg, name, list, "rules");
  console.error(on === true ? `${name} answers ${workspace} on its own (your answer to patio agents new)` : `answering ${workspace} on its own waits for you in the web app (${on})`);
}

// `patio rules <agent> --ask … --act … --answer …`: the three answers again, with the join's caps, for one workspace.
async function changeAnswers(cfg: Config, agent: string, v: { ask?: string; act?: string; answer?: string; workspace?: string }): Promise<never> {
  const path = agentPath(cfg.home, agent);
  if (!existsSync(path)) throw new Error(`${agent} has no file here (${path}): patio join <link> --agent ${agent} sets it up`);
  const text = await Bun.file(path).text();
  const file = parseAgentFile(text, agent);
  const status = await daemon.status(cfg).catch(() => null);
  const inWs = status?.agents.find((a) => a.name === agent)?.workspaces ?? file.asked_in ?? [];
  const workspace = v.workspace ?? (inWs.length === 1 ? inWs[0]! : null);
  if (!workspace) throw new Usage(`${agent} is in ${inWs.length ? inWs.join(", ") : "no workspace"}: say which one with --workspace <name>`);
  if (!inWs.includes(workspace)) throw new Error(`${agent} is not in ${workspace}: it answers on its own only the workspaces it is in (${inWs.join(", ") || "none"}). Nothing was changed.`);
  let given;
  try {
    given = checkAnswers({ ask: v.ask, act: v.act, answer: v.answer }, workspace);
  } catch (err) {
    if (err instanceof CapError) throw new Error(`${err.message}. Nothing was changed.`);
    throw err;
  }
  // From the person's own terminal it applies at once. From an agent, what widens waits for the person in the web app
  // (a card), and what narrows applies at once.
  const current = answersFor(file.rules, workspace);
  const { now, wider } = interactive() ? { now: { ...current, ...given }, wider: {} } : splitWidening(current, given);
  const next = applyAnswers(text, agent, now, workspace);
  if (next !== text) await writeFile(path, next, { mode: 0o600 });
  console.log(`${next === text ? "unchanged" : "changed"}: rules for ${agent} (in every workspace), from your answers (${tilde(path)}):`);
  for (const l of answerLines(now, workspace)) console.log(l);
  if (Object.keys(wider).length) {
    if (!status) throw new Error("patio is not running on this computer, and this change widens what others can do: it needs you in the web app. Start patio, or run it in your own terminal.");
    const r = await daemon.ruleRequest(cfg, { agent, workspace, answers: wider, by: "rules" });
    console.log(`waits for you in the web app (${r.web_url}): ${r.sentences.join("; ")}`);
    process.exit(5);
  }
  const list = parseAgentFile(next, agent).rules.defaults.auto_answer_in ?? [];
  if (list.length && now.answer === "yes" && current.answer !== "yes") {
    const on = status ? await turnOnAnswerIn(cfg, agent, list, "rules") : "patio is not running";
    if (on !== true) console.error(`answering on its own waits for you in the web app (${on})`);
  }
  process.exit(0);
}

// The person's answers in their terminal, a line at a time (one reader for every question).
const stdinLines = (async function* () {
  for await (const line of console) yield line;
})();

// `patio join <link>` (join.ts), with its errors shown plainly.
async function joinWithLink(
  cfg: Config,
  raw: string,
  v: { agent?: string; tool?: string; folder?: string; connect?: boolean; ask?: string; act?: string; answer?: string; "no-open"?: boolean; "no-wait"?: boolean; timeout?: string },
): Promise<never> {
  const link = parseInviteLink(raw);
  if (!link) throw new Error("This is not an invite link. Paste the link from your invite page.");
  const shellWord = (w: string) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);
  try {
    await join(cfg, {
      link,
      command: ["patio", ...process.argv.slice(2)].map(shellWord).join(" "),
      ask: async (question) => {
        process.stdout.write(question);
        const line = await stdinLines.next();
        return line.done ? "" : line.value;
      },
      answers: { ask: v.ask, act: v.act, answer: v.answer },
      agent: v.agent,
      tool: v.tool,
      folder: v.folder ? expandHome(v.folder) : undefined,
      connect: v.connect,
      open: !v["no-open"],
      timeoutSeconds: v.timeout ? Number(v.timeout) : undefined,
      interactive: interactive(),
      wait: !v["no-wait"],
    });
  } catch (err) {
    if (!(err instanceof JoinError)) throw err;
    console.error(err.message);
    process.exit(err instanceof JoinWaiting ? 5 : err instanceof JoinPending ? 12 : err instanceof JoinNeedsAnswers ? 13 : 1);
  }
  process.exit(0);
}

const OUTBOX_SAYS = "queued, will send when the server is reachable (patio outbox lists it; patio outbox cancel <id> takes it back)";

// The owner's rules (outgoing) hold the message: it is sent only if the owner approves it in the web app. Exit 7.
function held(sent: SendStatus): never {
  console.log(sent.convo);
  if (sent.reason?.includes("keys changed")) console.error(`waiting for you, not sent: ${sent.reason}: ${sent.web_url}`);
  else console.error(`waiting for you: your rules (outgoing) hold it (${sent.reason}); decide in the web app: ${sent.web_url}`);
  process.exit(7);
}


// One line per reply, `<agent>: <text>`. Exit 2 when none arrived.
function printReplies(res: Awaited<ReturnType<typeof waitForReplies>>) {
  if (res.not_sent) {
    console.error(res.not_sent);
    process.exit(11);
  }
  if (!res.replies.length) {
    console.error(res.broadcast ? "no replies before the timeout" : `no reply before the timeout${res.waiting_on ? `: ${res.waiting_on.say}` : ""}`);
    process.exit(2);
  }
  for (const r of res.replies) console.log(`${r.from}: ${r.text}`);
}

main().catch((err) => {
  if (err instanceof Usage) console.error(`usage: ${err.message}`);
  else console.error(err instanceof Error ? err.message : err);
  const code =
    err instanceof DaemonError
      ? ({ unreachable: 3, not_allowed: 4, reply_to_reply: 6, already_replied: 6, already_rejected: 6, already_dismissed: 6, blocked: 8, already_claimed: 9 } as Record<string, number>)[err.code]
      : undefined;
  process.exit(code ?? 1);
});
