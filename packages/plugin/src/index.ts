import { createReadStream, existsSync, statSync } from "node:fs"
import { basename } from "node:path"
import { Plugin } from "@opencode/plugin"
import { WebClient } from "@slack/web-api"

/**
 * opencode-slack-plugin
 *
 * Two capabilities, both driven by the SLACK_BOT_TOKEN env var (or the
 * `botToken` plugin option):
 *
 * 1. Tools — `slack_post_message`, `slack_list_channels` and
 *    `slack_upload_file`, so the agent can post to Slack and upload clips or
 *    documents from inside a session.
 * 2. Notifications (opt-in) — posts to `notifyChannel` when a session
 *    finishes, fails, is interrupted, or asks for permission.
 *
 * Example opencode.json(c):
 *
 *   {
 *     "plugins": [
 *       {
 *         "package": "opencode-slack-plugin",
 *         "options": {
 *           "notifyChannel": "C0123ABC",
 *           "notifyOn": ["failed", "permission"]
 *         }
 *       }
 *     ]
 *   }
 */

type NotifyKind = "succeeded" | "failed" | "interrupted" | "permission"

interface SlackOptions {
  /** Bot token. Defaults to process.env.SLACK_BOT_TOKEN. */
  botToken?: string
  /** Channel ID for session notifications. Notifications are disabled without it. */
  notifyChannel?: string
  /** Which events to notify on. Default: ["failed", "permission"]. */
  notifyOn?: NotifyKind[]
}

const NOTIFY_TYPES: Record<NotifyKind, string[]> = {
  succeeded: ["session.execution.succeeded"],
  failed: ["session.execution.failed"],
  interrupted: ["session.execution.interrupted"],
  permission: ["permission.asked"],
}

const SLACK_MESSAGE_LIMIT = 3900

/** Post possibly-long text as one or more Slack messages. */
async function postChunked(slack: WebClient, channel: string, text: string, threadTs?: string) {
  const chunks = chunkText(text, SLACK_MESSAGE_LIMIT)
  let lastTs: string | undefined
  for (const chunk of chunks) {
    const res = await slack.chat.postMessage({ channel, text: chunk, thread_ts: threadTs })
    lastTs = res.ts ?? lastTs
  }
  return lastTs
}

