# Workers runtime (scaffold)

Cloudflare Workers + Durable Objects + Containers version of the Slack bot, with
OpenCode running in a container and workspaces checkpointed to R2.

> **Status:** scaffold. Worker/DO logic and tests are in place; the wrangler
> config validates. The image has not been built or run end to end yet. The reply
> pump polls; the warm-stream half of the hybrid design is the next step.

## Shape

```
Slack ──POST /slack/events──────► Worker (verify signature, url_verification, ack)
                                     └─► ThreadContainer DO (one per thread)
                                           ├─ SQLite state (session, reply target, dedupe, pending permissions)
                                           ├─ :4001 control server (status/restore/start/checkpoint)
                                           ├─ :4000 opencode serve, cwd /workspace
                                           ├─ R2 CHECKPOINTS bucket (tar.gz of the workspace)
                                           └─ alarm pump → session.context → Slack reply
```

- The container class **is** the Durable Object; it reaches the container with
  `ctx.container.getTcpPort(port).fetch(...)` — no public URL.
- OpenCode is driven with `@opencode/client` and a custom `fetch` that rewrites
  requests to the container port (`src/opencode.ts`).
- The container never holds R2 credentials: the DO streams checkpoints to R2.
- XDG/HOME live under `/workspace/.state`, so session state is checkpointed with
  the code. The control server flushes the SQLite WAL before tarring.
- Permissions: "smart allow" rules are written into the container's OpenCode
  config (`entrypoint.sh`); dangerous commands are denied, everything else asks.

## Deploy with Workers Builds (no local Docker)

Cloudflare builds the image in the Workers Builds environment. One-time setup:

1. **Workers & Pages → Create/Connect** the `chester-hill-solutions/opencode-slack` repo.
2. **Settings → Builds**:
   - Root directory: `workers`
   - Build command: `bun install`
   - Deploy command: `npx wrangler deploy`
3. Add secrets: `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `SLACK_BOT_USER_ID`.
4. Create the R2 bucket: `bunx wrangler r2 bucket create opencode-slack-checkpoints`
   (or in the dashboard).
5. Push to `main` → Workers Builds builds the image, publishes it, and rolls out
   the container instances.

Notes:

- Non-production branches only upload Worker code (`wrangler versions upload`) —
  they do **not** publish a new image. Image changes need a merge to `main`, or a
  separate staging Worker connected to Builds.
- `wrangler deploy` from your machine still requires Docker when `image` points at
  a Dockerfile. That path is optional; Builds is the default.

## Local development without Docker

```sh
workers/scripts/container-dev.sh build   # Apple `container` builds the image
workers/scripts/container-dev.sh run     # runs it on :4000 (opencode) and :4001 (control)
```

Apple `container` (macOS 26+, Apple silicon) builds and runs the image as a
lightweight VM. `wrangler dev` with containers still needs a Docker-compatible
engine, so use this script for container smoke tests and `bun test` for the
Worker/DO logic.

```sh
cd workers
bun install
bun run typecheck
bun test
```

## Slack cutover (converting the existing app)

1. Deploy the Worker and confirm `GET /health`.
2. Slack app → **Event Subscriptions** → Request URL
   `https://<worker>/slack/events` (the Worker answers the `url_verification` challenge).
3. **Interactivity & Shortcuts** → Request URL
   `https://<worker>/slack/interactivity`.
4. **Socket Mode → off.** Events now arrive over HTTP.
5. Stop the local bot: `launchctl bootout gui/$(id -u)/ca.chesterhill.opencode-slack-bot`.

Rollback: re-enable Socket Mode and restart the launchd bot.

## Known gaps

- Warm-stream half of the hybrid reply pump (polling only today).
- Channel engagement (`!leave`, channel-level sessions) not ported.
- Check-in messages and permission buttons are wired but untested against a live container.
- Stow: the image carries `stow-s3`, but the workspace is currently a tar checkpoint;
  wiring the Stow workspace server (checkpoint/restore + R2 upstream) is the next slice.
- `slack_upload_file` lives in the container-side plugin; clips are deferred.
