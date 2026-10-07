// The SDK only reports the playback position when something changes (play, pause, seek, track
// change) plus whenever we poll it. Between reports we extrapolate from the last known position.

export type Now = () => number

export class PlaybackClock {
  private basePositionMs = 0
  private baseAt = 0
  private playing = false
  private durationMs = 0
  private readonly now: Now

  constructor(now: Now = () => performance.now()) {
    this.now = now
  }

  /** Record a fresh position report from the player. */
  sync(positionMs: number, paused: boolean, durationMs?: number): void {
    this.basePositionMs = positionMs
    this.baseAt = this.now()
    this.playing = !paused
    if (durationMs !== undefined) this.durationMs = durationMs
  }

  /** Move the clock immediately after we ask the player to seek, so callers don't see stale time. */
  jumpTo(positionMs: number): void {
    this.basePositionMs = positionMs
    this.baseAt = this.now()
  }

  setPlaying(playing: boolean): void {
    if (playing === this.playing) return
    this.basePositionMs = this.position()
    this.baseAt = this.now()
    this.playing = playing
  }

  get isPlaying(): boolean {
    return this.playing
  }

  get duration(): number {
    return this.durationMs
  }

  position(): number {
    const elapsed = this.playing ? this.now() - this.baseAt : 0
    const pos = this.basePositionMs + elapsed
    const max = this.durationMs > 0 ? this.durationMs : Number.POSITIVE_INFINITY
    return Math.min(Math.max(pos, 0), max)
  }
}
