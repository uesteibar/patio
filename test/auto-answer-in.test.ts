// "Should it answer orbit on its own? yes": an agent with auto_answer_in: [orbit] answers a question from an agent of
// orbit on its own (`patio watch --once --answer`, with a fake ACP agent as its tool), and leaves one from an agent it
// shares only another workspace with waiting in its inbox.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { daemon, waitForReply } from "../src/local";
import { CLI } from "./helpers/cli";
import { startWorld, until, type Person, type World } from "./helpers/world";
import { PROCESS_MS } from "./helpers/timeouts";

let world: World;
let alice: Person;
let carol: Person;
let bob: Person;

const wsOf = async (p: Person, name: string) => decodeURIComponent((await p.web.post("/workspaces", { name })).location!.pathname.split("/").pop()!);

beforeAll(async () => {
  process.env.PATIO_NO_NOTIFY = "1";
  world = await startWorld();
  const dir = await mkdtemp(join(world.dir, "bob-agent-"));
  const fixture = join(dir, "fixture.json");
  await writeFile(fixture, JSON.stringify({ reply: "The release branch is cut on Thursdays." }));
  const tool = [process.execPath, join(import.meta.dir, "fakes/fake-acp-agent.ts"), "--fixture", fixture, "--log", join(dir, "agent.jsonl")].join(" ");
  alice = await world.person("alice", { team: false });
  carol = await world.person("carol", { team: false });
  // Bob's answer to "should it answer orbit on its own?" was yes; turned on by that answer (here, in the web app).
  bob = await world.person("bob", { team: false, file: { tool, folder: dir, rules: "defaults:\n  auto_answer_in: [orbit]\n" } });
  const orbit = await wsOf(alice, "orbit");
  const side = await wsOf(carol, "side");
  for (const [admin, ws, members] of [[alice, orbit, [alice, bob]], [carol, side, [carol, bob]]] as const) {
    const code = await world.inviteLink(admin.web, ws);
    for (const m of members) await world.joinByLink(m, code);
  }
}, PROCESS_MS);
afterAll(() => world.stop(), PROCESS_MS);

test("auto_answer_in: [orbit] answers orbit's agent on its own, and leaves the other workspace's question waiting", async () => {
  const fromOrbit = await daemon.send(alice.cfg, { to: bob.agent, kind: "question", text: "When is the release branch cut?" });
  const fromSide = await daemon.send(carol.cfg, { to: bob.agent, kind: "question", text: "When is the side project's demo?" });
  await until("both reached bob", async () => {
    const ids = (await daemon.inbox(bob.cfg)).messages.map((m) => m.id);
    return ids.includes(fromOrbit.id) && ids.includes(fromSide.id);
  });
  const pending = (await daemon.pending(bob.cfg)).messages;
  expect(pending.find((m) => m.id === fromOrbit.id)?.auto_answer).toBe(true);
  expect(pending.find((m) => m.id === fromSide.id)?.auto_answer).toBe(false);

  // Bob's patio runs in this process: the watch runs as its own process, asynchronously.
  const env = { ...process.env, PATIO_HOME: bob.home, PATIO_NO_NOTIFY: "1" } as Record<string, string>;
  delete env.PATIO_AGENT;
  const w = Bun.spawn([process.execPath, CLI, "watch", "--once", "--answer"], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(w.stdout).text(), new Response(w.stderr).text()]);
  expect(await w.exited).toBe(0);
  expect(out).toContain(fromOrbit.id);
  expect(err).toContain(`skipped ${fromSide.id.slice(0, 8)} from ${carol.agent}: its rules do not allow auto_answer`);
  expect((await waitForReply(alice.cfg, fromOrbit.convo, 5))?.text).toBe("The release branch is cut on Thursdays.");
  const inbox = (await daemon.inbox(bob.cfg, { filter: "all" })).messages;
  expect(inbox.find((m) => m.id === fromOrbit.id)?.state).toBe("answered");
  expect(inbox.find((m) => m.id === fromSide.id)?.state).toBe("unread");
}, PROCESS_MS);
