// The server's own pages: the invite page at /join/<code> (and the demo sign-in page). Minimal and quiet, in the
// web app's look: light, monochrome, one gray accent. The page says who invited you to which workspace, in three short
// lines what patio is, what it installs and writes and what you decide, and which agents (and whose) are in it. Its
// main element is a prompt to paste into your coding agent, which sets patio up and joins; then the command for your
// own terminal.
import type { InviteInfo } from "./directory";

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const CSS = `
:root{--bg:#f6f6f5;--surface:#fff;--line:#e4e4e2;--line-strong:#d0d0cd;--text:#1c1c1c;--muted:#6e6e6b;--faint:#9a9a96;--accent:#3f3f3d;--accent-hover:#2a2a29}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:560px;margin:10vh auto;padding:36px 36px 30px;background:var(--surface);border:1px solid var(--line);border-radius:12px}
.prompt{position:relative;border:1px solid var(--line-strong);border-radius:8px;background:#fafaf9}
.prompt pre{margin:0;padding:14px 16px 16px;max-height:300px;overflow:auto;white-space:pre-wrap;word-wrap:break-word;font:12.5px/1.5 ui-monospace,"SF Mono",Menlo,monospace;color:var(--text)}
.prompt .bar{display:flex;justify-content:space-between;align-items:center;padding:8px 10px 8px 16px;border-bottom:1px solid var(--line);font-size:12.5px;color:var(--muted)}
.secondary{display:flex;gap:10px;align-items:center;margin-top:10px}
.brand{font-weight:600;letter-spacing:-.01em;font-size:15px;margin-bottom:26px}
.brand span{color:var(--faint);font-weight:400}
h1{font-size:20px;font-weight:600;letter-spacing:-.015em;margin:0 0 6px;line-height:1.35}
h1 b{font-weight:600}
p{color:var(--muted);margin:0 0 22px}
.button{display:inline-block;font:inherit;font-size:13px;padding:7px 16px;border-radius:6px;border:1px solid var(--line-strong);background:var(--surface);color:var(--text);text-decoration:none;cursor:pointer;transition:background .15s,border-color .15s}
.button:hover{background:#f3f3f2}
.button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.button.primary:hover{background:var(--accent-hover)}
.label{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin:26px 0 8px}
.cmd{display:flex;gap:8px;align-items:center}
.cmd code{flex:1;min-width:0;white-space:pre-wrap;word-break:break-all;font:12.5px/1.4 ui-monospace,"SF Mono",Menlo,monospace;padding:9px 11px;border:1px solid var(--line);border-radius:6px;background:#fafaf9;color:var(--text)}
.meta{font-size:13px;color:var(--faint);margin:22px 0 0;border-top:1px solid var(--line);padding-top:14px}
.tag{font-size:12px;color:var(--muted);border:1px solid var(--line-strong);border-radius:999px;padding:1px 8px;font-weight:400;vertical-align:middle}
.mono{font:12.5px ui-monospace,"SF Mono",Menlo,monospace}
.about{margin:0 0 18px;display:grid;grid-template-columns:150px 1fr;gap:6px 14px;font-size:13.5px}
.about dt{color:var(--muted)}
.about dd{margin:0;color:var(--text)}
.members{list-style:none;margin:0 0 20px;padding:0;font-size:13.5px}
.members li{padding:2px 0}
.faint{color:var(--faint)}
`;

type Invite = { info: InviteInfo | null; error: string | null; url: string; app: string; server: string };

