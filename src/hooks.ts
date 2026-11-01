import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { log, logError, logWarn } from './log'
import type { LyricLine } from './lyrics/lrc'
import { chooseRecord, findLyrics, getLrclibRecord } from './lyrics/lrclib'
import { hasJapanese, romanizeLines, type ReadingFixes, type RomajiLine } from './lyrics/romaji'
import { AutoLoopWatcher, type AutoLoopSpan } from './playback/autoLoop'
import { LoopController, type LoopOptions, type LoopStatus, type PracticeStep } from './playback/loop'
import { TestTracker, type TestSpan } from './playback/testTracker'
import { loadSavedLyrics, saveLyrics, updatePrefs, type SavedLyrics } from './practice/storage'
import { playerController, type PlayerTrack } from './spotify/player'

export function usePlayer() {
  return useSyncExternalStore(playerController.subscribe, playerController.getSnapshot)
}

/** Current song position, refreshed every `intervalMs`. */
export function usePosition(intervalMs = 100): number {
  const [position, setPosition] = useState(() => playerController.clock.position())
  useEffect(() => {
    const id = window.setInterval(() => setPosition(playerController.clock.position()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
  return position
}

/** Re-renders only when `select(position)` changes, so big views don't redraw 20 times a second. */
export function useDerivedFromPosition<T>(select: (positionMs: number) => T, intervalMs = 50): T {
  const selectRef = useRef(select)
  useEffect(() => {
    selectRef.current = select
  }, [select])
  const [value, setValue] = useState(() => select(playerController.clock.position()))
  useEffect(() => {
    const id = window.setInterval(() => {
      setValue(selectRef.current(playerController.clock.position()))
    }, intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
  // Recompute immediately when the selector itself changes (e.g. a new offset).
  const immediate = select(playerController.clock.position())
  return Object.is(immediate, value) ? value : immediate
}

export type LyricsState =
  | { status: 'loading' }
  | { status: 'ready'; lyrics: SavedLyrics }
  | { status: 'none' }
  | { status: 'error'; message: string }

export function useLyrics(track: PlayerTrack) {
  const [reloadKey, setReloadKey] = useState(0)
  const key = `${track.id}:${reloadKey}`
  const [state, setState] = useState<{ key: string; value: LyricsState } | null>(null)

  // Lyrics fetched before are kept in localStorage, so most songs open instantly.
  const initial = useMemo<LyricsState>(() => {
    const saved = loadSavedLyrics(track.id)
    return saved ? { status: 'ready', lyrics: saved } : { status: 'loading' }
    // reloadKey is a dependency so a re-download re-reads storage.
  }, [track.id, reloadKey]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (initial.status === 'ready') {
      const saved = initial.lyrics
      log('lyrics', 'loaded from storage', { trackId: track.id, source: saved.source, synced: saved.synced, lrclibId: saved.lrclibId, verified: saved.verified ?? false })
      // Lyrics saved before the name check existed could be another song's. Check once.
      if (saved.source !== 'lrclib' || saved.verified || saved.lrclibId === undefined || saved.addedFromLine !== undefined) return
      const controller = new AbortController()
      getLrclibRecord(saved.lrclibId, controller.signal)
        .then((record) => {
          if (!record) return
          const ok = chooseRecord([record], { name: track.name, artist: track.artists[0] ?? '', durationMs: track.durationMs })
          if (ok) {
            saveLyrics(track.id, { ...saved, verified: true })
            log('lyrics', 'saved lyrics checked: right song', { trackId: track.id, lrclibId: record.id })
          } else {
            logWarn('lyrics', 'saved lyrics were for a different song; looking up again', {
              trackId: track.id,
              lrclibId: record.id,
              savedName: record.trackName,
              savedArtist: record.artistName,
            })
            saveLyrics(track.id, null)
            // Sections, ratings and memorise settings belonged to the wrong lyrics' lines.
            updatePrefs(track.id, (p) => ({
              ...p,
              sectionStarts: undefined,
              sectionNames: {},
              mastery: {},
              hide: {},
              progress: undefined,
            }))
            setReloadKey((k) => k + 1)
          }
        })
        .catch(() => {
          // Couldn't check right now (LRCLIB down); try again next time the song opens.
        })
      return () => controller.abort()
    }
    const controller = new AbortController()
    const started = performance.now()
    log('lyrics', 'looking up on LRCLIB', { trackId: track.id, name: track.name, artist: track.artists[0], album: track.album, durationMs: track.durationMs })
    findLyrics(
      { name: track.name, artist: track.artists[0] ?? '', album: track.album, durationMs: track.durationMs },
      controller.signal,
    )
      .then((found) => {
        if (!found) {
          logWarn('lyrics', 'not found', { trackId: track.id, ms: performance.now() - started })
          setState({ key, value: { status: 'none' } })
          return
        }
        log('lyrics', 'found', {
          trackId: track.id,
          ms: performance.now() - started,
          lrclibId: found.record.id,
          synced: found.synced,
          instrumental: found.instrumental,
          recordDuration: found.record.duration,
          album: found.record.albumName,
          lines: found.text.split('\n').length,
        })
        const lyrics: SavedLyrics = {
          text: found.text,
          synced: found.synced,
          instrumental: found.instrumental,
          source: 'lrclib',
          label: `LRCLIB: ${found.record.artistName}, ${found.record.albumName ?? 'unknown album'}${found.synced || !found.record.syncedLyrics ? '' : ' (timed for a different recording, so shown untimed)'}`,
          lrclibId: found.record.id,
          verified: true,
        }
        saveLyrics(track.id, lyrics)
        setState({ key, value: { status: 'ready', lyrics } })
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return
        logError('lyrics', 'lookup failed', { trackId: track.id, error: e })
        setState({ key, value: { status: 'error', message: e instanceof Error ? e.message : String(e) } })
      })
    return () => controller.abort()
  }, [key, initial, track.id, track.name, track.artists, track.album, track.durationMs])

  const replace = useCallback(
    (lyrics: SavedLyrics) => {
      log('lyrics', 'replaced', { trackId: track.id, source: lyrics.source, label: lyrics.label, synced: lyrics.synced, lines: lyrics.text.split('\n').length })
      saveLyrics(track.id, lyrics)
      setState({ key, value: { status: 'ready', lyrics } })
    },
    [track.id, key],
  )

  const refetch = useCallback(() => {
    log('lyrics', 're-download requested', { trackId: track.id })
    saveLyrics(track.id, null)
    setReloadKey((k) => k + 1)
  }, [track.id])

  const value = state?.key === key ? state.value : initial
  return { state: value, replace, refetch }
}

export type RomajiMode = 'below' | 'only' | 'off'

export interface RomajiState {
  /** True when any line contains Japanese. */
  available: boolean
  loading: boolean
  error: string | null
  /** Romaji per line (null for lines with no Japanese), once ready. */
  lines: (RomajiLine | null)[] | null
}

/** Works out romaji for Japanese lyrics. The dictionary only downloads when it's needed. */
export function useRomaji(lines: LyricLine[], fixes: ReadingFixes): RomajiState {
  const available = useMemo(() => lines.some((l) => hasJapanese(l.text)), [lines])
  const [result, setResult] = useState<{
    source: LyricLine[]
    fixes: ReadingFixes
    lines: (RomajiLine | null)[] | null
    error: string | null
  } | null>(null)

  useEffect(() => {
    if (!available) return
    let cancelled = false
    const started = performance.now()
    romanizeLines(
      lines.map((l) => l.text),
      fixes,
    )
      .then((romaji) => {
        if (cancelled) return
        log('romaji', 'ready', {
          ms: performance.now() - started,
          japaneseLines: romaji.filter(Boolean).length,
          fixes: Object.keys(fixes).length,
          fixedWords: romaji.reduce((n, l) => n + (l?.words.filter((w) => w.fixed).length ?? 0), 0),
        })
        setResult({ source: lines, fixes, lines: romaji, error: null })
      })
      .catch((e: unknown) => {
        if (cancelled) return
        logError('romaji', 'failed', { error: e })
        setResult({ source: lines, fixes, lines: null, error: e instanceof Error ? e.message : String(e) })
      })
    return () => {
      cancelled = true
    }
  }, [lines, fixes, available])

  // While a new fix is being applied, keep showing the previous romaji rather than flashing empty.
  const current = result?.source === lines ? result : null
  return {
    available,
    loading: available && current === null,
    error: current?.error ?? null,
    lines: current?.lines ?? null,
  }
}

const LOOP_TICK_MS = 30

type PracticeRange = { fromSection: number; toSection: number }

export interface PracticeState {
  status: LoopStatus | null
  /** Set when a plan runs to completion, so the UI can ask how it went. */
  finished: PracticeRange | null
}

/** Runs a practice plan against the player: watches the position and seeks back as needed. */
export function usePractice() {
  const controllerRef = useRef<LoopController | null>(null)
  const gapTimer = useRef<number | null>(null)
  const onFinishedRef = useRef<((range: PracticeRange) => void) | null>(null)
  const [state, setState] = useState<PracticeState>({ status: null, finished: null })

  const clearGap = () => {
    if (gapTimer.current !== null) window.clearTimeout(gapTimer.current)
    gapTimer.current = null
  }

  const stop = useCallback(() => {
    if (controllerRef.current) log('practice', 'stopped', { status: controllerRef.current.status })
    controllerRef.current = null
    clearGap()
    setState({ status: null, finished: null })
  }, [])

  const execute = useCallback((controller: LoopController, action: ReturnType<LoopController['tick']>) => {
    log('practice', action.type === 'finished' ? 'finished' : 'jump back', {
      ...action,
      position: Math.round(playerController.clock.position()),
      step: controller.status.stepIndex,
      rep: controller.status.rep,
    })
    if (action.type === 'seek') {
      if (action.pauseMs > 0) {
        void playerController.pause('loop: pause between reps')
        clearGap()
        gapTimer.current = window.setTimeout(() => {
          gapTimer.current = null
          if (controllerRef.current !== controller) return
          void playerController
            .seek(action.positionMs, 'loop: restart after pause')
            .then(() => playerController.resume('loop: restart after pause'))
        }, action.pauseMs)
        // Park the clock on the restart point so the next tick doesn't see the old position.
        playerController.clock.jumpTo(action.positionMs)
      } else {
        void playerController.seek(action.positionMs, 'loop: jump back')
      }
    } else if (action.type === 'finished') {
      // Playback carries on into the rest of the song.
      const steps = controller.steps
      controllerRef.current = null
      const finished = {
        fromSection: Math.min(...steps.map((s) => s.fromSection)),
        toSection: Math.max(...steps.map((s) => s.toSection)),
      }
      setState({ status: null, finished })
      onFinishedRef.current?.(finished)
      return
    }
    setState({ status: controller.status, finished: null })
  }, [])

  const start = useCallback(
    (steps: PracticeStep[], options: LoopOptions, onFinished?: (range: PracticeRange) => void, join = false) => {
      clearGap()
      const controller = new LoopController(steps, options)
      onFinishedRef.current = onFinished ?? null
      log('practice', 'started', {
        steps: steps.map((s) => ({ from: s.fromSection, to: s.toSection, startMs: Math.round(s.startMs), endMs: Math.round(s.endMs), reps: s.reps })),
        ...options,
      })
      controllerRef.current = controller
      if (join) {
        // Playback is already at the start of the section, so this pass is the first rep.
        controller.join(performance.now())
        setState({ status: controller.status, finished: null })
        return
      }
      execute(controller, controller.start(performance.now()))
      void playerController.resume('loop: start practice')
    },
    [execute],
  )

  useEffect(() => {
    const id = window.setInterval(() => {
      const controller = controllerRef.current
      const clock = playerController.clock
      if (!controller || gapTimer.current !== null || !clock.isPlaying) return
      const action = controller.tick(clock.position(), performance.now())
      if (action.type !== 'none') execute(controller, action)
    }, LOOP_TICK_MS)
    return () => {
      window.clearInterval(id)
      clearGap()
    }
  }, [execute])

  const dismissFinished = useCallback(() => setState((s) => ({ ...s, finished: null })), [])

  return { ...state, start, stop, dismissFinished }
}

/**
 * Test mode: watches playback and calls `onPassed` for each section sung from start to end
 * without pausing, skipping or peeking. Returns the section currently being attempted.
 */
export function useTestMode(
  enabled: boolean,
  spans: TestSpan[],
  peek: boolean,
  onPassed: (sectionIndex: number) => void,
): number | null {
  const trackerRef = useRef<TestTracker | null>(null)
  const onPassedRef = useRef(onPassed)
  const peekRef = useRef(peek)
  const [attempt, setAttempt] = useState<number | null>(null)

  useEffect(() => {
    onPassedRef.current = onPassed
  }, [onPassed])

  useEffect(() => {
    if (!enabled) {
      trackerRef.current = null
      return
    }
    const tracker = new TestTracker(spans)
    trackerRef.current = tracker
    log('test', 'tracking', { sections: spans.length })
    const id = window.setInterval(() => {
      const clock = playerController.clock
      const position = clock.position()
      for (const event of tracker.tick(position, clock.isPlaying, performance.now(), peekRef.current)) {
        log('test', `section ${event.type}`, { ...event, position: Math.round(position), span: spans[event.section] })
        if (event.type === 'passed') onPassedRef.current(event.section)
      }
      setAttempt(tracker.current)
    }, 50)
    return () => {
      window.clearInterval(id)
      log('test', 'stopped tracking', { attempt: tracker.current })
    }
  }, [enabled, spans])

  // Looking at the words means this attempt doesn't count, and none starts until you stop looking.
  useEffect(() => {
    peekRef.current = peek
    if (peek) log('test', 'peeking', { attempt: trackerRef.current?.current ?? null })
  }, [peek])

  return enabled ? attempt : null
}

/**
 * Watches normal playback and calls `onEnter` when it reaches the start of a section that loops.
 * Does nothing while a loop is `running`. Returns `suppress`, to leave sections alone after a stop.
 */
export function useAutoLoop(
  enabled: boolean,
  spans: AutoLoopSpan[],
  running: boolean,
  onEnter: (sectionIndex: number) => void,
): (from: number, to: number) => void {
  const watcherRef = useRef(new AutoLoopWatcher(spans))
  const onEnterRef = useRef(onEnter)
  const runningRef = useRef(running)
  useEffect(() => {
    onEnterRef.current = onEnter
    runningRef.current = running
    watcherRef.current.setSpans(spans)
  }, [onEnter, running, spans])

  useEffect(() => {
    if (!enabled) return
    const watcher = watcherRef.current
    watcher.reset()
    const id = window.setInterval(() => {
      const clock = playerController.clock
      if (runningRef.current || !clock.isPlaying) {
        watcher.reset()
        return
      }
      const section = watcher.tick(clock.position())
      if (section !== null) {
        log('practice', 'auto loop', { section, position: Math.round(clock.position()) })
        onEnterRef.current(section)
      }
    }, LOOP_TICK_MS)
    return () => window.clearInterval(id)
  }, [enabled])

  return useCallback((from: number, to: number) => watcherRef.current.suppress(from, to), [])
}

/** True while the given key is held down (ignoring typing in form fields). */
export function useKeyHeld(key: string): boolean {
  const [held, setHeld] = useState(false)
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === key && !isTyping(e)) setHeld(true)
    }
    const up = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === key) setHeld(false)
    }
    const blur = () => setHeld(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [key])
  return held
}

export function isTyping(e: KeyboardEvent): boolean {
  const target = e.target as HTMLElement | null
  if (!target) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

export function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
