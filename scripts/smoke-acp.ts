// just smoke-acp --yes-live: the increment-5 path, live. Alice asks Bob a question about his sandbox repo. Bob's
// gatekeeper gates it with the real Jev (if it holds it, the script approves it as the owner, and says so); Bob runs `patio watch --once --answer`, which
// claims it (his grant has auto_answer for Alice) and starts Codex through codex-acp with its owner's normal
// setup, forced to gpt-6-luna at low effort through CODEX_CONFIG on that CLI process only. Codex's reply goes
// through Bob's real output gate (DLP, then Jev on his deny and posture rules) before it is sent.
//
// Pass: the reply reaches Alice with the fact, and Bob's audit log has the input and output decisions with
// Jev's answers. Earlier smokes also asked for a file to be created; the input gate's injection question now
// covers such requests ("change files"), so this one only asks. Spends 1 codex_acp unit (after a
// free preflight) and reserves 2 jev units (Bob's input and output gates; Alice's gate uses the fake Jev).
import { existsSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { budgetLeft, readBudget, spend } from "./lib/budget";
import { codexSmokeEnv, preflightCodex, SMOKE_EFFORT, SMOKE_MODEL } from "./lib/codex";
import { EXIT_BUDGET_SPENT, EXIT_FAIL, EXIT_NO_KEY, liveGate } from "./lib/live";
import { SANDBOX_DIR, SECRETS_FILE, VERIFY_DIR } from "./lib/paths";
import { runScenario, type Scenario } from "./lib/scenario";
import { readSecret } from "./lib/secrets";

const FACT = "PELICAN-7";
const JEV_UNITS = 2;
let ctx = { repo: "", env: {} as Record<string, string>, key: "" };

export const SMOKE_GRANTS = `contacts:
  alice:
    auto_answer: true
    deny: ["my salary and personal finances"]
    posture: ["never promise dates or commitments on my behalf"]
`;

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=patio-smoke", "-c", "user.email=smoke@patio.invalid", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.toString().trim();
};

