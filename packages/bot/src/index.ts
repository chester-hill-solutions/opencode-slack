import { App } from "@slack/bolt"
import { makeClient, latestAssistantReply, parseModelRef, type MessageInfo } from "./opencode"
import { StateStore } from "./state"
import { chunkText, mrkdwnEscape } from "./slackText"

/**
 * opencode-slack-bot — Socket Mode Slack app that drives OpenCode.
 *
 * Channels: @mention it (in a thread or not) to start/continue an OpenCode
 * session. The mention roots a thread; every later reply in that thread is
 * forwarded to the same session — no mention required.
 *
 * DMs: each DM is one continuous session. Use `!new` to start a fresh one.
 *
 * In-thread commands: !stop (interrupt), !new (fresh session), !status,
 * !help. Permission requests are posted with Approve once / Always allow /
 * Deny buttons.
 */

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN?.trim()
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN?.trim()

if (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN) {
  console.error("SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set (see .env.example).")
  process.exit(1)
}

const directory = process.env.OPENCODE_DIRECTORY ?? process.cwd()
const model = parseModelRef(process.env.OPENCODE_MODEL)
const client = await makeClient()
const state = new StateStore()

const app = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  socketMode: true,
})

const authTest = await app.client.auth.test()
const botUserId = authTest.user_id as string
const slack = app.client
const log = (...args: unknown[]) => console.log("[opencode-slack-bot]", ...args)

/** Slack envelopes wrap payloads in { data }; the client seems to unwrap them. Handle both. */
const unwrap = (value: any): any => value?.data ?? value

interface Incoming {
  channel: string
  /** ts of the message being answered; threads root here. */
  ts: string
  /** thread_ts when the message is already inside a thread. */
  threadTs?: string
  isDm: boolean
  text: string
  user?: string
}

function conversationKey(input: Incoming): { key: string; replyThreadTs?: string } {
  if (input.isDm) return { key: `${input.channel}:dm` } // no threading in DMs
  const root = input.threadTs ?? input.ts
  return { key: `${input.channel}:${root}`, replyThreadTs: root }
}

function stripMention(text: string): string {
  return text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim()
}

async function postChunked(channel: string, text: string, threadTs?: string): Promise<void> {
  for (const chunk of chunkText(text)) {
    await slack.chat.postMessage({ channel, text: chunk, ...(threadTs ? { thread_ts: threadTs } : {}) })
  }
}

