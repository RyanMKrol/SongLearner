// Plays a list of songs back to back: a playlist, or the karaoke set (every song you've fully
// learned). In a test run the lyrics are blurred; sections you get through without pausing,
// skipping or peeking count, each song's score is saved with it, and you get results at the end.
// The pages are components/Karaoke.tsx and components/Playlists.tsx.
import { useCallback, useEffect, useRef, useState } from 'react'
import { usePlayer } from './hooks'
import { log, logError } from './log'
import { loadLearnedSongs, updatePrefs, type LearnedSong, type SetSong } from './practice/storage'
import { navigate, type Route } from './router'
import { playTrack } from './spotify/api'
import { playerController } from './spotify/player'

/** Pause between songs, so there's a moment to breathe. */
const GAP_BETWEEN_SONGS_MS = 2500
/** A song counts as finished if playback stops within this much of its end. */
const END_TOLERANCE_MS = 3000

export interface SongResult {
  song: SetSong
  /** Section start lines sung through without help. */
  passed: number[]
  /** True once "send back to learning" has been used. */
  sentBack?: boolean
}

interface SetState {
  /** Shown in the banner, e.g. "Karaoke set" or a playlist's name. */
  title: string
  /** Test run: words blurred, scores recorded, results at the end. */
  test: boolean
  /** Where to go when a plain (non-test) run finishes. */
  returnTo: Route
  queue: SetSong[]
  index: number
  passed: Record<string, number[]>
  results: SongResult[]
  finished: boolean
}

export type KaraokeOrder = 'recent' | 'least-rehearsed' | 'shuffle'

export function ordered<T extends SetSong>(songs: T[], order: KaraokeOrder): T[] {
  if (order === 'shuffle') {
    const out = [...songs]
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[out[i], out[j]] = [out[j], out[i]]
    }
    return out
  }
  if (order === 'least-rehearsed') {
    const last = (s: SetSong) => s.rehearsals.at(-1)?.at ?? 0
    return [...songs].sort((a, b) => last(a) - last(b))
  }
  return songs
}

export interface StartOptions {
  title: string
  test: boolean
  returnTo: Route
}

