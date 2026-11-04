import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test"

// Capture Slack Web API calls made by the plugin.
const posted: Array<{ channel: string; text: string; thread_ts?: string }> = []

mock.module("@slack/web-api", () => ({
  WebClient: class {
    chat = {
      postMessage: async (msg: { channel: string; text: string; thread_ts?: string }) => {
        posted.push({ channel: msg.channel, text: msg.text, ...(msg.thread_ts ? { thread_ts: msg.thread_ts } : {}) })
        return { ok: true, ts: "999.0001" }
      },
    }
    conversations = {
      list: async () => ({
        channels: [{ id: "C123", name: "general", is_private: false }],
      }),
    }
  },
}))

const originalToken = process.env.SLACK_BOT_TOKEN

interface FakeTool {
  name: string
  description: string
  execute: (input: unknown, context: unknown) => Promise<{ content: string }>
}

function makeFakeCtx(options: Record<string, unknown>, eventBatches: unknown[][] = []) {
  const tools: FakeTool[] = []
  const namespaces: Array<{ name: string; description: string }> = []
  const editor = {
    namespace: (ns: { name: string; description: string }) => namespaces.push(ns),
    add: (tool: FakeTool) => tools.push(tool),
    list: () => tools,
    get: () => undefined,
    update: () => {},
    remove: () => {},
  }
  const ctx = {
    app: { version: "test" },
    location: { directory: "/tmp" },
    options,
    tool: {
      transform: async (fn: (editor: unknown) => void) => {
        fn(editor)
        return { dispose: async () => {} }
      },
    },
    event: {
      subscribe: () =>
        (async function* () {
          for (const batch of eventBatches) for (const e of batch) yield e as never
        })(),
    },
    session: {
      get: async () => ({ title: "Test session" }),
    },
  } as never
  return { ctx, tools, namespaces }
}

beforeEach(() => {
  posted.length = 0
  process.env.SLACK_BOT_TOKEN = "xoxb-test"
})

afterEach(() => {
  if (originalToken === undefined) delete process.env.SLACK_BOT_TOKEN
  else process.env.SLACK_BOT_TOKEN = originalToken
})

describe("opencode-slack-plugin", () => {
  test("registers slack tools in the slack namespace", async () => {
    const { default: plugin } = await import("../packages/plugin/src/index")
    const { ctx, tools, namespaces } = makeFakeCtx({})
    await plugin.setup(ctx)

    expect(namespaces).toEqual([{ name: "slack", description: expect.any(String) }])
    expect(tools.map((t) => t.name).sort()).toEqual(["list_channels", "post_message"])
  })

  test("slack_post_message posts to Slack", async () => {
    const { default: plugin } = await import("../packages/plugin/src/index")
    const { ctx, tools } = makeFakeCtx({})
    await plugin.setup(ctx)

    const post = tools.find((t) => t.name === "post_message")!
    const result = await post.execute({ channel: "C123", text: "hello from test" }, {})
    expect(posted).toEqual([{ channel: "C123", text: "hello from test" }])
    expect(result.content).toContain("C123")
  })

  test("notifications stay silent without notifyChannel", async () => {
    const { default: plugin } = await import("../packages/plugin/src/index")
    const { ctx } = makeFakeCtx({}, [[{ type: "session.execution.failed", data: { sessionID: "ses_1", error: { message: "boom" } } }]])
    await plugin.setup(ctx)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(posted).toEqual([])
  })

  test("posts a notification when a session fails and notifyChannel is set", async () => {
    const { default: plugin } = await import("../packages/plugin/src/index")
    const { ctx } = makeFakeCtx(
      { notifyChannel: "C999", notifyOn: ["failed"] },
      [[{ type: "session.execution.failed", data: { sessionID: "ses_1", error: { message: "boom" } } }]],
    )
    await plugin.setup(ctx)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(posted.length).toBe(1)
    expect(posted[0]!.channel).toBe("C999")
    expect(posted[0]!.text).toContain("Test session")
    expect(posted[0]!.text).toContain("boom")
  })

  test("missing token disables the plugin gracefully", async () => {
    delete process.env.SLACK_BOT_TOKEN
    const { default: plugin } = await import("../packages/plugin/src/index")
    const { ctx, tools } = makeFakeCtx({})
    const result = await plugin.setup(ctx)
    expect(result).toBeUndefined()
    expect(tools).toEqual([])
    expect(posted).toEqual([])
  })
})
