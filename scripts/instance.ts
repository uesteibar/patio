// just up <agents...> | just down <id> | just cli <id> <agent> -- <patio args>
import { join } from "node:path";
import { assertSafeHome, cliCommand, down, FAKE_JEV_KEY, readManifest, up } from "./lib/instance";

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "up": {
    // `--channel <name>` (repeatable): every agent joins that channel of the workspace `team`.
    const channels: string[] = [];
    const handles: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--channel") channels.push(args[++i] ?? "");
      else handles.push(args[i]!);
    }
    if (channels.some((c) => !c)) throw new Error("usage: just up <agents...> [--channel <name>]...");
    const m = await up(handles.map((handle) => ({ handle, channels })));
    console.error(`instance ${m.id}: exchange ${m.exchange.url}, agents ${Object.keys(m.agents).join(", ")}`);
    console.error(`manifest ${m.root}/manifest.json`);
    for (const a of Object.values(m.agents)) console.error(`  ${a.handle}: web app ${a.web_url} (sign in as ${a.login})`);
    if (channels.length) console.error(`  every agent is in ${channels.map((c) => `#${c}`).join(", ")}`);
    console.log(m.id);
    break;
  }
  case "down": {
    const [id] = args;
    if (!id) throw new Error("usage: just down <id>");
    console.log(JSON.stringify(await down(id)));
    break;
  }
  case "cli": {
    const [id, agent, ...rest] = args;
    if (!id || !agent) throw new Error("usage: just cli <id> <agent> -- <patio args>");
    const patioArgs = rest[0] === "--" ? rest.slice(1) : rest;
    const { cmd, env, cwd } = cliCommand(await readManifest(id), agent, patioArgs);
    const proc = Bun.spawn(cmd, { env, cwd, stdio: ["inherit", "inherit", "inherit"] });
    process.exit(await proc.exited);
  }
  case "env": {
    // Shell exports for a new person in this instance, set up by hand with `patio join <link>` (docs/poc/try-it.md):
    // a PATIO_HOME inside the instance root, the instance's server and its fake Jev. Not in the manifest, so `just
    // down` does not stop the patio that join starts (its pid is in $PATIO_HOME/patio.pid).
    const [id, person] = args;
    if (!id || !person || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(person)) throw new Error("usage: just env <id> <person>");
    const m = await readManifest(id);
    const home = join(m.root, person);
    assertSafeHome(home, m.root);
    const vars: Record<string, string> = {
      PATIO_HOME: home,
      PATIO_RELAY: m.exchange.url.replace(/^http/, "ws"),
      PATIO_NO_NOTIFY: "1",
      // A dev instance never installs the answer service: it would replace the computer's own (patio join).
      PATIO_NO_SERVICE: "1",
      PATIO_DEVICE_NAME: `${person}-laptop`,
      ...(m.jev ? { TYPESAFE_API_KEY: FAKE_JEV_KEY, PATIO_JEV_URL: m.jev.url } : {}),
    };
    for (const [k, v] of Object.entries(vars)) console.log(`export ${k}=${JSON.stringify(v)}`);
    break;
  }
  default:
    console.error("usage: instance.ts up <agents...> | down <id> | cli <id> <agent> -- <args> | env <id> <person>");
    process.exit(1);
}
