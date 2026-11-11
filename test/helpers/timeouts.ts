// Explicit test timeouts, sized to the work, so a loaded machine does not fail a test at Bun's default 5 s while a
// real hang still fails it. SERVER_MS: a test (or hook) that starts in-process servers (the exchange, gatekeepers, web
// apps, fake GitHub or Jev) and onboards people through them. PROCESS_MS: a test that also starts processes (the
// patio CLI, the MCP server, fake ACP agents, scripts), each of which pays Bun's start-up.
export const SERVER_MS = 30_000;
export const PROCESS_MS = 60_000;
