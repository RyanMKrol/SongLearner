// Everything the app remembers lives in localStorage, keyed by Spotify track ID.
import { useCallback, useEffect, useState } from 'react'
import type { HideLevel } from './mask'

/** 0 = not started, 1 = learning, 2 = almost, 3 = know it. */
export type Mastery = 0 | 1 | 2 | 3

export interface TrackPrefs {
  /** Positive values show the lyrics earlier. */
  offsetMs: number
  /** Custom section boundaries (line indices). Undefined means use the automatic split. */
  sectionStarts?: number[]
  /** Keyed by section start line. */
  sectionNames: Record<number, string>
  mastery: Record<number, Mastery>
  hide: Record<number, HideLevel>
}

export interface SavedLyrics {
  text: string
  synced: boolean
  instrumental?: boolean
  source: 'lrclib' | 'user'
  /** Human-readable description of where the lyrics came from. */
  label: string
  lrclibId?: number
}

export interface LibraryEntry {
  id: string
  uri: string
  name: string
  artists: string[]
  album: string
  imageUrl: string | null
  durationMs: number
  lastOpened: number
}

const PREFIX = 'songlearner:'

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(PREFIX + key)
    else localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    // Storage full or blocked. Practice still works, it just won't be remembered.
  }
}

export const defaultPrefs = (): TrackPrefs => ({
  offsetMs: 0,
  sectionNames: {},
  mastery: {},
  hide: {},
})

export function loadPrefs(trackId: string): TrackPrefs {
  return { ...defaultPrefs(), ...read<TrackPrefs>(`prefs:${trackId}`) }
}

export function savePrefs(trackId: string, prefs: TrackPrefs): void {
  write(`prefs:${trackId}`, prefs)
}

export function useTrackPrefs(trackId: string) {
  const [state, setState] = useState(() => ({ trackId, prefs: loadPrefs(trackId) }))
  // Switch to the new track's prefs during render rather than in an effect, to avoid a frame
  // where the old song's settings apply to the new one.
  const prefs = state.trackId === trackId ? state.prefs : loadPrefs(trackId)
  if (state.trackId !== trackId) setState({ trackId, prefs })

  const update = useCallback(
    (change: (prev: TrackPrefs) => TrackPrefs) => {
      setState((prev) => {
        const base = prev.trackId === trackId ? prev.prefs : loadPrefs(trackId)
        const next = change(base)
        savePrefs(trackId, next)
        return { trackId, prefs: next }
      })
    },
    [trackId],
  )
  return [prefs, update] as const
}

export function loadSavedLyrics(trackId: string): SavedLyrics | null {
  return read<SavedLyrics>(`lyrics:${trackId}`)
}

export function saveLyrics(trackId: string, lyrics: SavedLyrics | null): void {
  write(`lyrics:${trackId}`, lyrics)
}

export function loadLibrary(): LibraryEntry[] {
  return (read<LibraryEntry[]>('library') ?? []).sort((a, b) => b.lastOpened - a.lastOpened)
}

export function addToLibrary(entry: Omit<LibraryEntry, 'lastOpened'>): void {
  const others = loadLibrary().filter((e) => e.id !== entry.id)
  write('library', [{ ...entry, lastOpened: Date.now() }, ...others].slice(0, 200))
}

export function removeFromLibrary(trackId: string): void {
  write(
    'library',
    loadLibrary().filter((e) => e.id !== trackId),
  )
}

/** Fraction of sections marked as known, for the library overview. */
export function masterySummary(trackId: string): { known: number; total: number } | null {
  const prefs = read<TrackPrefs>(`prefs:${trackId}`)
  if (!prefs) return null
  const values = Object.values(prefs.mastery ?? {})
  if (values.length === 0) return null
  return { known: values.filter((v) => v === 3).length, total: values.length }
}

export function useLocalSetting<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => read<T>(`setting:${key}`) ?? initial)
  useEffect(() => write(`setting:${key}`, value), [key, value])
  return [value, setValue] as const
}
