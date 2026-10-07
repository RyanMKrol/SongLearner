// Where you were in each song, so going back to one resumes there. Kept for this browser tab
// (it survives a refresh, but not closing the tab).
const KEY = 'songlearner:positions'

function readAll(): Record<string, number> {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? '{}') as Record<string, number>
  } catch {
    return {}
  }
}

export function rememberPosition(trackId: string, positionMs: number): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ ...readAll(), [trackId]: Math.round(positionMs) }))
  } catch {
    // Not remembered; the song just starts from the top next time.
  }
}

export function lastPosition(trackId: string): number {
  return readAll()[trackId] ?? 0
}
