// `patio watch`: consume the inbox as messages arrive, or once (`--once`, for cron).
//
//   patio watch [--json]                stream each new message
//   patio watch --once [--json]         print what is pending (unread, or claimed with a lapsed lease) and exit
//   patio watch --answer [--once]       `answer` each pending question or request whose rules have auto_answer, with
//                                       the tool and folder of the agent it reached (every agent of this computer)
//   patio watch --exec <cmd> [--once]   run <cmd> (through sh) for each pending message, with the message as one
//                                       JSON line on stdin and never in the command line; exit 0 marks it read
//
// With --answer or --exec, one JSON line per message handled goes to stdout. Each message is handled at most
// once per watch process.
import { scrubEnv } from "./acp";
import { answer, type AnswerOptions } from "./answer";
import type { Config } from "./config";
import type { PublicItem } from "./inbox";
import { daemon, DaemonError, notRunning } from "./local";
import { table } from "./status";

// `as`: only this agent's messages. `tool`, `folder`, `in_place`: override every agent's file (patio watch --answer).
export type WatchOptions = { once?: boolean; json?: boolean; answer?: boolean; exec?: string; as?: string; tool?: string; folder?: string; in_place?: boolean };
type Out = { out: (line: string) => void; err: (line: string) => void };

// One message as a row: unread mark, its id (the message's: every command takes it, or the conversation's id), who sent
// it, its kind and state, and the text.
const cells = (m: PublicItem) => {
  const text = m.text.replace(/\s+/g, " ");
  const where = m.channel ? `#${m.channel.name} · ` : "";
  const shown = `${where}${text}`;
  return [m.state === "unread" ? "*" : "", m.id.slice(0, 8), m.from, m.kind, `${m.state}${m.not_reviewed ? " (not reviewed)" : ""}`, shown.length > 80 ? shown.slice(0, 79) + "…" : shown];
};

export function inboxLine(m: PublicItem) {
  return table([cells(m)]);
}

// `patio inbox`: a header row, then one row per message.
export function inboxTable(messages: PublicItem[]) {
  return table([["", "ID", "FROM", "KIND", "STATE", "MESSAGE"], ...messages.map(cells)]);
}

const show = (m: PublicItem, json?: boolean) => (json ? JSON.stringify(m) : inboxLine(m));

// The owner's script gets the owner's environment (it may call patio itself, so PATIO_* stays) without the TypeSafe
// key or the GitHub OAuth secret (security audit S2), and the message's id, conversation and kind.
export function execEnv(base: NodeJS.ProcessEnv, home: string, m: { id: string; convo: string; kind: string }): Record<string, string | undefined> {
  return { ...scrubEnv(base, ["TYPESAFE_", "GITHUB_CLIENT_"]), PATIO_HOME: home, PATIO_MESSAGE_ID: m.id, PATIO_MESSAGE_CONVO: m.convo, PATIO_MESSAGE_KIND: m.kind };
}

// Runs the command with the message on stdin. Its own output goes to stderr, so stdout stays JSON lines.
async function execFor(cfg: Config, cmd: string, m: PublicItem) {
  const proc = Bun.spawn(["sh", "-c", cmd], {
    stdin: new Blob([JSON.stringify(m) + "\n"]),
    stdout: "pipe",
    stderr: "pipe",
    env: execEnv(process.env, cfg.home, m),
  });
  const [o, e] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if (o.trim()) process.stderr.write(o.endsWith("\n") ? o : o + "\n");
  if (e.trim()) process.stderr.write(e.endsWith("\n") ? e : e + "\n");
  return proc.exited;
}

export async function watch(cfg: Config, opts: WatchOptions, io: Out = { out: (l) => console.log(l), err: (l) => console.error(l) }): Promise<number> {
  const acting = opts.answer || opts.exec !== undefined;
  if (!acting && opts.once) {
    for (const m of (await daemon.pending(cfg, opts.as)).messages) io.out(show(m, opts.json));
    return 0;
  }
  const done = new Set<string>();
  const handle = async () => {
    for (const m of (await daemon.pending(cfg, opts.as)).messages) {
      if (done.has(m.id)) continue;
      done.add(m.id);
      const { auto_answer, ...msg } = m;
      if (opts.answer) {
        if (m.kind !== "question" && m.kind !== "request") continue;
        // Held as doubtful and delivered only because nobody reviewed it in time: a person answers it, not watch.
        if (m.not_reviewed) {
          io.err(`skipped ${m.id.slice(0, 8)} from ${m.from}: it was not reviewed (it waited for you and nobody decided in time); answer it with patio answer ${m.id.slice(0, 8)}`);
          continue;
        }
        if (!auto_answer) {
          io.err(`skipped ${m.id.slice(0, 8)} from ${m.from}: its rules do not allow auto_answer (answer it with patio answer ${m.id.slice(0, 8)})`);
          continue;
        }
        // Each message is answered by the agent it reached, with that agent's tool and folder.
        const r = await answer(cfg, m.id, { tool: opts.tool, folder: opts.folder, ...(opts.in_place ? { in_place: true } : {}), log: io.err } satisfies AnswerOptions);
        io.out(
          JSON.stringify({
            id: m.id,
            from: m.from,
            to: m.local_agent || m.to,
            kind: m.kind,
            result: r.result,
            ...(r.reason ? { reason: r.reason } : {}),
            ...(r.workdir?.mode === "worktree" ? { discarded: r.workdir.discarded } : {}),
          }),
        );
      } else {
        const code = await execFor(cfg, opts.exec!, msg);
        if (code === 0) await daemon.read(cfg, m.id).catch(() => {});
        io.out(JSON.stringify({ id: m.id, from: m.from, kind: m.kind, exit_code: code }));
      }
    }
  };

  if (opts.once) {
    await handle();
    return 0;
  }
  // Subscribe first, then deal with what is pending, then with each new arrival, one pass at a time.
  const res = await fetch("http://daemon/watch", { unix: cfg.socket } as RequestInit).catch(() => null);
  if (!res?.body) throw new DaemonError(notRunning(cfg), "no_daemon");
  let running: Promise<void> = Promise.resolve();
  const kick = () => (running = running.then(handle).catch((err) => io.err(`watch: ${(err as Error).message}`)));
  if (acting) kick();
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of res.body) {
    buffered += typeof chunk === "string" ? chunk : decoder.decode(chunk as Uint8Array, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop()!;
    for (const line of lines.filter(Boolean)) {
      if (acting) kick();
      else io.out(opts.json ? line : inboxLine(JSON.parse(line)));
    }
  }
  await running;
  io.err("watch: patio on this computer closed the stream");
  return 1;
}
