export interface PracticeSettings {
  /** Loop repetitions, or null to loop until stopped. */
  loopReps: number | null
  /** Repetitions of each step in a build-up drill. */
  buildReps: number
  /** In a build-up, practise each new section alone before joining it on. */
  soloFirst: boolean
  leadInMs: number
  gapMs: number
}

export const DEFAULT_PRACTICE_SETTINGS: PracticeSettings = {
  loopReps: null,
  buildReps: 2,
  soloFirst: false,
  leadInMs: 2000,
  gapMs: 0,
}