/** Runs a set of songs: plays each one, moves on when it ends, and records test results. */
export function useSongSet() {
  const player = usePlayer()
  const [state, setState] = useState<SetState | null>(null)
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  })

  const current = state && !state.finished ? state.queue[state.index] : null

  /** Saves the current song's score and moves on (or finishes). */
  const advance = useCallback((reason: string) => {
    const s = stateRef.current
    if (!s || s.finished) return
    const song = s.queue[s.index]
    const passed = s.passed[song.id] ?? []
    log('karaoke', 'song done', { title: s.title, trackId: song.id, reason, passed: passed.length, total: song.sections })
    if (s.test) {
      // Section counts are refreshed from the song's progress, which updates as it's played.
      updatePrefs(song.id, (p) => ({
        ...p,
        rehearsals: [
          ...(p.rehearsals ?? []),
          { at: Date.now(), passed: passed.length, total: p.progress?.sections ?? song.sections },
        ],
      }))
    }
    const results = [...s.results, { song, passed }]
    const nextIndex = s.index + 1
    if (reason === 'ended set' || nextIndex >= s.queue.length) {
      log('karaoke', 'set finished', { title: s.title, songs: results.length })
      void playerController.pause('song set finished')
      if (s.test) {
        setState({ ...s, results, finished: true })
      } else {
        setState(null)
        navigate(s.returnTo)
      }
    } else {
      setState({ ...s, results, index: nextIndex })
    }
  }, [])

  // Start each song when its turn comes.
  const deviceId = player.deviceId
  const currentId = current?.id
  const currentUri = current?.uri
  const isFirst = state?.index === 0
  useEffect(() => {
    if (!currentId || !currentUri || !deviceId) return
    const id = window.setTimeout(
      () => {
        log('karaoke', 'playing', { trackId: currentId })
        playTrack(deviceId, currentUri).catch((e: unknown) => logError('karaoke', 'could not start song', { trackId: currentId, error: e }))
      },
      isFirst ? 0 : GAP_BETWEEN_SONGS_MS,
    )
    return () => window.clearTimeout(id)
    // isFirst only matters when a new song starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, currentUri, deviceId])

  // Notice when the song finishes: playback stops right at the end of the track.
  useEffect(() => {
    if (!currentId) return
    let lastPlaying = 0
    let duration = 0
    let sawThisSong = false
    const id = window.setInterval(() => {
      const snapshot = playerController.getSnapshot()
      if (snapshot.track?.id !== currentId) return
      sawThisSong = true
      const clock = playerController.clock
      if (clock.isPlaying) {
        lastPlaying = clock.position()
        duration = clock.duration
      } else if (sawThisSong && duration > 0 && lastPlaying >= duration - END_TOLERANCE_MS) {
        lastPlaying = 0
        advance('song ended')
      }
    }, 500)
    return () => window.clearInterval(id)
  }, [currentId, advance])

  /** Starts playing through `queue`; returns the first song's id (or null if it's empty). */
  const start = useCallback((queue: SetSong[], options: StartOptions): string | null => {
    if (queue.length === 0) return null
    playerController.activate()
    log('karaoke', 'set started', { ...options, songs: queue.map((s) => s.id) })
    setState({ ...options, queue, index: 0, passed: {}, results: [], finished: false })
    return queue[0].id
  }, [])

  /** The karaoke set: every fully learned song, as a test. */
  const startKaraoke = useCallback(
    (order: KaraokeOrder): string | null =>
      start(ordered<LearnedSong>(loadLearnedSongs(), order), { title: 'Karaoke set', test: true, returnTo: { name: 'karaoke' } }),
    [start],
  )

  const onPass = useCallback((startLine: number) => {
    setState((s) => {
      if (!s || s.finished) return s
      const id = s.queue[s.index].id
      const already = s.passed[id] ?? []
      if (already.includes(startLine)) return s
      return { ...s, passed: { ...s.passed, [id]: [...already, startLine] } }
    })
  }, [])

  const sendBack = useCallback((trackId: string) => {
    const s = stateRef.current
    const result = s?.results.find((r) => r.song.id === trackId)
    if (!s || !result) return
    // Sections you didn't get through go back to "learning"; the song leaves the set.
    updatePrefs(trackId, (p) => {
      const mastery = { ...p.mastery }
      for (const [line, level] of Object.entries(mastery)) {
        if (level === 3 && !result.passed.includes(Number(line))) mastery[Number(line)] = 1
      }
      const learned = Object.values(mastery).filter((v) => v === 3).length
      return {
        ...p,
        mastery,
        progress: p.progress ? { ...p.progress, learned, completedAt: undefined } : p.progress,
      }
    })
    log('karaoke', 'sent back to learning', { trackId, passed: result.passed.length, total: result.song.sections })
    setState({ ...s, results: s.results.map((r) => (r.song.id === trackId ? { ...r, sentBack: true } : r)) })
  }, [])

  const close = useCallback(() => setState(null), [])

  return {
    active: state !== null && !state.finished,
    title: state?.title ?? '',
    test: state?.test ?? false,
    returnTo: state?.returnTo ?? ({ name: 'home' } as Route),
    finished: state?.finished ? state.results : null,
    current,
    number: (state?.index ?? 0) + 1,
    total: state?.queue.length ?? 0,
    nextName: state && state.index + 1 < state.queue.length ? state.queue[state.index + 1].name : null,
    start,
    startKaraoke,
    onPass,
    next: () => advance('skipped'),
    end: () => advance('ended set'),
    sendBack,
    close,
  }
}

export type SongSet = ReturnType<typeof useSongSet>
