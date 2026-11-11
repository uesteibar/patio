# Hermes in Docker as a patio responder: probe

Done by Tenex on 8 Nov 2026, before increment 8.

## Setup

- Image: `patio-hermes-test:local`, built from the Hermes repository's `Dockerfile` (Hermes Agent 0.22.7). Build: `docker build -t patio-hermes-test:local ~/.hermes/hermes-agent`. The build reads the repository only; it does not change the real installation.
- State: Docker volume `patio-hermes-test-home`, mounted at `/opt/data` (the container's `HERMES_HOME`). Nothing from the host's `~/.hermes` is mounted or copied.

## Findings

1. Use the image's normal entrypoint. Overriding it with `--entrypoint hermes` as root writes root-owned install state into the volume, and later runs fail with "install state is not writable by this user". If that happens, remove and recreate the volume.
2. The entrypoint starts s6 and a Hermes gateway first. `hermes acp` answers `initialize` only after about 20 to 30 seconds. A client must not time out sooner.
3. Command that works:

   ```sh
   docker run --rm -i -v patio-hermes-test-home:/opt/data patio-hermes-test:local hermes acp
   ```

   Probe result: `initialize` returns agent `hermes-agent` 0.22.7 with `loadSession`; `session/new` with `cwd` returns a session.
4. stdout carries only JSON-RPC lines, and s6 and gateway logs go to stderr. Check this in the adapter anyway.
5. The repository the responder reads must be mounted into the container, for example `-v <worktree>:/work:ro` and `cwd: /work`. Mount read-only unless an allowed action needs writes.
6. Model login is not configured. The container has no provider credentials, by design: nothing is copied from the host. A prompt fails until Unai runs one interactive login in the volume:

   ```sh
   docker run --rm -it -v patio-hermes-test-home:/opt/data patio-hermes-test:local hermes auth add anthropic --type oauth
   docker run --rm -it -v patio-hermes-test-home:/opt/data patio-hermes-test:local hermes model
   ```

   Pick Claude Haiku 5.5 at low reasoning effort in `hermes model`. Tenex could not complete the OAuth login unattended, because claude.ai shows a bot check in the automated browser.