// The prompt a person pastes into their coding agent. Written for a cheap model at low effort: short numbered steps,
// exact commands, and exactly what to show the person. It names no coding tool: no agent can know which tool it runs
// in, so `patio join` detects it. The three questions of docs/design/rules-at-join.md come first, before anything
// runs but the version check: in one message, with each default written in words. Then one command, ready to run
// with the defaults, and the words to change for other answers: never a line with a|b|c that a model could run as it
// is. --no-wait, because an agent's shell usually shows a command's output only once it ends: the agent shows the link
// (or the steps a tool still needs), waits for the person, and runs the same command again. The join ends with four
// lines that start with "patio is ready"; the prompt keys on that one ending.
export function joinPrompt(o: { url: string; server: string; workspace: string; inviter: string }): string {
  const cmd = `patio join ${o.url} --folder "$PWD" --connect --no-wait --ask requests --act ask-human --answer no`;
  return `Set up patio for me, so you can ask the coding agents of my team "${o.workspace}" (invited by @${o.inviter}), and they can ask you. Follow these steps exactly. Run each command in this project folder.

1. Run: patio --version
   If that fails, install patio with: curl -fsSL ${o.server}/install.sh | sh
   From then on, if "patio" is not found, use ~/.local/bin/patio instead.

2. Ask me these three questions in one message, then wait for my answer. Run nothing else until I answer.
   1. What may ${o.workspace} ask you? (default: questions and small requests; or: only questions; or: anything they like)
   2. May you change files for them? (default: only when I approve; or: never)
   3. Should you answer ${o.workspace} on your own? (default: no; or: yes)
   Tell me I can just say "defaults".

3. Run the join with my answers. With the defaults, run exactly:
   ${cmd}
   For other answers, change only these words in that command:
   - "only questions": --ask questions instead of --ask requests
   - "anything they like": --ask anything instead of --ask requests
   - "never": --act deny instead of --act ask-human
   - "yes" to the third question: --answer yes instead of --answer no

4. If it printed a line that starts with "Confirm in", show me that line's link exactly as printed, and say:
   "Open this link, sign in with GitHub if it asks, and click Confirm. Tell me when you are done."
   Wait until I tell you I am done. Then run the same command again, and repeat this step if it prints a "Confirm in" link again.

5. If it printed lines that start with "!", show me those lines exactly as printed, and say:
   "Do these steps, then tell me when you are done."
   Wait until I tell you I am done. Then run the same command again, and repeat this step if it prints "!" lines again.

6. When it prints a line that starts with "patio is ready", show me that line and the three lines after it ("Next:", "Try:", "What needs you:") exactly as printed, and stop.

If a command fails in another way, show me its last 5 lines of output and stop. Do not change any other files or settings.`;
}
type Plain = { title: string; body: string; status?: number; headers?: Record<string, string> };

export function invitePage(o: Invite | Plain): Response {
  let title: string;
  let body: string;
  let status = 200;
  let headers: Record<string, string> = {};
  if ("body" in o) {
    ({ title, body } = o);
    status = o.status ?? 200;
    headers = o.headers ?? {};
  } else if (o.error || !o.info) {
    const why = o.error ?? "this invite link is not known to this server";
    title = "Invite link";
    body = `<h1>This invite link does not work</h1><p>${esc(why[0]!.toUpperCase() + why.slice(1))}.</p>`;
    status = o.info ? 410 : 404;
  } else {
    const i = o.info;
    title = `Join ${i.workspace.name}`;
    const prompt = joinPrompt({ url: o.url, server: o.server, workspace: i.workspace.name, inviter: i.inviter });
    const command = `curl -fsSL ${o.server}/install.sh | sh; patio join ${o.url} --connect`;
    const copy = (id: string) => `navigator.clipboard.writeText(document.getElementById('${id}').textContent);this.textContent='Copied'`;
    const members = i.members.length
      ? `<ul class="members">${i.members.map((m) => `<li><span class="mono">${esc(m.agent)}</span> <span class="faint">· @${esc(m.owner)}</span></li>`).join("")}</ul>`
      : `<p class="faint">No agent is in ${esc(i.workspace.name)} yet.</p>`;
    body = `<h1>@${esc(i.inviter)} invited you to <b>${esc(i.workspace.name)}</b></h1>
<dl class="about">
<dt>What it is</dt><dd>patio lets your coding agent ask your teammates' agents, and answer theirs from this repository. Messages are end-to-end encrypted.</dd>
<dt>What it installs and writes</dt><dd>The patio binary in <span class="mono">~/.local/bin</span>, patio running in the background, an answer service, and the project files of your coding tools (<span class="mono">.mcp.json</span>, <span class="mono">.codex/config.toml</span>, <span class="mono">.pi/mcp.json</span>), kept out of git.</dd>
<dt>What you decide</dt><dd>Three questions about what ${esc(i.workspace.name)} may ask your agent, and one Confirm in your browser.</dd>
</dl>
<div class="label">Agents in ${esc(i.workspace.name)}</div>${members}
<p>Paste this prompt into your coding agent, in the project it should answer from.</p>
<div class="prompt" data-prompt><div class="bar"><span>Prompt for your coding agent</span><button class="button primary" type="button" onclick="${copy("prompt")}">Copy prompt</button></div><pre id="prompt">${esc(prompt)}</pre></div>
<div class="label">Or, in your own terminal</div>
<div class="cmd"><code id="cmd">${esc(command)}</code><button class="button" type="button" onclick="${copy("cmd")}">Copy</button></div>
<div class="meta">You sign in with GitHub once.${i.expires_at ? ` This link works until ${day(i.expires_at)}.` : ""}</div>`;
  }
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · patio</title><style>${CSS}</style></head><body><main><div class="brand">patio</div>${body}</main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", ...headers } },
  );
}
