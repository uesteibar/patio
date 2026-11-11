// Increment 10, in increment 12's files: an agent's file (agents/<name>.yaml) reloaded while patio runs, and `patio status`.
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Scenario, Transcript } from "../lib/scenario";
import { bob, until } from "./inbox";
import { parseInbox } from "./inbox-lib";

// Sends `text` of `kind` from Alice to Bob and returns where it ended up: Bob's inbox, or rejected by his rules.
async function fate(t: Transcript, text: string, kind: string): Promise<"inbox" | "rejected"> {
  const sent = await t.cli("alice", ["ask", "bob", text, "--kind", kind]);
  if (sent.code !== 0) throw new Error(`ask failed: ${sent.stderr}`);
  return until(`"${text}" to be gated`, async () => {
    if (parseInbox(await t.cli("bob", ["inbox"])).some((r) => r.text === text)) return "inbox" as const;
    if (parseInbox(await t.cli("bob", ["inbox", "--rejected"])).some((r) => r.text.endsWith(text))) return "rejected" as const;
    return null;
  });
}

// Bob edits his agent's file (agents/bob.yaml): its rules, keeping the tool and folder it has. `raw`: the text as is.
const editRules = async (t: Transcript, rules: Record<string, unknown> | null, raw?: string) => {
  const file = join(t.m.agents.bob!.home, "agents", "bob.yaml");
  const doc = Bun.YAML.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const text = raw ?? JSON.stringify({ ...doc, rules }, null, 2) + "\n";
  await writeFile(file, raw ? `tool: ${JSON.stringify(doc.tool)}\nfolder: ${JSON.stringify(doc.folder)}\n${raw}` : text);
  t.note(`**Bob edits agents/bob.yaml** (no restart), its rules now:\n\n\`\`\`yaml\n${raw ?? Bun.YAML.stringify(rules, null, 2)}\n\`\`\``);
};

const reload: Scenario = {
  name: "rules-reload",
  description:
    "Bob's agent's rules (agents/bob.yaml) let in questions only. He edits them to let in heads-ups too: the next heads-up is delivered, without a restart. He then saves an invalid edit: patio keeps the last valid version (a report is still rejected, as that version says, rather than delivered as the default rules would), keeps its tool too (`patio answer` still works), and reports the error in its log, in `patio status` (exit 1) and in a banner in the web app. Fixing the file clears the error.",
  label: "deterministic",
  agents: () => [{ handle: "alice" }, bob({ reply: "Thursdays." }, { grants: "defaults:\n  kinds: [question]\n" })],
  async run(t) {
    t.expect("v1: a heads-up is rejected (questions only)", (await fate(t, "Heads-up one: I will rebase main", "heads-up")) === "rejected");
    await editRules(t, { kinds: ["question", "heads-up"] });
    t.expect("v2, without a restart: the next heads-up is delivered", (await fate(t, "Heads-up two: rebasing now", "heads-up")) === "inbox");
    t.expect("v2: a report is rejected", (await fate(t, "Report one: CI is green", "report")) === "rejected");

    await editRules(t, null, "rules:\n  kinds: [question, heads-up, gossip]\n");
    t.expect("an invalid edit keeps v2: a report is still rejected (the default rules would deliver it)", (await fate(t, "Report two: CI is still green", "report")) === "rejected");
    t.expect("and a heads-up is still delivered", (await fate(t, "Heads-up three: done", "heads-up")) === "inbox");
    const log = readFileSync(t.m.agents.bob!.log, "utf8");
    t.expect("the patio log reports the error and keeps v2", log.includes("agents/bob.yaml: rules: kinds must list some of") && log.includes("keeping the last valid version (v2"), log.split("\n").filter((l) => l.includes("bob.yaml")).join(" | "));
    const status = await t.cli("bob", ["status"]);
    t.expect("patio status exits 1", status.code === 1, `exit ${status.code}`);
    t.expect("and shows the error under needs attention", status.stdout.includes("status: needs attention") && status.stdout.includes("agents/bob.yaml: rules: kinds must list some of") && status.stdout.includes("(patio keeps the last valid version; fix the file, it is reloaded on save)"), status.stdout);
    const json = JSON.parse((await t.cli("bob", ["status", "--json"])).stdout);
    const f = json.files.find((x: { agent: string }) => x.agent === "bob");
    t.expect("patio status --json has the version kept and the error", json.healthy === false && f.version === 2 && f.error.message.includes("kinds must list"), JSON.stringify(f));
    const page = await t.webGet("bob", "/");
    t.expect("the web app shows a banner", page.html.includes("data-config-error") && page.text.includes("Configuration error. agents/bob.yaml: rules: kinds must list some of") && page.text.includes("keeps using the last valid version (v2)"), page.text.slice(0, 400));

    const sent = await t.cli("alice", ["ask", "bob", "When is the release branch cut?"]);
    const q = await until("the question in Bob's inbox", async () => parseInbox(await t.cli("bob", ["inbox", "--json"])).find((r) => r.convo === sent.stdout.slice(0, 8)));
    const answered = await t.cli("bob", ["answer", q.id]);
    t.expect("the invalid file keeps the last valid tool too: answer still works", answered.code === 0, `${answered.code} ${answered.stderr.split("\n").pop()}`);

    await editRules(t, { kinds: ["question", "heads-up", "report"] });
    t.expect("fixed (v3): a report is delivered", (await fate(t, "Report three: deployed", "report")) === "inbox");
    const status3 = JSON.parse((await t.cli("bob", ["status", "--json"])).stdout);
    const f3 = status3.files.find((x: { agent: string }) => x.agent === "bob");
    t.expect("the error is gone", f3.version === 3 && f3.error === null, JSON.stringify(f3));
  },
};

