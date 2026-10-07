// The karaoke set: an automatic playlist of every song you've fully learned, sung from memory.
// Songs play one after another with the lyrics blurred (test mode). Sections you get through
// without pausing, skipping or peeking count, and each song's score is saved with it.
// The page itself is in components/Karaoke.tsx.
import { useCallback, useEffect, useRef, useState } from 'react'
import { usePlayer } from './hooks'
import { log, logError } from './log'
import { loadLearnedSongs, updatePrefs, type LearnedSong } from './practice/storage'
import { playTrack } from './spotify/api'
import { playerController } from './spotify/player'

/** Pause between songs, so there's a moment to breathe. */
const GAP_BETWEEN_SONGS_MS = 2500
/** A song counts as finished if playback stops within this much of its end. */
const END_TOLERANCE_MS = 3000

export interface SongResult {
  song: LearnedSong
  /** Section start lines sung through without help. */
  passed: number[]
  /** True once "send back to learning" has been used. */
  sentBack?: boolean
}

interface SetState {
  queue: LearnedSong[]
  index: number
  passed: Record<string, number[]>
  results: SongResult[]
  finished: boolean
}

export type KaraokeOrder = 'recent' | 'least-rehearsed' | 'shuffle'

function ordered(songs: LearnedSong[], order: KaraokeOrder): LearnedSong[] {
  if (order === 'shuffle') {
    const out = [...songs]
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[out[i], out[j]] = [out[j], out[i]]
    }
    return out
  }
  if (order === 'least-rehearsed') {
    const last = (s: LearnedSong) => s.rehearsals.at(-1)?.at ?? 0
    return [...songs].sort((a, b) => last(a) - last(b))
  }
  return songs
}

/** Runs a karaoke set: plays each song, moves on when it ends, and records the results. */
export function useKaraokeSet() {
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
    log('karaoke', 'song done', { trackId: song.id, reason, passed: passed.length, total: song.sections })
    updatePrefs(song.id, (p) => ({
      ...p,
      rehearsals: [...(p.rehearsals ?? []), { at: Date.now(), passed: passed.length, total: song.sections }],
    }))
    const results = [...s.results, { song, passed }]
    const nextIndex = s.index + 1
    if (reason === 'ended set' || nextIndex >= s.queue.length) {
      log('karaoke', 'set finished', { songs: results.length })
      void playerController.pause('karaoke: set finished')
      setState({ ...s, results, finished: true })
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

  /** Starts a set and returns the first song's id (or null if there's nothing learned yet). */
  const start = useCallback((order: KaraokeOrder): string | null => {
    const queue = ordered(loadLearnedSongs(), order)
    if (queue.length === 0) return null
    playerController.activate()
    log('karaoke', 'set started', { order, songs: queue.map((s) => s.id) })
    setState({ queue, index: 0, passed: {}, results: [], finished: false })
    return queue[0].id
  }, [])

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
    finished: state?.finished ? state.results : null,
    current,
    number: (state?.index ?? 0) + 1,
    total: state?.queue.length ?? 0,
    nextName: state && state.index + 1 < state.queue.length ? state.queue[state.index + 1].name : null,
    start,
    onPass,
    next: () => advance('skipped'),
    end: () => advance('ended set'),
    sendBack,
    close,
  }
}

export type KaraokeSet = ReturnType<typeof useKaraokeSet>
