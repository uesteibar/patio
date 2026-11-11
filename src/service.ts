// `patio service install [--answer] [--uninstall] [--name N]`: runs `patio watch` (or `patio watch --answer`) as a
// service of the logged-in user, so the inbox is consumed without a terminal or a cron line. On Linux a systemd user
// unit (~/.config/systemd/user/<name>.service, enabled and started); on macOS a launchd agent
// (~/Library/LaunchAgents/<label>.plist, bootstrapped into the GUI domain). The service needs the gatekeeper
// running (patio join <link> starts it, or patio up); while it is not, watch exits and the service manager starts it again later.
//
// The unit carries PATIO_HOME, and a PATH and PATIO_TOOL_* resolved from the person's shell (toolpath.ts), so the coding
// tools are found without the shell's shims; and no agent: one watch --answer answers for every agent of this computer,
// each with its own tool and folder. It never carries a secret: patio holds the judge's key, and watch only talks to
// patio on this computer.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config";
import { serviceEnvironment, type Which } from "./toolpath";

export type ServiceSpec = {
  name: string;
  answer: boolean;
  // The patio command line: the Bun binary and cli.ts, or the compiled binary.
  command: string[];
  env: Record<string, string>;
  home: string;
};

export const DEFAULT_UNIT = "patio-watch";
export const DEFAULT_LABEL = "dev.patio.watch";
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,80}$/;

// How this process was started: `bun src/cli.ts` or the compiled `patio` binary.
export function patioCommand(main = Bun.main, exec = process.execPath): string[] {
  return /\.[cm]?[jt]s$/.test(main) ? [exec, main] : [exec];
}

export function serviceSpec(cfg: Config, opts: { answer?: boolean; name?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; command?: string[]; which?: Which }): ServiceSpec {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const name = opts.name ?? (platform === "darwin" ? DEFAULT_LABEL : DEFAULT_UNIT);
  if (!NAME_RE.test(name)) throw new Error(`a service name is letters, digits, _ . @ and - (got ${JSON.stringify(name)})`);
  const vars: Record<string, string> = { PATIO_HOME: cfg.home };
  if (env.PATIO_NO_NOTIFY) vars.PATIO_NO_NOTIFY = env.PATIO_NO_NOTIFY;
  Object.assign(vars, serviceEnvironment({ path: env.PATH ?? "", platform, which: opts.which }));
  return { name, answer: !!opts.answer, command: opts.command ?? patioCommand(), env: vars, home: cfg.home };
}

const args = (s: ServiceSpec) => [...s.command, "watch", ...(s.answer ? ["--answer"] : [])];

