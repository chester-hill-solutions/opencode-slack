import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/**
 * Tiny JSON-file store mapping Slack conversations to OpenCode sessions.
 *
 * Keys are opaque strings built by the bot:
 *   - channel engagement: "<channel>:channel"  (one session per channel, after a mention)
 *   - channel thread:     "<channel>:<thread_ts>" (one session per thread)
 *   - DM:                 "<channel>:dm"       (one continuous session per DM)
 *
 * Each entry records the session and, when the conversation lives in a
 * channel, the thread timestamp replies should be posted under.
 *
 * On disk:
 *   { threads: { "C:1699.001": { "sessionID": "ses_abc", "replyTs": "1699.001" } },
 *     sessionThreads: { "ses_abc": "C:1699.001" } }
 *
 * Written atomically (tmp + rename) on every mutation.
 */

export interface Entry {
  sessionID: string
  /** Thread root to post replies under. Absent for DMs (reply top-level). */
  replyTs?: string
}

export class StateStore {
  private threads = new Map<string, Entry>() // key -> entry
  private sessionToKey = new Map<string, string>() // sessionID -> key

  constructor(private readonly path: string = defaultStatePath()) {
    this.load()
  }

  getByKey(key: string): Entry | undefined {
    return this.threads.get(key)
  }

  setByKey(key: string, sessionID: string, replyTs?: string): void {
    const previous = this.threads.get(key)
    // Adopting a different session for this conversation (e.g. `!sessions 3`)
    // must drop the old session's reverse mapping, or a still-running old
    // session would post its reply into this thread.
    if (previous && previous.sessionID !== sessionID) this.sessionToKey.delete(previous.sessionID)
    this.threads.set(key, replyTs ? { sessionID, replyTs } : { sessionID })
    this.sessionToKey.set(sessionID, key)
    this.save()
  }

  removeByKey(key: string): void {
    const entry = this.threads.get(key)
    this.threads.delete(key)
    if (entry) this.sessionToKey.delete(entry.sessionID)
    this.save()
  }

  /** Reverse lookup for the event stream: sessionID -> where its replies go. */
  getThread(sessionID: string): { channel: string; replyTs?: string } | undefined {
    const key = this.sessionToKey.get(sessionID)
    if (!key) return undefined
    const entry = this.threads.get(key)
    if (!entry) return undefined
    const idx = key.indexOf(":")
    return { channel: key.slice(0, idx), ...(entry.replyTs ? { replyTs: entry.replyTs } : {}) }
  }

  private load(): void {
    if (!existsSync(this.path)) return
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as {
        threads?: Record<string, string | Entry>
        sessionThreads?: Record<string, string>
      }
      for (const [key, value] of Object.entries(raw.threads ?? {})) {
        // Older files stored the session id as a bare string; derive the reply
        // thread from the key (everything after the first colon, except the
        // "dm" and "channel" sentinels).
        if (typeof value === "string") {
          const suffix = key.slice(key.indexOf(":") + 1)
          const entry: Entry = suffix === "dm" || suffix === "channel" ? { sessionID: value } : { sessionID: value, replyTs: suffix }
          this.threads.set(key, entry)
        } else if (typeof value?.sessionID === "string") {
          this.threads.set(key, value)
        }
      }
      for (const [sessionID, key] of Object.entries(raw.sessionThreads ?? {})) {
        this.sessionToKey.set(sessionID, key)
      }
    } catch (err) {
      console.warn(`[opencode-slack-bot] could not read state file ${this.path}:`, err)
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const payload = JSON.stringify(
      {
        threads: Object.fromEntries(this.threads),
        sessionThreads: Object.fromEntries(this.sessionToKey),
      },
      null,
      2,
    )
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, payload)
    renameSync(tmp, this.path)
  }
}

function defaultStatePath(): string {
  if (process.env.OPENCODE_SLACK_STATE) return process.env.OPENCODE_SLACK_STATE
  const xdg = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
  return join(xdg, "opencode-slack", "state.json")
}
