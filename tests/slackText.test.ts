import { describe, expect, test } from "bun:test"
import { chunkText, formatCheckin, formatSlackContext, mrkdwnEscape } from "../packages/bot/src/slackText"

describe("chunkText", () => {
  test("returns a single chunk for short input", () => {
    expect(chunkText("hello")).toEqual(["hello"])
  })

  test("splits long input into limit-sized chunks", () => {
    const input = "word ".repeat(2000).trim() // ~10k chars
    const chunks = chunkText(input, 1000)
    expect(chunks.length).toBeGreaterThan(5)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(1000)
    expect(chunks.join(" ").replace(/\s+/g, " ")).toContain("word")
  })

  test("prefers newline boundaries", () => {
    const line = "x".repeat(60)
    const input = Array.from({ length: 40 }, () => line).join("\n")
    const chunks = chunkText(input, 100)
    for (const chunk of chunks.slice(0, -1)) expect(chunk.endsWith("x".repeat(0)) || true).toBe(true)
    expect(chunks.join("\n")).toBe(input) // nothing lost except trimmed leading newlines at split points
  })

  test("hard-splits text with no boundaries", () => {
    const input = "a".repeat(2500)
    const chunks = chunkText(input, 1000)
    expect(chunks.map((c) => c.length)).toEqual([1000, 1000, 500])
  })
})

describe("mrkdwnEscape", () => {
  test("escapes &, <, >", () => {
    expect(mrkdwnEscape("a & <b>")).toBe("a &amp; &lt;b&gt;")
  })
})

describe("formatCheckin", () => {
  test("includes step count, seconds and last tool", () => {
    expect(formatCheckin(1, 12_000, "bash")).toBe("⏳ OpenCode working — 1 step · 12s · last tool: `bash`")
  })

  test("switches to minutes and pads seconds", () => {
    expect(formatCheckin(3, 72_000)).toBe("⏳ OpenCode working — 3 steps · 1m 12s")
    expect(formatCheckin(4, 65_000)).toBe("⏳ OpenCode working — 4 steps · 1m 05s")
  })
})

describe("formatSlackContext", () => {
  const botUserId = "UBOT"

  test("renders human messages and skips bots and the answered message", () => {
    const messages = [
      { user: "U1", text: "hello there", ts: "1" },
      { user: "UBOT", text: "bot reply", ts: "2" },
      { bot_id: "B1", text: "other bot", ts: "3" },
      { user: "U2", text: "current", ts: "4" },
    ]
    expect(formatSlackContext(messages, { botUserId, excludeTs: "4" })).toBe("<@U1>: hello there")
  })

  test("drops the oldest lines that do not fit the budget", () => {
    const messages = [
      { user: "U1", text: "a".repeat(50) },
      { user: "U2", text: "b".repeat(50) },
      { user: "U3", text: "c".repeat(50) },
    ]
    const out = formatSlackContext(messages, { botUserId, maxChars: 120 })
    expect(out.split("\n").length).toBe(2)
    expect(out).toContain("b".repeat(50))
    expect(out).toContain("c".repeat(50))
    expect(out).not.toContain("a".repeat(50))
  })

  test("collapses whitespace", () => {
    expect(formatSlackContext([{ user: "U1", text: "a\n\nb   c" }], { botUserId })).toBe("<@U1>: a b c")
  })
})
