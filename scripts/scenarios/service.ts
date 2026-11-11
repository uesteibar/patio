// Increment 10: `patio service install` on Linux, with the real `systemctl --user`. The unit has a test suffix (the
// instance id), and the scenario removes it whatever happens.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Scenario } from "../lib/scenario";
import { until } from "./inbox";

const systemctl = (...args: string[]) => {
  const p = Bun.spawnSync(["systemctl", "--user", ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: (p.stdout.toString() + p.stderr.toString()).trim() };
};

const service: Scenario = {
  name: "service",
  description:
    "Bob installs `patio watch` as a systemd user unit (name with a test suffix): the unit file carries his PATIO_HOME and runs watch, systemd says it is active and stays active (watch is connected to his gatekeeper), and the command printed how to see its state and log and stop it. Installing again with --answer replaces it with watch --answer. `--uninstall` stops it, disables it and removes the file; the scenario cleans up whatever happens.",
  label: "deterministic",
  agents: () => [{ handle: "alice" }, { handle: "bob" }],
  async run(t) {
    const name = `patio-watch-test-${t.m.id}`;
    const unit = `${name}.service`;
    const file = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user", unit);
    t.expect("systemctl --user is available", systemctl("--version").code === 0);
    try {
      const install = await t.cli("bob", ["service", "install", "--name", name]);
      t.expect("install exits 0", install.code === 0, `${install.code} ${install.stderr}`);
      t.expect("it says how to see the state and the log, and how to stop and remove it", [`systemctl --user status ${unit}`, `journalctl --user -u ${unit} -f`, `systemctl --user stop ${unit}`, `patio service install --uninstall --name ${name}`].every((l) => install.stdout.includes(l)), install.stdout);
      const text = existsSync(file) ? readFileSync(file, "utf8") : "";
      t.note(`The unit file ${file}:\n\n\`\`\`ini\n${text}\`\`\``);
      t.expect("the unit runs patio watch with Bob's PATIO_HOME", text.includes(`Environment=PATIO_HOME=${t.m.agents.bob!.home}`) && / watch\n/.test(text), text);
      t.expect("and carries no secret", !text.includes("TYPESAFE") && !text.includes("fake-jev-key") && !text.includes("GITHUB_"));
      const active = await until("the unit to be active", async () => systemctl("is-active", unit).out === "active");
      t.expect("systemd says it is active", !!active);
      await Bun.sleep(1500);
      t.expect("and it stays active (watch is connected to Bob's gatekeeper)", systemctl("is-active", unit).out === "active", systemctl("status", unit, "--no-pager").out);
      const pid = Number(systemctl("show", "-p", "MainPID", "--value", unit).out);
      const cmdline = pid ? readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ") : "";
      t.expect("its process is patio watch", cmdline.includes("cli.ts watch"), cmdline);
      t.expect("systemd enabled it for the next login", systemctl("is-enabled", unit).out === "enabled");

      const again = await t.cli("bob", ["service", "install", "--answer", "--name", name]);
      t.expect("installing again with --answer exits 0", again.code === 0, again.stderr);
      t.expect("the unit now runs watch --answer", readFileSync(file, "utf8").includes(" watch --answer\n"));
      await until("active again", async () => systemctl("is-active", unit).out === "active");
      const cmdlineOf = () => {
        const pid = Number(systemctl("show", "-p", "MainPID", "--value", unit).out);
        try {
          return pid ? readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ") : "";
        } catch {
          return "";
        }
      };
      const answering = await until("the restarted process", async () => cmdlineOf().includes("watch --answer")).catch(() => false);
      t.expect("the running process is watch --answer", !!answering, cmdlineOf());

      const remove = await t.cli("bob", ["service", "install", "--uninstall", "--name", name]);
      t.expect("--uninstall exits 0 and says what it removed", remove.code === 0 && remove.stdout.startsWith(`removed ${file}`), remove.stdout);
      t.expect("the unit file is gone", !existsSync(file));
      t.expect("the unit is not active", systemctl("is-active", unit).out !== "active", systemctl("is-active", unit).out);
      t.expect("systemd no longer knows it", !systemctl("list-unit-files", unit, "--no-legend").out.includes(unit));
    } finally {
      systemctl("disable", "--now", unit);
      rmSync(file, { force: true });
      systemctl("daemon-reload");
      systemctl("reset-failed", unit);
      t.expect("clean-up: nothing of the test unit is left", !existsSync(file) && !systemctl("list-units", "--all", "--no-legend", unit).out.includes(unit));
    }
  },
};

export const SERVICE_SCENARIOS = [service];
