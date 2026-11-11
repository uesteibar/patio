// Day 2: `patio update` and `patio uninstall`.
//
// update: installs the latest patio from the server this computer uses (its install.sh, the same one the invite
// page's prompt runs), then restarts patio and the answer service, so both run the new binary.
//
// uninstall: stops the answer service, revokes this computer at the server with its own key (its agents leave their
// workspaces; final: its keys are refused from then on), stops patio (found by its lock, else by its socket), and
// removes the project entries patio wrote (and their lines in .git/info/exclude). With --binary it removes the patio
// binary too. It says what it did, line by line; a step that fails says why and what to do, and the exit is 1. The
// patio home (the agents' files, the inbox, the history, this computer's keys) stays, for the person to remove or keep.
import { existsSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { parseAgentFile, toolLabel, validName } from "./agent-file";
import { expandHome, rememberedExchange, tilde, type Config } from "./config";
import { CONNECT_TOOLS, connectedTools, projectFile, removeProjectEntries, unexcludeProjectFiles } from "./connect";
import { exchangeUrls, startBackground } from "./join";
import { loadOrCreateDevice } from "./crypto";
import { daemon } from "./local";
import { alive, lockHolder, socketOwner } from "./lock";
import { revokeSelfAt } from "./self-revoke";
import { answerServiceState, DEFAULT_LABEL, DEFAULT_UNIT, installService, patioCommand, type Run } from "./service";

type Say = (line: string) => void;

const runSync: Run = (cmd) => {
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: (p.stdout.toString() + p.stderr.toString()).trim() };
};

// Stops the patio of this home (never this process): the one holding the lock, else the one listening on its socket (a
// patio from before the lock). It waits until it is gone, and kills it when SIGTERM is not enough.
async function stopPatio(cfg: Config, say: Say, fail: Say = say): Promise<number | null> {
  let pid = lockHolder(cfg.home);
  let how = "";
  if (!pid) {
    pid = socketOwner(cfg.socket);
    how = ", found by its socket";
  }
  if (!pid) {
    say("· patio: not running");
    return null;
  }
  const gone = async (ms: number) => {
    for (let i = 0; i < ms / 50 && alive(pid!); i++) await Bun.sleep(50);
    return !alive(pid!);
  };
  try {
    process.kill(pid, "SIGTERM");
    if (!(await gone(5000))) {
      process.kill(pid, "SIGKILL");
      if (!(await gone(2000))) throw new Error("it is still running");
    }
  } catch (err) {
    fail(`patio: could not stop it (pid ${pid}: ${(err as Error).message}). Stop it yourself: kill ${pid}`);
    return null;
  }
  say(`✓ patio: stopped (pid ${pid}${how})`);
  return pid;
}

// This computer revoked at the server, signed with its own key: whether or not patio runs or knows who is signed in.
async function revokeThisComputer(cfg: Config, say: Say, fail: Say) {
  if (!existsSync(join(cfg.home, "device.json"))) return say(`· this computer: no keys in ${tilde(cfg.home)}; nothing to revoke`);
  const { http } = exchangeUrls(rememberedExchange(cfg.home) ?? cfg.relay);
  const r = await revokeSelfAt(http, await loadOrCreateDevice(cfg.home));
  const elsewhere = "the Computers page of patio's web app on another of your computers";
  if (!r.ok) {
    if (r.why === "unreachable") return fail(`this computer: the server at ${http} is not reachable, so this computer is still in your workspaces. Run patio uninstall again once it is reachable, or revoke it on ${elsewhere}`);
    if (r.why === "old_server") return fail(`this computer: the server at ${http} cannot revoke it from here (it runs an older patio). Revoke it on ${elsewhere}, or ask the server's operator to update it`);
    return fail(`this computer: the server refused to revoke it: ${r.detail}. Fix that, then run patio uninstall again`);
  }
  const { state, label, left } = r.result;
  for (const l of left) say(`✓ ${l.agent}: out of ${l.workspace}`);
  if (state === "revoked") say(`✓ this computer (${label}): revoked at the server; its keys are refused from now on`);
  else if (state === "already") say(`· this computer (${label}): already revoked at the server`);
  else if (state === "not_signed_in") say("· this computer: not signed in at the server; nothing to revoke");
  else say("· this computer: the server does not know it; nothing to revoke");
}

