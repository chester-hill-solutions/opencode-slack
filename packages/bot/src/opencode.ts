import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"

export type OpenCodeClient = ReturnType<typeof OpenCode.make>

/**
 * Build the OpenCode client.
 *
 * - OPENCODE_URL set      → connect to that server. Auth via OPENCODE_TOKEN
 *   (sent as a bearer token) or OPENCODE_AUTH_HEADER (full Authorization
 *   header value, e.g. "Basic base64…" for Caddy basic auth).
 * - Otherwise             → discover (or start) the local OpenCode
 *   background service via @opencode/client/service.
 */
export async function makeClient(): Promise<OpenCodeClient> {
  const url = process.env.OPENCODE_URL
  if (url) {
    const headers = authHeaders()
    return OpenCode.make({ baseUrl: url, ...(headers ? { headers } : {}) })
  }
  const endpoint = await Service.ensure()
  return OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
}

function authHeaders(): Record<string, string> | undefined {
  if (process.env.OPENCODE_AUTH_HEADER) {
    return { authorization: process.env.OPENCODE_AUTH_HEADER }
  }
  if (process.env.OPENCODE_TOKEN) {
    return { authorization: `Bearer ${process.env.OPENCODE_TOKEN}` }
  }
  return undefined
}

export interface TextPart {
  type: string
  text?: string
}

export interface MessageInfo {
  type: string
  id?: string
  time?: { created?: number }
  content?: TextPart[]
  text?: string
}

/**
 * Extract the assistant reply to the *latest* user message in a session
 * context: all assistant text parts emitted after the last user message.
 */
export function latestAssistantReply(messages: MessageInfo[]): string {
  let lastUserIndex = -1
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.type === "user") lastUserIndex = i
  }
  const reply = messages
    .slice(lastUserIndex + 1)
    .filter((m) => m.type === "assistant")
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n\n")
    .trim()
  return reply
}
