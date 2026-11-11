# Brief: increment 2, GitHub identity, workspaces and the local web app

Owner: Tenex (coordinator). Implementer: Pi. Authorized by Unai on 8 Nov 2026, with autonomous chaining.

Read first: `docs/poc/proposal.md` (sections 2.1, 2.7, 3 and 4.2), `docs/poc/plan.md` (increment 2), `docs/poc/execution.md` (increment 1 acceptance) and the current code.

## Outcome

An admin invites `@jorge` to a workspace, Jorge signs in with GitHub, his gatekeeper pairs with his account, and his agent gets an identity after Jorge approves it in the web app. Only members of a shared workspace can message each other.

## Scope

1. GitHub sign-in through the exchange (OAuth web flow). The exchange reads the GitHub base URLs from configuration, so tests use a fake GitHub provider under `test/fakes/` that implements the authorize, token and `/user` endpoints for a few fixed users.
2. Gatekeeper pairing. A gatekeeper asks the exchange for a short pairing code; the human confirms it in the web app while signed in. The device is then bound to that GitHub user. This replaces the development tokens for gatekeepers.
3. Workspaces. A signed-in user creates a workspace and becomes its admin. The admin invites GitHub logins. An invited user who signs in is a member. The admin sees a notice with the new member's device fingerprints and can revoke the member. The roster records who invited whom.
4. Agent identities. An agent asks for an identity (`register` in the CLI, `request_identity` in the MCP) with a name such as `jorge-claude`. The request stays pending until the owner approves it in the web app. Then the agent can join workspaces where its owner is a member. Messages are addressed to agent identities, and the exchange refuses delivery between agents whose owners share no workspace.
5. Approval only by a human: approvals need a signed-in web app session. No CLI command or MCP tool can approve, and the agent's CLI and MCP credentials cannot call the approval endpoints.
6. Local web app served by the gatekeeper: sign-in, pending approvals, workspace members (invite and revoke for admins). Keep it small and server-rendered unless a client framework is clearly needed.

## Visual direction for the web app

Unai's taste: light theme, monochrome grayscale with a single gray accent, sophisticated and minimal, app-like (Sketch is the reference). No pastel colors, gradients, emoji, decorative illustrations or generic "AI dashboard" looks. System font stack, generous whitespace, calm and sparse motion. Use real states: empty, pending, approved, revoked, error.

## Exit gate

- Scenarios with the fake GitHub provider: invite, sign-in, pairing, agent request and approval, message between members, refused message between non-members, revoke.
- Browser check (Playwright, headless) of the approval flow: sign in, see the pending request, approve, and the agent's `register` then reports the identity as ready. Save screenshots under `.verify/`.
- A test that the agent's credentials cannot approve.
- `just verify` passes. Docs and README updated.

## Live GitHub

Add `just smoke-github --yes-live` for a real GitHub OAuth sign-in. It needs `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in the main checkout's `.env`; when they are absent it exits 2 with a clear message. Do not try to create the OAuth app; that is Unai's step.

## Constraints

- Work on `poc`, commit as you go with `git commit -- <paths>`, never push.
- TDD for behavior changes. Keep the change as small as the outcome allows.
- No paid live calls are needed in this increment.

## Report

Commits, scenarios added, the `just verify` summary, screenshots of the web app states, what changed in the protocol and the trust model, and what remains unverified.
