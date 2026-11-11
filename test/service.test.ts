// Increment 10: `patio service install` writes a systemd user unit (Linux) or a launchd agent (macOS) that runs
// `patio watch` (or `watch --answer`). The macOS plist is checked against a golden file only.
import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureAnswerService, installService, launchdPlist, patioCommand, serviceSpec, systemdUnit } from "../src/service";

const cfg = { home: "/Users/jorge/.patio", handle: "", relay: "ws://127.0.0.1:7777", socket: "/Users/jorge/.patio/daemon.sock" };
const env = { PATH: "/opt/homebrew/bin:/usr/bin:/bin", PATIO_AGENT: "jorge-claude", TYPESAFE_API_KEY: "must-not-appear", GITHUB_CLIENT_SECRET: "nor-this" };
const command = ["/opt/homebrew/bin/bun", "/Users/jorge/code/patio/src/cli.ts"];
// The coding tools as the person's shell finds them (toolpath.ts): only Claude Code here.
const which = (c: string) => (c === "claude" ? "/opt/homebrew/bin/claude" : null);
const golden = (name: string) => readFile(join(import.meta.dir, "golden", name), "utf8");

test("the macOS launchd agent matches the golden file", async () => {
  const spec = serviceSpec(cfg, { answer: true, platform: "darwin", env, command, which });
  expect(spec.name).toBe("dev.patio.watch");
  expect(launchdPlist(spec)).toBe(await golden("dev.patio.watch.plist"));
});

test("the systemd user unit runs watch (or watch --answer) with PATIO_HOME and the PATH of the tools found, no agent (it answers for every agent here) and no secret", async () => {
  const spec = serviceSpec({ ...cfg, home: "/home/jorge/.patio" }, { answer: true, platform: "linux", env, command: ["/usr/bin/bun", "/home/jorge/code/patio/src/cli.ts"], which });
  expect(spec.name).toBe("patio-watch");
  const unit = systemdUnit(spec);
  expect(unit).toBe(await golden("patio-watch.service"));
  expect(unit).not.toContain("must-not-appear");
  expect(unit).not.toContain("jorge-claude");
  expect(systemdUnit({ ...spec, answer: false })).toContain("ExecStart=/usr/bin/bun /home/jorge/code/patio/src/cli.ts watch\n");
});

test("odd characters are quoted for systemd; a bad name is refused", () => {
  const unit = systemdUnit(serviceSpec({ ...cfg, home: "/home/a b/50%$x" }, { platform: "linux", env: {}, command: ["/bin/bun"] }));
  expect(unit).toContain('Environment="PATIO_HOME=/home/a b/50%%$$x"');
  expect(() => serviceSpec(cfg, { name: "../evil", platform: "linux", env: {} })).toThrow("a service name is");
});

test("patio is started the way this process was: bun with cli.ts, or the compiled binary", () => {
  expect(patioCommand("/x/src/cli.ts", "/usr/bin/bun")).toEqual(["/usr/bin/bun", "/x/src/cli.ts"]);
  expect(patioCommand("/usr/local/bin/patio", "/usr/local/bin/patio")).toEqual(["/usr/local/bin/patio"]);
});

test("install writes the unit and enables and starts it; uninstall stops it and removes the file", async () => {
  const home = await mkdtemp(join(tmpdir(), "patio-service-"));
  const calls: string[] = [];
  const run = (cmd: string[]) => (calls.push(cmd.join(" ")), { code: 0, out: "" });
  const prev = process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CONFIG_HOME;
  try {
    const out = await installService(cfg, { platform: "linux", run, home, name: "patio-watch-unit-test" });
    const file = join(home, ".config/systemd/user/patio-watch-unit-test.service");
    expect(existsSync(file)).toBe(true);
    expect(calls).toEqual(["systemctl --user daemon-reload", "systemctl --user enable patio-watch-unit-test.service", "systemctl --user restart patio-watch-unit-test.service"]);
    expect(out).toContain("journalctl --user -u patio-watch-unit-test.service -f");
    expect(out).toContain("patio service install --uninstall --name patio-watch-unit-test");
    calls.length = 0;
    expect(await installService(cfg, { platform: "linux", run, home, name: "patio-watch-unit-test", uninstall: true })).toStartWith("removed ");
    expect(existsSync(file)).toBe(false);
    expect(calls[0]).toBe("systemctl --user disable --now patio-watch-unit-test.service");
  } finally {
    if (prev !== undefined) process.env.XDG_CONFIG_HOME = prev;
  }
});

test("the plist's comments hold no '--', which XML forbids", () => {
  const plist = launchdPlist(serviceSpec(cfg, { platform: "darwin", env, command, which }));
  for (const c of plist.match(/<!--[\s\S]*?-->/g) ?? []) expect(c.slice(4, -3)).not.toContain("--");
});

test("the join's answer service: installed once; a second join changes nothing; one for another PATIO_HOME is left alone", async () => {
  const prev = process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CONFIG_HOME;
  try {
    for (const platform of ["linux", "darwin"] as const) {
      const home = await mkdtemp(join(tmpdir(), "patio-answer-service-"));
      const calls: string[] = [];
      const run = (cmd: string[]) => (calls.push(cmd.join(" ")), { code: 0, out: "" });
      const odd = { ...cfg, home: join(home, "a b", "50%$x") };
      const first = await ensureAnswerService(odd, { platform, run, home });
      expect(first.state, platform).toBe("installed");
      const text = await readFile(first.file!, "utf8");
      expect(text, platform).toContain(platform === "linux" ? " watch --answer\n" : "<string>--answer</string>");
      const installed = calls.length;
      expect(installed, platform).toBeGreaterThan(0);
      expect(await ensureAnswerService(odd, { platform, run, home }), platform).toEqual({ state: "present", file: first.file });
      expect(calls.length, platform).toBe(installed);
      expect(await readFile(first.file!, "utf8")).toBe(text);
      // Written by an older patio (another PATH): written again, for the same home.
      await Bun.write(first.file!, text.replace(platform === "linux" ? /^Environment=PATH=.*$/m : /<key>PATH<\/key>\s*<string>[^<]*<\/string>/, platform === "linux" ? "Environment=PATH=/old/shims:/usr/bin" : "<key>PATH</key>\n    <string>/old/shims:/usr/bin</string>"));
      expect(await ensureAnswerService(odd, { platform, run, home }), platform).toEqual({ state: "updated", file: first.file });
      expect(await readFile(first.file!, "utf8")).toBe(text);
      const rewritten = calls.length;
      // Another patio home on the same computer: its service is not replaced.
      expect(await ensureAnswerService({ ...cfg, home: join(home, "other") }, { platform, run, home }), platform).toEqual({ state: "other-home", file: first.file, home: odd.home });
      expect(calls.length, platform).toBe(rewritten);
    }
  } finally {
    if (prev !== undefined) process.env.XDG_CONFIG_HOME = prev;
  }
});
