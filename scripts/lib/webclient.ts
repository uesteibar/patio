// A scripted browser for one gatekeeper's web app: follows redirects by hand (through the exchange and the
// GitHub provider) and keeps that app's session cookie and CSRF token. Used by tests and scenarios to drive
// the same sign-in, pairing, approval and workspace flows a human uses.
export class WebClient {
  cookie = "";
  csrf = "";
  constructor(readonly base: string) {}

  async signIn(login: string) {
    let url = `${this.base}/login?login=${encodeURIComponent(login)}`;
    for (let hop = 0; hop < 10; hop++) {
      const res = await fetch(url, { redirect: "manual", headers: url.startsWith(this.base) && this.cookie ? { cookie: this.cookie } : {} });
      const set = res.headers.get("set-cookie");
      if (set && url.startsWith(this.base)) this.cookie = set.split(";")[0]!;
      const next = res.headers.get("location");
      if (!next) break;
      url = new URL(next, url).toString();
      if (url === `${this.base}/` || url.startsWith(`${this.base}/?`)) break;
    }
    const page = await this.get("/");
    this.csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    if (!this.csrf) throw new Error(`${login} did not end up signed in`);
  }

  get(path: string) {
    return fetch(`${this.base}${path}`, { redirect: "manual", headers: this.cookie ? { cookie: this.cookie } : {} });
  }

  // Posts a form; returns where the app redirected to (with its ok= or error= message) and the response.
  async post(path: string, fields: Record<string, string>, opts: { csrf?: string; cookie?: string; origin?: string } = {}) {
    const res = await fetch(`${this.base}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...((opts.cookie ?? this.cookie) ? { cookie: opts.cookie ?? this.cookie } : {}),
        ...(opts.origin ? { origin: opts.origin } : {}),
      },
      body: new URLSearchParams({ csrf: opts.csrf ?? this.csrf, ...fields }),
    });
    const location = res.headers.get("location");
    const back = location ? new URL(location, this.base) : null;
    return { res, location: back, ok: back?.searchParams.get("ok") ?? null, error: back?.searchParams.get("error") ?? null };
  }
}

