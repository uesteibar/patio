// A WebSocket proxy between one gatekeeper and the exchange. A test can make it swallow the frames of one type the
// gatekeeper sends (so a request to the exchange never gets an answer), and take it down (the exchange becomes
// unreachable: open connections close, new ones are refused) and up again.
import type { ServerWebSocket } from "bun";

type Conn = { up: WebSocket | null; queue: string[] };

export function startProxy(target: string) {
  let down = false;
  let swallow: string | null = null;
  const swallowed: Array<Record<string, unknown>> = [];
  const conns = new Set<ServerWebSocket<Conn>>();
  const server = Bun.serve<Conn, never>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      if (down) return new Response("the exchange is down", { status: 503 });
      if (srv.upgrade(req, { data: { up: null, queue: [] } })) return;
      return new Response("WebSocket only", { status: 426 });
    },
    websocket: {
      open(ws) {
        conns.add(ws);
        const up = new WebSocket(target);
        ws.data.up = up;
        up.onopen = () => {
          for (const f of ws.data.queue.splice(0)) up.send(f);
        };
        up.onmessage = (ev) => ws.send(String(ev.data));
        up.onclose = (ev) => ws.close(ev.code >= 4000 ? ev.code : 1000);
      },
      message(ws, raw) {
        const text = String(raw);
        if (swallow && (JSON.parse(text) as { type?: string }).type === swallow) {
          swallowed.push(JSON.parse(text));
          return;
        }
        if (ws.data.up?.readyState === WebSocket.OPEN) ws.data.up.send(text);
        else ws.data.queue.push(text);
      },
      close(ws) {
        conns.delete(ws);
        ws.data.up?.close();
      },
    },
  });
  return {
    url: `ws://127.0.0.1:${server.port}`,
    swallowed,
    swallow(type: string | null) {
      swallow = type;
    },
    down() {
      down = true;
      for (const ws of conns) ws.close();
    },
    up() {
      down = false;
    },
    stop() {
      server.stop(true);
    },
  };
}
