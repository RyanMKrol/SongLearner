// Splits lyrics into practice sections (roughly verses and choruses) and works out their timing.
// Spotify no longer exposes song structure to new apps, so this is all derived from the lyrics.
import type { LyricLine } from './lrc'

export interface Section {
  index: number
  /** First line of the section (an index into lyrics.lines). Also the section's storage key. */
  startLine: number
  /** Last sung line of the section, inclusive. */
  endLine: number
  name: string
  /** Sections whose lyrics repeat elsewhere in the song share a letter (A, B, ...). */
  repeatGroup: string | null
}

export interface SectionTiming {
  startMs: number
  endMs: number
}

const MAX_LINES = 10
const TARGET_LINES = 8

/** Lines with no letters or digits ("", "♪", "...") mark instrumental breaks. */
export function isSung(line: LyricLine): boolean {
  return /[\p{L}\p{N}]/u.test(line.text)
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function sungIndices(lines: LyricLine[]): number[] {
  return lines.flatMap((line, i) => (isSung(line) ? [i] : []))
}

/** Typical time between the starts of consecutive sung lines. */
export function medianLineInterval(lines: LyricLine[]): number {
  const sung = sungIndices(lines).filter((i) => lines[i].timeMs !== null)
  const gaps: number[] = []
  for (let k = 1; k < sung.length; k++) {
    gaps.push((lines[sung[k]].timeMs as number) - (lines[sung[k - 1]].timeMs as number))
  }
  return median(gaps)
}

/** Default section boundaries: stanza breaks, instrumental gaps, and splitting of long blocks. */
export function autoSectionStarts(lines: LyricLine[]): number[] {
  const sung = sungIndices(lines)
  if (sung.length === 0) return []

  const hasStanzas = lines.some((line, i) => i > 0 && line.stanzaBreakBefore)
  const synced = lines.some((line) => line.timeMs !== null)
  const gapLimit = Math.max(5000, medianLineInterval(lines) * 2.2)

  const groups: number[][] = [[sung[0]]]
  for (let k = 1; k < sung.length; k++) {
    const prev = sung[k - 1]
    const cur = sung[k]
    let breakHere = false
    for (let j = prev + 1; j <= cur; j++) {
      if (lines[j].stanzaBreakBefore || !isSung(lines[j])) breakHere = true
    }
    if (!hasStanzas && synced) {
      const gap = (lines[cur].timeMs ?? 0) - (lines[prev].timeMs ?? 0)
      if (gap > gapLimit) breakHere = true
    }
    if (breakHere) groups.push([cur])
    else groups[groups.length - 1].push(cur)
  }

  // Long blocks are hard to learn in one go, so split them into even chunks.
  const split = groups.flatMap((group) => {
    if (group.length <= MAX_LINES) return [group]
    const chunks = Math.ceil(group.length / TARGET_LINES)
    const size = Math.ceil(group.length / chunks)
    const out: number[][] = []
    for (let i = 0; i < group.length; i += size) out.push(group.slice(i, i + size))
    return out
  })

  // A lone line ("Yeah!") isn't worth its own section: fold it into its neighbour.
  const merged: number[][] = []
  for (let i = 0; i < split.length; i++) {
    const group = split[i]
    if (group.length === 1 && i + 1 < split.length) {
      split[i + 1] = [...group, ...split[i + 1]]
    } else if (group.length === 1 && merged.length > 0) {
      merged[merged.length - 1].push(...group)
    } else {
      merged.push(group)
    }
  }
  return merged.map((group) => group[0])
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [])
}

function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const w of a) if (b.has(w)) shared++
  return shared / (a.size + b.size - shared)
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
}

export function buildSections(
  lines: LyricLine[],
  starts: number[],
  names: Record<number, string> = {},
): Section[] {
  const sung = sungIndices(lines)
  if (sung.length === 0) return []

  const valid = [...new Set(starts)].filter((i) => i >= 0 && i < lines.length && isSung(lines[i]))
  if (!valid.includes(sung[0])) valid.push(sung[0])
  valid.sort((a, b) => a - b)

  const sections: Section[] = valid.map((startLine, index) => {
    const limit = index + 1 < valid.length ? valid[index + 1] - 1 : lines.length - 1
    let endLine = limit
    while (endLine > startLine && !isSung(lines[endLine])) endLine--
    return {
      index,
      startLine,
      endLine,
      name: names[startLine] ?? truncate(lines[startLine].text, 34),
      repeatGroup: null,
    }
  })

  // Spot repeated parts (usually the chorus) so the song's shape is visible at a glance.
  const wordSets = sections.map((s) =>
    words(
      lines
        .slice(s.startLine, s.endLine + 1)
        .map((l) => l.text)
        .join(' '),
    ),
  )
  const groupOf: number[] = sections.map((_, i) => i)
  for (let i = 0; i < sections.length; i++) {
    for (let j = 0; j < i; j++) {
      if (groupOf[j] === j && similarity(wordSets[i], wordSets[j]) >= 0.6) {
        groupOf[i] = j
        break
      }
    }
  }
  const counts = new Map<number, number>()
  groupOf.forEach((g) => counts.set(g, (counts.get(g) ?? 0) + 1))
  const letters = new Map<number, string>()
  groupOf.forEach((g, i) => {
    if ((counts.get(g) ?? 0) < 2) return
    if (!letters.has(g)) letters.set(g, String.fromCharCode(65 + letters.size))
    sections[i].repeatGroup = letters.get(g) ?? null
  })

  return sections
}

/**
 * Start and end of each section in lyric time. A section ends when the next line starts, but
 * never more than a few line-lengths after its last line, so loops skip long instrumentals.
 */
export function sectionTimings(
  sections: Section[],
  lines: LyricLine[],
  durationMs: number,
): (SectionTiming | null)[] {
  const cap = Math.min(9000, Math.max(4000, medianLineInterval(lines) * 2.5))
  return sections.map((section) => {
    const start = lines[section.startLine]?.timeMs
    const lastStart = lines[section.endLine]?.timeMs
    if (start === null || start === undefined || lastStart === null || lastStart === undefined) {
      return null
    }
    let next: number | null = null
    for (let i = section.endLine + 1; i < lines.length; i++) {
      const t = lines[i].timeMs
      if (t !== null && t > lastStart) {
        next = t
        break
      }
    }
    const natural = next ?? (durationMs > 0 ? durationMs : lastStart + cap)
    return { startMs: start, endMs: Math.min(natural, lastStart + cap) }
  })
}
