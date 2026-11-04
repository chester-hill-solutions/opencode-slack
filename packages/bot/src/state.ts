import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/**
 * Tiny JSON-file store mapping Slack conversations to OpenCode sessions.
 *
 * The key is an opaque string built by the bot:
 *   - channels: "<channel>:<thread_ts>" (one session per thread)
 *   - DMs:      "<channel>:dm"          (one continuous session per DM)
 *
 * Layout on disk:
 *   { threads: { "C:1699.001": "ses_abc" },
 *     sessionThreads: { "ses_abc": "C:1699.001" } }
 *
 * Written atomically (tmp + rename) on every mutation. Fine at Slack-bot
 * write volumes; swap for SQLite if this ever gets hot.
 */
export class StateStore {
  private threads = new Map<string, string>() // key -> sessionID
  private sessionToKey = new Map<string, string>() // sessionID -> key

  constructor(private readonly path: string = defaultStatePath()) {
    this.load()
  }

  getByKey(key: string): string | undefined {
    return this.threads.get(key)
  }

  setByKey(key: string, sessionID: string): void {
    this.threads.set(key, sessionID)
    this.sessionToKey.set(sessionID, key)
    this.save()
  }

  removeByKey(key: string): void {
    const sessionID = this.threads.get(key)
    this.threads.delete(key)
    if (sessionID) this.sessionToKey.delete(sessionID)
    this.save()
  }

  /** Reverse lookup for the event stream: sessionID -> where its replies go. */
  getThread(sessionID: string): { channel: string; threadTs: string } | undefined {
    const key = this.sessionToKey.get(sessionID)
    if (!key) return undefined
    const idx = key.indexOf(":")
    return { channel: key.slice(0, idx), threadTs: key.slice(idx + 1) }
  }

  private load(): void {
    if (!existsSync(this.path)) return
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as {
        threads?: Record<string, string>
        sessionThreads?: Record<string, string>
      }
      for (const [key, sessionID] of Object.entries(raw.threads ?? {})) {
        this.threads.set(key, sessionID)
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
