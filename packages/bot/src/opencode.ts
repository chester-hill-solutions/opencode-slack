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

export interface ModelRef {
  providerID: string
  id: string
  variant?: string
}

/**
 * Parse a model reference in `provider/model` or `provider/model#variant`
 * form. Returns undefined when the string is malformed.
 */
export function parseModelRef(ref: string | undefined): ModelRef | undefined {
  if (!ref) return undefined
  const [modelPart, variant] = ref.split("#", 2)
  const slash = modelPart.indexOf("/")
  if (slash <= 0 || slash === modelPart.length - 1) return undefined
  const providerID = modelPart.slice(0, slash)
  const id = modelPart.slice(slash + 1)
  return variant ? { providerID, id, variant } : { providerID, id }
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
