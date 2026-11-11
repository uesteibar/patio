// Desktop notifications, only for what waits for the person (Questions for you, a message the rules held, changed
// keys, a change of rules to confirm): never for what the answer service answers on its own. A click opens the web app
// on Needs you where the platform lets it:
//   - Linux: notify-send with an "Open" action (libnotify 0.7.9 and later), then xdg-open; an older notify-send that
//     has no actions shows the notification without one.
//   - macOS: terminal-notifier -open when it is installed; otherwise osascript, which cannot open a page on click.
// PATIO_NO_NOTIFY turns them off (tests, scripts).
export type Which = (cmd: string) => string | null;

const line = (text: string) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > 80 ? one.slice(0, 79) + "…" : one;
};

// The command that shows the notification, or null when there is none on this platform.
export function notifyCommand(o: { platform: NodeJS.Platform; which: Which; title: string; body: string; url: string }): string[] | null {
  const title = `patio: ${o.title}`;
  const body = line(o.body);
  if (o.platform === "linux") {
    if (!o.which("notify-send")) return null;
    const open = o.which("xdg-open") ? `[ "$a" = open ] && xdg-open "$3" >/dev/null 2>&1` : "true";
    // Waits for the click in the background; falls back to a plain notification when actions are not supported.
    return ["sh", "-c", `a=$(notify-send --app-name=patio --action=open=Open -- "$1" "$2" 2>/dev/null) && { ${open}; } || notify-send --app-name=patio -- "$1" "$2"`, "sh", title, body, o.url];
  }
  if (o.platform === "darwin") {
    if (o.which("terminal-notifier")) return ["terminal-notifier", "-title", title, "-message", body, "-open", o.url, "-group", "patio"];
    return ["osascript", "-e", `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`];
  }
  return null;
}

export function notify(title: string, body: string, url: string, env = process.env) {
  if (env.PATIO_NO_NOTIFY) return;
  const cmd = notifyCommand({ platform: process.platform, which: (c) => Bun.which(c), title, body, url });
  if (!cmd) return;
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", stdin: "ignore" }).unref();
  } catch {}
}
