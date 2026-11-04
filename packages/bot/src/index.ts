import { App } from "@slack/bolt"
import { makeClient, latestAssistantReply, parseModelRef, type MessageInfo } from "./opencode"
import { StateStore } from "./state"
import { chunkText, formatCheckin, formatSlackContext, markdownToMrkdwn, mrkdwnEscape, type SlackContextMessage } from "./slackText"
import { conversationKey } from "./conversation"

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
  /** A mention: engage the whole channel, not just this thread. */
  engageChannel?: boolean
}

/** Slack thread (or recent channel history) rendered for the agent. */
async function fetchContextMessages(input: Incoming): Promise<SlackContextMessage[]> {
  try {
    if (input.threadTs) {
      const res = await slack.conversations.replies({ channel: input.channel, ts: input.threadTs, limit: 60 })
      return (res.messages ?? []) as SlackContextMessage[]
    }
    const res = await slack.conversations.history({
      channel: input.channel,
      latest: input.ts,
      inclusive: false,
      limit: 20,
    })
    return ((res.messages ?? []) as SlackContextMessage[]).reverse()
  } catch (err) {
    console.warn("[opencode-slack-bot] could not fetch Slack context:", err)
    return []
  }
}

async function buildPromptText(input: Incoming, text: string): Promise<string> {
  if (input.isDm) return text // the DM history is already the session
  const messages = await fetchContextMessages(input)
  const context = formatSlackContext(messages, { botUserId, excludeTs: input.ts })
  if (!context) return text
  const source = input.threadTs ? `thread ${input.threadTs}` : "recent channel history"
  return [
    `<slack_context channel="${input.channel}" source="${source}">`,
    context,
    "</slack_context>",
    "",
    "<message>",
    text,
    "</message>",
  ].join("\n")
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
  const { key, replyThreadTs: initialReplyTs } = conversationKey(input, (key) => state.getByKey(key))
  const entry = state.getByKey(key)
  const replyThreadTs = entry?.replyTs ?? initialReplyTs
  const text = stripMention(input.text)

  const [command] = text.split(/\s+/)

  // -- commands -----------------------------------------------------------
  if (command === "!help" || command === "!help.") {
    await postChunked(
      channel,
      [
        "*OpenCode Slack bot*",
        "• Mention me to start a session. I then follow this channel — every message feeds the same session, with thread context.",
        "• In a thread, mention me to give that thread its own session.",
        "• DMs are one continuous session.",
        "• `!stop` — interrupt the running session",
        "• `!new` — start a fresh session",
        "• `!leave` — stop following this channel",
        "• `!status` — show the mapped session",
        "• Permission requests arrive as buttons: *Approve once*, *Always allow*, *Deny*.",
      ].join("\n"),
      replyThreadTs,
    )
    return
  }

  if (command === "!stop") {
    const sessionID = entry?.sessionID
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

  if (command === "!leave") {
    if (input.isDm) return void (await postChunked(channel, "I'm not following a channel here — just say `!new` for a fresh session.", replyThreadTs))
    state.removeByKey(`${channel}:channel`)
    await postChunked(channel, "👋 Not following this channel any more — mention me to re-engage.", replyThreadTs)
    return
  }

  if (command === "!status") {
    const sessionID = entry?.sessionID
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

  let sessionID = entry?.sessionID
  let created = false
  if (!sessionID) {
    const session = unwrap(
      await client.session.create({
        location: { directory },
        title: text.replace(/\s+/g, " ").slice(0, 80),
      }),
    ) as { id: string }
    sessionID = session.id
    state.setByKey(key, sessionID, initialReplyTs)
    created = true
    if (model) {
      await client.session.switchModel({ sessionID, model }).catch((err) => {
        console.warn(`[opencode-slack-bot] could not switch session ${sessionID} to ${model.providerID}/${model.id}:`, err)
      })
    }
  }

  // A mention in a channel engages the channel: later messages keep using this session.
  if (!input.isDm && !state.getByKey(`${channel}:channel`)) {
    state.setByKey(`${channel}:channel`, sessionID, replyThreadTs)
  }

  // Point the session's reply target at the conversation that is driving it
  // right now. One session can be engaged from several threads (a channel
  // session is reused by any thread that has no session of its own), and the
  // event stream only carries the session ID, so without this refresh the
  // reply lands in whichever thread was engaged first.
  state.setByKey(key, sessionID, replyThreadTs)

  const prompt = await buildPromptText(input, text)
  try {
    await client.session.prompt({ sessionID, text: prompt })
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
      engageChannel: true,
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
    // Follow mapped threads, and any message in a channel we've been mentioned in.
    const inMappedThread = threadTs ? state.getByKey(`${channel}:${threadTs}`) : undefined
    const channelEngaged = state.getByKey(`${channel}:channel`)
    if (!inMappedThread && !channelEngaged) return
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

// --- progress check-ins -----------------------------------------------------

const CHECKIN_SECONDS = Math.max(10, Number(process.env.OPENCODE_SLACK_CHECKIN_SECONDS ?? 45) || 45)
const PROGRESS_MAX_MS = 30 * 60_000

interface Progress {
  channel: string
  threadTs?: string
  statusTs?: string
  steps: number
  tool?: string
  startedAt: number
  lastUpdate: number
}

const progress = new Map<string, Progress>()

function startProgress(sessionID: string, channel: string, threadTs?: string): Progress {
  const existing = progress.get(sessionID)
  if (existing) return existing
  const now = Date.now()
  const created: Progress = { channel, threadTs, steps: 0, startedAt: now, lastUpdate: now }
  progress.set(sessionID, created)
  return created
}

async function checkin(p: Progress): Promise<void> {
  const now = Date.now()
  if (now - p.lastUpdate < CHECKIN_SECONDS * 1000) return
  p.lastUpdate = now
  const text = formatCheckin(p.steps, now - p.startedAt, p.tool)
  try {
    if (p.statusTs) {
      await slack.chat.update({ channel: p.channel, ts: p.statusTs, text })
    } else {
      const res = await slack.chat.postMessage({
        channel: p.channel,
        text,
        ...(p.threadTs ? { thread_ts: p.threadTs } : {}),
      })
      p.statusTs = res.ts
    }
  } catch (err) {
    console.warn("[opencode-slack-bot] check-in failed:", err)
  }
}

async function finishProgress(sessionID: string): Promise<void> {
  const p = progress.get(sessionID)
  if (!p) return
  progress.delete(sessionID)
  if (!p.statusTs) return
  try {
    await slack.chat.delete({ channel: p.channel, ts: p.statusTs })
  } catch {
    /* message already gone or delete refused — cosmetic */
  }
}

// Keep the check-in fresh even while the agent sits inside one long tool call.
const checkinTimer = setInterval(
  () => {
    const now = Date.now()
    for (const [sessionID, p] of progress) {
      if (now - p.startedAt > PROGRESS_MAX_MS) {
        void finishProgress(sessionID)
        continue
      }
      void checkin(p)
    }
  },
  Math.max(5, Math.floor(CHECKIN_SECONDS / 3)) * 1000,
)
checkinTimer.unref?.()

// --- OpenCode event stream → Slack (auto-reconnecting) ----------------------

const EVENT_TYPES = [
  "session.step.started",
  "session.tool.input.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "permission.asked",
]

async function handleEvent(rawEvent: unknown): Promise<void> {
  const event = rawEvent as any
  const sessionID = event?.data?.sessionID as string | undefined
  if (!sessionID) return
  const thread = state.getThread(sessionID)
  if (!thread) return // not a Slack-driven session
  const replyThreadTs = thread.replyTs

  switch (event.type) {
    case "session.step.started": {
      const p = startProgress(sessionID, thread.channel, replyThreadTs)
      p.steps++
      await checkin(p)
      break
    }
    case "session.tool.input.started": {
      const p = startProgress(sessionID, thread.channel, replyThreadTs)
      if (typeof event.data?.name === "string") p.tool = event.data.name
      await checkin(p)
      break
    }
    case "session.execution.succeeded": {
      await finishProgress(sessionID)
      const context = unwrap(await client.session.context({ sessionID })) as MessageInfo[] | undefined
      const reply = Array.isArray(context) ? latestAssistantReply(context) : ""
      await postChunked(
        thread.channel,
        reply ? markdownToMrkdwn(reply) : "_(finished — no text output)_",
        replyThreadTs,
      )
      break
    }
    case "session.execution.failed": {
      await finishProgress(sessionID)
      const message = (event?.data?.error?.message as string | undefined) ?? "unknown error"
      await postChunked(thread.channel, `❌ OpenCode failed: ${mrkdwnEscape(message)}`, replyThreadTs)
      break
    }
    case "session.execution.interrupted": {
      await finishProgress(sessionID)
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
}

/** Subscribe, and reconnect with backoff whenever the live stream ends or fails. */
async function eventLoop(): Promise<void> {
  let backoff = 1000
  for (;;) {
    try {
      for await (const rawEvent of client.event.subscribe({ types: EVENT_TYPES as never[] })) {
        backoff = 1000 // a delivered event means the stream is healthy
        try {
          await handleEvent(rawEvent)
        } catch (err) {
          console.error(`[opencode-slack-bot] failed to handle ${(rawEvent as any)?.type}:`, err)
        }
      }
    } catch (err) {
      console.warn("[opencode-slack-bot] event stream error:", err)
    }
    console.warn(`[opencode-slack-bot] event stream ended — reconnecting in ${Math.round(backoff / 1000)}s`)
    await new Promise((resolve) => setTimeout(resolve, backoff))
    backoff = Math.min(backoff * 2, 30_000)
  }
}

void eventLoop()

await app.start()
log(
  `ready — connected to OpenCode, directory: ${directory}` +
    (model ? `, model: ${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}` : ", model: location default") +
    `, check-in: ${CHECKIN_SECONDS}s`,
)