export const smokeAcp: Scenario = {
  name: "smoke-acp",
  description: `Live: Bob's \`patio watch --once --answer\` answers Alice's question with Codex (codex-acp with the owner's normal setup, ${SMOKE_MODEL}, effort ${SMOKE_EFFORT}) from a sandbox repo, through Bob's real input and output gates and the real Jev.`,
  label: "live",
  agents: () => [
    { handle: "alice" },
    {
      handle: "bob",
      grants: SMOKE_GRANTS,
      // Bob's gates use the real Jev; Alice's keep the instance's fake one.
      get env() {
        return { TYPESAFE_API_KEY: ctx.key, PATIO_JEV_URL: "", PATIO_JEV_MAX_RETRIES: "0" };
      },
      agentConfig: async (dir) => {
        const root = dirname(dir);
        ctx.repo = join(SANDBOX_DIR, `${basename(root)}-repo`);
        ctx.env = codexSmokeEnv(join(root, "codex-acp-logs"));
        await mkdir(join(ctx.repo, "docs"), { recursive: true });
        await writeFile(join(ctx.repo, "README.md"), "# Sandbox service\n\nA throwaway repo for the patio Codex smoke.\n");
        await writeFile(join(ctx.repo, "docs/release.md"), `# Release notes\n\nThe deploy freeze codename for this sprint is ${FACT}.\n`);
        git(ctx.repo, "init", "-q");
        git(ctx.repo, "add", ".");
        git(ctx.repo, "commit", "-q", "-m", "sandbox");
        return `agent: codex\ncwd: ${JSON.stringify(ctx.repo)}\n`;
      },
    },
  ],
  async run(t) {
    const pre = await preflightCodex(ctx.repo, ctx.env);
    t.note(
      `Preflight (no prompt, no budget): codex-acp reports model \`${pre.model}\`, effort \`${pre.effort}\`, starting mode \`${pre.current_mode}\` (modes ${pre.modes.join(", ")}).`,
    );
    t.expect(`codex-acp session uses ${SMOKE_MODEL} at ${SMOKE_EFFORT} effort`, pre.ok, `${pre.model}/${pre.effort}`);
    if (!pre.ok) return;

    const ask = await t.cli("alice", [
      "ask",
      "bob",
      "What is the deploy freeze codename for this sprint? It is written in docs/release.md in your repo; please read it and quote it.",
      "--file",
      "docs/release.md",
    ]);
    t.expect("ask exits 0", ask.code === 0, `exit ${ask.code}`);
    // Bob's input gate asks the real Jev; wait for its decision before consuming the inbox.
    for (let i = 0; i < 100 && !t.gateLog("bob", false).length; i++) await Bun.sleep(200);
    const input = t.gateLog("bob")[0];
    t.expect("Bob's input gate asked the real Jev and did not reject it", !!input?.jev?.request_id && input?.verdict !== "reject", JSON.stringify(input));
    if (!input || input.verdict === "reject") return;
    if (input.verdict === "ask-human") {
      const res = await t.webPost("bob", `/gates/${input.message_id}/decide`, { decision: "approve" });
      t.note(`**Bob's input gate held the question** (${input.reason}); Bob approved it once in the web app so the run could go on: ${res.ok ?? res.error}`);
    }

    const left = await spend("codex_acp");
    t.note(`Spent 1 codex_acp unit; ${left} left.`);
    const watch = await t.cli("bob", ["watch", "--once", "--answer"], 500_000, ctx.env);
    const line = watch.stdout ? JSON.parse(watch.stdout.split("\n")[0]!) : null;
    t.expect("watch --once --answer answered the question", watch.code === 0 && line?.result === "answered", watch.stdout || watch.stderr.slice(-600));
    const wait = await t.cli("alice", ["wait", ask.stdout, "--timeout", "30"]);
    t.expect(`the reply reaches Alice and contains the fact ${FACT}`, wait.code === 0 && wait.stdout.includes(FACT), wait.stdout.slice(0, 600));
    const status = git(ctx.repo, "status", "--porcelain", "--untracked-files=all");
    t.note(`Sandbox repo after the run (informational): ${status ? "changed:\n\n```text\n" + status + "\n```" : "unchanged"}`);
    const output = t.gateLog("bob").find((l) => l.direction === "out");
    t.expect("Bob's output gate sent the reply after asking the real Jev (deny and posture)", output?.verdict === "send" && Object.keys(output?.probabilities ?? {}).join() === "deny_0,posture_0" && !!output?.jev?.request_id, JSON.stringify(output));
    const audit = t.audit("bob", watch.stderr);
    t.expect("answer logged the session mode", audit.mode.length === 1, audit.mode.join());
    t.expect("Bob's message is answered", /\banswered\b/.test((await t.cli("bob", ["inbox", "--all"])).stdout));
  },
};

if (import.meta.main) {
  await liveGate("smoke-acp", "codex_acp", 1);
  const jevLeft = budgetLeft(await readBudget(), "jev");
  if (jevLeft < JEV_UNITS) {
    console.error(`smoke-acp: jev budget spent (${jevLeft} left, ${JEV_UNITS} needed). Nothing was sent.`);
    process.exit(EXIT_BUDGET_SPENT);
  }
  const key = await readSecret("TYPESAFE_API_KEY");
  if (!key) {
    console.error(`smoke-acp: TYPESAFE_API_KEY is absent from ${SECRETS_FILE}; Bob's gates need the real Jev. Nothing was sent.`);
    process.exit(EXIT_NO_KEY);
  }
  ctx.key = key;
  await spend("jev", JEV_UNITS);
  const r = await runScenario(smokeAcp);
  // Keep the evidence with the other verification output; the instance itself is throwaway.
  const out = join(VERIFY_DIR, "live", `acp-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "result.json"), JSON.stringify(r, null, 2) + "\n");
  if (r.transcript && existsSync(r.transcript)) await copyFile(r.transcript, join(out, "transcript.md"));
  console.error(`${r.ok ? "PASS" : "FAIL"} smoke-acp (${r.ms} ms) transcript ${r.transcript}${r.error ? ` error: ${r.error}` : ""}`);
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : EXIT_FAIL);
}
