// Increment 16: moving to a new computer without a dead end. `patio uninstall` revokes this computer at the server with
// its own key, also with a patio that holds no lock, or says it did not (exit 1). A join on a new computer for an agent
// of the person's other computer offers one action, Move; teammates see a key change card that names the owner and the
// new computer. `Try:` suggests an agent that answers.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertSafeHome, cliCommand, FAKE_JEV_KEY, inherited, procStart } from "../lib/instance";
import { PATIO_CLI, REPO } from "../lib/paths";
import type { Scenario, Transcript } from "../lib/scenario";
import { WebClient } from "../lib/webclient";

const MOVED_LINE = "Your teammates' patio will ask them to trust this computer's new keys before your messages reach them.";
const ANSWERS = ["--ask", "requests", "--act", "ask-human", "--answer", "no"];

async function teamLink(t: Transcript) {
  const r = await t.tty("alice", cliCommand(t.m, "alice", ["invite", "--workspace", "team", "--expires", "7d"]));
  return /(http:\/\/127\.0\.0\.1:\d+\/join\/[\w-]+)/.exec(r.stdout)?.[1] ?? "";
}

// A computer of a person's inside the instance root: a PATIO_HOME and a project folder.
async function computer(t: Transcript, name: string, extra: Record<string, string> = {}) {
  const root = join(t.m.root, name);
  const home = join(root, ".patio");
  const folder = join(root, "code", "orbit");
  assertSafeHome(home, t.m.root);
  await mkdir(folder, { recursive: true });
  const env = {
    ...inherited(),
    HOME: root,
    PATIO_HOME: home,
    PATIO_WEB_PORT: "0",
    PATIO_DEVICE_NAME: name,
    PATIO_NO_NOTIFY: "1",
    PATIO_NO_SERVICE: "1",
    ...(t.m.jev ? { TYPESAFE_API_KEY: FAKE_JEV_KEY, PATIO_JEV_URL: t.m.jev.url } : {}),
    ...extra,
  };
  const run = async (args: string[]) => {
    const started = Date.now();
    const p = Bun.spawn([process.execPath, PATIO_CLI, ...args], { env, cwd: REPO, stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: 60_000 });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const code = await p.exited;
    t.lines.push(`### ${name}$ patio ${args.join(" ")}`, "", `exit ${code} in ${Date.now() - started} ms`, "", "```text", out.trim(), ...(err.trim() ? [`stderr: ${err.trim()}`] : []), "```", "");
    return { code, out: out + err };
  };
  // Stops this computer's patio: by its pid file, else by the pid the join printed.
  const stop = (pid?: number) => {
    const f = join(home, "patio.pid");
    const p = pid ?? (existsSync(f) ? Number(readFileSync(f, "utf8")) : 0);
    if (p && procStart(p)) process.kill(p, "SIGTERM");
  };
  return { root, home, folder, env, run, stop };
}

// The join as a coding agent runs it, and the person's click on the one screen: `decision` is confirm or move.
async function joinByAgent(t: Transcript, c: Awaited<ReturnType<typeof computer>>, login: string, decision: "confirm" | "move", url: string) {
  const args = ["join", url, "--tool", "claude", "--folder", c.folder, "--no-wait", ...ANSWERS];
  const first = await c.run(args);
  const confirm = /Confirm in your browser: (\S+)/.exec(first.out)?.[1];
  if (!confirm) return { first, screen: "", clicked: null, second: first };
  const u = new URL(confirm);
  const web = new WebClient(u.origin);
  await web.signIn(login);
  const screen = await (await web.get(u.pathname + u.search)).text();
  const clicked = await web.post("/confirm", { code: u.searchParams.get("code")!, decision });
  t.note(`**@${login} opens the link, signs in and clicks ${decision === "move" ? "Move" : "Confirm"}**: ${clicked.ok ?? clicked.error}`);
  return { first, screen, clicked, second: await c.run(args) };
}

