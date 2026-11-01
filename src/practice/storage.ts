// Everything the app remembers lives in localStorage, keyed by Spotify track ID.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { changedKeys, log, logDebug, logWarn } from '../log'
import type { WordTiming } from '../lyrics/wordAlign'
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
  /** How many times to loop a section, or null for forever. Keyed by start line, or "from-to" start lines for a run. */
  loopReps?: Record<string, number | null>
  /** Romaji corrections for this song: original word → how it's sung. */
  readings?: Record<string, string>
  /** Claude's check of how a Japanese song is sung. */
  aiReview?: AiReview
  /** Section counts, kept up to date by the song screen so lists can show progress. */
  progress?: SongProgress
  /** Results of karaoke sets this song was part of, oldest first. */
  rehearsals?: Rehearsal[]
  /** When each word is sung, for the karaoke fill (see lyrics/wordAlign.ts). */
  wordTiming?: WordTiming
}

export interface SongProgress {
  sections: number
  learned: number
  /** When every section was first learned; cleared if one is marked not learned again. */
  completedAt?: number
}

export interface Rehearsal {
  at: number
  /** Sections sung through without help in this run. */
  passed: number
  total: number
}

export interface AiReview {
  /** Fingerprint of the lyrics that were checked. */
  lyricsKey: string
  reviewedAt: number
  model: string
  notes: string
  suggestions: {
    source: string
    reading: string
    confidence: 'high' | 'medium' | 'low'
    reason: string
    /** Whether the suggestion is used in the romaji. Low-confidence ones start off. */
    applied: boolean
  }[]
}