async function handleUserText(input: Incoming): Promise<void> {
  const { channel } = input
  const { key, replyThreadTs } = conversationKey(input)
  const text = stripMention(input.text)

  const [command] = text.split(/\s+/)

  // -- commands -----------------------------------------------------------
  if (command === "!help" || command === "!help.") {
    await postChunked(
      channel,
      [
        "*OpenCode Slack bot*",
        "• Mention me (or DM me) to start an OpenCode session.",
        "• Reply in the thread to continue it — no mention needed.",
        "• `!stop` — interrupt the running session",
        "• `!new` — start a fresh session",
        "• `!status` — show the mapped session",
        "• Permission requests arrive as buttons: *Approve once*, *Always allow*, *Deny*.",
      ].join("\n"),
      replyThreadTs,
    )
    return
  }

  if (command === "!stop") {
    const sessionID = state.getByKey(key)
    if (!sessionID) return void (await postChunked(channel, "No session mapped here yet.", replyThreadTs))
    await client.session.interrupt({ sessionID, resume: false })
    await postChunked(channel, "⏹️ Interrupted.", replyThreadTs)
    return
  }

  if (command === "!new") {
    state.removeByKey(key)
    await postChunked(channel, "🆕 Next message starts a fresh session.", replyThreadTs)
    return
  }

  if (command === "!status") {
    const sessionID = state.getByKey(key)
    if (!sessionID) return void (await postChunked(channel, "No session mapped here yet.", replyThreadTs))
    try {
      const session = unwrap(await client.session.get({ sessionID })) as { title?: string } | undefined
      await postChunked(
        channel,
        `Session \`${sessionID}\`${session?.title ? ` — *${mrkdwnEscape(session.title)}*` : ""}\nDirectory: \`${directory}\``,
        replyThreadTs,
      )
    } catch (err) {
      await postChunked(channel, `⚠️ Couldn't fetch session \`${sessionID}\`: ${errorMessage(err)}`, replyThreadTs)
    }
    return
  }

  // -- prompt -------------------------------------------------------------
  if (!text) {
    await postChunked(channel, "Say something after the mention — or try `!help`.", replyThreadTs)
    return
  }

  let sessionID = state.getByKey(key)
  let created = false
  if (!sessionID) {
    const session = unwrap(
      await client.session.create({
        location: { directory },
        title: text.replace(/\s+/g, " ").slice(0, 80),
      }),
    ) as { id: string }
    sessionID = session.id
    state.setByKey(key, sessionID)
    created = true
    if (model) {
      await client.session.switchModel({ sessionID, model }).catch((err) => {
        console.warn(`[opencode-slack-bot] could not switch session ${sessionID} to ${model.providerID}/${model.id}:`, err)
      })
    }
  }

  try {
    await client.session.prompt({ sessionID, text })
  } catch (err) {
    await postChunked(channel, `⚠️ Couldn't deliver the prompt: ${errorMessage(err)}`, replyThreadTs)
    return
  }

  if (created) {
    await postChunked(
      channel,
      `🫡 On it — OpenCode session \`${sessionID}\` in \`${directory}\``,
      replyThreadTs,
    )
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

/** Acknowledge with an :eyes: reaction; failures (missing scope) are ignored. */
async function eyes(channel: string, ts: string): Promise<void> {
  try {
    await slack.reactions.add({ channel, timestamp: ts, name: "eyes" })
  } catch {
    /* cosmetic only */
  }
}

// --- handlers ------------------------------------------------------------

app.event("app_mention", async ({ event }) => {
  const ev = event as unknown as {
    channel: string
    ts: string
    thread_ts?: string
    text?: string
    user?: string
  }
  try {
    const input: Incoming = {
      channel: ev.channel,
      ts: ev.ts,
      isDm: false,
      text: ev.text ?? "",
      ...(ev.thread_ts ? { threadTs: ev.thread_ts } : {}),
      ...(ev.user ? { user: ev.user } : {}),
    }
    await eyes(ev.channel, ev.ts)
    await handleUserText(input)
  } catch (err) {
    console.error("[opencode-slack-bot] app_mention failed:", err)
    await postChunked(ev.channel, `⚠️ Something went wrong: ${errorMessage(err)}`, ev.thread_ts ?? ev.ts).catch(() => {})
  }
})

app.event("message", async ({ event }) => {
  const ev = event as unknown as Record<string, unknown>
  // Skip edits, joins, bot messages (including our own), and anything without text.
  if (typeof ev.subtype === "string") return
  if (ev.bot_id) return
  const text = typeof ev.text === "string" ? ev.text : undefined
  const channel = typeof ev.channel === "string" ? ev.channel : undefined
  const ts = typeof ev.ts === "string" ? ev.ts : undefined
  if (!text || !channel || !ts) return
  if (text.includes(`<@${botUserId}>`)) return // handled by app_mention

  const isDm = ev.channel_type === "im"
  const threadTs = typeof ev.thread_ts === "string" ? ev.thread_ts : undefined

  if (!isDm) {
    // Channel message: only forward if it lands in a thread we mapped.
    if (!threadTs) return
    if (!state.getByKey(`${channel}:${threadTs}`)) return
  }

  const input: Incoming = {
    channel,
    ts,
    isDm,
    text,
    ...(threadTs ? { threadTs } : {}),
    ...(typeof ev.user === "string" ? { user: ev.user } : {}),
  }
  try {
    await handleUserText(input)
  } catch (err) {
    console.error("[opencode-slack-bot] message failed:", err)
    await postChunked(channel, `⚠️ Something went wrong: ${errorMessage(err)}`, threadTs).catch(() => {})
  }
})

// --- permission buttons ----------------------------------------------------

type Decision = "once" | "always" | "reject"
const PERMISSION_ACTIONS: Record<string, Decision> = {
  oc_perm_once: "once",
  oc_perm_always: "always",
  oc_perm_reject: "reject",
}

registerPermissionHandlers(app, PERMISSION_ACTIONS)

function registerPermissionHandlers(
  boltApp: App,
  actions: Record<string, Decision>,
): void {
  for (const [actionId, decision] of Object.entries(actions)) {
    boltApp.action(actionId, async ({ ack, body, action }) => {
      await ack()
      const value = (action as { value?: string }).value ?? "{}"
      let parsed: { sessionID?: string; requestID?: string } = {}
      try {
        parsed = JSON.parse(value)
      } catch {
        /* fall through to error text */
      }
      const { sessionID, requestID } = parsed
      const msg: any = body as any
      const channel = msg.channel?.id ?? msg.container?.channel_id
      const messageTs = msg.message?.ts ?? msg.container?.message_ts
      const approver = msg.user?.id ?? msg.user_id

      const decisionLabel =
        decision === "reject" ? "Denied" : decision === "always" ? "Approved (always)" : "Approved (once)"

      if (!sessionID || !requestID) {
        await updateButtons(channel, messageTs, "⚠️ Could not parse the permission request payload.")
        return
      }
      try {
        await client.permission.reply({ sessionID, requestID, decision })
        await updateButtons(
          channel,
          messageTs,
          `🔐 Permission ${decisionLabel.toLowerCase()}${approver ? ` by <@${approver}>` : ""}.`,
        )
      } catch (err) {
        await updateButtons(channel, messageTs, `⚠️ Failed to record decision: ${errorMessage(err)}`)
      }
    })
  }
}

async function updateButtons(channel: string | undefined, ts: string | undefined, text: string): Promise<void> {
  if (!channel || !ts) return
  await slack.chat.update({ channel, ts, text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] })
}

// --- OpenCode event stream → Slack -----------------------------------------

void (async () => {
  const types = [
    "session.execution.succeeded",
    "session.execution.failed",
    "session.execution.interrupted",
    "permission.asked",
  ]
  for await (const rawEvent of client.event.subscribe({ types: types as never[] })) {
    const event = rawEvent as any
    const sessionID = event?.data?.sessionID as string | undefined
    if (!sessionID) continue
    const thread = state.getThread(sessionID)
    if (!thread) continue // not a Slack-driven session
    const isDm = thread.threadTs === "dm"
    const replyThreadTs = isDm ? undefined : thread.threadTs

    try {
      switch (event.type) {
        case "session.execution.succeeded": {
          const context = unwrap(await client.session.context({ sessionID })) as MessageInfo[] | undefined
          const reply = Array.isArray(context) ? latestAssistantReply(context) : ""
          await postChunked(thread.channel, reply || "_(finished — no text output)_", replyThreadTs)
          break
        }
        case "session.execution.failed": {
          const message = (event?.data?.error?.message as string | undefined) ?? "unknown error"
          await postChunked(thread.channel, `❌ OpenCode failed: ${mrkdwnEscape(message)}`, replyThreadTs)
          break
        }
        case "session.execution.interrupted": {
          const reason = (event?.data?.reason as string | undefined) ?? "unknown"
          await postChunked(thread.channel, `⏹️ OpenCode interrupted (${reason}).`, replyThreadTs)
          break
        }
        case "permission.asked": {
          const action = (event?.data?.action as string | undefined) ?? "unknown action"
          const resources = Array.isArray(event?.data?.resources) ? (event.data.resources as string[]) : []
          const requestID = event?.data?.id as string | undefined
          if (!requestID) break
          const resourceList =
            resources.map((r) => `• \`${mrkdwnEscape(String(r))}\``).join("\n") || "• _(no resources)_"
          await slack.chat.postMessage({
            channel: thread.channel,
            ...(replyThreadTs ? { thread_ts: replyThreadTs } : {}),
            text: `🔐 Approval needed — ${action}`,
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `🔐 *Approval needed* — \`${mrkdwnEscape(action)}\`\n${resourceList}\nSession \`${sessionID}\``,
                },
              },
              {
                type: "actions",
                elements: [
                  {
                    type: "button",
                    text: { type: "plain_text", text: "Approve once" },
                    style: "primary",
                    action_id: "oc_perm_once",
                    value: JSON.stringify({ sessionID, requestID }),
                  },
                  {
                    type: "button",
                    text: { type: "plain_text", text: "Always allow" },
                    action_id: "oc_perm_always",
                    value: JSON.stringify({ sessionID, requestID }),
                  },
                  {
                    type: "button",
                    text: { type: "plain_text", text: "Deny" },
                    style: "danger",
                    action_id: "oc_perm_reject",
                    value: JSON.stringify({ sessionID, requestID }),
                  },
                ],
              },
            ],
          })
          break
        }
      }
    } catch (err) {
      console.error(`[opencode-slack-bot] failed to handle ${event?.type}:`, err)
    }
  }
  console.warn("[opencode-slack-bot] event subscription ended")
})().catch((err) => console.error("[opencode-slack-bot] event stream crashed:", err))

await app.start()
log(
  `ready — connected to OpenCode, directory: ${directory}` +
    (model ? `, model: ${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}` : ", model: location default"),
)
