import { DurableObject } from "cloudflare:workers"
import { makeClient, portFetch, type ContainerPort } from "./opencode"
import { ThreadStore } from "./state"
import {
  chunkText,
  formatSlackContext,
  mrkdwnEscape,
  type SlackContextMessage,
  type SlackEventEnvelope,
} from "./slack"
import { isSettled, latestAssistantReply, type MessageInfo } from "./messages"
import { parseModelRef, type Env } from "./env"

const OPENCODE_PORT = 4000
const CONTROL_PORT = 4001
const POLL_MS = 2000

export interface EventRequest {
  eventID?: string
  key: string
  replyTs?: string
  event: NonNullable<SlackEventEnvelope["event"]>
}

export interface InteractionRequest {
  key: string
  sessionID: string
  requestID: string
  decision: "once" | "always" | "reject"
  user?: string
}

export class ThreadContainer extends DurableObject<Env> {
  private readonly store: ThreadStore

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.store = new ThreadStore(ctx.storage)
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/event") {
      await this.onEvent((await request.json()) as EventRequest)
      return Response.json({ ok: true })
    }
    if (url.pathname === "/interaction") {
      await this.onInteraction((await request.json()) as InteractionRequest)
      return Response.json({ ok: true })
    }
    if (url.pathname === "/health") return Response.json({ ok: true })
    return new Response("not found", { status: 404 })
  }

  // ------------------------------------------------------------- Slack events

  private async onEvent(input: EventRequest): Promise<void> {
    const event = input.event
    if (!event.channel || !event.ts) return
    if (event.bot_id || event.subtype) return
    if (!event.text) return
    if (input.eventID && (await this.store.seenBefore(input.eventID))) return

    const text = this.stripMention(event.text)
    if (!text) return

    const sessionID = await this.ensureSession(text, event.channel, input.replyTs)
    const prompt = await this.buildPrompt(event.channel, event.ts, event.thread_ts, text)
    await this.withClient((client) => client.session.prompt({ sessionID, text: prompt }))

    const state = await this.store.get()
    state.lastReply = undefined
    await this.store.save(state)
    await this.ctx.storage.setAlarm(Date.now() + POLL_MS)
  }

  private async onInteraction(input: InteractionRequest): Promise<void> {
    const sessionID = (await this.store.takePermission(input.requestID)) ?? input.sessionID
    await this.withClient((client) =>
      client.permission.reply({ sessionID, requestID: input.requestID, decision: input.decision }),
    )
  }

  // ------------------------------------------------------------------- prompt

  private async ensureSession(text: string, channel: string, replyTs?: string): Promise<string> {
    const state = await this.store.get()
    if (state.sessionID) return state.sessionID

    const session = await this.withClient((client) =>
      client.session.create({
        location: { directory: "/workspace" },
        title: text.replace(/\s+/g, " ").slice(0, 80),
      }),
    )
    const sessionID = (session as { id?: string }).id
    if (!sessionID) throw new Error("session.create returned no id")

    const model = parseModelRef(this.env.OPENCODE_MODEL)
    if (model) {
      await this.withClient((client) => client.session.switchModel({ sessionID, model })).catch(() => {})
    }
    await this.store.setSession(sessionID, channel, replyTs)
    return sessionID
  }

  private async buildPrompt(channel: string, ts: string, threadTs: string | undefined, text: string): Promise<string> {
    const messages = await this.fetchContext(channel, ts, threadTs)
    const context = formatSlackContext(messages, {
      botUserId: this.env.SLACK_BOT_USER_ID ?? "",
      excludeTs: ts,
    })
    if (!context) return text
    return [
      `<slack_context channel="${channel}" source="${threadTs ? `thread ${threadTs}` : "recent channel history"}">`,
      context,
      "</slack_context>",
      "",
      "<message>",
      text,
      "</message>",
    ].join("\n")
  }

  private async fetchContext(
    channel: string,
    ts: string,
    threadTs: string | undefined,
  ): Promise<SlackContextMessage[]> {
    try {
      if (threadTs) {
        const res = await this.slack("conversations.replies", { channel, ts: threadTs, limit: 60 })
        return (res.messages ?? []) as SlackContextMessage[]
      }
      const res = await this.slack("conversations.history", { channel, latest: ts, inclusive: false, limit: 20 })
      return ((res.messages ?? []) as SlackContextMessage[]).reverse()
    } catch {
      return []
    }
  }

  // -------------------------------------------------------------- reply pump

  /** One poll per alarm; re-arms itself until the run settles. */
  async alarm(): Promise<void> {
    const state = await this.store.get()
    if (!state.sessionID || !state.channel) return

    const sessionID = state.sessionID
    const messages = await this.withClient((client) => client.session.context({ sessionID }))
    const reply = latestAssistantReply((messages ?? []) as MessageInfo[])

    if (reply && reply !== state.lastReply) {
      await this.postChunked(state.channel, reply, state.replyTs)
      state.lastReply = reply
      await this.store.save(state)
    }

    if (isSettled((messages ?? []) as MessageInfo[])) {
      await this.checkpoint()
      return
    }
    await this.ctx.storage.setAlarm(Date.now() + POLL_MS)
  }

  // ---------------------------------------------------------------- container

  private async port(number: number): Promise<ContainerPort> {
    const container = this.ctx.container
    if (!container) throw new Error("no container bound")
    if (!container.running) container.start()
    const port = container.getTcpPort(number)
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const res = await port.fetch("http://container/health")
        if (res.ok) return port
      } catch {
        /* not ready yet */
      }
      await sleep(200)
    }
    throw new Error(`container port ${number} did not become ready`)
  }

  private async withClient<T>(fn: (client: ReturnType<typeof makeClient>) => Promise<T>): Promise<T> {
    const port = await this.ensureReady()
    const client = makeClient(portFetch(port))
    return fn(client)
  }

  /** Start the container, restore the checkpoint on first boot, start OpenCode. */
  private async ensureReady(): Promise<ContainerPort> {
    const control = await this.port(CONTROL_PORT)
    const status = (await (await control.fetch("http://container/status")).json()) as { initialized?: boolean }
    if (!status.initialized) {
      const checkpoint = await this.env.CHECKPOINTS.get(this.checkpointKey())
      if (checkpoint?.body) {
        await control.fetch("http://container/restore", { method: "POST", body: checkpoint.body })
      }
    }
    await control.fetch("http://container/start", { method: "POST" })
    const container = this.ctx.container
    if (!container) throw new Error("no container bound")
    return container.getTcpPort(OPENCODE_PORT)
  }

  private checkpointKey(): string {
    return `workspaces/${this.ctx.id.toString()}.tar.gz`
  }

  private async checkpoint(): Promise<void> {
    try {
      const control = await this.port(CONTROL_PORT)
      const response = await control.fetch("http://container/checkpoint")
      if (!response.ok || !response.body) return
      await this.env.CHECKPOINTS.put(this.checkpointKey(), response.body)
    } catch (err) {
      console.warn("checkpoint failed", err)
    }
  }

  // -------------------------------------------------------------------- Slack

  private async postChunked(channel: string, text: string, threadTs?: string): Promise<void> {
    for (const chunk of chunkText(text)) {
      await this.slack("chat.postMessage", {
        channel,
        text: chunk,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      })
    }
  }

  private stripMention(text: string): string {
    const botUserId = this.env.SLACK_BOT_USER_ID
    if (!botUserId) return text.trim()
    return text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim()
  }

  private async slack(method: string, body: Record<string, unknown>): Promise<Record<string, any>> {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.env.SLACK_BOT_TOKEN}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    })
    const json = (await res.json()) as { ok?: boolean; error?: string }
    if (!json.ok) throw new Error(`${method}: ${json.error ?? "unknown_error"}`)
    return json as Record<string, any>
  }
}

// ------------------------------------------------------------------- helpers

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
