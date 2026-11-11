import { afterAll, expect, test } from "bun:test";
import { startFakeGitHub } from "./fake-github";
import { SERVER_MS } from "../helpers/timeouts";

const gh = startFakeGitHub({ clientId: "cid", clientSecret: "csecret" });
afterAll(() => gh.stop(), SERVER_MS);

const authorize = (params: Record<string, string>) =>
  fetch(`${gh.webUrl}/login/oauth/authorize?${new URLSearchParams({ client_id: "cid", redirect_uri: "http://127.0.0.1:9/cb", state: "s1", ...params })}`, {
    redirect: "manual",
  });

const tokenFor = (code: string, secret = "csecret") =>
  fetch(`${gh.webUrl}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: "cid", client_secret: secret, code, redirect_uri: "http://127.0.0.1:9/cb" }),
  });

test("the authorize page lets you pick one of the fixed users", async () => {
  const page = await (await authorize({})).text();
  for (const login of ["alice", "bob", "carol", "jorge", "unai"]) expect(page).toContain(`Sign in as ${login}`);
}, SERVER_MS);

test("authorize with a login, then token, then /user returns that GitHub user", async () => {
  const res = await authorize({ login: "jorge" });
  expect(res.status).toBe(302);
  const back = new URL(res.headers.get("location")!);
  expect(back.origin + back.pathname).toBe("http://127.0.0.1:9/cb");
  expect(back.searchParams.get("state")).toBe("s1");
  const token = (await (await tokenFor(back.searchParams.get("code")!)).json()) as { access_token: string; token_type: string };
  expect(token.token_type).toBe("bearer");
  const user = await (await fetch(`${gh.apiUrl}/user`, { headers: { authorization: `Bearer ${token.access_token}` } })).json();
  expect(user).toMatchObject({ login: "jorge", id: expect.any(Number) });
}, SERVER_MS);

test("a code works once, needs the client secret, and an unknown client is refused", async () => {
  const code = new URL((await authorize({ login: "alice" })).headers.get("location")!).searchParams.get("code")!;
  expect(((await (await tokenFor(code, "wrong")).json()) as { error: string }).error).toBe("incorrect_client_credentials");
  expect((await (await tokenFor(code)).json()) as object).toHaveProperty("access_token");
  expect(((await (await tokenFor(code)).json()) as { error: string }).error).toBe("bad_verification_code");
  expect((await authorize({ client_id: "other" })).status).toBe(404);
  expect((await fetch(`${gh.apiUrl}/user`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
}, SERVER_MS);
