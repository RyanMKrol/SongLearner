// Parses LRC ("[mm:ss.xx] line") and plain lyrics into one line model.

export interface LyricLine {
  /** Lyric time in ms, or null for untimed (plain) lyrics. */
  timeMs: number | null
  text: string
  /** True when a blank line (a stanza break) came right before this line in the source. */
  stanzaBreakBefore: boolean
}

export interface Lyrics {
  synced: boolean
  lines: LyricLine[]
}

const LEADING_TIME_TAG = /^\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/
const META_TAG = /^\[([a-z]+):(.*)\]\s*$/i
const WORD_TAG = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g

function toMs(minutes: string, seconds: string): number {
  return Math.round((Number(minutes) * 60 + Number(seconds.replace(':', '.'))) * 1000)
}

export function looksLikeLrc(text: string): boolean {
  return /^\s*\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/m.test(text)
}

export function parseLrc(text: string): Lyrics {
  const entries: { timeMs: number; text: string; order: number; breakBefore: boolean }[] = []
  let offsetMs = 0
  let pendingBreak = false
  let order = 0

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) {
      if (entries.length > 0) pendingBreak = true
      continue
    }

    const times: number[] = []
    let match: RegExpExecArray | null
    let rest = line
    // Timestamps sit at the start of the line, possibly several in a row.
    while ((match = LEADING_TIME_TAG.exec(rest))) {
      times.push(toMs(match[1], match[2]))
      rest = rest.slice(match[0].length).trimStart()
    }

    if (times.length === 0) {
      const meta = META_TAG.exec(line)
      if (meta && meta[1].toLowerCase() === 'offset') offsetMs = Number(meta[2]) || 0
      continue
    }

    const lyric = rest.replace(WORD_TAG, '').replace(/\s+/g, ' ').trim()
    for (const t of times) {
      entries.push({ timeMs: t, text: lyric, order: order++, breakBefore: pendingBreak })
    }
    pendingBreak = false
  }

  // A positive [offset:] tag means the lyrics should show earlier.
  entries.sort((a, b) => a.timeMs - b.timeMs || a.order - b.order)
  return {
    synced: true,
    lines: entries.map((e) => ({
      timeMs: Math.max(0, e.timeMs - offsetMs),
      text: e.text,
      stanzaBreakBefore: e.breakBefore,
    })),
  }
}

export function parsePlain(text: string): Lyrics {
  const lines: LyricLine[] = []
  let pendingBreak = false
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) {
      if (lines.length > 0) pendingBreak = true
      continue
    }
    lines.push({ timeMs: null, text: line, stanzaBreakBefore: pendingBreak })
    pendingBreak = false
  }
  return { synced: false, lines }
}

export function parseLyrics(text: string): Lyrics {
  return looksLikeLrc(text) ? parseLrc(text) : parsePlain(text)
}

function formatTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 10))
  const minutes = Math.floor(total / 6000)
  const seconds = Math.floor((total % 6000) / 100)
  const hundredths = total % 100
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(minutes)}:${pad(seconds)}.${pad(hundredths)}`
}

/** Serialises timed lines back to LRC, keeping stanza breaks as blank lines. */
export function toLrc(lines: { timeMs: number; text: string; stanzaBreakBefore: boolean }[]): string {
  const out: string[] = []
  lines.forEach((line, i) => {
    if (i > 0 && line.stanzaBreakBefore) out.push('')
    out.push(`[${formatTime(line.timeMs)}] ${line.text}`)
  })
  return out.join('\n')
}

/** Index of the line being sung at `timeMs`, or -1 before the first line. */
export function lineIndexAt(lines: LyricLine[], timeMs: number): number {
  let lo = 0
  let hi = lines.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const t = lines[mid].timeMs
    if (t !== null && t <= timeMs) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

/**
 * Copies lines `fromLine`..`toLine` to the end of the lyrics, with the first copy at `atMs` and the
 * same spacing as the original. For songs whose lyric file stops before the singing does, which
 * usually means an outro that repeats an earlier part. Returns the new LRC, or null if the lyrics
 * aren't timed or `atMs` isn't after the last line.
 */
export function appendRepeat(lines: LyricLine[], fromLine: number, toLine: number, atMs: number): string | null {
  if (lines.some((l) => l.timeMs === null)) return null
  const timed = lines as (LyricLine & { timeMs: number })[]
  const last = timed.at(-1)?.timeMs ?? 0
  const base = timed[fromLine]?.timeMs
  if (base === undefined || atMs <= last) return null
  const copies = timed.slice(fromLine, toLine + 1).map((line, i) => ({
    timeMs: Math.round(atMs + (line.timeMs - base)),
    text: line.text,
    stanzaBreakBefore: i === 0,
  }))
  return toLrc([...timed, ...copies])
}
