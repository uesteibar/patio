// Increment 11: a demo teammate without GitHub. `patio exchange demo-person` runs on the server's host (it opens the
// server's database), creates the person and prints a one-time sign-in link valid 10 minutes. Opening it lets that
// browser sign in to the demo person's patio web app through the same handoff as GitHub, once. Others see them
// labelled demo, and a GitHub account with the same login is refused.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { daemon } from "../src/local";
import { startWorld, until, WebClient, type World } from "./helpers/world";
import { PROCESS_MS } from "./helpers/timeouts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
let world: World;
beforeAll(async () => {
  process.env.PATIO_NO_NOTIFY = "1";
  world = await startWorld();
}, PROCESS_MS);
afterAll(() => world.stop(), PROCESS_MS);

async function demoPerson(login: string) {
  const proc = Bun.spawn([process.execPath, CLI, "exchange", "demo-person", login, "--db", world.dbPath, "--public-url", world.exchangeUrl], { stdout: "pipe", stderr: "pipe", env: { ...process.env, PATIO_NO_NOTIFY: "1" } });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  expect(await proc.exited).toBe(0);
  return { link: out.trim(), err };
}

// What a browser does: open the demo link (the server sets a cookie), then sign in to the web app, which goes
// through the server's sign-in start; that request carries the cookie and comes straight back signed in.
async function signInWithDemoLink(web: WebClient, link: string) {
  const opened = await fetch(link);
  const cookie = opened.headers.get("set-cookie")?.split(";")[0] ?? "";
  const start = await fetch(`${web.base}/login`, { redirect: "manual" });
  const toServer = start.headers.get("location")!;
  const back = await fetch(toServer, { redirect: "manual", headers: cookie ? { cookie } : {} });
  const done = await fetch(back.headers.get("location")!, { redirect: "manual" });
  web.cookie = done.headers.get("set-cookie")?.split(";")[0] ?? "";
  web.csrf = /name="csrf" value="([^"]+)"/.exec(await (await web.get("/")).text())?.[1] ?? "";
  return { opened, signedIn: !!web.csrf };
}

test("the demo person signs in once with the link, is labelled demo for others, and the link fails the second time", async () => {
  const { link, err } = await demoPerson("demo-ana");
  expect(link).toStartWith(`${world.exchangeUrl}/auth/demo/`);
  expect(err).toContain("created @demo-ana");
  const g = await world.gatekeeper();
  const { opened, signedIn } = await signInWithDemoLink(g.web, link);
  expect(await opened.text()).toContain("Sign in as @demo-ana");
  expect(signedIn).toBe(true);
  expect(await (await g.web.get("/")).text()).toContain("Signed in as <b>@demo-ana</b>");
  // The operator can act as them: confirm the computer, register an agent, join a workspace.
  const { code } = await daemon.pair(g.cfg);
  expect((await g.web.post("/pair", { code })).ok).toContain("is now your computer, @demo-ana");
  await until("the pairing", () => g.d.login() === "demo-ana");
  expect((await daemon.register(g.cfg, "demo-ana-agent", true)).agent.status).toBe("approved");
  const team = await world.team();
  const created = await team.admin.post(`/workspaces/${team.id}/links`, { expires: "7d" });
  const invite = /Created an invite link: \S+\/join\/(\S+)$/.exec(created.ok!)![1]!;
  expect((await daemon.joinLink(g.cfg, invite, ["demo-ana-agent"], true)).status).toBe("joined");
  const roster = await (await team.admin.get(`/workspaces/${team.id}`)).text();
  expect(roster).toMatch(/@demo-ana <span class="tag demo"[^>]*>demo<\/span>/);
  // The link is used once.
  const again = await fetch(link);
  expect(again.status).toBe(410);
  expect(await again.text()).toContain("This sign-in link no longer works");
  const other = await world.gatekeeper();
  expect((await signInWithDemoLink(other.web, link)).signedIn).toBe(false);
}, PROCESS_MS);

test("a GitHub sign-in whose login is a demo person's is refused with a clear message", async () => {
  await demoPerson("carol");
  const g = await world.gatekeeper();
  await expect(g.web.signIn("carol")).rejects.toThrow("carol did not end up signed in");
  const res = await fetch(`${g.web.base}/login?login=carol`, { redirect: "manual" });
  let url = res.headers.get("location")!;
  for (let hop = 0; hop < 6 && !url.startsWith(g.web.base); hop++) url = new URL((await fetch(url, { redirect: "manual" })).headers.get("location")!, url).toString();
  const back = await fetch(url, { redirect: "manual" });
  const error = new URL(back.headers.get("location")!, g.web.base).searchParams.get("error");
  expect(error).toBe("@carol is a demo person on this server, so the GitHub account @carol cannot sign in here; ask the server's operator about it");
}, PROCESS_MS);
