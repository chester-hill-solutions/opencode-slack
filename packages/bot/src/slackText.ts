const LIMIT = 3900

/** Split text into Slack-sized chunks, preferring newline boundaries. */
export function chunkText(text: string, limit: number = LIMIT): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n", limit)
    if (cut < limit / 2) cut = remaining.lastIndexOf(" ", limit)
    if (cut < limit / 2) cut = limit
    chunks.push(remaining.slice(0, cut))
    remaining = remaining.slice(cut).trimStart()
  }
  if (remaining.length > 0) chunks.push(remaining)
  return chunks
}

/** Escape the three characters Slack mrkdwn treats specially. */
export function mrkdwnEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** One-line progress check-in for a running session. */
export function formatCheckin(steps: number, elapsedMs: number, tool?: string): string {
  const seconds = Math.max(0, Math.round(elapsedMs / 1000))
  const elapsed =
    seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`
  const parts = [`⏳ OpenCode working — ${steps} step${steps === 1 ? "" : "s"}`, elapsed]
  if (tool) parts.push(`last tool: \`${tool}\``)
  return parts.join(" · ")
}
