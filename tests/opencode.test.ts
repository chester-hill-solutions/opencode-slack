import { describe, expect, test } from "bun:test"
import { latestAssistantReply, parseModelRef, type MessageInfo } from "../packages/bot/src/opencode"

function user(text: string, created: number): MessageInfo {
  return { type: "user", text, time: { created } }
}
function assistant(texts: string[], created: number): MessageInfo {
  return {
    type: "assistant",
    time: { created },
    content: texts.map((t) => ({ type: "text", text: t })),
  }
}

describe("latestAssistantReply", () => {
  test("returns text after the last user message", () => {
    const messages = [
      user("first", 1),
      assistant(["reply one"], 2),
      user("second", 3),
      assistant(["reply two part A", "reply two part B"], 4),
    ]
    expect(latestAssistantReply(messages)).toBe("reply two part A\n\nreply two part B")
  })

  test("ignores non-text parts (reasoning, tool calls)", () => {
    const messages = [
      user("go", 1),
      {
        type: "assistant",
        time: { created: 2 },
        content: [
          { type: "reasoning", text: "internal" },
          { type: "text", text: "visible" },
          { type: "tool" } as never,
        ],
      },
    ]
    expect(latestAssistantReply(messages)).toBe("visible")
  })

  test("returns empty string when there is no assistant output", () => {
    expect(latestAssistantReply([user("hi", 1)])).toBe("")
    expect(latestAssistantReply([])).toBe("")
  })
})

describe("parseModelRef", () => {
  test("parses provider/model", () => {
    expect(parseModelRef("opencode-go/deepseek-v4.1-flash")).toEqual({
      providerID: "opencode-go",
      id: "deepseek-v4.1-flash",
    })
  })

  test("parses a variant suffix", () => {
    expect(parseModelRef("opencode-go/deepseek-v4.1-flash#high")).toEqual({
      providerID: "opencode-go",
      id: "deepseek-v4.1-flash",
      variant: "high",
    })
  })

  test("rejects malformed references", () => {
    expect(parseModelRef(undefined)).toBeUndefined()
    expect(parseModelRef("")).toBeUndefined()
    expect(parseModelRef("no-slash")).toBeUndefined()
    expect(parseModelRef("/missing-provider")).toBeUndefined()
    expect(parseModelRef("missing-model/")).toBeUndefined()
  })
})
