// Who's in the karaoke set: songs join by being fully learned, and you can overrule that by hand.
import type { TrackPrefs } from './storage'

type SetPrefs = Pick<TrackPrefs, 'progress' | 'karaokeChoice'>

/** Every section of the song is learned. */
export function isFullyLearned(prefs: SetPrefs | null): boolean {
  const progress = prefs?.progress
  return Boolean(progress?.completedAt) && progress!.sections > 0 && progress!.learned >= progress!.sections
}

/** When the song joined the karaoke set, or null if it isn't in it. */
export function karaokeJoinedAt(prefs: SetPrefs | null): number | null {
  if (prefs?.karaokeChoice === null) return null
  if (prefs?.karaokeChoice !== undefined) return prefs.karaokeChoice
  return isFullyLearned(prefs) ? prefs!.progress!.completedAt! : null
}

/**
 * The choice to save when you add a song or take it out. It stays automatic when that already gives
 * the right answer, so a song you take out before learning it still joins once it's learned.
 */
export function karaokeChoiceFor(prefs: SetPrefs, join: boolean, now: number): TrackPrefs['karaokeChoice'] {
  if (join) return isFullyLearned(prefs) ? undefined : now
  return isFullyLearned(prefs) ? null : undefined
}
