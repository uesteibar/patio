// Shared by the gatekeeper (src/gates.ts) and the live smokes.
// @typesafe-ai/sdk 0.7.0 under Bun 1.4.4: before parsing, the SDK takes a reader on `response.clone().body`
// AND on `response.body`, then releases both. Bun then treats the original body as used and `response.text()`
// throws ERR_BODY_ALREADY_USED, even against a healthy server. This fetch hands the SDK a response whose body
// is buffered and can be read any number of times. Use it as the `fetch` option of every TypeSafeClient under Bun.
class BufferedResponse {
  constructor(
    private readonly bytes: ArrayBuffer,
    readonly status: number,
    readonly statusText: string,
    readonly headers: Headers,
  ) {}
  get ok() {
    return this.status >= 200 && this.status < 300;
  }
  get body() {
    return new Response(this.bytes).body;
  }
  get bodyUsed() {
    return false;
  }
  clone() {
    return new BufferedResponse(this.bytes, this.status, this.statusText, this.headers);
  }
  arrayBuffer() {
    return Promise.resolve(this.bytes.slice(0));
  }
  text() {
    return Promise.resolve(new TextDecoder().decode(this.bytes));
  }
  async json() {
    return JSON.parse(await this.text());
  }
}

export const bunSafeFetch = async (input: string, init?: RequestInit): Promise<Response> => {
  const res = await fetch(input, init);
  const bytes = await res.arrayBuffer();
  const headers = new Headers(res.headers);
  // fetch already decoded the body, so these no longer describe it.
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new BufferedResponse(bytes, res.status, res.statusText, headers) as unknown as Response;
};
