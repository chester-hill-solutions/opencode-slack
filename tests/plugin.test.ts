import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test"

// Capture Slack Web API calls made by the plugin.
const posted: Array<{ channel: string; text: string; thread_ts?: string }> = []
const uploads: Array<Record<string, unknown>> = []

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
    files = {
      uploadV2: async (args: Record<string, unknown>) => {
        // Drain the read stream so the temp file isn't deleted mid-open.
        const file = args.file as AsyncIterable<Uint8Array> | undefined
        if (file) {
          for await (const _chunk of file) {
            /* consume */
          }
        }
        uploads.push(args)
        return { ok: true }
      },
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
  uploads.length = 0
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
    expect(tools.map((t) => t.name).sort()).toEqual(["list_channels", "post_message", "upload_file"])
  })

  test("slack_upload_file uploads a local file", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dir = mkdtempSync(join(tmpdir(), "opencode-slack-upload-"))
    const path = join(dir, "clip.mp4")
    writeFileSync(path, Buffer.from("fake video bytes"))

    try {
      const { default: plugin } = await import("../packages/plugin/src/index")
      const { ctx, tools } = makeFakeCtx({})
      await plugin.setup(ctx)

      const upload = tools.find((t) => t.name === "upload_file")!
      const result = await upload.execute({ path, channel: "C123", title: "Debate clip", comment: "take a look" }, {})

      expect(uploads.length).toBe(1)
      expect(uploads[0]).toMatchObject({
        channel_id: "C123",
        filename: "clip.mp4",
        title: "Debate clip",
        initial_comment: "take a look",
      })
      expect(result.content).toContain("clip.mp4")
      expect(result.content).toContain("C123")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
    const cleanup = await plugin.setup(ctx)
    // Wait for the detached event loop to post, then stop it so nothing leaks
    // into the next test.
    const deadline = Date.now() + 1000
    while (posted.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
    await cleanup?.()

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