// systemd: % starts a specifier and $ a variable, in ExecStart and Environment alike.
const sd = (text: string) => text.replace(/%/g, "%%").replace(/\$/g, "$$$$");
const sdArg = (arg: string) => (/^[\w@+=:,./-]+$/.test(arg) ? sd(arg) : `"${sd(arg).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);

export function systemdUnit(s: ServiceSpec): string {
  return [
    "# Written by `patio service install`. Remove it with `patio service install --uninstall" + (s.name === DEFAULT_UNIT ? "" : ` --name ${s.name}`) + "`.",
    "[Unit]",
    `Description=patio watch${s.answer ? " --answer" : ""} (PATIO_HOME=${sd(s.home)})`,
    "",
    "[Service]",
    "Type=simple",
    ...Object.entries(s.env).map(([k, v]) => `Environment=${sdArg(`${k}=${v}`)}`),
    `ExecStart=${args(s).map(sdArg).join(" ")}`,
    "Restart=on-failure",
    "RestartSec=10",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function launchdPlist(s: ServiceSpec): string {
  const log = join(s.home, "watch.log");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    // An XML comment cannot hold "--", so the uninstall flag is not spelled out here.
    "<!-- Written by patio service install; it removes it too (the uninstall option). -->",
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xml(s.name)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...args(s).map((a) => `    <string>${xml(a)}</string>`),
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...Object.entries(s.env).flatMap(([k, v]) => [`    <key>${xml(k)}</key>`, `    <string>${xml(v)}</string>`]),
    "  </dict>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
    "  <key>ThrottleInterval</key>",
    "  <integer>10</integer>",
    "  <key>StandardOutPath</key>",
    `  <string>${xml(log)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xml(log)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export type Run = (cmd: string[]) => { code: number; out: string };
const runSync: Run = (cmd) => {
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: (p.stdout.toString() + p.stderr.toString()).trim() };
};

export type ServiceOptions = { answer?: boolean; uninstall?: boolean; name?: string; platform?: NodeJS.Platform; run?: Run; home?: string };

// Where the service's file goes: the systemd user unit, or the launchd agent.
export function serviceFile(spec: ServiceSpec, platform: NodeJS.Platform, userHome = homedir()): string | null {
  if (platform === "linux") return join(process.env.XDG_CONFIG_HOME || join(userHome, ".config"), "systemd", "user", `${spec.name}.service`);
  if (platform === "darwin") return join(userHome, "Library", "LaunchAgents", `${spec.name}.plist`);
  return null;
}

// What an existing service file runs: for which PATIO_HOME, and whether it answers.
function existing(text: string, platform: NodeJS.Platform): { home: string | null; answer: boolean } {
  if (platform === "darwin") {
    const home = /<key>PATIO_HOME<\/key>\s*<string>([^<]*)<\/string>/.exec(text)?.[1];
    return { home: home ? home.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") : null, answer: text.includes("<string>--answer</string>") };
  }
  const env = /^Environment="?PATIO_HOME=(.*?)"?$/m.exec(text)?.[1];
  return { home: env ? env.replace(/\\(.)/g, "$1").replace(/%%/g, "%").replace(/\$\$/g, "$") : null, answer: /^ExecStart=.* watch --answer$/m.test(text) };
}

export type AnswerService = { state: "installed" | "updated" | "present" | "other-home" | "unsupported"; file: string | null; home?: string };

// `patio join`'s step: the one `watch --answer` service of this computer, installed once. Already there for this
// PATIO_HOME: nothing changes. There for another PATIO_HOME: left alone (one service per computer, not ours to take).
// Turns on no auto-answer: each contact's stays off until the person turns it on in the web app.
// Whether this home's answer service is installed, without changing anything.
export function answerServiceState(cfg: Config, opts: { platform?: NodeJS.Platform; home?: string; name?: string } = {}): "present" | "missing" | "other-home" | "unsupported" {
  const platform = opts.platform ?? process.platform;
  const spec = serviceSpec(cfg, { answer: true, name: opts.name, platform, which: () => null });
  const file = serviceFile(spec, platform, opts.home ?? homedir());
  if (!file) return "unsupported";
  if (!existsSync(file)) return "missing";
  const e = existing(readFileSync(file, "utf8"), platform);
  if (e.home && e.home !== cfg.home) return "other-home";
  return e.answer ? "present" : "missing";
}

export async function ensureAnswerService(cfg: Config, opts: Omit<ServiceOptions, "answer" | "uninstall"> = {}): Promise<AnswerService> {
  const platform = opts.platform ?? process.platform;
  const spec = serviceSpec(cfg, { answer: true, name: opts.name, platform });
  const file = serviceFile(spec, platform, opts.home ?? homedir());
  if (!file) return { state: "unsupported", file: null };
  let ours = false;
  if (existsSync(file)) {
    const text = readFileSync(file, "utf8");
    const e = existing(text, platform);
    if (e.home && e.home !== cfg.home) return { state: "other-home", file, home: e.home };
    // This home's service, as it would be written now: nothing to do. Written by an older patio, or with another
    // environment (a PATH resolved before, without PATIO_TOOL_*): written again.
    if (e.home === cfg.home && e.answer && text === (platform === "darwin" ? launchdPlist(spec) : systemdUnit(spec))) return { state: "present", file };
    ours = e.home === cfg.home && e.answer;
  }
  await installService(cfg, { ...opts, platform, answer: true });
  return { state: ours ? "updated" : "installed", file };
}

// Installs (or removes) the service and returns what to print. Throws with a message when it cannot.
export async function installService(cfg: Config, opts: ServiceOptions = {}): Promise<string> {
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? runSync;
  const userHome = opts.home ?? homedir();
  const spec = serviceSpec(cfg, { answer: opts.answer, name: opts.name, platform });
  const what = `patio watch${spec.answer ? " --answer" : ""}`;
  const again = spec.name === (platform === "darwin" ? DEFAULT_LABEL : DEFAULT_UNIT) ? "" : ` --name ${spec.name}`;
  if (platform === "linux") {
    const dir = join(process.env.XDG_CONFIG_HOME || join(userHome, ".config"), "systemd", "user");
    const file = join(dir, `${spec.name}.service`);
    const unit = `${spec.name}.service`;
    const must = (cmd: string[]) => {
      const r = run(cmd);
      if (r.code !== 0) throw new Error(`${cmd.join(" ")} failed: ${r.out || `exit ${r.code}`}`);
    };
    if (opts.uninstall) {
      const existed = existsSync(file);
      run(["systemctl", "--user", "disable", "--now", unit]);
      await rm(file, { force: true });
      run(["systemctl", "--user", "daemon-reload"]);
      run(["systemctl", "--user", "reset-failed", unit]);
      return existed ? `removed ${file}; the ${unit} user unit is stopped and disabled` : `no ${file}; nothing to remove`;
    }
    await mkdir(dir, { recursive: true });
    await writeFile(file, systemdUnit(spec));
    must(["systemctl", "--user", "daemon-reload"]);
    must(["systemctl", "--user", "enable", unit]);
    // Restart, not start: installing again (say, with --answer) replaces a running watch.
    must(["systemctl", "--user", "restart", unit]);
    return [
      `installed ${file}`,
      `${what} runs now, and at every login, as the systemd user unit ${unit}. It needs patio running on this computer (patio join <link> starts it, or patio up).`,
      `  state:   systemctl --user status ${unit}`,
      `  log:     journalctl --user -u ${unit} -f`,
      `  stop:    systemctl --user stop ${unit}`,
      `  remove:  patio service install --uninstall${again}`,
    ].join("\n");
  }
  if (platform === "darwin") {
    const file = join(userHome, "Library", "LaunchAgents", `${spec.name}.plist`);
    const domain = `gui/${process.getuid?.() ?? 501}`;
    if (opts.uninstall) {
      const existed = existsSync(file);
      run(["launchctl", "bootout", `${domain}/${spec.name}`]);
      await rm(file, { force: true });
      return existed ? `removed ${file}; the ${spec.name} launchd agent is stopped` : `no ${file}; nothing to remove`;
    }
    await mkdir(join(userHome, "Library", "LaunchAgents"), { recursive: true });
    run(["launchctl", "bootout", `${domain}/${spec.name}`]);
    await writeFile(file, launchdPlist(spec));
    const r = run(["launchctl", "bootstrap", domain, file]);
    if (r.code !== 0) throw new Error(`launchctl bootstrap ${domain} ${file} failed: ${r.out || `exit ${r.code}`}`);
    return [
      `installed ${file}`,
      `${what} runs now, and at every login, as the launchd agent ${spec.name}. It needs patio running on this computer (patio join <link> starts it, or patio up).`,
      `  state:   launchctl print ${domain}/${spec.name}`,
      `  log:     tail -f ${join(spec.home, "watch.log")}`,
      `  stop:    launchctl bootout ${domain}/${spec.name}`,
      `  remove:  patio service install --uninstall${again}`,
    ].join("\n");
  }
  throw new Error(`patio service install supports Linux (systemd) and macOS (launchd), not ${platform}`);
}
