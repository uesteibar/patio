// Increment 11: who confirms what. Settings that widen what others can do to your agent (auto_answer, a list of
// allowed actions) stay off until the owner turns them on in the web app, per agent and per workspace, even when the
// owner wrote them in the agent's file in their own terminal: an agent that can edit the file must not widen its own
// reach.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { daemon } from "../src/local";
import { startWorld, until, type World } from "./helpers/world";
import { SERVER_MS } from "./helpers/timeouts";

let world: World;
beforeAll(async () => {
  process.env.PATIO_NO_NOTIFY = "1";
  world = await startWorld();
}, SERVER_MS);
afterAll(() => world.stop(), SERVER_MS);

test("auto_answer in an agent's rules stays off until the owner turns it on in the web app; an edited list waits again", async () => {
  const alice = await world.person("alice");
  const bob = await world.person("bob", { grants: `contacts:\n  ${alice.agent}:\n    auto_answer: true\n`, turnOnRules: false });
  expect((await daemon.status(bob.cfg)).pending.rules).toBe(1);
  await daemon.send(alice.cfg, { to: bob.agent, kind: "question", text: "Is staging green?" });
  await until("the question", async () => (await daemon.pending(bob.cfg)).messages.length === 1);
  expect((await daemon.pending(bob.cfg)).messages[0]!.auto_answer).toBe(false);

  const page = await (await bob.web.get("/")).text();
  expect(page).toContain(`${bob.agent} answers ${alice.agent}&#39;s questions and requests on its own (auto_answer)`);
  expect(await world.turnOnRules(bob.web)).toEqual([`${bob.agent}:rules.contacts.${alice.agent}.auto_answer`]);
  expect((await daemon.pending(bob.cfg)).messages[0]!.auto_answer).toBe(true);
  expect((await daemon.status(bob.cfg)).pending.rules).toBe(0);

  // A list of allowed actions is a setting of its own; editing it makes a new one, off until turned on.
  await Bun.write(join(bob.home, "agents", `${bob.agent}.yaml`), `rules:\n  contacts:\n    ${alice.agent}:\n      auto_answer: true\n      actions: ["run the test suite"]\n`);
  await until("the edit to be read", async () => (await daemon.status(bob.cfg)).pending.rules === 1);
  expect((await daemon.pending(bob.cfg)).messages[0]!.auto_answer).toBe(true);
  // Another person signed in to Bob's web app cannot turn it on.
  const other = new (await import("./helpers/world")).WebClient(bob.web.base);
  await other.signIn("carol");
  expect((await other.post("/rules/confirm", { key: `${bob.agent}:rules.contacts.${alice.agent}.actions=["run the test suite"]` })).error).toContain("Only @bob");
  expect((await daemon.status(bob.cfg)).pending.rules).toBe(1);
}, SERVER_MS);