const noul = (n: number) => ({ type: "noul" as const, noul: n });

const status: Scenario = {
  name: "status",
  description:
    "`patio status` on one screen: you, this computer, the server, and a table of agents. Bob's patio is connected, signed in, has an approved agent in a workspace with a valid file, and Jev: healthy, exit 0. A message his input gate holds needs him: exit 1, and the screen says what and where. With the gatekeeper stopped, status says it is not running (exit 1). --json carries the same.",
  label: "deterministic",
  jev: { default: noul(0.02), answers: { allow: noul(0.98), injection: [{ stateMatches: "HOLD-ME", answer: noul(0.6) }, { answer: noul(0.02) }] } },
  agents: () => [{ handle: "alice" }, bob({ reply: "Thursdays." })],
  async run(t) {
    const ok = await t.cli("bob", ["status"]);
    t.expect("healthy: exit 0", ok.code === 0 && ok.stdout.endsWith("status: healthy"), `${ok.code}\n${ok.stdout}`);
    for (const line of ["you: @bob", "this computer: bob-gatekeeper", "(connected)", "judge: this computer's key (TYPESAFE_API_KEY)", "waiting for you: 0 questions, 0 incoming and 0 outgoing messages", "inbox: 0 unread", "outbox: 0 queued", "web app http://127.0.0.1:", "AGENT", "WORKSPACES"])
      t.expect(`it shows ${line.trim()}`, ok.stdout.includes(line));
    t.expect("the table has bob, in team, on this computer", /^bob\s+.*\s+team\s+.*bob-gatekeeper$/m.test(ok.stdout), ok.stdout);
    const json = JSON.parse((await t.cli("bob", ["status", "--json"])).stdout);
    t.expect("--json: healthy, nothing needs attention", json.running === true && json.healthy === true && json.attention.length === 0, JSON.stringify(json.attention));

    await t.cli("alice", ["ask", "bob", "HOLD-ME: what is the payroll schedule?"]);
    await until("held", async () => JSON.parse((await t.cli("bob", ["status", "--json"])).stdout).pending.held_in === 1);
    const held = await t.cli("bob", ["status"]);
    t.expect("a held message: exit 1, and the screen says what and where", held.code === 1 && held.stdout.includes("status: needs attention") && held.stdout.includes("1 message waits for you in the web app: http://127.0.0.1:"), held.stdout);

    await t.stopAgent("bob");
    const down = await t.cli("bob", ["status"]);
    t.expect("patio stopped: not running, exit 1", down.code === 1 && down.stdout.startsWith("patio: not running") && down.stdout.includes("patio is not running on this computer") && down.stdout.includes("start it with `patio up`"), down.stdout);
    const downJson = JSON.parse((await t.cli("bob", ["status", "--json"])).stdout);
    t.expect("--json says so too", downJson.running === false && downJson.healthy === false, JSON.stringify(downJson));
  },
};

export const CONFIG_SCENARIOS = [reload, status];