function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > limit) {
    // Prefer splitting at a newline, then a space, then hard-split.
    let cut = remaining.lastIndexOf("\n", limit)
    if (cut < limit / 2) cut = remaining.lastIndexOf(" ", limit)
    if (cut < limit / 2) cut = limit
    chunks.push(remaining.slice(0, cut))
    remaining = remaining.slice(cut).trimStart()
  }
  if (remaining.length > 0) chunks.push(remaining)
  return chunks
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export default Plugin.define({
  id: "slack",

  async setup(ctx) {
    const options = (ctx.options ?? {}) as SlackOptions
    const token = (process.env.SLACK_BOT_TOKEN ?? options.botToken)?.trim()
    if (!token) {
      console.warn("[opencode-slack] SLACK_BOT_TOKEN is not set — Slack tools and notifications are disabled.")
      return
    }

    const slack = new WebClient(token)
    const log = (...args: unknown[]) => console.log("[opencode-slack]", ...args)

    // ---------------------------------------------------------------- tools
    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "slack",
        description: "Slack tools: post messages and list channels",
      })

      editor.add({
        name: "post_message",
        description:
          "Post a message to a Slack channel or thread. Find channel IDs with slack_list_channels. Long messages are split automatically.",
        input: {
          type: "object",
          properties: {
            channel: {
              type: "string",
              description: "Channel ID, e.g. C0123ABC. Use slack_list_channels to resolve names to IDs.",
            },
            text: { type: "string", description: "Message text (mrkdwn supported)." },
            thread_ts: {
              type: "string",
              description: "Optional thread timestamp to reply inside an existing thread.",
            },
          },
          required: ["channel", "text"],
          additionalProperties: false,
        },
        options: { namespace: "slack", codemode: true },
        execute: async (input) => {
          const { channel, text, thread_ts } = input as {
            channel: string
            text: string
            thread_ts?: string
          }
          const ts = await postChunked(slack, channel, text, thread_ts)
          return { content: `Posted to Slack channel ${channel}${thread_ts ? ` (thread ${thread_ts})` : ""}. ts: ${ts ?? "unknown"}` }
        },
      })

      editor.add({
        name: "list_channels",
        description: "List Slack channels the bot has access to, with their IDs.",
        input: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Max channels to return (default 100)." },
          },
          additionalProperties: false,
        },
        options: { namespace: "slack", codemode: true },
        execute: async (input) => {
          const { limit } = input as { limit?: number }
          const res = await slack.conversations.list({
            limit: Math.min(Math.max(limit ?? 100, 1), 1000),
            exclude_archived: true,
            types: "public_channel,private_channel",
          })
          const channels = (res.channels ?? []).map((c) => ({ id: c.id, name: c.name, is_private: c.is_private }))
          return { content: JSON.stringify(channels, null, 2) }
        },
      })

      editor.add({
        name: "upload_file",
        description:
          "Upload a local file (video clip, image, audio, document) to a Slack channel, optionally into a thread. Requires the files:write scope.",
        input: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute path to the file to upload." },
            channel: {
              type: "string",
              description: "Channel ID, e.g. C0123ABC. Use slack_list_channels to resolve names to IDs.",
            },
            title: { type: "string", description: "Title shown for the file (defaults to the filename)." },
            comment: { type: "string", description: "Message posted alongside the file." },
            thread_ts: {
              type: "string",
              description: "Optional thread timestamp to upload into an existing thread.",
            },
          },
          required: ["path", "channel"],
          additionalProperties: false,
        },
        options: { namespace: "slack", codemode: true },
        execute: async (input) => {
          const { path, channel, title, comment, thread_ts } = input as {
            path: string
            channel: string
            title?: string
            comment?: string
            thread_ts?: string
          }
          if (!existsSync(path)) throw new Error(`file not found: ${path}`)
          const stat = statSync(path)
          if (!stat.isFile()) throw new Error(`not a file: ${path}`)

          const filename = basename(path)
          const args = {
            channel_id: channel,
            file: createReadStream(path),
            filename,
            title: title ?? filename,
            ...(comment ? { initial_comment: comment } : {}),
            ...(thread_ts ? { thread_ts } : {}),
          } as Parameters<InstanceType<typeof WebClient>["files"]["uploadV2"]>[0]
          const res = await slack.files.uploadV2(args)
          // uploadV2 returns one completeUploadExternal response per file group.
          const first = (Array.isArray(res) ? res[0] : res) as {
            files?: Array<{ id?: string }>
            file?: { id?: string }
          }
          const fileId = first?.files?.[0]?.id ?? first?.file?.id
          return {
            content: `Uploaded ${filename} (${stat.size} bytes) to ${channel}${thread_ts ? ` (thread ${thread_ts})` : ""}.${fileId ? ` file id: ${fileId}` : ""}`,
          }
        },
      })
    })

    // --------------------------------------------------------- notifications
    const notifyChannel = options.notifyChannel
    if (!notifyChannel) {
      log("loaded (tools only; set notifyChannel in plugin options to enable notifications)")
      return
    }

    const notifyOn = new Set<NotifyKind>(options.notifyOn ?? ["failed", "permission"])
    const types = [...notifyOn].flatMap((kind) => NOTIFY_TYPES[kind])
    if (types.length === 0) {
      log("notifyOn is empty — notifications disabled")
      return
    }

    const sessionTitle = async (sessionID: string): Promise<string | undefined> => {
      try {
        const session = await ctx.session.get({ sessionID })
        return asRecord(session)?.title as string | undefined
      } catch {
        return undefined
      }
    }

    const label = async (sessionID: string) => {
      const title = await sessionTitle(sessionID)
      return title ? `*${title}* (\`${sessionID}\`)` : `session \`${sessionID}\``
    }

    const controller = new AbortController()
    void (async () => {
      for await (const rawEvent of ctx.event.subscribe({ types: types as never[], signal: controller.signal })) {
        const event = rawEvent as unknown as { type: string; data?: unknown }
        try {
          const data = asRecord(event.data) ?? {}
          const sessionID = data.sessionID as string | undefined
          if (!sessionID) continue

          switch (event.type) {
            case "session.execution.succeeded":
              await slack.chat.postMessage({
                channel: notifyChannel,
                text: `✅ OpenCode finished — ${await label(sessionID)}`,
              })
              break
            case "session.execution.failed": {
              const error = asRecord(data.error)
              const message = (error?.message as string | undefined) ?? "unknown error"
              await slack.chat.postMessage({
                channel: notifyChannel,
                text: `❌ OpenCode failed — ${await label(sessionID)}\n${message}`,
              })
              break
            }
            case "session.execution.interrupted": {
              const reason = (data.reason as string | undefined) ?? "unknown"
              await slack.chat.postMessage({
                channel: notifyChannel,
                text: `⏹️ OpenCode interrupted (${reason}) — ${await label(sessionID)}`,
              })
              break
            }
            case "permission.asked": {
              const action = (data.action as string | undefined) ?? "unknown action"
              const resources = Array.isArray(data.resources) ? (data.resources as string[]) : []
              const requestID = data.id as string | undefined
              const resourceList = resources.map((r) => `• \`${r}\``).join("\n")
              await slack.chat.postMessage({
                channel: notifyChannel,
                text: [
                  `🔐 Approval needed — *${action}* (${await label(sessionID)})`,
                  resourceList,
                  requestID ? `Request \`${requestID}\`` : undefined,
                ]
                  .filter(Boolean)
                  .join("\n"),
              })
              break
            }
          }
        } catch (err) {
          console.warn("[opencode-slack] failed to post notification:", err)
        }
      }
    })().catch((err) => {
      if (!controller.signal.aborted) console.warn("[opencode-slack] event subscription ended:", err)
    })

    log(`notifications enabled for: ${[...notifyOn].join(", ")} → ${notifyChannel}`)
    return () => controller.abort()
  },
})
