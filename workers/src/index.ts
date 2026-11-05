import { parseInteractionBody, verifySlackSignature, type SlackEventEnvelope } from "./slack"
import type { Env } from "./env"
import type { EventRequest, InteractionRequest } from "./thread"

export { ThreadContainer } from "./thread"

const DECISIONS = {
  oc_perm_once: "once",
  oc_perm_always: "always",
  oc_perm_reject: "reject",
} as const

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/health") return new Response("ok")
    if (request.method !== "POST") return new Response("not found", { status: 404 })

    const body = await request.text()
    const valid = await verifySlackSignature({
      signingSecret: env.SLACK_SIGNING_SECRET,
      timestamp: request.headers.get("x-slack-request-timestamp"),
      signature: request.headers.get("x-slack-signature"),
      body,
    })
    if (!valid) return new Response("invalid signature", { status: 401 })

    if (url.pathname === "/slack/events") {
      const payload = JSON.parse(body) as SlackEventEnvelope
      if (payload.type === "url_verification") {
        return Response.json({ challenge: payload.challenge })
      }

      const event = payload.event
      if (!event?.channel || !event.ts) return new Response("ok")

      const isDm = event.channel_type === "im"
      const replyTs = isDm ? undefined : event.thread_ts ?? event.ts
      const key = isDm ? `${event.channel}:dm` : `${event.channel}:${event.thread_ts ?? event.ts}`

      const dispatch: EventRequest = {
        ...(payload.event_id ? { eventID: payload.event_id } : {}),
        key,
        ...(replyTs ? { replyTs } : {}),
        event,
      }
      ctx.waitUntil(
        env.THREAD.getByName(key).fetch("https://thread/event", {
          method: "POST",
          body: JSON.stringify(dispatch),
        }),
      )
      return new Response("ok")
    }

    if (url.pathname === "/slack/interactivity") {
      const payload = parseInteractionBody(body)
      const action = payload?.actions?.[0]
      if (!action?.value || !action.action_id) return new Response("ok")

      const decision = DECISIONS[action.action_id as keyof typeof DECISIONS]
      if (!decision) return new Response("ok")

      const parsed = JSON.parse(action.value) as { key?: string; sessionID?: string; requestID?: string }
      if (!parsed.key || !parsed.sessionID || !parsed.requestID) return new Response("ok")

      const dispatch: InteractionRequest = {
        key: parsed.key,
        sessionID: parsed.sessionID,
        requestID: parsed.requestID,
        decision,
        ...(payload?.user?.id ? { user: payload.user.id } : {}),
      }
      ctx.waitUntil(
        env.THREAD.getByName(parsed.key).fetch("https://thread/interaction", {
          method: "POST",
          body: JSON.stringify(dispatch),
        }),
      )
      return new Response("ok")
    }

    return new Response("not found", { status: 404 })
  },
}