const uninstallNoLock: Scenario = {
  name: "uninstall-no-lock",
  description:
    "Jorge's computer runs a patio that holds no lock and has no pid file (as patio before 0.13 did; PATIO_TEST_NO_LOCK=1). `patio uninstall --yes` finds it by its socket and stops it, revokes the computer at the server with the computer's own key (jorge-team leaves team), never prints \"unknown endpoint\", and exits 0. On his new computer the same join takes the name jorge-team with a plain Confirm: the name is free. Run again on the old computer, uninstall says it is already revoked.",
  label: "deterministic",
  agents: () => [{ handle: "alice" }],
  async run(t) {
    const url = await teamLink(t);
    const old = await computer(t, "jorge-laptop", { PATIO_TEST_NO_LOCK: "1" });
    const joined = await joinByAgent(t, old, "jorge", "confirm", url);
    t.expect("the old computer joins team, with no lock file", joined.second.code === 0 && !existsSync(join(old.home, "patio.pid")), joined.second.out.slice(-300));
    const pid = Number(/patio: started on this computer \(pid (\d+)/.exec(joined.first.out)?.[1] ?? 0);
    const r = await old.run(["uninstall", "--yes"]);
    t.expect("uninstall exits 0 and never prints unknown endpoint", r.code === 0 && !r.out.includes("unknown endpoint"), r.out);
    t.expect("jorge-team leaves team, and the computer is revoked at the server", r.out.includes("✓ jorge-team: out of team") && r.out.includes("✓ this computer (jorge-laptop): revoked at the server; its keys are refused from now on"), r.out);
    t.expect("the patio without a lock is found by its socket and stopped", r.out.includes(`✓ patio: stopped (pid ${pid}, found by its socket)`) && !procStart(pid), r.out);
    const mac = await computer(t, "jorge-mac");
    const next = await joinByAgent(t, mac, "jorge", "confirm", url);
    t.expect(
      "the new computer takes the name jorge-team with a plain Confirm (no Move: the name is free)",
      next.screen.includes(">Confirm</button>") && !next.screen.includes("Move jorge-team") && next.second.code === 0 && next.second.out.includes("patio is ready: jorge-team is in team.") && !next.second.out.includes(MOVED_LINE),
      next.second.out.slice(-400),
    );
    const again = await old.run(["uninstall", "--yes"]);
    t.expect("run again on the old computer: already revoked, exit 0", again.code === 0 && again.out.includes("· this computer (jorge-laptop): already revoked at the server") && again.out.includes("· patio: not running"), again.out);
    mac.stop();
  },
};

const uninstallRefused: Scenario = {
  name: "uninstall-refused",
  description:
    "Carol uninstalls while the server cannot revoke her computer. A server from before increment 16 (no route for it) and an unreachable server each get a line marked ! with the reason and the next step, and exit 1; nothing says \"unknown endpoint\". Once the server is back, the same command revokes the computer and exits 0.",
  label: "deterministic",
  agents: () => [{ handle: "alice" }],
  async run(t) {
    const url = await teamLink(t);
    const c = await computer(t, "carol-laptop");
    const joined = await joinByAgent(t, c, "carol", "confirm", url);
    t.expect("Carol's computer joins team", joined.second.code === 0, joined.second.out.slice(-300));
    const server = readFileSync(join(c.home, "exchange"), "utf8");
    const old = Bun.serve({ port: 0, fetch: () => Response.json({ error: "unknown endpoint" }, { status: 404 }) });
    try {
      await writeFile(join(c.home, "exchange"), `ws://127.0.0.1:${old.port}\n`);
      t.note(`**This computer's server is now an older patio server** (http://127.0.0.1:${old.port}, no route to revoke from patio uninstall).`);
      const r = await c.run(["uninstall", "--yes"]);
      t.expect(
        "an older server: ! with the reason and where to revoke it instead, exit 1, no unknown endpoint",
        r.code === 1 && !r.out.includes("unknown endpoint") && r.out.includes(`! this computer: the server at http://127.0.0.1:${old.port} cannot revoke it from here (it runs an older patio).`) && r.out.includes("patio is not fully off this computer: see the lines marked ! above."),
        r.out,
      );
    } finally {
      old.stop(true);
    }
    await writeFile(join(c.home, "exchange"), server);
    await t.stopExchange();
    const down = await c.run(["uninstall", "--yes"]);
    t.expect("an unreachable server: ! with the reason and the next step, exit 1", down.code === 1 && down.out.includes("is not reachable, so this computer is still in your workspaces. Run patio uninstall again once it is reachable"), down.out);
    await t.startExchange();
    const ok = await c.run(["uninstall", "--yes"]);
    t.expect("with the server back, the same command revokes the computer and exits 0", ok.code === 0 && ok.out.includes("✓ this computer (carol-laptop): revoked at the server"), ok.out);
  },
};

const moveComputer: Scenario = {
  name: "move-computer",
  description:
    "Jorge's agent jorge-team lives on jorge-laptop, and Alice has written to it. His laptop is off; on his new Mac his coding agent runs the same join. The one screen says jorge-team lives on his other computer jorge-laptop and when it was last seen, and offers one action: Move jorge-team to this computer. He clicks it; the laptop, with no other agent, is revoked. The join ends with the line about his teammates' trust. Alice's next message waits for her, and her key change card names @jorge and jorge-mac.",
  label: "deterministic",
  agents: () => [{ handle: "alice" }],
  async run(t) {
    const url = await teamLink(t);
    const laptop = await computer(t, "jorge-laptop");
    const first = await joinByAgent(t, laptop, "jorge", "confirm", url);
    t.expect("jorge-team joins team from the laptop", first.second.code === 0, first.second.out.slice(-300));
    const hello = await t.cli("alice", ["ask", "jorge-team", "Which branch has the fix?"]);
    t.expect("Alice writes to jorge-team (her patio pins its keys)", hello.code === 0, hello.stderr);
    laptop.stop();
    await Bun.sleep(300);
    t.note("**Jorge's laptop is off.**");
    const mac = await computer(t, "jorge-mac");
    const moved = await joinByAgent(t, mac, "jorge", "move", url);
    t.expect(
      "the screen says where jorge-team lives and when it was last seen, and offers one action, Move",
      /<b>jorge-team<\/b> lives on your other computer <b>jorge-laptop<\/b> \(last seen (just now|\d+ minutes? ago)\)\./.test(moved.screen) &&
        moved.screen.includes(">Move jorge-team to this computer</button>") &&
        !moved.screen.includes(">Confirm</button>") &&
        moved.screen.includes("jorge-laptop has no other agent, so it is revoked too."),
      moved.screen.replace(/<style[\s\S]*?<\/style>/, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 800),
    );
    t.expect("Move confirms it here", (moved.clicked?.ok ?? "").startsWith("jorge-team moved here from jorge-laptop, and is your agent on this computer, in team"), moved.clicked?.ok ?? moved.clicked?.error ?? "");
    t.expect(
      "the join ends with the line about teammates' trust",
      moved.second.code === 0 && moved.second.out.includes(`Next: start a new Claude Code session in this folder.\n${MOVED_LINE}\nTry:`),
      moved.second.out.slice(-500),
    );
    const again = await t.cli("alice", ["ask", "jorge-team", "And the tests?"]);
    t.expect("Alice's next message waits for her decision on the new keys (exit 7)", again.code === 7 && again.stderr.includes("keys changed"), again.stderr);
    const page = await t.webGet("alice", "/");
    t.expect(
      "Alice's key change card names the owner and the new computer",
      page.html.includes("The server now gives other keys for <b>jorge-team</b>, an agent of @jorge, now on the computer <b>jorge-mac</b>"),
      page.text.slice(0, 600),
    );
    mac.stop();
  },
};

const tryOnline: Scenario = {
  name: "try-online-agent",
  description:
    "The join's `Try:` line suggests an agent that answers. Alice invited Jorge, but her patio is off; Bob's is on: Try suggests bob. With Bob's off too, it suggests the inviter's agent, alice.",
  label: "deterministic",
  agents: () => [{ handle: "alice" }, { handle: "bob" }],
  async run(t) {
    const url = await teamLink(t);
    await t.stopAgent("alice");
    const jorge = await computer(t, "jorge-laptop");
    const j = await joinByAgent(t, jorge, "jorge", "confirm", url);
    t.expect("the inviter's agent is offline and bob is online: Try suggests bob", j.second.code === 0 && j.second.out.includes("Try: ask bob a question about their work."), j.second.out.slice(-300));
    await t.stopAgent("bob");
    jorge.stop();
    await Bun.sleep(300);
    const dave = await computer(t, "dave-laptop");
    const d = await joinByAgent(t, dave, "dave", "confirm", url);
    t.expect("nobody else online: Try suggests the inviter's agent, alice", d.second.code === 0 && d.second.out.includes("Try: ask alice a question about their work."), d.second.out.slice(-300));
    dave.stop();
  },
};

export const MOVE_SCENARIOS: Scenario[] = [uninstallNoLock, uninstallRefused, moveComputer, tryOnline];
