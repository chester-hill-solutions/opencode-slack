# Workers runtime (scaffold)

Cloudflare Workers + Durable Objects + Containers version of the Slack bot, with
OpenCode running in a container and workspaces checkpointed to R2.

> **Status:** scaffold. The Worker/DO logic and its tests are in place and the
> wrangler config validates. The container image cannot be built in this
> environment (Docker is not installed), so nothing has run end to end yet. The
> reply pump currently polls; the warm-stream half of the hybrid design is the
> next step.

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

## Setup

```sh
cd workers
bun install
bunx wrangler r2 bucket create opencode-slack-checkpoints

bunx wrangler secret put SLACK_SIGNING_SECRET   # Basic Information → Signing Secret
bunx wrangler secret put SLACK_BOT_TOKEN        # xoxb-…
bunx wrangler secret put SLACK_BOT_USER_ID      # U… (bot user id)
```

`wrangler.jsonc` sets `WORKSPACE_REPO`, `OPENCODE_MODEL` and `CHECKIN_SECONDS`;
override them per environment if needed.

## Deploy

Docker is required to build the container image (`wrangler deploy` builds it
locally, even for `--dry-run`):

```sh
bunx wrangler deploy
```

## Slack cutover (converting the existing app)

1. Deploy the Worker and confirm `GET /health`.
2. Slack app → **Event Subscriptions** → Request URL
   `https://<worker>/slack/events` (Slack sends a `url_verification` challenge;
   the Worker answers it).
3. **Interactivity & Shortcuts** → Request URL
   `https://<worker>/slack/interactivity`.
4. **Socket Mode → off.** Events now arrive over HTTP.
5. Stop the local bot (`launchctl bootout gui/$(id -u)/ca.chesterhill.opencode-slack-bot`).

Rollback: re-enable Socket Mode and restart the launchd bot.

## Local development

```sh
bunx wrangler dev     # requires Docker for the container
bun test              # pure logic: signature, keys, permissions, state, pump helpers
bun run typecheck
```

## Known gaps

- Warm-stream half of the hybrid reply pump (polling only today).
- Channel engagement (`!leave`, channel-level sessions) is not ported yet.
- Check-in messages and permission buttons are wired in the DO but untested
  against a live container.
- Stow integration is currently a tar checkpoint; the `stow-s3` binary is in the
  image but the workspace server wiring is next.
- `slack_upload_file` lives in the container-side plugin; clips are deferred.
