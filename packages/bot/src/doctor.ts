import { existsSync } from "node:fs"
import { WebClient } from "@slack/web-api"
import { makeClient } from "./opencode"
import { StateStore } from "./state"

/**
 * bun run doctor
 *
 * Validates the bot's configuration end to end without starting the bot:
 *   1. SLACK_BOT_TOKEN  — auth.test
 *   2. SLACK_APP_TOKEN  — apps.connections.open (Socket Mode)
 *   3. channel list     — IDs for SLACK_AGENT_CHANNEL_ID / notifyChannel
 *   4. OpenCode         — service discovery + server info
 *   5. state file       — path + mapping count
 */

const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`

let failures = 0
function ok(label: string, detail?: string) {
  console.log(`${green("✔")} ${label}${detail ? dim(` — ${detail}`) : ""}`)
}
function fail(label: string, detail?: string) {
  failures++
  console.log(`${red("✘")} ${label}${detail ? dim(` — ${detail}`) : ""}`)
}
function info(label: string, detail?: string) {
  console.log(`• ${label}${detail ? dim(` — ${detail}`) : ""}`)
}

const botToken = process.env.SLACK_BOT_TOKEN?.trim()
const appToken = process.env.SLACK_APP_TOKEN?.trim()

if (!existsSync(".env")) {
  info(".env not found in the current directory", "Bun loads .env from the working directory")
}

// 1. Bot token
let slack: WebClient | undefined
if (!botToken) {
  fail("SLACK_BOT_TOKEN is not set")
} else {
  slack = new WebClient(botToken)
  try {
    const auth = await slack.auth.test()
    ok("SLACK_BOT_TOKEN valid", `bot ${auth.bot_id} in ${auth.team} (${auth.url})`)
  } catch (err) {
    slack = undefined
    fail("SLACK_BOT_TOKEN rejected", errorCode(err))
  }
}

// 2. App-level token (Socket Mode)
if (!appToken) {
  fail("SLACK_APP_TOKEN is not set")
} else if (!appToken.startsWith("xapp-")) {
  fail("SLACK_APP_TOKEN does not look like an app-level token", "expected xapp-…")
} else {
  try {
    await new WebClient().apps.connections.open({ token: appToken })
    ok("SLACK_APP_TOKEN valid", "Socket Mode connection can be opened")
  } catch (err) {
    fail("SLACK_APP_TOKEN rejected", errorCode(err))
  }
}

// 3. Channels (for the plugin's notifyChannel)
if (slack) {
  try {
    const res = await slack.conversations.list({
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 200,
    })
    const channels = res.channels ?? []
    ok("conversations.list works", `${channels.length} channels visible to the bot`)
    for (const c of channels.slice(0, 30)) {
      info(`  ${c.id}  #${c.name}${c.is_private ? " (private)" : ""}`)
    }
    if (channels.length > 30) info(`  … and ${channels.length - 30} more`)
    info("Use one of these IDs as the plugin's notifyChannel; invite the bot to private channels first")
  } catch (err) {
    fail("conversations.list failed", errorCode(err))
  }
}

// 4. OpenCode
try {
  const client = await makeClient()
  const server = await client.server.info()
  const urls = Array.isArray((server as { urls?: string[] }).urls) ? (server as { urls: string[] }).urls : []
  ok("OpenCode reachable", `v${(server as { version?: string }).version ?? "?"}${urls.length ? ` at ${urls.join(", ")}` : ""}`)
} catch (err) {
  fail("OpenCode unreachable", err instanceof Error ? err.message : String(err))
}

// 5. State
new StateStore()
info("state file", process.env.OPENCODE_SLACK_STATE ?? "~/.local/share/opencode-slack/state.json")

console.log()
if (failures > 0) {
  console.log(red(`${failures} check(s) failed`))
  process.exit(1)
}
console.log(green("all checks passed"))

function errorCode(err: unknown): string {
  const data = (err as { data?: { error?: string } } | undefined)?.data
  if (data?.error) return data.error
  return err instanceof Error ? err.message : String(err)
}
