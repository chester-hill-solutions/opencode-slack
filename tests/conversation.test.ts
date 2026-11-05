import { describe, expect, test } from "bun:test"
import { conversationKey, replyTarget, type ConversationEntry } from "../packages/bot/src/conversation"

const store = (entries: Record<string, ConversationEntry>) => (key: string) => entries[key]

const thread = (channel: string, ts: string) => `${channel}:${ts}`

describe("conversationKey", () => {
  test("DMs are one unthreaded conversation", () => {
    expect(conversationKey({ channel: "D1", ts: "1", isDm: true }, store({}))).toEqual({ key: "D1:dm" })
  })

  test("a mention engages the thread it was sent in", () => {
    expect(
      conversationKey({ channel: "C1", ts: "2", threadTs: "1", isDm: false, engageChannel: true }, store({})),
    ).toEqual({ key: thread("C1", "1"), replyThreadTs: "1" })
  })

  test("a mapped thread keeps its own conversation", () => {
    const entries = { [thread("C1", "1")]: { replyTs: "1" } }
    expect(conversationKey({ channel: "C1", ts: "3", threadTs: "1", isDm: false }, store(entries))).toEqual({
      key: thread("C1", "1"),
      replyThreadTs: "1",
    })
  })

  test("a top-level message starts at its own ts when nothing is engaged", () => {
    expect(conversationKey({ channel: "C1", ts: "5", isDm: false }, store({}))).toEqual({
      key: "C1:channel",
      replyThreadTs: "5",
    })
  })

  test("an engaged channel answers a top-level message in a new thread under it", () => {
    // The channel was engaged from thread 1. A fresh top-level message (ts 9)
    // must be answered under ts 9, not inside thread 1.
    const entries = { "C1:channel": { replyTs: "1" } }
    expect(conversationKey({ channel: "C1", ts: "9", isDm: false }, store(entries))).toEqual({
      key: "C1:channel",
      replyThreadTs: "9",
    })
  })

  test("replies in the thread the message arrived in, not the engagement thread", () => {
    // The channel was first engaged from thread 1; this message is in thread 7.
    // Posting to 1 is the bug this pins: the user was looking at thread 7.
    const entries = { "C1:channel": { replyTs: "1" } }
    expect(conversationKey({ channel: "C1", ts: "8", threadTs: "7", isDm: false }, store(entries))).toEqual({
      key: "C1:channel",
      replyThreadTs: "7",
    })
  })

  test("an unmapped thread without engagement gets its own conversation", () => {
    expect(conversationKey({ channel: "C1", ts: "4", threadTs: "2", isDm: false }, store({}))).toEqual({
      key: thread("C1", "2"),
      replyThreadTs: "2",
    })
  })
})

describe("replyTarget", () => {
  test("the freshly resolved target wins over the stored one", () => {
    // The regression: a message in thread 7 while the channel entry still says
    // thread 1 must reply to 7.
    expect(replyTarget("7", "1")).toBe("7")
  })

  test("falls back to the stored target only when nothing was resolved", () => {
    expect(replyTarget(undefined, "1")).toBe("1")
    expect(replyTarget(undefined, undefined)).toBeUndefined()
  })
})