export interface SavedLyrics {
  text: string
  synced: boolean
  instrumental?: boolean
  source: 'lrclib' | 'user'
  /** Human-readable description of where the lyrics came from. */
  label: string
  lrclibId?: number
  /** Lines from this index on were added by you at the end (see EndOfLyrics). */
  addedFromLine?: number
  /** Set once the LRCLIB entry has been checked to really be this song. */
  verified?: boolean
  /** You've changed the words of at least one line. */
  edited?: boolean
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
const STORE_URL = '/api/store'
/** Keys whose latest value hasn't been confirmed on disk yet (survives a reload). */
const UNSYNCED_KEY = `${PREFIX}unsynced`
/** What's kept on disk. The Spotify login and other per-tab state stay in the browser. */
const PERSISTED = /^(prefs:|lyrics:|library$|playlists$|setting:)/

// Everything is held in memory, loaded from disk at startup (see server/diskStore.ts). Each change
// is saved to disk shortly after it's made, and mirrored to localStorage as a fallback copy.
const cache = new Map<string, unknown>()
let diskAvailable = false
const pending = new Map<string, unknown>()
let flushTimer: number | null = null
const versions = new Map<string, number>()

export type StorageStatus = 'loading' | 'saved' | 'saving' | 'error' | 'browser-only'
let status: StorageStatus = 'loading'
const statusListeners = new Set<() => void>()
function setStatus(next: StorageStatus): void {
  if (next === status) return
  status = next
  statusListeners.forEach((l) => l())
}
export function useStorageStatus(): StorageStatus {
  return useSyncExternalStore(
    (l) => {
      statusListeners.add(l)
      return () => statusListeners.delete(l)
    },
    () => status,
  )
}

function readUnsynced(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(UNSYNCED_KEY) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}
function writeUnsynced(keys: Set<string>): void {
  try {
    if (keys.size === 0) localStorage.removeItem(UNSYNCED_KEY)
    else localStorage.setItem(UNSYNCED_KEY, JSON.stringify([...keys]))
  } catch {
    // Can't record it; the change is still in memory and queued for disk.
  }
}

function mirrorToBrowser(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(PREFIX + key)
    else localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch (e) {
    logWarn('storage', 'browser copy failed', { key, error: e })
  }
}

function browserCopy(): Map<string, unknown> {
  const out = new Map<string, unknown>()
  for (let i = 0; i < localStorage.length; i++) {
    const full = localStorage.key(i)
    if (!full?.startsWith(PREFIX)) continue
    const key = full.slice(PREFIX.length)
    if (!PERSISTED.test(key)) continue
    try {
      out.set(key, JSON.parse(localStorage.getItem(full) ?? 'null'))
    } catch {
      // Unreadable entry; skip it.
    }
  }
  return out
}

/**
 * Loads everything from disk. Anything only in this browser (from before data moved to disk, or
 * changed while the dev server was down) is copied to disk. Call once before rendering.
 */
export async function initStorage(): Promise<void> {
  const browser = browserCopy()
  let disk: Record<string, unknown> | null = null
  try {
    const res = await fetch(STORE_URL, { cache: 'no-store' })
    if (res.ok) disk = (await res.json()) as Record<string, unknown>
  } catch {
    // Dev server not reachable.
  }

  if (!disk) {
    for (const [k, v] of browser) cache.set(k, v)
    setStatus('browser-only')
    logWarn('storage', 'disk storage unavailable; using this browser only', { keys: browser.size })
    return
  }

  diskAvailable = true
  for (const [k, v] of Object.entries(disk)) cache.set(k, v)
  const unsynced = readUnsynced()
  let migrated = 0
  for (const [k, v] of browser) {
    // Browser wins only for keys disk has never seen, or ones changed here but not yet saved.
    if (!(k in disk) || unsynced.has(k)) {
      cache.set(k, v)
      pending.set(k, v)
      migrated++
    }
  }
  for (const k of unsynced) {
    if (!browser.has(k) && k in disk) {
      // Deleted here while disk was unreachable.
      cache.delete(k)
      pending.set(k, null)
    }
  }
  // Keep the browser copy matching disk.
  for (const [k, v] of cache) mirrorToBrowser(k, v)
  setStatus('saved')
  log('storage', 'loaded from disk', { keys: cache.size, copiedFromBrowser: migrated })
  if (pending.size > 0) scheduleFlush(0)
}

function scheduleFlush(delay = 300): void {
  if (!diskAvailable) return
  if (flushTimer !== null) window.clearTimeout(flushTimer)
  flushTimer = window.setTimeout(() => {
    flushTimer = null
    void flush()
  }, delay)
}

function takeBatch() {
  const set: Record<string, unknown> = {}
  const remove: string[] = []
  const sent = new Map<string, number>()
  for (const [k, v] of pending) {
    if (v === null) remove.push(k)
    else set[k] = v
    sent.set(k, versions.get(k) ?? 0)
  }
  pending.clear()
  return { set, remove, sent }
}

async function flush(): Promise<void> {
  if (pending.size === 0) return
  const { set, remove, sent } = takeBatch()
  setStatus('saving')
  try {
    const res = await fetch(STORE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ set, remove }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    // Only clear keys that haven't changed again since this batch was sent.
    const unsynced = readUnsynced()
    for (const [k, version] of sent) if ((versions.get(k) ?? 0) === version) unsynced.delete(k)
    writeUnsynced(unsynced)
    logDebug('storage', 'saved to disk', { set: Object.keys(set), removed: remove })
    setStatus(pending.size > 0 ? 'saving' : 'saved')
  } catch (e) {
    // Put the batch back (newer changes win) and try again shortly.
    for (const [k, v] of Object.entries(set)) if (!pending.has(k)) pending.set(k, v)
    for (const k of remove) if (!pending.has(k)) pending.set(k, null)
    setStatus('error')
    logWarn('storage', 'saving to disk failed; will retry', { error: e, keys: pending.size })
    scheduleFlush(5000)
  }
}

if (typeof window !== 'undefined') {
  // Last-moment save when the tab closes.
  window.addEventListener('pagehide', () => {
    if (!diskAvailable || pending.size === 0) return
    const { set, remove } = takeBatch()
    navigator.sendBeacon?.(STORE_URL, new Blob([JSON.stringify({ set, remove })], { type: 'application/json' }))
  })
}

function read<T>(key: string): T | null {
  return (cache.get(key) as T | undefined) ?? null
}

function write(key: string, value: unknown): void {
  if (value === null) cache.delete(key)
  else cache.set(key, value)
  mirrorToBrowser(key, value)
  if (!diskAvailable) return
  versions.set(key, (versions.get(key) ?? 0) + 1)
  pending.set(key, value)
  const unsynced = readUnsynced()
  unsynced.add(key)
  writeUnsynced(unsynced)
  setStatus('saving')
  scheduleFlush()
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
      setState(() => {
        // Always start from what's saved: other parts of the app (like a karaoke set recording
        // its result) can change a song's prefs too, and their changes mustn't be overwritten.
        const base = loadPrefs(trackId)
        const next = change(base)
        const changed = changedKeys(base, next)
        if (changed.length > 0) {
          log('prefs', 'changed', {
            trackId,
            changed,
            // Small values are useful to see directly; big ones (lyric-keyed maps) just by size.
            values: Object.fromEntries(
              changed.map((k) => {
                const v = (next as unknown as Record<string, unknown>)[k]
                const json = JSON.stringify(v) ?? ''
                return [k, json.length <= 300 ? v : `${json.length} chars`]
              }),
            ),
          })
        }
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

/** Forgets a song entirely: its place in the library and playlists, lyrics, edits and progress. */
export function deleteSong(trackId: string): void {
  log('storage', 'deleting song', { trackId })
  const playlists = loadPlaylists()
  if (playlists.some((p) => p.trackIds.includes(trackId))) {
    savePlaylists(playlists.map((p) => ({ ...p, trackIds: p.trackIds.filter((id) => id !== trackId) })))
  }
  write(
    'library',
    loadLibrary().filter((e) => e.id !== trackId),
  )
  write(`prefs:${trackId}`, null)
  write(`lyrics:${trackId}`, null)
  try {
    sessionStorage.removeItem(`songlearner:test-mode:${trackId}`)
  } catch {
    // Nothing to clear.
  }
}

/** Progress for the library overview. */
export function masterySummary(trackId: string): { known: number; total: number; complete: boolean } | null {
  const prefs = read<TrackPrefs>(`prefs:${trackId}`)
  if (prefs?.progress && prefs.progress.sections > 0) {
    const { learned, sections, completedAt } = prefs.progress
    return { known: learned, total: sections, complete: completedAt !== undefined }
  }
  // Songs not opened since progress was recorded: count the rated sections.
  const values = Object.values(prefs?.mastery ?? {})
  if (values.length === 0) return null
  return { known: values.filter((v) => v === 3).length, total: values.length, complete: false }
}

/** A song as it appears in a list that can be played through (a playlist or the karaoke set). */
export interface SetSong extends LibraryEntry {
  /** Number of sections, if the song has been opened since progress was recorded (else 0). */
  sections: number
  rehearsals: Rehearsal[]
}

export interface LearnedSong extends SetSong {
  completedAt: number
}

export function toSetSong(entry: LibraryEntry): SetSong {
  const prefs = read<TrackPrefs>(`prefs:${entry.id}`)
  return { ...entry, sections: prefs?.progress?.sections ?? 0, rehearsals: prefs?.rehearsals ?? [] }
}

/** Songs with every section learned: the karaoke set. Most recently learned first. */
export function loadLearnedSongs(): LearnedSong[] {
  return loadLibrary()
    .flatMap((entry) => {
      const prefs = read<TrackPrefs>(`prefs:${entry.id}`)
      const progress = prefs?.progress
      if (!progress?.completedAt || progress.sections === 0 || progress.learned < progress.sections) return []
      return [{ ...entry, completedAt: progress.completedAt, sections: progress.sections, rehearsals: prefs?.rehearsals ?? [] }]
    })
    .sort((a, b) => b.completedAt - a.completedAt)
}

/** Changes one song's prefs from outside its song screen. */
export function updatePrefs(trackId: string, change: (prev: TrackPrefs) => TrackPrefs): void {
  const before = loadPrefs(trackId)
  const next = change(before)
  log('prefs', 'changed', { trackId, changed: changedKeys(before, next) })
  savePrefs(trackId, next)
}

export function useLocalSetting<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => read<T>(`setting:${key}`) ?? initial)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) first.current = false
    else log('settings', 'changed', { key, value: value as unknown })
    write(`setting:${key}`, value)
  }, [key, value])
  return [value, setValue] as const
}

