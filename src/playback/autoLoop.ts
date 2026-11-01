// Sections can be set to loop a number of times. While the song plays normally, this decides when
// playback has just reached one of them, so the caller can start looping it. Pure logic, fed with
// playback positions, so it can be tested without a player.

export interface AutoLoopSpan {
  /** Song time. */
  startMs: number
  endMs: number
  /** Whether this section loops when playback reaches it. */
  loops: boolean
}

/** Only count arriving near a section's start; jumping into the middle of one doesn't loop it. */
const START_WINDOW_MS = 1500

export class AutoLoopWatcher {
  private spans: AutoLoopSpan[]
  private lastSection: number | null = null
  /** Sections you just stopped looping, left alone until playback moves away from them. */
  private suppressed: { from: number; to: number } | null = null

  constructor(spans: AutoLoopSpan[]) {
    this.spans = spans
  }

  setSpans(spans: AutoLoopSpan[]): void {
    this.spans = spans
  }

  /** Forget where playback was, e.g. while a loop was running. */
  reset(): void {
    this.lastSection = null
  }

  /** Don't start looping sections from..to again until playback has moved away from them. */
  suppress(from: number, to: number): void {
    this.suppressed = { from, to }
  }

  private sectionAt(positionMs: number): number | null {
    const i = this.spans.findIndex((s) => positionMs >= s.startMs && positionMs < s.endMs)
    return i === -1 ? null : i
  }

  /** The section to start looping now, if playback has just reached one that loops. */
  tick(positionMs: number): number | null {
    const section = this.sectionAt(positionMs)
    const arrived = section !== null && section !== this.lastSection
    this.lastSection = section

    if (this.suppressed) {
      const first = this.spans[this.suppressed.from]
      const last = this.spans[this.suppressed.to]
      // Moved on past them, or back well before them (further than any run-up).
      const away = !first || !last || positionMs >= last.endMs || positionMs < first.startMs - 6000
      if (!away) return null
      this.suppressed = null
    }

    if (!arrived || section === null) return null
    const span = this.spans[section]
    if (!span.loops || positionMs - span.startMs > START_WINDOW_MS) return null
    return section
  }
}
