// just browser-join: headless Chromium (Playwright), in a fresh instance with the fake GitHub, checks joining by
// prompt and the Agents page. Jorge, new, has his coding agent run `patio join <link> --no-wait` on a fresh home (no
// terminal): it prints one link. In the browser he signs in with GitHub and lands on one screen, "Your agent
// jorge-team (Claude Code in …) wants to join team", and clicks Confirm; the agent's second run finishes. Then Bob,
// with two agents on one computer (bob and bob-side, each with its own rules), opens the Agents page: one card per
// agent with its tool, folder, workspaces (taken out and put back), the coding tools that run it, and its rules (one
// set, the same in every workspace). Jorge then moves jorge-team to a new computer with the screen's one action, Move.
// Screenshots go to .verify/browser/join-<timestamp>/.
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { findChromium } from "./lib/browser";
import { assertSafeHome, cliCommand, FAKE_JEV_KEY, inherited, procStart, stop, up } from "./lib/instance";
import { PATIO_CLI, REPO, VERIFY_DIR } from "./lib/paths";

type Check = { name: string; ok: boolean; detail?: string };

export async function browserJoin(outRoot = join(VERIFY_DIR, "browser")) {
  const executablePath = findChromium();
  if (!executablePath) return { ok: false, error: "no Chromium found (set PATIO_CHROMIUM)" };
  const out = join(outRoot, `join-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(out, { recursive: true });
  const checks: Check[] = [];
  const screenshots: string[] = [];
  const expect = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, ...(detail ? { detail } : {}) });

  const m = await up([
    { handle: "alice", channels: ["general"] },
    {
      handle: "bob",
      grants: 'defaults:\n  deny: ["salaries"]\ncontacts:\n  alice:\n    per_day: 20\n',
      agentConfig: (dir) => `agent: claude\ncwd: ${JSON.stringify(join(dir, "code", "orbit"))}\n`,
      extra: [{ name: "bob-side", file: (dir) => ({ tool: "codex", folder: join(dir, "code", "side"), rules: 'defaults:\n  kinds: [question, report]\n  posture: ["never promise a date"]\n' }) }],
    },
  ]);
  const browser = await chromium.launch({ executablePath, headless: true });
  const shot = async (page: Page, name: string, selector?: string) => {
    const file = join(out, `${String(screenshots.length + 1).padStart(2, "0")}-${name}.png`);
    if (selector) await page.locator(selector).first().screenshot({ path: file });
    else await page.screenshot({ path: file, fullPage: true });
    screenshots.push(file);
  };
  const home = join(m.root, "jorge", ".patio");
  try {
    // ---- the link, and Jorge's agent on a fresh home ------------------------------------------------------------
    const ws = m.workspaces.team!;
    const aliceWeb = m.agents.alice!.web_url;
    const admin = await (await browser.newContext({ viewport: { width: 1180, height: 900 } })).newPage();
    await admin.goto(`${aliceWeb}/login?login=alice`);
    await admin.waitForURL(`${aliceWeb}/`);
    await admin.goto(`${aliceWeb}/workspaces/${ws.id}`);
    await admin.locator('[data-channel="general"]').getByRole("button", { name: "Make default" }).click();
    await admin.waitForSelector(".flash:not(.error)");
    const url = `${m.exchange.url.replace(/^ws/, "http")}/join/${ws.link}`;

    assertSafeHome(home, m.root);
    const folder = join(m.root, "jorge", "code", "orbit");
    await mkdir(folder, { recursive: true });
    const env = { ...inherited(), HOME: join(m.root, "jorge"), PATIO_HOME: home, PATIO_WEB_PORT: "0", PATIO_DEVICE_NAME: "jorge-laptop", PATIO_NO_NOTIFY: "1", PATIO_NO_SERVICE: "1", ...(m.jev ? { TYPESAFE_API_KEY: FAKE_JEV_KEY, PATIO_JEV_URL: m.jev.url } : {}) };
    const args = [process.execPath, PATIO_CLI, "join", url, "--tool", "claude", "--folder", folder, "--no-wait", "--ask", "requests", "--act", "ask-human", "--answer", "yes"];
    const first = Bun.spawnSync(args, { env, cwd: REPO, stdout: "pipe", stderr: "pipe" });
    const confirm = /Confirm in your browser: (\S+)/.exec(first.stdout.toString())?.[1] ?? "";
    expect("the agent's first run prints one link and stops (exit 5)", first.exitCode === 5 && !!confirm, first.stdout.toString());

    // ---- the one screen ------------------------------------------------------------------------------------------
    const jorge = await (await browser.newContext({ viewport: { width: 1180, height: 820 } })).newPage();
    const c = new URL(confirm);
    // He opens the link: patio sends him to sign in with GitHub first, then back to the screen.
    await jorge.goto(confirm);
    await jorge.waitForURL(/\/login|github|authorize|\/confirm/);
    if (!jorge.url().includes("/confirm")) {
      await jorge.goto(`${c.origin}/login?login=jorge&next=${encodeURIComponent(c.pathname + c.search)}`);
      await jorge.waitForURL(`${c.origin}/confirm${c.search}`);
    }
    const screen = jorge.locator("[data-confirm]");
    const said = ((await screen.locator("h1").textContent()) ?? "").replace(/\s+/g, " ");
    // The folder as a person writes it: ~ for the home patio runs with.
    expect("one screen: Your agent jorge-team (Claude Code in the folder) wants to join team", said === "Your agent jorge-team (Claude Code in ~/code/orbit) wants to join team", said);
    expect("with Confirm and Decline", (await screen.getByRole("button").allTextContents()).join("|") === "Decline|Confirm");
    await shot(jorge, "confirm-one-screen");
    await screen.getByRole("button", { name: "Confirm" }).click();
    await jorge.waitForSelector(".flash:not(.error)");
    const done = (await jorge.locator(".flash").textContent()) ?? "";
    expect("Confirm covers the computer, the agent and the join", done === "jorge-team is your agent on this computer, in team and #general. Tell your agent you are done: it still has to finish the setup (patio join).", done);
    await shot(jorge, "after-confirm-agents");
    // The link again, once confirmed: the same words, and no claim that the setup is finished.
    await jorge.goto(confirm);
    const confirmed = ((await jorge.locator("main").textContent()) ?? "").replace(/\s+/g, " ");
    expect("the confirmed screen says to tell your agent you are done", confirmed.includes("Tell your agent you are done") && !/\bDone\b/.test(confirmed.replace("you are done", "")), confirmed.slice(0, 300));
    await shot(jorge, "confirmed-tell-your-agent");
    const second = Bun.spawnSync(args, { env, cwd: REPO, stdout: "pipe", stderr: "pipe" });
    expect("the agent's second run finishes (exit 0)", second.exitCode === 0 && second.stdout.toString().includes("patio is ready: jorge-team is in team."), second.stdout.toString());
    // His three answers (requests, ask-human, yes), as sentences on his Agents page, with the command to change them.
    await jorge.goto(`${c.origin}/agents`);
    const answers = ((await jorge.locator('[data-answers="jorge-team"]').textContent()) ?? "").replace(/\s+/g, " ");
    expect(
      "the Agents page says the three answers as sentences, and how to change them",
      answers.includes("Others may ask jorge-team questions and small requests; never for secrets.") &&
        answers.includes("jorge-team changes files for them only when you approve.") &&
        answers.includes("jorge-team answers the agents of team on its own.") &&
        answers.includes("Change them: patio rules jorge-team --ask … --act … --answer …"),
      answers,
    );
    await shot(jorge, "agents-three-answers", '[data-agent-card="jorge-team"]');

    // ---- the Agents page ---------------------------------------------------------------------------------------
    const bobWeb = m.agents.bob!.web_url;
    const bob = await (await browser.newContext({ viewport: { width: 1180, height: 1000 } })).newPage();
    await bob.goto(`${bobWeb}/login?login=bob`);
    await bob.waitForURL(`${bobWeb}/`);
    await bob.getByRole("link", { name: "Agents" }).click();
    const cards = bob.locator("[data-agent-card]");
    expect("one card per agent", (await cards.count()) === 2 && (await cards.evaluateAll((els) => els.map((e) => e.getAttribute("data-agent-card")))).join(",") === "bob,bob-side");
    const side = bob.locator('[data-agent-card="bob-side"]');
    const sideText = ((await side.textContent()) ?? "").replace(/\s+/g, " ");
    expect("a card shows the tool and folder, its workspaces and the coding tools", sideText.includes("Codex in") && sideText.includes("code/side") && (await side.locator('.chip[data-ws="team"]').count()) === 1 && sideText.includes("patio connect claude --as bob-side"), sideText.slice(0, 300));
    expect("its rules are one set, with no tab per workspace", (await side.locator(".tab").count()) === 0 && sideText.includes("kinds: question, report") && sideText.includes("never promise a date"), sideText.slice(-400));
    await shot(bob, "agents-page");
    // Each card links to the agent's guide: the text its coding tool reads with the MCP tool guide.
    await side.getByRole("link", { name: "Guide" }).click();
    await bob.waitForURL(/\/agents\/bob-side\/guide$/);
    const guide = ((await bob.locator("[data-guide]").textContent()) ?? "").replace(/\s+/g, " ");
    expect(
      "the Agents page links the guide: who it is, its rules, how to ask and answer, what never to do, who is in its workspaces",
      guide.includes("You are the patio agent bob-side, of @bob.") && guide.includes("Your rules, in plain words") && guide.includes("What never to do") && /team: .*alice · @alice/.test(guide) && guide.includes("bob-side (you)"),
      guide.slice(0, 400),
    );
    await shot(bob, "agent-guide");
    await bob.goto(`${bobWeb}/agents`);
    // Taking an agent out of a workspace asks first, and says what happens.
    await bob.locator('[data-agent-card="bob-side"] .chip[data-ws="team"] a.x').click();
    await bob.waitForURL(/\/agents\/bob-side\/workspaces\/[^/]+\/leave$/);
    const ask = ((await bob.locator("[data-confirm-leave]").textContent()) ?? "").replace(/\s+/g, " ");
    expect("the leave confirmation: take bob-side out of team? its open questions close", ask.includes("Take bob-side out of team?") && ask.includes("Its open questions from team close."), ask);
    await bob.getByRole("button", { name: "Take it out" }).click();
    await bob.waitForSelector(".flash:not(.error)");
    expect("taking bob-side out of team", ((await bob.locator(".flash").textContent()) ?? "") === "bob-side left team.", (await bob.locator(".flash").textContent()) ?? "");
    expect("its card says Not in a workspace", ((await bob.locator('[data-agent-card="bob-side"]').textContent()) ?? "").includes("Not in a workspace"));
    await bob.locator('[data-agent-card="bob-side"] select[name=workspace]').selectOption({ label: "team" });
    await bob.locator('[data-agent-card="bob-side"]').getByRole("button", { name: "Add" }).click();
    await bob.waitForSelector(".flash:not(.error)");
    expect("and putting it back, into the default channels too", ((await bob.locator(".flash").textContent()) ?? "") === "bob-side is in team and #general.", (await bob.locator(".flash").textContent()) ?? "");
    // Now in #general: the confirmation names the channels it leaves. Cancel keeps it in.
    await bob.locator('[data-agent-card="bob-side"] .chip[data-ws="team"] a.x').click();
    await bob.waitForURL(/\/agents\/bob-side\/workspaces\/[^/]+\/leave$/);
    const named = ((await bob.locator("[data-confirm-leave]").textContent()) ?? "").replace(/\s+/g, " ");
    expect("the confirmation names the channels it leaves", named.includes("Take bob-side out of team? It leaves #general. Its open questions from team close."), named);
    await shot(bob, "leave-confirmation");
    await bob.getByRole("link", { name: "Cancel" }).click();
    await bob.waitForURL(`${bobWeb}/agents`);
    await shot(bob, "agents-page-after");

    // ---- moving to a new computer --------------------------------------------------------------------------------
    // Jorge's laptop is off; on his new Mac his coding agent runs the same join for jorge-team. The one screen says
    // where jorge-team lives and when that computer was last seen, and offers one action: Move.
    const laptopPid = existsSync(join(home, "patio.pid")) ? Number(readFileSync(join(home, "patio.pid"), "utf8")) : 0;
    if (laptopPid && procStart(laptopPid)) process.kill(laptopPid, "SIGTERM");
    for (let i = 0; i < 100 && laptopPid && procStart(laptopPid); i++) await Bun.sleep(50);
    const macHome = join(m.root, "jorge-mac", ".patio");
    assertSafeHome(macHome, m.root);
    const macFolder = join(m.root, "jorge-mac", "code", "orbit");
    await mkdir(macFolder, { recursive: true });
    const macEnv = { ...env, HOME: join(m.root, "jorge-mac"), PATIO_HOME: macHome, PATIO_DEVICE_NAME: "jorge-mac" };
    const macArgs = [process.execPath, PATIO_CLI, "join", url, "--tool", "claude", "--folder", macFolder, "--no-wait", "--ask", "requests", "--act", "ask-human", "--answer", "yes"];
    const macFirst = Bun.spawnSync(macArgs, { env: macEnv, cwd: REPO, stdout: "pipe", stderr: "pipe" });
    const macConfirm = /Confirm in your browser: (\S+)/.exec(macFirst.stdout.toString())?.[1] ?? "";
    expect("on the new computer, the agent's first run prints one link (exit 5)", macFirst.exitCode === 5 && !!macConfirm, macFirst.stdout.toString());
    const mac = await (await browser.newContext({ viewport: { width: 1180, height: 900 } })).newPage();
    const cm = new URL(macConfirm);
    await mac.goto(`${cm.origin}/login?login=jorge&next=${encodeURIComponent(cm.pathname + cm.search)}`);
    await mac.waitForURL(`${cm.origin}/confirm${cm.search}`);
    const moveScreen = mac.locator("[data-confirm]");
    const moveText = ((await moveScreen.textContent()) ?? "").replace(/\s+/g, " ");
    expect(
      "the screen says jorge-team lives on jorge-laptop, when it was last seen, and what moving does",
      moveText.includes("jorge-team lives on your other computer jorge-laptop (last seen just now).") &&
        moveText.includes("jorge-laptop has no other agent, so it is revoked too.") &&
        moveText.includes("Your teammates' patio will ask them to trust this computer's new keys before your messages reach them."),
      moveText.slice(0, 600),
    );
    expect("one action, Move jorge-team to this computer (and Decline)", (await moveScreen.getByRole("button").allTextContents()).join("|") === "Decline|Move jorge-team to this computer");
    await shot(mac, "confirm-move-to-this-computer");
    await moveScreen.getByRole("button", { name: "Move jorge-team to this computer" }).click();
    await mac.waitForSelector(".flash:not(.error)");
    const movedFlash = (await mac.locator(".flash").textContent()) ?? "";
    expect("Move confirms it here", movedFlash.startsWith("jorge-team moved here from jorge-laptop, and is your agent on this computer, in team"), movedFlash);
    await shot(mac, "after-move-agents");
    const macSecond = Bun.spawnSync(macArgs, { env: macEnv, cwd: REPO, stdout: "pipe", stderr: "pipe" });
    expect(
      "the agent's second run finishes, and says what teammates will see",
      macSecond.exitCode === 0 && macSecond.stdout.toString().includes("patio is ready: jorge-team is in team.") && macSecond.stdout.toString().includes("Your teammates' patio will ask them to trust this computer's new keys before your messages reach them."),
      macSecond.stdout.toString(),
    );
    const macPidFile = join(macHome, "patio.pid");
    const macPid = existsSync(macPidFile) ? Number(readFileSync(macPidFile, "utf8")) : 0;
    if (macPid && procStart(macPid)) process.kill(macPid, "SIGTERM");

    // ---- a person removed from the workspace -------------------------------------------------------------------
    // Alice, team's admin, removes Jorge. His coding agent, on another computer, runs the same join: the one screen
    // shows the refusal, and no Confirm button.
    const aliceTeam = await admin.goto(`${aliceWeb}/workspaces/${ws.id}`);
    expect("Alice opens team's page", aliceTeam?.status() === 200);
    await admin.locator('[data-member="jorge"]').getByRole("button", { name: "Remove from team" }).click();
    await admin.waitForSelector(".flash:not(.error)");
    const home2 = join(m.root, "jorge2", ".patio");
    assertSafeHome(home2, m.root);
    await mkdir(join(m.root, "jorge2", "code", "orbit"), { recursive: true });
    const env2 = { ...env, HOME: join(m.root, "jorge2"), PATIO_HOME: home2, PATIO_DEVICE_NAME: "jorge-desktop" };
    const again = Bun.spawnSync([process.execPath, PATIO_CLI, "join", url, "--tool", "claude", "--folder", join(m.root, "jorge2", "code", "orbit"), "--no-wait", "--ask", "requests", "--act", "ask-human", "--answer", "no"], { env: env2, cwd: REPO, stdout: "pipe", stderr: "pipe" });
    const confirm2 = /Confirm in your browser: (\S+)/.exec(again.stdout.toString())?.[1] ?? "";
    expect("his agent's run on the new computer prints the link (exit 5)", again.exitCode === 5 && !!confirm2, again.stdout.toString());
    const removed = await (await browser.newContext({ viewport: { width: 1180, height: 820 } })).newPage();
    const c2 = new URL(confirm2);
    await removed.goto(`${c2.origin}/login?login=jorge&next=${encodeURIComponent(c2.pathname + c2.search)}`);
    await removed.waitForURL(`${c2.origin}/confirm${c2.search}`);
    const refusal = removed.locator("[data-confirm]");
    const refusalText = ((await refusal.textContent()) ?? "").replace(/\s+/g, " ");
    expect(
      "removed from team: the screen says so, with Decline and no Confirm",
      refusalText.includes("You were removed from team") && (await refusal.getByRole("button").allTextContents()).join("|") === "Decline",
      refusalText.slice(0, 400),
    );
    await shot(removed, "confirm-removed-person");
    const pid2File = join(home2, "patio.pid");
    if (existsSync(pid2File)) {
      const pid2 = Number(readFileSync(pid2File, "utf8"));
      if (pid2 && procStart(pid2)) process.kill(pid2, "SIGTERM");
    }
  } finally {
    await browser.close();
    const pidFile = join(home, "patio.pid");
    const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : 0;
    if (pid && procStart(pid)) process.kill(pid, "SIGTERM");
    await stop(m);
  }
  return { ok: checks.every((c) => c.ok), instance: m.id, checks, screenshots, dir: out };
}

if (import.meta.main) {
  const result = await browserJoin().catch((err) => ({ ok: false, error: String(err?.stack ?? err) }));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
