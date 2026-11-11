// Security audit S2: the responder and `watch --exec` must not inherit the TypeSafe key, the GitHub OAuth secret or
// patio's own variables from the CLI's environment (Bun autoloads a `.env` from the current directory).
import { expect, test } from "bun:test";
import { agentEnv } from "../src/acp";
import { execEnv } from "../src/watch";

const base = {
  PATH: "/usr/bin",
  HOME: "/home/bob",
  TYPESAFE_API_KEY: "ts-secret",
  TYPESAFE_BASE_URL: "https://x",
  GITHUB_CLIENT_ID: "id",
  GITHUB_CLIENT_SECRET: "gh-secret",
  PATIO_HOME: "/home/bob/.patio",
  PATIO_RELAY: "ws://127.0.0.1:7777",
  PATIO_HANDLE: "bob",
  CODEX_HOME: "/home/bob/.codex",
};

test("the responder gets the owner's environment without secrets or patio variables, plus what the preset sets", () => {
  const env = agentEnv(base, { CODEX_CONFIG: "{}", PI_CODING_AGENT_DIR: undefined });
  expect(env.PATH).toBe("/usr/bin");
  expect(env.HOME).toBe("/home/bob");
  expect(env.CODEX_HOME).toBe("/home/bob/.codex");
  expect(env.CODEX_CONFIG).toBe("{}");
  for (const k of ["TYPESAFE_API_KEY", "TYPESAFE_BASE_URL", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "PATIO_HOME", "PATIO_RELAY", "PATIO_HANDLE", "PI_CODING_AGENT_DIR"])
    expect(k in env, k).toBe(false);
});

test("watch --exec keeps patio's variables for the owner's script (it may call patio) and drops the secrets", () => {
  const env = execEnv(base, "/home/bob/.patio", { id: "m1", convo: "c1", kind: "question" });
  expect(env.PATIO_HOME).toBe("/home/bob/.patio");
  expect(env.PATIO_HANDLE).toBe("bob");
  expect(env.PATIO_MESSAGE_ID).toBe("m1");
  expect(env.PATH).toBe("/usr/bin");
  for (const k of ["TYPESAFE_API_KEY", "TYPESAFE_BASE_URL", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"]) expect(k in env, k).toBe(false);
});
