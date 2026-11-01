export interface PracticeSettings {
  /** Sections set to loop do so by themselves when the song reaches them. Off for a full run-through. */
  autoLoop: boolean
  /** Repetitions of each step in a build-up drill. */
  buildReps: number
  /** In a build-up, practise each new section alone before joining it on. */
  soloFirst: boolean
  leadInMs: number
  gapMs: number
  /** Loops it takes a "fade" section to hide every letter. */
  fadeLoops: number
}

export const DEFAULT_PRACTICE_SETTINGS: PracticeSettings = {
  autoLoop: true,
  buildReps: 2,
  soloFirst: false,
  leadInMs: 2000,
  gapMs: 0,
  fadeLoops: 5,
}
