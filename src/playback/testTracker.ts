// Test mode: decides when a section has been sung through without help. Pure logic, fed with
// playback positions, so it can be tested without a player.

export interface TestSpan {
  /** Song time. */
  startMs: number
  endMs: number
}

export type TestEvent =
  | { type: 'passed'; section: number }
  | { type: 'started'; section: number }
  | { type: 'cancelled'; section: number; reason: 'paused' | 'seeked' | 'peeked' | 'left section' | 'sections changed' }

/** A section only counts if you were there from (nearly) its first line. */
const START_WINDOW_MS = 1500
/** Position reports further than this from where playback should be mean someone seeked. */
const JUMP_TOLERANCE_MS = 1200
/** Treat a section as finished slightly before its end, since positions arrive in steps. */
const END_SLACK_MS = 250

export class TestTracker {
  private spans: TestSpan[]
  private attempt: number | null = null
  private lastPosition: number | null = null
  private lastAt = 0
  /** Furthest position heard while peeking; sections starting at or before it can't count. */
  private peekedAt = Number.NEGATIVE_INFINITY

  constructor(spans: TestSpan[]) {
    this.spans = spans
  }

  /** The section currently being tested, if any. */
  get current(): number | null {
    return this.attempt
  }

  setSpans(spans: TestSpan[]): TestEvent[] {
    this.spans = spans
    return this.cancel('sections changed')
  }

  /** Peeking at the words, or anything else that means the attempt doesn't count. */
  interrupt(): TestEvent[] {
    return this.cancel('peeked')
  }

  private cancel(reason: Extract<TestEvent, { type: 'cancelled' }>['reason']): TestEvent[] {
    if (this.attempt === null) return []
    const section = this.attempt
    this.attempt = null
    return [{ type: 'cancelled', section, reason }]
  }

  /** `peeking` is true while the words are being shown; nothing counts until it ends. */
  tick(positionMs: number, playing: boolean, now: number, peeking = false): TestEvent[] {
    const events: TestEvent[] = []
    const last = this.lastPosition
    const expected = last === null ? positionMs : last + (now - this.lastAt)
    this.lastPosition = positionMs
    this.lastAt = now

    if (peeking) {
      this.peekedAt = Math.max(this.peekedAt, positionMs)
      return this.cancel('peeked')
    }

    if (!playing) {
      // Pausing mid-section means you stopped to think: that attempt is over.
      // (The position is kept, so resuming doesn't look like a jump.)
      return this.cancel('paused')
    }
    if (last !== null && Math.abs(positionMs - expected) > JUMP_TOLERANCE_MS) {
      events.push(...this.cancel('seeked'))
      // Jumping somewhere (e.g. back to retry a section) clears the peek.
      this.peekedAt = Number.NEGATIVE_INFINITY
    }

    if (this.attempt !== null) {
      const span = this.spans[this.attempt]
      if (!span || positionMs < span.startMs - JUMP_TOLERANCE_MS) {
        events.push(...this.cancel('left section'))
      } else if (positionMs >= span.endMs - END_SLACK_MS) {
        events.push({ type: 'passed', section: this.attempt })
        this.attempt = null
      }
    }

    if (this.attempt === null) {
      const index = this.spans.findIndex(
        (s) =>
          s.startMs > this.peekedAt &&
          positionMs >= s.startMs &&
          positionMs < s.startMs + START_WINDOW_MS &&
          positionMs < s.endMs - END_SLACK_MS,
      )
      if (index >= 0) {
        this.attempt = index
        events.push({ type: 'started', section: index })
      }
    }
    return events
  }
}
