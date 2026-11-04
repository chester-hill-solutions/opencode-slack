# opencode-slack

Slack integration for [OpenCode](https://opencode.ai). Two pieces:

| Package | What it is |
| --- | --- |
| [`packages/plugin`](packages/plugin) | `opencode-slack-plugin` — OpenCode **server plugin**: adds `slack_post_message` / `slack_list_channels` tools to the agent, and opt-in Slack notifications when sessions finish, fail, are interrupted, or ask for permission. |
| [`packages/bot`](packages/bot) | `opencode-slack-bot` — **Slack app** (Socket Mode) that starts and continues OpenCode sessions from Slack mentions, threads and DMs, streams replies back, and posts permission requests as Approve/Deny buttons. |

Neither CHS nor OpenCode ships a Slack integration, so both are new code; the only runtime dependencies are `@slack/web-api` (plugin), `@slack/bolt` and `@opencode/client` (bot).

Verified against OpenCode 2.2.x: the plugin loads in a real `opencode run` and the model sees `slack_list_channels` / `slack_post_message`; the bot's client path (service discovery, session create/get/context/remove) is exercised by the unit tests and was smoke-tested against a live local OpenCode server.

## Quick start

### 1. Create the Slack app

1. Go to <https://api.slack.com/apps> → **Create New App** → **From an app manifest**.
2. Paste [`slack-app-manifest.yml`](slack-app-manifest.yml), create, and **Install to Workspace**.
3. Copy the **Bot User OAuth Token** (`xoxb-…`) from *OAuth & Permissions*.
4. Under *Basic Information → App-Level Tokens*, generate a token (`xapp-…`) with the `connections:write` scope.

### 2. Configure environment

```sh
cp .env.example .env   # fill in SLACK_BOT_TOKEN and SLACK_APP_TOKEN
```

The bot reads `.env`. If you also load the plugin (see below), give it the same bot token through a separate 0600 file so it never lands in `opencode.json`:

```sh
printf '%s' 'xoxb-…' > ~/.config/opencode/slack-bot-token
chmod 600 ~/.config/opencode/slack-bot-token
```

### 3. Verify and run

```sh
bun install
bun run doctor         # validates both tokens, lists channels, checks OpenCode
bun run bot            # or: bun run packages/bot/src/index.ts
```

`doctor` prints the channel IDs you can use for `notifyChannel` and fails loudly on a bad token or an unreachable OpenCode server.

Requires [Bun](https://bun.sh) ≥ 1.1. By default the bot discovers and starts your **local OpenCode background service** automatically (via `@opencode/client/service`). To talk to a remote server instead, set `OPENCODE_URL` (+ `OPENCODE_TOKEN` or `OPENCODE_AUTH_HEADER`) — see `.env.example`.

### 4. Use it

- **Channels:** invite the bot (`/invite @OpenCode`), then `@OpenCode refactor the auth middleware`. The mention engages the channel: from then on **every message in the channel** feeds the same session — no mention needed, in a thread or not. Replies stay in the mention's thread.
- Mention the bot *inside a thread* to give that thread its own session; messages in that thread keep using it.
- Each prompt carries the Slack **thread context** (or recent channel history for top-level messages), so the agent can see what was being discussed, including messages from before it was mentioned.
- **DMs:** each DM is one continuous session. `!new` starts a fresh one.
- **Commands (in-thread or DM):** `!stop` interrupt, `!new` fresh session, `!leave` stop following a channel, `!status`, `!help`.
- **Permissions:** when OpenCode asks to run something sensitive, the bot posts *Approve once / Always allow / Deny* buttons. The decision is recorded in the session.
- Replies appear when the session finishes (live event stream; if the bot is down during a run, that reply is missed).
- While a session runs, the bot keeps **one** message in the thread updated (`⏳ OpenCode working — 7 steps · 1m 20s · last tool: bash`) every `OPENCODE_SLACK_CHECKIN_SECONDS` (default 45), then deletes it when the reply lands.
- The event stream auto-reconnects with backoff (1s → 30s) if it drops, so the bot doesn't go deaf after a network blip.

The directory new sessions operate on is `OPENCODE_DIRECTORY` (defaults to the bot's cwd). Session↔thread mappings persist in `~/.local/share/opencode-slack/state.json` (override with `OPENCODE_SLACK_STATE`).

The model for new sessions comes from `OPENCODE_MODEL` (`provider/model` or `provider/model#variant`, e.g. `opencode-go/deepseek-v4.1-flash`); leave it unset to use the location's default model. Existing sessions keep whatever model they were started with.

## OpenCode plugin

Add to your `opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-slack-plugin",   // or a local path / workspace package
      "options": {
        "notifyChannel": "C0123ABC",        // opt-in; omit for tools only
        "notifyOn": ["failed", "permission"] // succeeded | failed | interrupted | permission
      }
    }
  ]
}
```

The bot token is read from `SLACK_BOT_TOKEN` in the OpenCode server's environment, or from `options.botToken`. For a global config, don't paste the token into `opencode.json` — keep it in a 0600 file and use [config variable substitution](https://opencode.ai/v2/docs/config#variables):

```sh
printf '%s' 'xoxb-…' > ~/.config/opencode/slack-bot-token
chmod 600 ~/.config/opencode/slack-bot-token
```

```jsonc
{
  "plugins": [
    {
      "package": "/Users/you/WebProjects/opencode-slack/packages/plugin",
      "options": {
        "botToken": "{file:~/.config/opencode/slack-bot-token}",
        "notifyChannel": "C0123ABC",
        "notifyOn": ["failed"]
      }
    }
  ]
}
```

`{env:SLACK_BOT_TOKEN}` works too if the OpenCode server is started with that variable set. Find channel IDs with `bun run doctor` or the `slack_list_channels` tool.

Tools provided to the agent:

- `slack_post_message` — post to a channel (or thread via `thread_ts`); long messages are split automatically.
- `slack_list_channels` — list channels the bot can see, with IDs.

Notifications are **off** unless `notifyChannel` is set. If you run the bot, you may want `notifyOn: ["failed"]` only — the bot already posts interactive permission buttons, so the plugin's permission ping is a plain-text extra.

Local development: point `plugins` at the workspace path, e.g. `"plugins": ["/Users/you/WebProjects/opencode-slack/packages/plugin"]`, or `bun link` it.

## Deployment

Any always-on host works (it's an outbound Socket Mode connection — no inbound ports). For Railway, create a service from this repo, set the env vars from `.env.example` (`OPENCODE_URL` pointing at your OpenCode server, `OPENCODE_AUTH_HEADER=Basic …` if it's behind Caddy basic auth, and `OPENCODE_DIRECTORY=/data/project` on a mounted volume), and run `bun run bot`.

## Security notes

- The bot acts with **your** OpenCode permissions in `OPENCODE_DIRECTORY`. Anyone who can talk to the bot in Slack can drive that session. Restrict the channel, or run a dedicated OpenCode instance with tight [permissions](https://opencode.ai/v2/docs/permissions) for Slack-driven work — the permission buttons exist to keep a human in the loop.
- `xoxb`/`xapp` tokens belong in env vars or a secret store, never in git. `.env` is gitignored.
- State file contains only thread→session ID mappings; it holds no tokens or message content.

## Development

```sh
bun install
bun run typecheck   # tsc --noEmit across the workspace
bun test            # unit tests (chunking, state store, reply extraction)
```

## How it works

```
Slack                     opencode-slack-bot                    OpenCode server
 │  @mention / thread reply │                                     │
 │ ───────────────────────► │ session.prompt(sessionID, text)     │
 │                          │ ──────────────────────────────────► │
 │                          │                                     │ (agent loop runs)
 │                          │ session.execution.succeeded event   │
 │                          │ ◄────────────────────────────────── │
 │ ◄─────────────────────── │ chat.postMessage(thread)            │
 │  permission.asked        │ ◄────────────────────────────────── │
 │ ◄─────────────────────── │ Block Kit Approve/Deny buttons      │
 │  button click            │ POST /permission/{requestID}/reply  │
 │ ───────────────────────► │ ──────────────────────────────────► │
```

The plugin runs *inside* the OpenCode server and subscribes to the same events independently — it's for unattended notifications, and works even when the bot is down.
