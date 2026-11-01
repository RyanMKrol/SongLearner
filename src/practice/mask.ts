// Memorise mode: hide parts of each word so you have to recall them.

/**
 * How a section's words are shown: 0 = everything, 1 = first letter of each word, 2 = nothing,
 * 3 = fade (all words at first, then more of each word hidden on every loop).
 */
export type HideLevel = 0 | 1 | 2 | 3

/**
 * What's hidden on a line right now. Fade sections turn into `{ fade }` while looping: the share
 * of each word hidden, from the end of the word. Outside a loop they show everything.
 */
export type Mask = 0 | 1 | 2 | { fade: number }

export interface TextSegment {
  text: string
  masked: boolean
}

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu

/** Share of each word a fade section hides after `loops` passes, all of it after `fadeLoops`. */
export function fadeMask(loops: number, fadeLoops: number): Mask {
  const share = Math.min(1, loops / Math.max(1, fadeLoops))
  return share > 0 ? { fade: share } : 0
}

/** How many letters at the start of a word stay visible. */
function shownLetters(letters: number, mask: Exclude<Mask, 0>): number {
  if (mask === 1) return 1
  if (mask === 2) return 0
  return letters - Math.round(letters * mask.fade)
}

export function maskText(text: string, mask: Mask): TextSegment[] {
  if (mask === 0) return [{ text, masked: false }]
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
    const letters = [...match[0]]
    const shown = shownLetters(letters.length, mask)
    push(letters.slice(0, shown).join(''), false)
    push(letters.slice(shown).join(''), true)
    cursor = start + match[0].length
  }
  push(text.slice(cursor), false)
  return out
}
