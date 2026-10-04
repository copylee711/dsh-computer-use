/**
 * Split text for streamed entry: paste block by block so the user watches it
 * appear, while each block still goes in literally (typing Markdown key by key
 * into Typora / Obsidian / Word trips their auto-formatting).
 *
 * Blocks end after a blank-line separator, never inside a ``` / ~~~ fence and
 * never inside a paragraph (a half-pasted **bold** or link may not re-render).
 * Text with no blank line at all (a story written one paragraph per line) is
 * split at its line ends instead, or it would go in as a single block; a table
 * keeps its rows together. Joining the blocks gives back the original text exactly.
 */
export function splitBlocks(text: string, minChars = 80): string[] {
  const lines = text.split(/(?<=\n)/) // keep each line's newline
  // One paragraph per line: every line end is a paragraph end.
  const byLine = !/\n[ \t]*\r?\n/.test(text) && !/^\s*(```|~~~|\|)/m.test(text)
  const blocks: string[] = []
  let current = ''
  let fence: string | undefined
  let previousBlank = false
  for (const line of lines) {
    const bare = line.replace(/\r?\n$/, '')
    const marker = /^\s*(```+|~~~+)/.exec(bare)?.[1]
    if (marker !== undefined) {
      if (fence === undefined) fence = marker[0]!.repeat(marker.length)
      else if (marker.startsWith(fence)) fence = undefined
    }
    const blank = bare.trim() === ''
    // A non-blank line after blank ones starts a new block (outside fences).
    if (fence === undefined && !blank && (previousBlank || (byLine && current !== '')) && current.length >= minChars) {
      blocks.push(current)
      current = ''
    }
    current += line
    if (marker === undefined || fence !== undefined) previousBlank = blank && fence === undefined
    else previousBlank = false
  }
  if (current !== '') blocks.push(current)
  return blocks
}

/** Pieces of at most ~`size` characters, broken after whitespace where possible (for paced typing). */
export function typingPieces(text: string, size = 60): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > size) {
    let cut = Math.max(rest.lastIndexOf(' ', size), rest.lastIndexOf('\n', size))
    if (cut < size / 2) cut = size
    else cut += 1
    // Never split a surrogate pair.
    if (/[\uD800-\uDBFF]/.test(rest[cut - 1] ?? '')) cut += 1
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest !== '') out.push(rest)
  return out
}
