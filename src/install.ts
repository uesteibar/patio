// What the server serves to install patio: /install.sh, and the built binaries (scripts/build.ts) from a directory
// given with `patio exchange --dist DIR` (or PATIO_DIST), each beside its SHA-256: /dist/patio-<platform> and
// /dist/patio-<platform>.sha256. install.sh detects the platform, downloads the binary to ~/.local/bin/patio, checks
// it against the published SHA-256 and prints the version. `curl -fsSL <server>/install.sh | sh`.
import { existsSync } from "node:fs";
import { join } from "node:path";

export const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64"] as const;
const FILE_RE = /^patio-(darwin-arm64|darwin-x64|linux-x64)(\.sha256)?$/;

export function installScript(base: string): string {
  return `#!/bin/sh
# patio installer, from ${base}. Puts the patio binary in ~/.local/bin/patio (PATIO_INSTALL_DIR to change it).
set -eu
server="${base}"
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) platform=darwin-arm64 ;;
  Darwin-x86_64) platform=darwin-x64 ;;
  Linux-x86_64|Linux-amd64) platform=linux-x64 ;;
  *) echo "patio: no build for $(uname -s) $(uname -m) (there are darwin-arm64, darwin-x64 and linux-x64)" >&2; exit 1 ;;
esac
dir="\${PATIO_INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$dir"
tmp="$(mktemp "\${TMPDIR:-/tmp}/patio.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
curl -fsSL "$server/dist/patio-$platform" -o "$tmp"
want="$(curl -fsSL "$server/dist/patio-$platform.sha256" | cut -d' ' -f1)"
if command -v sha256sum >/dev/null 2>&1; then got="$(sha256sum "$tmp" | cut -d' ' -f1)"; else got="$(shasum -a 256 "$tmp" | cut -d' ' -f1)"; fi
if [ -z "$want" ] || [ "$want" != "$got" ]; then echo "patio: the download does not match its SHA-256 ($got, expected $want); nothing installed" >&2; exit 1; fi
chmod 755 "$tmp"
mv "$tmp" "$dir/patio"
trap - EXIT
echo "installed $dir/patio ($platform, sha256 $got)"
"$dir/patio" --version
case ":$PATH:" in *":$dir:"*) ;; *) echo "note: $dir is not in your PATH; add it, or run $dir/patio" >&2 ;; esac
`;
}

// Serves /install.sh and /dist/<file>; null for other paths. Without a directory, /install.sh says so.
export function installRoutes(dist: string | undefined, base: () => string) {
  return (url: URL): Response | null => {
    if (url.pathname === "/install.sh") {
      if (!dist) return new Response("echo 'patio: this server has no builds to install (it runs without --dist)' >&2; exit 1\n", { status: 404, headers: { "content-type": "text/x-shellscript" } });
      return new Response(installScript(base()), { headers: { "content-type": "text/x-shellscript; charset=utf-8", "cache-control": "no-store" } });
    }
    const m = /^\/dist\/([\w.-]+)$/.exec(url.pathname);
    if (!m) return null;
    if (!dist || !FILE_RE.test(m[1]!)) return new Response("not found\n", { status: 404 });
    const file = join(dist, m[1]!);
    if (!existsSync(file)) return new Response("not found\n", { status: 404 });
    return new Response(Bun.file(file), { headers: { "content-type": m[1]!.endsWith(".sha256") ? "text/plain" : "application/octet-stream", "cache-control": "no-store" } });
  };
}