// --- Playlists ---------------------------------------------------------------------------------

export interface Playlist {
  id: string
  name: string
  /** In play order. */
  trackIds: string[]
  createdAt: number
}

const NO_PLAYLISTS: Playlist[] = []
const playlistListeners = new Set<() => void>()

export function loadPlaylists(): Playlist[] {
  return read<Playlist[]>('playlists') ?? NO_PLAYLISTS
}

function savePlaylists(playlists: Playlist[]): void {
  write('playlists', playlists)
  playlistListeners.forEach((l) => l())
}

/** All playlists; re-renders when they change. */
export function usePlaylists(): Playlist[] {
  return useSyncExternalStore(
    (l) => {
      playlistListeners.add(l)
      return () => playlistListeners.delete(l)
    },
    loadPlaylists,
  )
}

function changePlaylist(id: string, change: (p: Playlist) => Playlist): void {
  savePlaylists(loadPlaylists().map((p) => (p.id === id ? change(p) : p)))
}

export function createPlaylist(name: string, firstTrackId?: string): Playlist {
  const playlist: Playlist = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: name.trim() || 'New playlist',
    trackIds: firstTrackId ? [firstTrackId] : [],
    createdAt: Date.now(),
  }
  log('playlists', 'created', { id: playlist.id, name: playlist.name, firstTrackId })
  savePlaylists([...loadPlaylists(), playlist])
  return playlist
}

export function renamePlaylist(id: string, name: string): void {
  if (!name.trim()) return
  log('playlists', 'renamed', { id, name })
  changePlaylist(id, (p) => ({ ...p, name: name.trim() }))
}

export function deletePlaylist(id: string): void {
  log('playlists', 'deleted', { id })
  savePlaylists(loadPlaylists().filter((p) => p.id !== id))
}

/** Adds the song to the playlist, or removes it if it's already there. */
export function togglePlaylistSong(id: string, trackId: string): void {
  changePlaylist(id, (p) => {
    const inList = p.trackIds.includes(trackId)
    log('playlists', inList ? 'song removed' : 'song added', { id, trackId })
    return { ...p, trackIds: inList ? p.trackIds.filter((t) => t !== trackId) : [...p.trackIds, trackId] }
  })
}

export function movePlaylistSong(id: string, from: number, to: number): void {
  changePlaylist(id, (p) => {
    if (to < 0 || to >= p.trackIds.length) return p
    const trackIds = [...p.trackIds]
    const [moved] = trackIds.splice(from, 1)
    trackIds.splice(to, 0, moved)
    log('playlists', 'reordered', { id, from, to })
    return { ...p, trackIds }
  })
}

/** A playlist's songs, in order (songs no longer in the library are skipped). */
export function playlistSongs(playlist: Playlist): SetSong[] {
  const library = new Map(loadLibrary().map((e) => [e.id, e]))
  return playlist.trackIds.flatMap((id) => {
    const entry = library.get(id)
    return entry ? [toSetSong(entry)] : []
  })
}