// Every step says what it did (✓), that there was nothing to do (·), or why it failed and what to do (!). Any ! makes
// the result not ok: patio uninstall then exits 1.
export async function uninstall(cfg: Config, o: { binary?: boolean; say?: Say; platform?: NodeJS.Platform; userHome?: string; run?: Run } = {}): Promise<{ ok: boolean }> {
  const say = o.say ?? ((l: string) => console.log(l));
  let ok = true;
  const fail = (l: string) => {
    ok = false;
    say(`! ${l}`);
  };
  // 1. The answer service.
  try {
    const service = answerServiceState(cfg, { platform: o.platform, home: o.userHome });
    if (service === "present") {
      await installService(cfg, { answer: true, uninstall: true, platform: o.platform, home: o.userHome, run: o.run });
      say("✓ answer service: stopped and removed");
    } else say(`· answer service: none for this patio${service === "other-home" ? " (the one installed answers for another patio home; left as it is)" : ""}`);
  } catch (err) {
    fail(`answer service: could not remove it (${(err as Error).message}). Remove it with: patio service install --uninstall`);
  }

  // 2. The agents out of their workspaces, and this computer revoked at the server.
  await revokeThisComputer(cfg, say, fail);

  // 3. patio itself.
  await stopPatio(cfg, say, fail);

  // 4. The project entries patio wrote, and their lines in .git/info/exclude.
  const dir = join(cfg.home, "agents");
  const names = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".yaml")).map((f) => f.slice(0, -5)).filter(validName) : [];
  for (const name of names) {
    let folder: string | null = null;
    try {
      const f = parseAgentFile(await Bun.file(join(dir, `${name}.yaml`)).text(), name);
      folder = f.folder ? expandHome(f.folder) : null;
    } catch {}
    if (!folder) continue;
    try {
      const user = connectedTools(name, folder).filter((c) => c.endsWith("(user)"));
      const removed = await removeProjectEntries(name, folder);
      const unexcluded = await unexcludeProjectFiles(folder, CONNECT_TOOLS.map(projectFile));
      if (removed.length) say(`✓ ${name}: patio removed from ${removed.join(", ")} in ${tilde(folder)}${unexcluded.length ? ", and from .git/info/exclude" : ""}`);
      else if (unexcluded.length) say(`✓ ${name}: .git/info/exclude in ${tilde(folder)} no longer lists patio's files`);
      for (const u of user) {
        const tool = u.split(" ")[0]!;
        say(`  note: ${toolLabel(tool)} runs patio as ${name} for every folder; remove it with: ${tool} mcp remove ${tool === "claude" ? "--scope user " : ""}patio-${name}`);
      }
    } catch (err) {
      fail(`${name}: could not remove patio's entries in ${tilde(folder)} (${(err as Error).message}). Remove the patio-${name} entries from its project files yourself`);
    }
  }

  // 5. The binary, on request.
  if (o.binary) {
    const cmd = patioCommand();
    if (cmd.length > 1) say("· binary: this patio runs from source; nothing to remove");
    else
      try {
        await rm(cmd[0]!, { force: true });
        say(`✓ binary: removed ${tilde(cmd[0]!)}`);
      } catch (err) {
        fail(`binary: could not remove ${tilde(cmd[0]!)} (${(err as Error).message}). Remove it yourself: rm ${cmd[0]}`);
      }
  }
  if (ok) say(`patio is off this computer. Your agents' files and their history stay in ${tilde(cfg.home)}: remove that folder to forget them too.`);
  else say("patio is not fully off this computer: see the lines marked ! above.");
  return { ok };
}

export async function update(cfg: Config, o: { say?: Say; platform?: NodeJS.Platform; userHome?: string; run?: Run } = {}) {
  const say = o.say ?? ((l: string) => console.log(l));
  const run = o.run ?? runSync;
  const platform = o.platform ?? process.platform;
  const server = rememberedExchange(cfg.home) ?? cfg.relay;
  const { http } = exchangeUrls(server);
  const res = await fetch(`${http}/install.sh`, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
  if (!res?.ok) throw new Error(`could not download ${http}/install.sh${res ? ` (the server answered ${res.status})` : " (the server is not reachable)"}`);
  const script = await res.text();
  const sh = Bun.spawn(["sh", "-s"], { stdin: new Blob([script]), stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(sh.stdout).text(), new Response(sh.stderr).text()]);
  const code = await sh.exited;
  if (code !== 0) throw new Error(`install.sh from ${http} failed with exit code ${code}: ${(err || out).trim().split("\n").slice(-3).join(" | ")}`);
  say(`✓ installed the latest patio from ${http}${out.trim() ? ` (${out.trim().split("\n").at(-1)})` : ""}`);

  // patio: restarted on the same server, with the new binary.
  const status = await daemon.status(cfg).catch(() => null);
  const stopped = await stopPatio(cfg, () => {});
  if (stopped) {
    const relay = status?.relay ?? cfg.relay;
    const { pid } = await startBackground({ ...cfg, relay }, relay);
    say(`✓ patio: restarted (pid ${pid})`);
  } else say("· patio: not running; patio up or patio join <link> starts it");

  // The answer service, when this home has one.
  if (answerServiceState(cfg, { platform, home: o.userHome }) === "present") {
    const r =
      platform === "darwin"
        ? run(["launchctl", "kickstart", "-k", `gui/${process.getuid?.() ?? 501}/${DEFAULT_LABEL}`])
        : run(["systemctl", "--user", "restart", `${DEFAULT_UNIT}.service`]);
    say(r.code === 0 ? "✓ answer service: restarted" : `! answer service: could not restart it (${r.out || `exit ${r.code}`})`);
  } else say("· answer service: none for this patio");
}
