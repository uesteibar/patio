// Small helpers for running tools and reading their versions.
export async function run(cmd: string[], opts: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number } = {}) {
  try {
    const proc = Bun.spawn(cmd, {
      cwd: opts.cwd,
      env: opts.env as Record<string, string> | undefined,
      stdout: "pipe",
      stderr: "pipe",
      timeout: opts.timeoutMs ?? 30_000,
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    return { code: 127, stdout: "", stderr: String(err) };
  }
}

export async function versionOf(cmd: string[]): Promise<string | null> {
  const res = await run(cmd);
  if (res.code !== 0) return null;
  return (res.stdout || res.stderr).split("\n").find((l) => /\d+\.\d+/.test(l))?.trim() ?? null;
}
