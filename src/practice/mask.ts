// Memorise mode: hide parts of each word so you have to recall them.

/** 0 = show everything, 1 = first letter of each word, 2 = hide all words. */
export type HideLevel = 0 | 1 | 2

export interface TextSegment {
  text: string
  masked: boolean
}

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu

export function maskText(text: string, level: HideLevel): TextSegment[] {
  if (level === 0) return [{ text, masked: false }]
  const out: TextSegment[] = []
  const push = (part: string, masked: boolean) => {
    if (!part) return
    const last = out[out.length - 1]
    if (last && last.masked === masked) last.text += part
    else out.push({ text: part, masked })
  }

  let cursor = 0
  for (const match of text.matchAll(WORD)) {
    const start = match.index ?? 0
    push(text.slice(cursor, start), false)
    const word = match[0]
    if (level === 1) {
      const first = [...word][0]
      push(first, false)
      push(word.slice(first.length), true)
    } else {
      push(word, true)
    }
    cursor = start + word.length
  }
  push(text.slice(cursor), false)
  return out
}
