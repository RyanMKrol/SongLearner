// Decides when to jump back during practice. Pure logic: the caller feeds it the playback position
// and carries out the seeks it asks for, which keeps it easy to test.

export interface PracticeStep {
  /** Indices of the first and last section in this step. */
  fromSection: number
  toSection: number
  /** Song time (already adjusted for the lyric offset). */
  startMs: number
  endMs: number
  /** How many times to play this step, or null to repeat until stopped. */
  reps: number | null
}

export interface LoopOptions {
  /** How far before the step's first line playback restarts, so you hear the run-up. */
  leadInMs: number
  /** Silence between repetitions. */
  gapMs: number
}

export type LoopAction =
  | { type: 'none' }
  | { type: 'seek'; positionMs: number; pauseMs: number }
  | { type: 'finished' }

export interface LoopStatus {
  stepIndex: number
  stepCount: number
  /** 1-based repetition currently playing. */
  rep: number
  reps: number | null
  step: PracticeStep
}

/** Ignore position reports for a moment after a seek; the SDK can still report the old position. */
const SEEK_SETTLE_MS = 600

export class LoopController {
  private stepIndex = 0
  private completedReps = 0
  private settleUntil = 0
  readonly steps: PracticeStep[]
  readonly options: LoopOptions

  constructor(steps: PracticeStep[], options: LoopOptions) {
    if (steps.length === 0) throw new Error('A practice plan needs at least one step')
    this.steps = steps
    this.options = options
  }

  get status(): LoopStatus {
    const step = this.steps[this.stepIndex]
    return {
      stepIndex: this.stepIndex,
      stepCount: this.steps.length,
      rep: this.completedReps + 1,
      reps: step.reps,
      step,
    }
  }

  private restartPoint(): number {
    return Math.max(0, this.steps[this.stepIndex].startMs - this.options.leadInMs)
  }

  /** Where to seek to begin practising. */
  start(now: number): LoopAction {
    this.stepIndex = 0
    this.completedReps = 0
    this.settleUntil = now + SEEK_SETTLE_MS
    return { type: 'seek', positionMs: this.restartPoint(), pauseMs: 0 }
  }

  tick(positionMs: number, now: number): LoopAction {
    if (now < this.settleUntil) return { type: 'none' }
    const step = this.steps[this.stepIndex]
    if (positionMs < step.endMs) return { type: 'none' }

    this.completedReps++
    if (step.reps !== null && this.completedReps >= step.reps) {
      this.stepIndex++
      this.completedReps = 0
      if (this.stepIndex >= this.steps.length) {
        this.stepIndex = this.steps.length - 1
        return { type: 'finished' }
      }
    }
    this.settleUntil = now + SEEK_SETTLE_MS + this.options.gapMs
    return { type: 'seek', positionMs: this.restartPoint(), pauseMs: this.options.gapMs }
  }
}

export interface SectionSpan {
  startMs: number
  endMs: number
}

function span(timings: SectionSpan[], from: number, to: number) {
  return { startMs: timings[from].startMs, endMs: timings[to].endMs }
}

/** Loop sections `from`..`to` as one block. */
export function chainPlan(
  timings: SectionSpan[],
  from: number,
  to: number,
  reps: number | null,
): PracticeStep[] {
  return [{ fromSection: from, toSection: to, ...span(timings, from, to), reps }]
}

/**
 * Cumulative drill: A, then A+B, then A+B+C... With `soloFirst`, each new section is practised
 * on its own before it's joined on: A, B, A+B, C, A+B+C...
 */
export function buildUpPlan(
  timings: SectionSpan[],
  from: number,
  to: number,
  reps: number,
  soloFirst: boolean,
): PracticeStep[] {
  const steps: PracticeStep[] = []
  for (let end = from; end <= to; end++) {
    if (soloFirst && end > from) {
      steps.push({ fromSection: end, toSection: end, ...span(timings, end, end), reps })
    }
    steps.push({ fromSection: from, toSection: end, ...span(timings, from, end), reps })
  }
  return steps
}
