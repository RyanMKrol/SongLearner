// When to count in to the next sung line (see components/LeadIn.tsx).

/** When lines start and end, in lyric time, for counting in after a pause. */
export interface LeadInTiming {
  now: () => number
  /** When line `i` starts being sung: its first word if the words are timed, otherwise its LRC time. */
  start: (i: number) => number | null
  /** When line `i` has finished being sung (or a rough guess without word timings). */
  end: (i: number) => number | null
}

/**
 * Where to count in to line `target` from, given the line being sung now (-1 before the first).
 * During an intro or a gap line it's straight away; after a sung line it's once that line has ended.
 */
export function leadInFor(
  timing: LeadInTiming,
  currentLine: number,
  currentIsSung: boolean,
  target: number,
): { waitFromMs: number; startMs: number } | null {
  const startMs = timing.start(target)
  if (startMs === null) return null
  if (currentLine < 0 || !currentIsSung) return { waitFromMs: Number.NEGATIVE_INFINITY, startMs }
  const end = timing.end(currentLine)
  return end === null ? null : { waitFromMs: end, startMs }
}
