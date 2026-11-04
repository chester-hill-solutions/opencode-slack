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

const STASH_OPEN = "\u0000"
const STASH_CLOSE = "\u0000"
const BOLD = "\u0001"
const RULE = "\u2500".repeat(20)

/**
 * Convert the model's Markdown into Slack mrkdwn.
 *
 * Slack's dialect is close enough to Markdown to look fine in a preview and
 * different enough to arrive as literal punctuation in the client:
 *
 * - `**bold**` / `__bold__` render with the asterisks showing (Slack bold is
 *   single `*`); `*italic*` needs to become `_italic_`.
 * - `# Heading` has no Slack equivalent, so headings are bolded.
 * - `- item` renders as a literal hyphen (Slack has no bullet syntax); task
 *   boxes `- [ ]` become ☐ / ☑.
 * - Pipe tables have no syntax at all and collapse into unreadable prose, so
 *   they are re-emitted inside a code block, where the pipes line up again.
 * - `[label](url)` needs `<url|label>`, and the angle brackets that form it must
 *   not be escaped by {@link mrkdwnEscape}.
 *
 * Fenced blocks, inline code and URLs are stashed before escaping so their
 * contents are passed through untouched.
 */
export function markdownToMrkdwn(markdown: string): string {
  const saved: string[] = []
  const stash = (slack: string): string => {
    saved.push(slack)
    return `${STASH_OPEN}${saved.length - 1}${STASH_CLOSE}`
  }
  // Nested stashes (inline code inside a link label) need more than one pass.
  const restore = (text: string): string => {
    let previous = ""
    let current = text
    while (current !== previous) {
      previous = current
      current = current.replace(/\u0000(\d+)\u0000/g, (_, index: string) => saved[Number(index)] ?? "")
    }
    return current
  }

  // 1. Fenced code blocks: verbatim, before anything else touches them.
  const lines = markdown.split("\n")
  const body: string[] = []
  let fence: string[] | null = null
  for (const line of lines) {
    if (fence) {
      if (/^\s*(```|~~~)\s*$/.test(line)) {
        body.push(stash(`\`\`\`\n${fence.join("\n")}\n\`\`\``))
        fence = null
      } else {
        fence.push(line)
      }
      continue
    }
    if (/^\s*(```|~~~)/.test(line)) {
      fence = []
      continue
    }
    body.push(line)
  }
  if (fence) body.push(stash(`\`\`\`\n${fence.join("\n")}\n\`\`\``))
  let text = body.join("\n")

  // 2. Pipe tables: also verbatim, and before escaping, so cells keep their
  //    original characters inside the code block.
  const tableRows: string[] = []
  const withoutTables: string[] = []
  const flushTable = () => {
    if (tableRows.length === 0) return
    withoutTables.push(stash(`\`\`\`\n${tableRows.join("\n")}\n\`\`\``))
    tableRows.length = 0
  }
  for (const line of text.split("\n")) {
    if (/^\s*\|.*\|\s*$/.test(line)) tableRows.push(line.trim())
    else {
      flushTable()
      withoutTables.push(line)
    }
  }
  flushTable()
  text = withoutTables.join("\n")

  // 3. Inline code and links, stashed so escaping cannot reach them.
  text = text.replace(/`([^`\n]+)`/g, (_match, code: string) => stash(`\`${code}\``))
  text = text.replace(/!?\[([^\]\n]*)\]\((<?)([^)\s>]+)\2\)/g, (_match, label: string, _bracket: string, url: string) =>
    stash(`<${url}|${mrkdwnEscape(label)}>`),
  )
  text = text.replace(/<(https?:\/\/[^>\s]+)>/g, (_match, url: string) => stash(`<${url}>`))

  // 4. Escape the prose that is left.
  text = mrkdwnEscape(text)

  // 5. Line-level structure.
  text = text
    .split("\n")
    .map((line) => {
      if (/^\s*$/.test(line)) return line
      // Blockquote markers were escaped above; restore the leading ones only.
      const quote = /^(\s*)((?:&gt;\s*)+)(.*)$/.exec(line)
      if (quote) return `${quote[1] ?? ""}${(quote[2] ?? "").replace(/&gt;/g, ">")}${quote[3] ?? ""}`
      if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) return RULE
      const heading = /^(\s*)#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)
      if (heading) return `${heading[1] ?? ""}${BOLD}${heading[2] ?? ""}${BOLD}`
      const task = /^(\s*(?:>\s*)*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line)
      if (task) return `${task[1] ?? ""}${(task[2] ?? "").toLowerCase() === "x" ? "☑" : "☐"} ${task[3] ?? ""}`
      const bullet = /^(\s*(?:>\s*)*)[-*+]\s+(.*)$/.exec(line)
      if (bullet) return `${bullet[1] ?? ""}• ${bullet[2] ?? ""}`
      return line
    })
    .join("\n")

  // 6. Inline emphasis, bold first so its markers are not read as italics.
  text = text
    .replace(/\*\*(?=\S)([^\n]*?)(?<=\S)\*\*/g, (_match, inner: string) => `${BOLD}${inner}${BOLD}`)
    .replace(/__(?=\S)([^\n]*?)(?<=\S)__/g, (_match, inner: string) => `${BOLD}${inner}${BOLD}`)
    .replace(/(?<![\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])/g, "_$1_")
    .replace(/~~(?=\S)([^~\n]*?)(?<=\S)~~/g, "~$1~")
    .replace(/\u0001/g, "*")

  return restore(text)
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

export interface SlackContextMessage {
  user?: string
  text?: string
  bot_id?: string
  ts?: string
  subtype?: string
}

/**
 * Render Slack messages as compact context for a prompt: newest messages that
 * fit the budget, bot messages and the message being answered excluded.
 */
export function formatSlackContext(
  messages: SlackContextMessage[],
  options: { botUserId: string; excludeTs?: string; maxChars?: number },
): string {
  const maxChars = options.maxChars ?? 3000
  const lines: string[] = []
  for (const message of messages) {
    if (!message.text) continue
    if (message.bot_id || message.subtype) continue
    if (message.user === options.botUserId) continue
    if (options.excludeTs && message.ts === options.excludeTs) continue
    const text = message.text.replace(/\s+/g, " ").trim().slice(0, 500)
    if (!text) continue
    lines.push(`${message.user ? `<@${message.user}>` : "someone"}: ${text}`)
  }
  // Keep the most recent lines that fit.
  const kept: string[] = []
  let used = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (used + line.length + 1 > maxChars) break
    kept.unshift(line)
    used += line.length + 1
  }
  return kept.join("\n")
}
