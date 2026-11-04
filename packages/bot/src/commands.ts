/**
 * Pure formatters for the `!model` and `!sessions` commands.
 *
 * Kept out of the entrypoint so the output shape and the index-or-id
 * resolution can be unit-tested without booting Slack or OpenCode.
 */

import { mrkdwnEscape } from "./slackText"

export interface ModelSummary {
  providerID: string
  id: string
  name?: string
  status?: string
  enabled?: boolean
}

export interface SessionSummary {
  id: string
  title?: string
  time?: { updated?: number }
  model?: { providerID: string; id: string; variant?: string }
}

/** `provider/model`, optionally with `#variant`. */
export function modelRef(model: { providerID: string; id: string; variant?: string }): string {
  return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`
}

/** "just now", "5m ago", "3h ago", "2d ago", or "" when the time is unknown. */
export function relativeTime(timestamp: number | undefined, now: number): string {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return ""
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000))
  if (seconds < 45) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

/**
 * Render the model switcher.
 *
 * Lists enabled models only, with the current one marked, and says how many
 * were left out rather than dumping a hundred lines into a thread.
 */
export function formatModelList(
  models: ModelSummary[],
  options: { current?: string; limit?: number } = {},
): string {
  const limit = options.limit ?? 25
  const usable = models.filter((model) => model.enabled !== false && model.status !== "deprecated")
  const shown = usable.slice(0, limit)
  const lines = [
    "*Models* — switch with `!model provider/model` (add `#variant` for a variant):",
    ...shown.map((model) => {
      const ref = `${model.providerID}/${model.id}`
      const name = model.name && model.name !== model.id ? ` — ${mrkdwnEscape(model.name)}` : ""
      const current = options.current === ref ? "  ← current" : ""
      return `• \`${ref}\`${name}${current}`
    }),
  ]
  if (usable.length > shown.length) {
    lines.push(`_…and ${usable.length - shown.length} more_`)
  }
  if (usable.length === 0) lines.push("_No enabled models reported by this OpenCode server._")
  return lines.join("\n")
}

/** Render the session switcher. Numbering matches what {@link resolveSessionChoice} accepts. */
export function formatSessionList(
  sessions: SessionSummary[],
  options: { now?: number; limit?: number; current?: string } = {},
): string {
  const now = options.now ?? Date.now()
  const limit = options.limit ?? 10
  const shown = sessions.slice(0, limit)
  if (shown.length === 0) return "_No sessions in this directory yet — send a message to start one._"
  const lines = [
    "*Recent sessions* — switch this conversation with `!sessions <number>` (or an id):",
    ...shown.map((session, index) => {
      const title = session.title ? mrkdwnEscape(session.title) : "_untitled_"
      const when = relativeTime(session.time?.updated, now)
      const model = session.model ? modelRef(session.model) : "default model"
      const current = options.current === session.id ? "  ← current" : ""
      const parts = [`\`${session.id}\``, when, `\`${model}\``].filter(Boolean).join(" · ")
      return `${index + 1}. *${title}* — ${parts}${current}`
    }),
  ]
  if (sessions.length > shown.length) lines.push(`_…and ${sessions.length - shown.length} more_`)
  return lines.join("\n")
}

export type SessionChoice =
  | { kind: "session"; session: SessionSummary }
  | { kind: "error"; message: string }

/** Accept a 1-based number from the rendered list, a full id, or an unambiguous id prefix. */
export function resolveSessionChoice(sessions: SessionSummary[], arg: string): SessionChoice {
  const raw = arg.trim()
  if (!raw) return { kind: "error", message: "Give a session number or id." }

  if (/^\d+$/.test(raw)) {
    const index = Number(raw) - 1
    const session = sessions[index]
    if (!session) {
      return { kind: "error", message: `There is no session ${raw} in the list — run \`!sessions\` again.` }
    }
    return { kind: "session", session }
  }

  const exact = sessions.find((session) => session.id === raw)
  if (exact) return { kind: "session", session: exact }

  const matches = sessions.filter((session) => session.id.startsWith(raw))
  if (matches.length === 1 && matches[0]) return { kind: "session", session: matches[0] }
  if (matches.length > 1) {
    return { kind: "error", message: `\`${raw}\` matches ${matches.length} sessions — use more of the id.` }
  }
  return { kind: "error", message: `No session matches \`${raw}\`.` }
}
