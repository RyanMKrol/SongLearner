// Works out how far the karaoke fill is from what you hear, from taps you make as each word starts.
//
// Matching every tap to its nearest word goes wrong when the fill is off by about as much as the gap
// between words: taps land nearer the wrong word. Instead this tries every shift in a range and
// keeps the one that lines up the most taps with word starts at once (a shift of one word only
// lines up a few by chance), then fine-tunes with the median of what's left.

/** Furthest the fill is assumed to be off. */
const SEARCH_MS = 1500
const STEP_MS = 10
/** A tap this close to a word start (after shifting) counts as hitting it. */
const HIT_MS = 120
/** Fewest taps that hit a word before the estimate is worth showing. */
export const MIN_HITS = 6

export interface Calibration {
  /** Add this to the lyric timing offset (positive shows the lyrics earlier). */
  deltaMs: number
  /** Taps that lined up with a word start. */
  hits: number
  taps: number
  /** How much the hits vary, as the middle half's spread (ms). Small means steady tapping. */
  spreadMs: number
}

function nearest(sorted: number[], t: number): number {
  let lo = 0
  let hi = sorted.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] < t) lo = mid + 1
    else hi = mid
  }
  const after = sorted[lo]
  const before = sorted[lo - 1]
  return before !== undefined && Math.abs(before - t) < Math.abs(after - t) ? before : after
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * `taps` and `wordStarts` are in lyric time (song position plus the current offset). Returns null
 * until enough taps line up with words.
 */
export function estimateOffset(taps: number[], wordStarts: number[]): Calibration | null {
  if (taps.length === 0 || wordStarts.length === 0) return null
  const starts = [...wordStarts].sort((a, b) => a - b)

  // Cost of a shift: each tap's distance to its nearest word start, capped so a stray tap can't
  // dominate. Ties go to the smaller shift.
  let best = { shift: 0, cost: Number.POSITIVE_INFINITY }
  for (let shift = -SEARCH_MS; shift <= SEARCH_MS; shift += STEP_MS) {
    let cost = 0
    for (const t of taps) cost += Math.min(Math.abs(nearest(starts, t + shift) - (t + shift)), HIT_MS * 2)
    if (cost < best.cost - 1e-9 || (Math.abs(cost - best.cost) < 1e-9 && Math.abs(shift) < Math.abs(best.shift))) {
      best = { shift, cost }
    }
  }

  const residuals = taps
    .map((t) => nearest(starts, t + best.shift) - (t + best.shift))
    .filter((r) => Math.abs(r) <= HIT_MS)
  if (residuals.length < MIN_HITS) return null
  const deltas = residuals.map((r) => r + best.shift).sort((a, b) => a - b)
  const q = (p: number) => deltas[Math.min(deltas.length - 1, Math.floor(p * deltas.length))]
  return {
    deltaMs: Math.round(median(deltas) / 10) * 10,
    hits: residuals.length,
    taps: taps.length,
    spreadMs: Math.round(q(0.75) - q(0.25)),
  }
}
