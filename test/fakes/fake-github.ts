#!/usr/bin/env bun
// A fake GitHub OAuth provider for tests and dev instances: the authorize page, the token endpoint and
// GET /user, for a few fixed users. It follows GitHub's web application flow closely enough for the
// exchange's real OAuth code: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
//
// The authorize page lists the users as buttons ("Sign in as jorge"). A `login` query parameter (GitHub
// treats it as a suggestion) signs that user in straight away, so scripts need no browser.
//
//   bun test/fakes/fake-github.ts --client-id ID --client-secret SECRET   # prints its base URL
export const FAKE_USERS = [
  { login: "alice", id: 1001, name: "Alice Example" },
  { login: "bob", id: 1002, name: "Bob Example" },
  { login: "carol", id: 1003, name: "Carol Example" },
  { login: "dave", id: 1004, name: "Dave Example" },
  { login: "jorge", id: 1005, name: "Jorge Example" },
  { login: "unai", id: 1006, name: "Unai Example" },
];

export type FakeGitHubOptions = { clientId: string; clientSecret: string; port?: number; users?: typeof FAKE_USERS };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function startFakeGitHub(opts: FakeGitHubOptions) {
  const users = opts.users ?? FAKE_USERS;
  const codes = new Map<string, { login: string; redirectUri: string; expires: number }>();
  const tokens = new Map<string, string>(); // access token -> login
  const random = () => crypto.randomUUID().replaceAll("-", "");

  const issueCode = (login: string, redirectUri: string, state: string | null) => {
    const code = random();
    codes.set(code, { login, redirectUri, expires: Date.now() + 10 * 60_000 });
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    if (state !== null) back.searchParams.set("state", state);
    return Response.redirect(back.toString(), 302);
  };

  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/login/oauth/authorize") {
        const p = url.searchParams;
        const redirectUri = p.get("redirect_uri");
        if (p.get("client_id") !== opts.clientId || !redirectUri) return new Response("Not Found", { status: 404 });
        const chosen = req.method === "POST" ? String((await req.formData()).get("login") ?? "") : p.get("login");
        if (chosen && users.some((u) => u.login === chosen)) return issueCode(chosen, redirectUri, p.get("state"));
        const buttons = users
          .map((u) => `<button name="login" value="${esc(u.login)}">Sign in as ${esc(u.login)}</button>`)
          .join("\n");
        return new Response(
          `<!doctype html><html><head><title>Fake GitHub: authorize</title>
<style>body{font:15px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#222;max-width:360px;margin:80px auto}
button{display:block;width:100%;margin:8px 0;padding:10px;border:1px solid #ccc;border-radius:6px;background:#fafafa;font:inherit;cursor:pointer}</style>
</head><body><h1>Fake GitHub</h1><p>Authorize the patio exchange (test double).</p>
<form method="post" action="${esc(url.pathname + url.search)}">${buttons}</form></body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      if (url.pathname === "/login/oauth/access_token" && req.method === "POST") {
        const type = req.headers.get("content-type") ?? "";
        const body = type.includes("json")
          ? ((await req.json()) as Record<string, string>)
          : Object.fromEntries(new URLSearchParams(await req.text()));
        if (body.client_id !== opts.clientId || body.client_secret !== opts.clientSecret)
          return Response.json({ error: "incorrect_client_credentials" });
        const entry = codes.get(body.code ?? "");
        codes.delete(body.code ?? "");
        if (!entry || entry.expires < Date.now() || (body.redirect_uri && body.redirect_uri !== entry.redirectUri))
          return Response.json({ error: "bad_verification_code" });
        const token = `gho_${random()}`;
        tokens.set(token, entry.login);
        return Response.json({ access_token: token, token_type: "bearer", scope: "" });
      }
      if (url.pathname === "/api/user" || url.pathname === "/user") {
        const auth = req.headers.get("authorization") ?? "";
        const login = tokens.get(auth.replace(/^(Bearer|token) /i, ""));
        const user = users.find((u) => u.login === login);
        if (!user) return Response.json({ message: "Bad credentials" }, { status: 401 });
        return Response.json(user);
      }
      return new Response("Not Found", { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  return { webUrl: base, apiUrl: `${base}/api`, port: server.port!, stop: () => server.stop(true) };
}

if (import.meta.main) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    return i < 0 ? undefined : process.argv[i + 1];
  };
  const gh = startFakeGitHub({ clientId: arg("--client-id") ?? "fake-client", clientSecret: arg("--client-secret") ?? "fake-secret", port: Number(arg("--port") ?? 0) });
  console.log(`fake github listening on ${gh.webUrl}`);
}
