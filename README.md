# opencode-slack

[![CI](https://github.com/chester-hill-solutions/opencode-slack/actions/workflows/ci.yml/badge.svg)](https://github.com/chester-hill-solutions/opencode-slack/actions/workflows/ci.yml)

Slack integration for [OpenCode](https://opencode.ai): talk to OpenCode from a Slack channel, and let OpenCode talk back to Slack.

Two packages:

| Package | What it is |
| --- | --- |
| [`packages/bot`](packages/bot) | `opencode-slack-bot` — a **Slack app** (Socket Mode) that runs OpenCode sessions from Slack. A mention engages a channel; after that it follows the conversation, keeps the thread context, streams the reply back, shows progress while working, and turns permission requests into Approve/Deny buttons. |
| [`packages/plugin`](packages/plugin) | `opencode-slack-plugin` — an **OpenCode server plugin** that gives the agent `slack_post_message` / `slack_list_channels` tools, plus opt-in Slack notifications when sessions finish, fail, are interrupted, or ask for permission. |

Verified against OpenCode 2.2.x. The plugin is loaded by a real `opencode run` (the model sees the `slack_*` tools), and the bot's client path — service discovery, session create/get/context/remove, model switch — is covered by the unit tests and was exercised against a live OpenCode server.

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
bun run doctor         # validates both tokens, lists channel IDs, checks OpenCode
bun run bot            # or: bun run packages/bot/src/index.ts
```

`doctor` fails loudly on a bad token or an unreachable OpenCode server, and prints the channel IDs you can use for the plugin's `notifyChannel`.

Requires [Bun](https://bun.sh) ≥ 1.1. By default the bot discovers and starts your **local OpenCode background service** (via `@opencode/client/service`). To talk to a remote server instead, set `OPENCODE_URL` (+ `OPENCODE_TOKEN` or `OPENCODE_AUTH_HEADER`) — see [Configuration](#configuration).

### 4. Use it

- **Channels:** invite the bot (`/invite @OpenCode`), then `@OpenCode refactor the auth middleware`. The mention **engages the channel**: from then on every human message in the channel feeds the same session — no mention needed, top-level or in any thread. Replies land in the thread the message was sent in.
- **Threads:** mention the bot *inside* a thread to give that thread its own session; messages in that thread keep using it.
- **Thread context:** each prompt is wrapped with the Slack thread's messages (or recent channel history for top-level messages), so the agent sees what was being discussed — including messages from before it was mentioned.
- **DMs:** each DM is one continuous session; `!new` starts a fresh one.
- **Commands:** `!stop` interrupt · `!new` fresh session · `!leave` stop following a channel · `!status` · `!help`.
- **Permissions:** when OpenCode asks to run something sensitive, the bot posts *Approve once / Always allow / Deny* buttons; the decision is recorded in the session.
- **Progress:** while a run is in flight the bot keeps one message in the thread updated (`⏳ OpenCode working — 7 steps · 1m 20s · last tool: bash`), then deletes it when the reply lands. Interval: `OPENCODE_SLACK_CHECKIN_SECONDS` (default 45).
- **Formatting:** the reply is Markdown, so it is converted to Slack mrkdwn before posting — headings become bold, `**bold**` becomes `*bold*`, `*italic*` becomes `_italic_`, `[label](url)` becomes `<url|label>`, `-` lists get Slack bullets, and pipe tables are re-emitted inside a code block. Fenced and inline code are passed through untouched.
- **Resilience:** the live event stream reconnects with backoff (1s → 30s), so a network blip doesn't leave the bot deaf.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | — | Bot token (`xoxb-…`). Required. |
| `SLACK_APP_TOKEN` | — | App-level token (`xapp-…`, `connections:write`). Required for Socket Mode. |
| `OPENCODE_URL` | local service | Explicit OpenCode server, e.g. `https://opencode.example.com`. |
| `OPENCODE_TOKEN` | — | Bearer token for `OPENCODE_URL`. |
| `OPENCODE_AUTH_HEADER` | — | Full `Authorization` header value, e.g. `Basic …` for Caddy basic auth. |
| `OPENCODE_DIRECTORY` | bot's cwd | Directory new sessions operate on. |
| `OPENCODE_MODEL` | location default | Model for new sessions: `provider/model` or `provider/model#variant`. |
| `OPENCODE_SLACK_CHECKIN_SECONDS` | `45` | Progress message refresh interval. |
| `OPENCODE_SLACK_STATE` | `~/.local/share/opencode-slack/state.json` | Thread/channel → session mappings. |

Mappings persist across restarts. Old state files (bare session IDs) are migrated automatically.

## OpenCode plugin

Add to your `opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-slack-plugin",   // or a local path / workspace package
      "options": {
        "notifyChannel": "C0123ABC",         // opt-in; omit for tools only
        "notifyOn": ["failed", "permission"] // succeeded | failed | interrupted | permission
      }
    }
  ]
}
```

The token comes from `SLACK_BOT_TOKEN` in the OpenCode server's environment, or from `options.botToken`. For a global config, don't paste the token into `opencode.json` — keep it in a 0600 file and use [config variable substitution](https://opencode.ai/v2/docs/config#variables):

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

`{env:SLACK_BOT_TOKEN}` works too if the server is started with that variable set. Find channel IDs with `bun run doctor` or the `slack_list_channels` tool.

Tools provided to the agent:

- `slack_post_message` — post to a channel (or thread via `thread_ts`); long messages are split automatically.
- `slack_list_channels` — list channels the bot can see, with IDs.

Notifications are **off** unless `notifyChannel` is set. If you run the bot, `notifyOn: ["failed"]` is usually enough — the bot already posts interactive permission buttons.

The plugin isn't published to npm; load it by path (or `bun link` it).

## Deployment

Any always-on host works — it's an outbound Socket Mode connection, so there are no inbound ports. For Railway, create a service from this repo, set the env vars from `.env.example` (`OPENCODE_URL` pointing at your OpenCode server, `OPENCODE_AUTH_HEADER=Basic …` if it's behind Caddy basic auth, `OPENCODE_DIRECTORY=/data/project` on a mounted volume), and run `bun run bot`.

## Security

- The bot acts with **your** OpenCode permissions in `OPENCODE_DIRECTORY`. Anyone who can talk to it in Slack can drive that session — restrict the channel, and give Slack-driven work a dedicated OpenCode instance with tight [permissions](https://opencode.ai/v2/docs/permissions). The Approve/Deny buttons exist to keep a human in the loop.
- `xoxb`/`xapp` tokens belong in env vars or a secret store, never in git. `.env` is gitignored.
- The state file holds only conversation → session ID mappings and reply targets; no tokens or message content.

## Limitations

- Event subscriptions are live-only: a reply produced while the bot is offline is not replayed (the session still has it; `!status`/OpenCode does).
- Slack context uses user IDs (`<@U0…>`) rather than display names, because the app doesn't request `users:read`.
- Channel engagement is intentionally broad: after a mention, every human message in that channel goes to the agent until `!leave`.

## Development

```sh
bun install
bun run typecheck   # tsc --noEmit across the workspace
bun test            # unit tests: chunking, context formatting, state, reply extraction, plugin
bun run doctor      # end-to-end config check
```

```
opencode-slack/
├── packages/bot/src/
│   ├── index.ts       # Slack handlers, session routing, event stream, check-ins
│   ├── opencode.ts    # client construction, reply extraction, model refs
│   ├── state.ts       # persisted conversation → session mappings
│   ├── slackText.ts   # chunking, escaping, check-in and context formatting
│   └── doctor.ts      # config verification
├── packages/plugin/src/index.ts
├── slack-app-manifest.yml
└── tests/
```

## How it works

```
Slack                          opencode-slack-bot                     OpenCode server
 │  @mention (engages channel)   │                                      │
 │ ────────────────────────────► │ session.create + switchModel         │
 │                               │ session.prompt(text + thread ctx)    │
 │                               │ ───────────────────────────────────► │
 │                               │                                      │ agent loop
 │                               │ session.step.started / tool.called   │
 │                               │ ◄─────────────────────────────────── │
 │ ◄──────────────────────────── │ check-in: chat.postMessage/update    │
 │                               │                                      │
 │                               │ session.execution.succeeded          │
 │                               │ ◄─────────────────────────────────── │
 │ ◄──────────────────────────── │ chat.postMessage(thread)             │
 │                               │                                      │
 │  permission.asked             │ ◄─────────────────────────────────── │
 │ ◄──────────────────────────── │ Block Kit Approve / Always / Deny    │
 │  button click                 │ session.permission.reply             │
 │ ────────────────────────────► │ ───────────────────────────────────► │
```

The plugin runs *inside* the OpenCode server and subscribes to the same events independently — it's for unattended notifications and works even when the bot is down.

---

MIT © Chester Hill Solutions
