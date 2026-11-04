/**
 * Which conversation a Slack message belongs to, and where its replies go.
 *
 * Split out of the bot entrypoint so the routing rules can be unit-tested:
 * the entrypoint builds the Slack/OpenCode clients at import time, which a
 * test cannot do.
 */

export interface ConversationInput {
  channel: string
  /** ts of the message being answered; threads root here. */
  ts: string
  /** thread_ts when the message is already inside a thread. */
  threadTs?: string
  isDm: boolean
  /** A mention: engage the whole channel, not just this thread. */
  engageChannel?: boolean
}

export interface ConversationEntry {
  /** Thread root replies should be posted under. Absent for DMs. */
  replyTs?: string
}

export interface ConversationKey {
  key: string
  replyThreadTs?: string
}

/**
 * Resolve the conversation key and reply thread for an incoming message.
 *
 * Rules, in order:
 * - DMs are one continuous conversation and are never threaded.
 * - A mention, or a message in an already-mapped thread, gets that thread's
 *   own conversation.
 * - An engaged channel shares one conversation across its messages.
 * - Anything else starts with the channel (or the thread it arrived in).
 *
 * The reply target is always **the thread the message arrived in**. Falling
 * back to the thread a channel was first engaged from is what used to post
 * replies into a thread the user was not looking at.
 */
export function conversationKey(
  input: ConversationInput,
  lookup: (key: string) => ConversationEntry | undefined,
): ConversationKey {
  if (input.isDm) return { key: `${input.channel}:dm` } // no threading in DMs

  const threadKey = input.threadTs ? `${input.channel}:${input.threadTs}` : undefined
  if (threadKey && (input.engageChannel || lookup(threadKey))) {
    return { key: threadKey, replyThreadTs: input.threadTs }
  }

  const channelKey = `${input.channel}:channel`
  const channelEntry = lookup(channelKey)
  if (channelEntry) {
    // A threaded message joins the engaged channel's conversation, but its
    // reply belongs in this thread, not in the one that engaged the channel.
    return { key: channelKey, replyThreadTs: input.threadTs ?? channelEntry.replyTs ?? input.ts }
  }

  if (threadKey) return { key: threadKey, replyThreadTs: input.threadTs }
  return { key: channelKey, replyThreadTs: input.ts }
}
