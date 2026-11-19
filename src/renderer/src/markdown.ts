export interface InlineToken {
  type: "text" | "bold" | "code"
  text: string
}

export type MarkdownBlock =
  | { type: "heading"; level: number; tokens: InlineToken[] }
  | { type: "paragraph"; lines: InlineToken[][] }
  | { type: "list"; ordered: boolean; items: InlineToken[][] }
  | { type: "code"; text: string }

export function parseInlineTokens(raw: string): InlineToken[] {
  const tokens: InlineToken[] = []
  const pattern = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g
  let lastIndex = 0
  let match: RegExpExecArray | null = pattern.exec(raw)

  while (match) {
    if (match.index > lastIndex) {
      tokens.push({ type: "text", text: raw.slice(lastIndex, match.index) })
    }
    const piece = match[0]
    if (piece.startsWith("**") && piece.endsWith("**") && piece.length > 4) {
      tokens.push({ type: "bold", text: piece.slice(2, -2) })
    } else if (piece.startsWith("`") && piece.endsWith("`") && piece.length > 2) {
      tokens.push({ type: "code", text: piece.slice(1, -1) })
    } else {
      tokens.push({ type: "text", text: piece })
    }
    lastIndex = match.index + piece.length
    match = pattern.exec(raw)
  }

  if (lastIndex < raw.length) {
    tokens.push({ type: "text", text: raw.slice(lastIndex) })
  }
  return tokens.length ? tokens : [{ type: "text", text: raw }]
}

export function parseMarkdownBlocks(raw: string): MarkdownBlock[] {
  const lines = String(raw || "").replace(/\r\n?/g, "\n").split("\n")
  const blocks: MarkdownBlock[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    const trimmed = line.trim()

    if (!trimmed) {
      index += 1
      continue
    }

    if (trimmed.startsWith("```")) {
      const codeLines: string[] = []
      index += 1
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        codeLines.push(lines[index])
        index += 1
      }
      if (index < lines.length) {
        index += 1
      }
      blocks.push({ type: "code", text: codeLines.join("\n") })
      continue
    }

    const headingMatch = /^(#{1,3})\s+(.+)$/.exec(trimmed)
    if (headingMatch) {
      blocks.push({
        type: "heading",
        level: headingMatch[1].length,
        tokens: parseInlineTokens(headingMatch[2])
      })
      index += 1
      continue
    }

    const ulMatch = /^[-*•]\s+(.+)$/.exec(trimmed)
    if (ulMatch) {
      const items: InlineToken[][] = []
      while (index < lines.length) {
        const nextMatch = /^[-*•]\s+(.+)$/.exec(lines[index].trim())
        if (!nextMatch) {
          break
        }
        items.push(parseInlineTokens(nextMatch[1]))
        index += 1
      }
      blocks.push({ type: "list", ordered: false, items })
      continue
    }

    const olMatch = /^\d+\.\s+(.+)$/.exec(trimmed)
    if (olMatch) {
      const items: InlineToken[][] = []
      while (index < lines.length) {
        const nextMatch = /^\d+\.\s+(.+)$/.exec(lines[index].trim())
        if (!nextMatch) {
          break
        }
        items.push(parseInlineTokens(nextMatch[1]))
        index += 1
      }
      blocks.push({ type: "list", ordered: true, items })
      continue
    }

    const paraLines: InlineToken[][] = []
    while (index < lines.length) {
      const cur = lines[index].trim()
      if (!cur || cur.startsWith("```") || /^(?:#{1,3}|[-*•]|\d+\.)\s+/.test(cur)) {
        break
      }
      paraLines.push(parseInlineTokens(lines[index]))
      index += 1
    }
    blocks.push({ type: "paragraph", lines: paraLines })
  }

  return blocks
}
