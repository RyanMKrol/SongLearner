import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  isTyping,
  useDerivedFromPosition,
  useKeyHeld,
  useLyrics,
  usePlayer,
  usePractice,
  useAutoLoop,
  useTestMode,
  useRomaji,
  type RomajiMode,
} from '../hooks'
import { appendTapped, lineIndexAt, parseLyrics, toLrc, withLineText } from '../lyrics/lrc'
import { getLrclibRecord, type LrclibRecord } from '../lyrics/lrclib'
import { hasJapanese, type RomajiWord } from '../lyrics/romaji'
import { combineReadingFixes, lyricsKey, requestReadingReview, ReviewError } from '../lyrics/readingReview'
import { alignmentLines, wordTimesFor, type WordTiming } from '../lyrics/wordAlign'
import {
  autoSectionStarts,
  buildSections,
  innerAutoStarts,
  isSung,
  mergeStarts,
  sectionTimings,
  splitStarts,
  truncate,
  type Section,
} from '../lyrics/sections'
import { buildUpPlan, chainPlan } from '../playback/loop'
import { estimateOffset, MIN_HITS } from '../playback/calibrate'
import { fadeMask, type HideLevel, type Mask } from '../practice/mask'
import { addToLibrary, useLocalSetting, useTrackPrefs, type Mastery, type SavedLyrics, type TrackPrefs } from '../practice/storage'
import { log, logDebug } from '../log'
import { rememberPosition } from '../playback/positions'
import { playerController, type PlayerTrack } from '../spotify/player'
import { EndOfLyrics } from './EndOfLyrics'
import { LyricsPane, type LineFill } from './LyricsPane'
import type { LeadInTiming } from '../playback/leadIn'
import { PasteDialog, ReadingDialog, VersionsDialog } from './LyricsDialogs'
import { PerformanceView } from './PerformanceView'
import { DEFAULT_PRACTICE_SETTINGS, type PracticeSettings } from '../practice/settings'
import { SectionPanel } from './SectionPanel'
import { TapSync } from './TapSync'
import { TimingControl, Transport } from './Transport'
import { WordAlignPanel } from './WordAlignPanel'

type Overlay = null | 'tapsync' | 'performance' | 'paste' | 'versions'

const NO_FIXES: Record<string, string> = {}

/** Line-index-keyed prefs no longer line up once the lyrics text changes, so clear them. */
const resetLineKeyedPrefs = (p: TrackPrefs): TrackPrefs => ({
  ...p,
  sectionStarts: undefined,
  sectionNames: {},
  mastery: {},
  hide: {},
  wordTiming: undefined,
})

/** A song being played as part of a set: a playlist or the karaoke set (see karaoke.ts). */
export interface KaraokeSetInfo {
  /** e.g. "Karaoke set" or the playlist's name. */
  title: string
  /** Test run: the words start hidden and sections sung through count. */
  test: boolean
  /** 1-based place in the set. */
  number: number
  total: number
  nextName: string | null
  /** A section was sung through without help. */
  onPass: (startLine: number) => void
  onNext: () => void
  onEnd: () => void
}

export function SongView({ track, karaoke = null }: { track: PlayerTrack; karaoke?: KaraokeSetInfo | null }) {
  const player = usePlayer()
  const { state: lyricsState, replace, refetch } = useLyrics(track)
  const [prefs, updatePrefs] = useTrackPrefs(track.id)
  const practice = usePractice()
  const [savedSettings, setSettings] = useLocalSetting<PracticeSettings>('practice', DEFAULT_PRACTICE_SETTINGS)
  // Settings saved before a newer option existed get its default.
  const settings = useMemo(() => ({ ...DEFAULT_PRACTICE_SETTINGS, ...savedSettings }), [savedSettings])
  const [selection, setSelection] = useState<{ from: number; to: number } | null>(null)
  const [editSplits, setEditSplits] = useState(false)
  const [overlay, setOverlay] = useState<Overlay>(null)
  // On a phone the side panel is a bottom sheet: closed it shows just the transport.
  const [sheetOpen, setSheetOpen] = useState(false)
  // Held H on a keyboard, or the hold-to-peek button on a touch screen.
  const [touchPeek, setTouchPeek] = useState(false)
  const peek = useKeyHeld('h') || touchPeek
  // Remembered per song for this browser tab, so a refresh (or any rebuild of this screen)
  // doesn't drop you out of a test halfway through.
  const testModeKey = `songlearner:test-mode:${track.id}`
  const [testMode, setTestMode] = useState(() => {
    // A test run is about singing from memory, so the words start hidden.
    if (karaoke?.test) return true
    try {
      return sessionStorage.getItem(testModeKey) === '1'
    } catch {
      return false
    }
  })
  useEffect(() => {
    try {
      if (testMode) sessionStorage.setItem(testModeKey, '1')
      else sessionStorage.removeItem(testModeKey)
    } catch {
      // Storage blocked: test mode just won't survive a refresh.
    }
  }, [testMode, testModeKey])
  const [justPassed, setJustPassed] = useState<number | null>(null)
  const [romajiMode, setRomajiMode] = useLocalSetting<RomajiMode>('romaji', 'below')
  const [fixReadings, setFixReadings] = useState(false)
  const [fixingWord, setFixingWord] = useState<RomajiWord | null>(null)
  const [editWords, setEditWords] = useState(false)
  const offset = prefs.offsetMs

  useEffect(() => {
    addToLibrary({
      id: track.id,
      uri: track.uri,
      name: track.name,
      artists: track.artists,
      album: track.album,
      imageUrl: track.imageUrl,
      durationMs: track.durationMs,
    })
  }, [track])

  const saved = lyricsState.status === 'ready' ? lyricsState.lyrics : null
  const lyrics = useMemo(() => (saved ? parseLyrics(saved.text) : null), [saved])
  const lines = useMemo(() => lyrics?.lines ?? [], [lyrics])
  const synced = lyrics?.synced ?? false

  const sections = useMemo(
    () => buildSections(lines, prefs.sectionStarts ?? autoSectionStarts(lines), prefs.sectionNames),
    [lines, prefs.sectionStarts, prefs.sectionNames],
  )
  // Claude's check of how a Japanese song is sung. Its fixes apply first; your own fixes win.
  const currentLyricsKey = saved ? lyricsKey(saved.text) : null
  const review = prefs.aiReview && prefs.aiReview.lyricsKey === currentLyricsKey ? prefs.aiReview : null
  const readingFixes = useMemo(() => combineReadingFixes(review, prefs.readings) ?? NO_FIXES, [review, prefs.readings])
  const romaji = useRomaji(lines, readingFixes)

  const [reviewError, setReviewError] = useState<{ key: string; kind: string; message: string } | null>(null)
  const reviewInFlight = useRef<string | null>(null)
  const runReview = useCallback(
    (key: string, words: { source: string; standard: string }[]) => {
      if (reviewInFlight.current === key) return
      reviewInFlight.current = key
      requestReadingReview({
        title: track.name,
        artist: track.artists.join(', '),
        album: track.album,
        lines: lines.filter((l) => hasJapanese(l.text)).map((l) => l.text),
        words,
      })
        .then((result) => {
          updatePrefs((p) => ({
            ...p,
            aiReview: {
              lyricsKey: key,
              reviewedAt: Date.now(),
              model: result.model,
              notes: result.notes,
              suggestions: result.suggestions.map((s) => ({ ...s, applied: s.confidence !== 'low' })),
            },
          }))
        })
        .catch((e: unknown) => {
          const kind = e instanceof ReviewError ? e.kind : 'failed'
          setReviewError({ key, kind, message: e instanceof Error ? e.message : String(e) })
        })
        .finally(() => {
          if (reviewInFlight.current === key) reviewInFlight.current = null
        })
    },
    [track.name, track.artists, track.album, lines, updatePrefs],
  )
  // Lyric files often stop before the song does (an outro that repeats an earlier part). You can
  // add the ending by tapping: pick the repeated lines, then tap as each one is sung.
  const lastLyricMs = synced ? (lines.at(-1)?.timeMs ?? 0) : 0
  const lyricsEndSongMs = lastLyricMs - offset
  const [outro, setOutro] = useState<{
    base: SavedLyrics
    baseLines: typeof lines
    from: number | null
    to: number | null
    taps: number[]
  } | null>(null)
  const hasAdditions = saved?.addedFromLine !== undefined || Boolean(saved?.label.endsWith(' + your additions'))
  const showEndNotice =
    synced && sections.length > 0 && (track.durationMs - lyricsEndSongMs > 25000 || hasAdditions || outro !== null)

  /** Saves the base lyrics plus the tapped lines, keeping prefs and Claude's check in step. */
  const saveOutro = (state: NonNullable<typeof outro>) => {
    if (state.from === null) return true
    const to = state.to ?? state.baseLines.length - 1
    const base = state.base
    const text = state.taps.length === 0 ? base.text : appendTapped(state.baseLines, state.from, to, state.taps)
    if (text === null) return false
    const baseLabel = base.label.replace(/ \+ your additions$/, '')
    replace(
      state.taps.length === 0
        ? base
        : { ...base, text, label: `${baseLabel} + your additions`, addedFromLine: base.addedFromLine ?? state.baseLines.length },
    )
    const newKey = lyricsKey(text)
    updatePrefs((p) => ({
      ...p,
      // The added lines repeat existing ones, so Claude's check still applies.
      aiReview: p.aiReview && p.aiReview.lyricsKey === currentLyricsKey ? { ...p.aiReview, lyricsKey: newKey } : p.aiReview,
    }))
    return true
  }

  const startOutro = () => {
    if (!saved) return
    log('lyrics', 'adding an ending: started')
    setOutro({ base: saved, baseLines: lines, from: null, to: null, taps: [] })
  }

  const pickOutroLine = (lineIndex: number, extend: boolean) => {
    if (!outro || outro.taps.length > 0 || lineIndex >= outro.baseLines.length) return
    if (!isSung(outro.baseLines[lineIndex])) return
    const next =
      extend && outro.from !== null && lineIndex >= outro.from
        ? { ...outro, to: lineIndex }
        : { ...outro, from: lineIndex, to: null }
    log('lyrics', 'adding an ending: lines picked', { from: next.from, to: next.to })
    setOutro(next)
  }

  const tapOutro = () => {
    if (!outro || outro.from === null) return
    // People tap a little after they hear a line start.
    const at = playerController.clock.position() + offset - 120
    const next = { ...outro, taps: [...outro.taps, at] }
    if (!saveOutro(next)) {
      logDebug('lyrics', 'adding an ending: tap ignored (before the previous line)', { atMs: Math.round(at) })
      return
    }
    log('lyrics', 'adding an ending: tap', { atMs: Math.round(at), count: next.taps.length })
    setOutro(next)
  }

  const undoOutroTap = () => {
    if (!outro || outro.taps.length === 0) return
    const next = { ...outro, taps: outro.taps.slice(0, -1) }
    saveOutro(next)
    log('lyrics', 'adding an ending: undo tap', { count: next.taps.length })
    setOutro(next)
  }

  const finishOutro = (keep: boolean) => {
    if (!outro) return
    log('lyrics', keep ? 'adding an ending: done' : 'adding an ending: cancelled', { taps: outro.taps.length })
    if (!keep) saveOutro({ ...outro, taps: [] })
    setOutro(null)
  }

  // While tapping in an ending, Space taps, Backspace undoes and Escape finishes. The keyboard
  // handler reads these through a ref so it always sees the latest taps.
  const outroKeysRef = useRef({ active: false, tap: tapOutro, undo: undoOutroTap, finish: finishOutro })
  useEffect(() => {
    outroKeysRef.current = { active: outro?.from != null, tap: tapOutro, undo: undoOutroTap, finish: finishOutro }
  })

  /** Removes every line added at the end, going back to the lyrics as downloaded. */
  const removeAdditions = async () => {
    if (!saved) return
    let keepLines = saved.addedFromLine
    // Additions made before addedFromLine was recorded: count the lines of the LRCLIB original.
    if (keepLines === undefined && saved.lrclibId !== undefined) {
      const record = await getLrclibRecord(saved.lrclibId).catch(() => null)
      const original = record?.syncedLyrics ? parseLyrics(record.syncedLyrics).lines : null
      if (original && original.every((l, i) => lines[i]?.text === l.text && lines[i]?.timeMs === l.timeMs)) {
        keepLines = original.length
      }
    }
    if (keepLines === undefined || keepLines >= lines.length) {
      log('lyrics', 'remove additions: nothing to remove', { keepLines, lines: lines.length })
      return
    }
    const text = toLrc(lines.slice(0, keepLines).map((l) => ({ ...l, timeMs: l.timeMs ?? 0 })))
    log('lyrics', 'removed added lines', { removed: lines.length - keepLines })
    replace({ ...saved, text, label: saved.label.replace(/ \+ your additions$/, ''), addedFromLine: undefined })
    const newKey = lyricsKey(text)
    updatePrefs((p) => ({
      ...p,
      sectionStarts: p.sectionStarts?.filter((i) => i < (keepLines ?? 0)),
      aiReview: p.aiReview && p.aiReview.lyricsKey === currentLyricsKey ? { ...p.aiReview, lyricsKey: newKey } : p.aiReview,
    }))
  }

  /** Changes the words of one line, keeping its timing. */
  const editLine = (lineIndex: number, text: string) => {
    if (!saved) return
    const next = withLineText(lines, lineIndex, text)
    if (next === null || next === saved.text) return
    log('lyrics', 'line edited', { line: lineIndex })
    replace({ ...saved, text: next, edited: true })
    const newKey = lyricsKey(next)
    updatePrefs((p) => ({
      ...p,
      // A small wording change doesn't undo Claude's check of the readings.
      aiReview: p.aiReview && p.aiReview.lyricsKey === currentLyricsKey ? { ...p.aiReview, lyricsKey: newKey } : p.aiReview,
    }))
  }

  /** Sets how a word is sung in this song, or null to go back to the dictionary reading. */
  const saveReading = useCallback(
    (word: RomajiWord, reading: string | null) => {
      updatePrefs((p) => {
        const readings = { ...p.readings }
        const backToDictionary = reading === null || reading === word.standard
        if (backToDictionary) delete readings[word.source]
        else readings[word.source] = reading
        // Going back to the dictionary reading also switches off Claude's suggestion for it.
        const aiReview =
          backToDictionary && p.aiReview
            ? {
                ...p.aiReview,
                suggestions: p.aiReview.suggestions.map((s) => (s.source === word.source ? { ...s, applied: false } : s)),
              }
            : p.aiReview
        return { ...p, readings, aiReview }
      })
    },
    [updatePrefs],
  )

  /** Every distinct Japanese word with its dictionary romaji, for the review. */
  const reviewWords = useMemo(() => {
    const seen = new Map<string, string>()
    for (const line of romaji.lines ?? []) {
      for (const w of line?.words ?? []) {
        if (w.kind === 'word' && hasJapanese(w.source) && !seen.has(w.source)) seen.set(w.source, w.standard)
      }
    }
    return [...seen].map(([source, standard]) => ({ source, standard }))
  }, [romaji.lines])
  const reviewFailed = reviewError !== null && reviewError.key === currentLyricsKey
  const reviewPending = romaji.available && currentLyricsKey !== null && review === null && !reviewFailed
  // Japanese songs only: check once the romaji is ready, then keep the result with the song.
  useEffect(() => {
    if (reviewPending && currentLyricsKey && romaji.lines && reviewWords.length > 0) {
      runReview(currentLyricsKey, reviewWords)
    }
  }, [reviewPending, currentLyricsKey, romaji.lines, reviewWords, runReview])
  const romajiLines = romajiMode === 'off' ? null : romaji.lines

  // Karaoke fill: word timings worked out from the song's audio (see WordAlignPanel).
  const [fillOn, setFillOn] = useLocalSetting<boolean>('karaokeFill', true)
  const [autoAlign, setAutoAlign] = useLocalSetting<boolean>('autoAlign', true)
  const wordTiming = prefs.wordTiming
  const lyricNow = useCallback(() => playerController.clock.position() + offset, [offset])
  const fill = useMemo<LineFill | null>(
    () =>
      wordTiming && fillOn
        ? { words: (lineIndex, shown) => wordTimesFor(wordTiming, lineIndex, shown), now: lyricNow }
        : null,
    [wordTiming, fillOn, lyricNow],
  )
  // Counting in after an intro or a break. Word timings say exactly when singing starts and stops;
  // without them, a line is assumed to be sung for at most 6 seconds.
  const leadIn = useMemo<LeadInTiming>(
    () => ({
      now: lyricNow,
      start: (i) => wordTiming?.lines[i]?.words[0]?.startMs ?? lines[i]?.timeMs ?? null,
      end: (i) => {
        const words = wordTiming?.lines[i]?.words
        if (words?.length) return words[words.length - 1].endMs
        const t = lines[i]?.timeMs
        return t == null ? null : t + 6000
      },
    }),
    [lyricNow, wordTiming, lines],
  )
  // Japanese lines are aligned by their romaji, so wait for it.
  const alignReady = synced && lines.some(isSung) && (!romaji.available || romaji.lines !== null)
  const buildAlignLines = useCallback(() => alignmentLines(lines, romaji.lines), [lines, romaji.lines])
  const saveWordTiming = useCallback((t: WordTiming) => updatePrefs((p) => ({ ...p, wordTiming: t })), [updatePrefs])
  /** Sections as shown: unnamed sections take their label from the romaji when there is some. */
  const displaySections = useMemo(
    () =>
      sections.map((s) => {
        const r = romajiLines?.[s.startLine]
        return r && !prefs.sectionNames[s.startLine] ? { ...s, name: truncate(r.text, 34) } : s
      }),
    [sections, romajiLines, prefs.sectionNames],
  )
  const timings = useMemo(
    () => (synced ? sectionTimings(sections, lines, track.durationMs) : sections.map(() => null)),
    [synced, sections, lines, track.durationMs],
  )
  /** Section timings in song time (the offset moves lyrics relative to the audio). */
  const songTimings = useMemo(
    () => timings.map((t) => (t ? { startMs: t.startMs - offset, endMs: t.endMs - offset } : { startMs: 0, endMs: 0 })),
    [timings, offset],
  )

  // Test mode: blurred lyrics; sections sung through without help get marked as learned.
  const markLearned = useCallback(
    (sectionIndex: number, learned: boolean) => {
      const section = sections[sectionIndex]
      if (!section) return
      updatePrefs((p) => ({ ...p, mastery: { ...p.mastery, [section.startLine]: learned ? 3 : 1 } }))
    },
    [sections, updatePrefs],
  )
  const karaokePass = karaoke?.onPass
  const onSectionPassed = useCallback(
    (sectionIndex: number) => {
      markLearned(sectionIndex, true)
      setJustPassed(sectionIndex)
      const section = sections[sectionIndex]
      if (section) karaokePass?.(section.startLine)
    },
    [markLearned, sections, karaokePass],
  )
  useEffect(() => {
    if (justPassed === null) return
    const id = window.setTimeout(() => setJustPassed(null), 2500)
    return () => window.clearTimeout(id)
  }, [justPassed])
  const testAttempt = useTestMode(testMode && synced, songTimings, peek, onSectionPassed)

  const learnedCount = sections.filter((s) => prefs.mastery[s.startLine] === 3).length

  // Keep the song's progress up to date for the library and the karaoke set. A song is learned
  // when every section is; it joins the karaoke set then, and leaves it if one is unlearned.
  useEffect(() => {
    if (!synced || sections.length === 0) return
    const current = prefs.progress
    const complete = learnedCount === sections.length
    if (current?.sections === sections.length && current.learned === learnedCount && Boolean(current.completedAt) === complete) {
      return
    }
    if (complete && !current?.completedAt) log('song-view', 'song learned (added to the karaoke set)', { trackId: track.id })
    if (!complete && current?.completedAt) log('song-view', 'song no longer fully learned (left the karaoke set)', { trackId: track.id })
    updatePrefs((p) => ({
      ...p,
      progress: {
        sections: sections.length,
        learned: learnedCount,
        completedAt: complete ? (p.progress?.completedAt ?? Date.now()) : undefined,
      },
    }))
  }, [synced, sections.length, learnedCount, prefs.progress, track.id, updatePrefs])

  const startSection = useCallback(
    (sectionIndex: number) => {
      const t = songTimings[sectionIndex]
      if (!t) return
      playerController.activate()
      void playerController
        .seek(t.startMs - settings.leadInMs, 'test: start section')
        .then(() => playerController.resume('test: start section'))
    },
    [songTimings, settings.leadInMs],
  )
  const firstUnlearned = sections.findIndex((s) => prefs.mastery[s.startLine] !== 3)

  const currentLine = useDerivedFromPosition(
    useCallback((pos: number) => (synced ? lineIndexAt(lines, pos + offset) : -1), [synced, lines, offset]),
  )

  const sectionOfLine = useCallback(
    (lineIndex: number): Section | null => {
      let found: Section | null = null
      for (const s of sections) if (s.startLine <= lineIndex) found = s
      return found
    },
    [sections],
  )

  const hideForSection = useCallback((s: Section): HideLevel => prefs.hide[s.startLine] ?? 0, [prefs.hide])
  const practiceStatus = practice.status
  const hideFor = useCallback(
    (lineIndex: number): Mask => {
      const s = sectionOfLine(lineIndex)
      if (!s) return 0
      const level = hideForSection(s)
      if (level !== 3) return level
      // Fade sections lose more of each word every time they're looped, and show everything otherwise.
      const passes = practiceStatus?.sectionPasses[s.index]
      return passes === undefined ? 0 : fadeMask(passes, settings.fadeLoops)
    },
    [sectionOfLine, hideForSection, practiceStatus, settings.fadeLoops],
  )
  const masteryFor = useCallback((s: Section): Mastery => prefs.mastery[s.startLine] ?? 0, [prefs.mastery])

  // How many times each section (or run of sections) is looped is remembered for the song.
  const repsKey = useCallback(
    (from: number, to: number): string | null => {
      const first = sections[from]
      const last = sections[to]
      if (!first || !last) return null
      return from === to ? String(first.startLine) : `${first.startLine}-${last.startLine}`
    },
    [sections],
  )
  const loopRepsFor = useCallback(
    (from: number, to: number): number | null => {
      const key = repsKey(from, to)
      // Sections with nothing saved play once.
      const saved = key === null ? undefined : prefs.loopReps?.[key]
      return saved === undefined ? 1 : saved
    },
    [repsKey, prefs.loopReps],
  )
  const saveLoopReps = useCallback(
    (from: number, to: number, reps: number | null) => {
      const key = repsKey(from, to)
      if (key === null || prefs.loopReps?.[key] === reps) return
      updatePrefs((p) => ({ ...p, loopReps: { ...p.loopReps, [key]: reps } }))
    },
    [repsKey, prefs.loopReps, updatePrefs],
  )

  // Practice actions.
  const { start: startPractice, stop: stopPractice } = practice
  // When a loop ends the song plays on, so select the next section, ready to loop with L.
  const selectNext = useCallback(
    (range: { toSection: number }) => {
      const next = range.toSection + 1
      if (next < sections.length) setSelection({ from: next, to: next })
    },
    [sections.length],
  )
  const loop = useCallback(
    (from: number, to: number) => {
      if (!synced || sections.length === 0) return
      playerController.activate()
      setSelection({ from, to })
      // Asking to loop something set to play once loops it until stopped.
      const reps = loopRepsFor(from, to)
      startPractice(chainPlan(songTimings, from, to, reps === 1 ? null : reps), settings, selectNext)
    },
    [synced, sections.length, songTimings, settings, startPractice, loopRepsFor, selectNext],
  )

  // Sections set to loop more than once loop by themselves when playback reaches them.
  const autoSpans = useMemo(
    () =>
      songTimings.map((t, i) => {
        const reps = loopRepsFor(i, i)
        return { ...t, loops: reps !== null && reps > 1 }
      }),
    [songTimings, loopRepsFor],
  )
  const autoLoop = useCallback(
    (i: number) => {
      setSelection({ from: i, to: i })
      startPractice(chainPlan(songTimings, i, i, loopRepsFor(i, i)), settings, selectNext, true)
    },
    [songTimings, loopRepsFor, settings, startPractice, selectNext],
  )
  const suppressAutoLoop = useAutoLoop(
    settings.autoLoop && synced && !testMode && !karaoke,
    autoSpans,
    practice.status !== null,
    autoLoop,
  )
  const practiceRunning = practice.status
  const stopLooping = useCallback(() => {
    // Stopping a loop shouldn't start it again straight away.
    if (practiceRunning) suppressAutoLoop(practiceRunning.step.fromSection, practiceRunning.step.toSection)
    stopPractice()
  }, [practiceRunning, suppressAutoLoop, stopPractice])
  const buildUp = useCallback(
    (from: number, to: number) => {
      if (!synced) return
      playerController.activate()
      startPractice(buildUpPlan(songTimings, from, to, settings.buildReps, settings.soloFirst), settings)
    },
    [synced, songTimings, settings, startPractice],
  )

  // Changing the lyrics or the section splits invalidates a running loop.
  const splitKey = sections.map((s) => s.startLine).join(',')
  useEffect(() => stopPractice(), [lines, splitKey, stopPractice])

  const practiceStep = practice.status?.step ?? null
  const activeLines = useMemo(
    () =>
      practiceStep
        ? {
            from: sections[practiceStep.fromSection]?.startLine ?? 0,
            to: sections[practiceStep.toSection]?.endLine ?? lines.length - 1,
          }
        : null,
    [practiceStep, sections, lines.length],
  )

  const seekToLine = useCallback(
    (lineIndex: number) => {
      const t = lines[lineIndex]?.timeMs
      if (t === null || t === undefined) return
      if (activeLines && (lineIndex < activeLines.from || lineIndex > activeLines.to)) stopPractice()
      playerController.activate()
      void playerController.seek(t - offset - 500, 'jump to line')
      if (player.paused) void playerController.resume('jump to line')
    },
    [lines, offset, activeLines, stopPractice, player.paused],
  )

  const selectSection = (index: number, extend: boolean) => {
    logDebug('song-view', 'section clicked', { index, extend })
    setSelection((prev) => {
      if (extend && prev) {
        const anchor = prev.from
        return { from: Math.min(anchor, index), to: Math.max(anchor, index) }
      }
      if (prev && prev.from === index && prev.to === index) return null
      return { from: index, to: index }
    })
  }

  const toggleSplit = (lineIndex: number) => {
    const firstSung = lines.findIndex(isSung)
    if (lineIndex === firstSung) return
    const current = sections.map((s) => s.startLine)
    const next = current.includes(lineIndex) ? current.filter((i) => i !== lineIndex) : [...current, lineIndex]
    updatePrefs((p) => ({ ...p, sectionStarts: next.sort((a, b) => a - b) }))
    setSelection(null)
  }

  /** Turns sections `from`..`to` into one bigger section, for learning in larger chunks. */
  const mergeSections = (from: number, to: number) => {
    if (to <= from) return
    const first = sections[from]
    const parts = sections.slice(from, to + 1)
    log('sections', 'merged', { from, to, startLines: parts.map((s) => s.startLine) })
    updatePrefs((p) => {
      const mastery = { ...p.mastery }
      const hide = { ...p.hide }
      const sectionNames = { ...p.sectionNames }
      // Learned only if every part was, so merging never marks anything learned by accident.
      const merged = Math.min(...parts.map((s) => p.mastery[s.startLine] ?? 0)) as Mastery
      for (const s of parts.slice(1)) {
        delete mastery[s.startLine]
        delete hide[s.startLine]
        delete sectionNames[s.startLine]
      }
      if (merged > 0) mastery[first.startLine] = merged
      else delete mastery[first.startLine]
      return { ...p, sectionStarts: mergeStarts(sections, from, to), mastery, hide, sectionNames }
    })
    setSelection({ from, to: from })
  }

  /** Splits a merged section back into its automatic parts, which inherit its rating. */
  const splitSection = (index: number) => {
    const section = sections[index]
    if (!section) return
    const auto = autoSectionStarts(lines)
    const inner = innerAutoStarts(section, auto)
    if (inner.length === 0) return
    log('sections', 'split', { index, startLine: section.startLine, into: inner.length + 1 })
    updatePrefs((p) => {
      const mastery = { ...p.mastery }
      const hide = { ...p.hide }
      for (const start of inner) {
        if (p.mastery[section.startLine] !== undefined) mastery[start] = p.mastery[section.startLine]
        if (p.hide[section.startLine] !== undefined) hide[start] = p.hide[section.startLine]
      }
      return { ...p, sectionStarts: splitStarts(sections, index, auto), mastery, hide }
    })
    setSelection(null)
  }
  const autoStarts = useMemo(() => autoSectionStarts(lines), [lines])
  const canSplit = (section: Section) => innerAutoStarts(section, autoStarts).length > 0

  const setOffset = useCallback(
    (ms: number) => updatePrefs((p) => ({ ...p, offsetMs: Math.max(-5000, Math.min(5000, Math.round(ms))) })),
    [updatePrefs],
  )

  // Timing calibration: tap Space as each word starts, and the median gap between your taps and the
  // word timings says how far to move the lyrics. Taps are kept as song positions, so they're
  // measured against whatever the offset is when the result is worked out.
  const [calibration, setCalibration] = useState<{ positions: number[] } | null>(null)
  const wordStarts = useMemo(
    () => (wordTiming ? Object.values(wordTiming.lines).flatMap((l) => l.words.map((w) => w.startMs)) : []),
    [wordTiming],
  )
  const calibrationResult = useMemo(
    () => (calibration ? estimateOffset(calibration.positions.map((p) => p + offset), wordStarts) : null),
    [calibration, offset, wordStarts],
  )
  const startCalibration = () => {
    log('calibrate', 'started', { offsetMs: offset })
    setEditWords(false)
    setCalibration({ positions: [] })
    if (playerController.getSnapshot().paused) void playerController.togglePlay('calibrate: start')
  }
  const tapCalibration = () => {
    const at = playerController.clock.position()
    setCalibration((c) => c && { positions: [...c.positions, at] })
  }
  const endCalibration = (apply: boolean) => {
    if (apply && calibrationResult) {
      log('calibrate', 'applied', { from: offset, to: offset + calibrationResult.deltaMs, ...calibrationResult })
      setOffset(offset + calibrationResult.deltaMs)
    } else {
      log('calibrate', 'cancelled', { taps: calibration?.positions.length ?? 0 })
    }
    setCalibration(null)
  }
  const calibrationKeysRef = useRef({ active: false, tap: tapCalibration, end: endCalibration })
  useEffect(() => {
    calibrationKeysRef.current = { active: calibration !== null, tap: tapCalibration, end: endCalibration }
  })

  const applyLyrics = (next: SavedLyrics) => {
    replace(next)
    updatePrefs((p) => resetLineKeyedPrefs({ ...p, offsetMs: 0 }))
    setSelection(null)
    setOverlay(null)
  }

  const pickVersion = (r: LrclibRecord) =>
    applyLyrics({
      text: r.syncedLyrics ?? r.plainLyrics ?? '',
      synced: Boolean(r.syncedLyrics),
      instrumental: r.instrumental,
      source: 'lrclib',
      label: `LRCLIB: ${r.artistName}, ${r.albumName ?? 'unknown album'}`,
      lrclibId: r.id,
    })

  // Keyboard shortcuts.
  useEffect(() => {
    if (overlay === 'tapsync' || overlay === 'paste' || overlay === 'versions' || fixingWord) return
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return
      const pos = playerController.clock.position()
      if (!e.repeat) logDebug('keys', 'pressed', { key: e.key, position: Math.round(pos) })
      const calibrationKeys = calibrationKeysRef.current
      if (calibrationKeys.active) {
        if (e.key === ' ') {
          e.preventDefault()
          if (!e.repeat) calibrationKeys.tap()
          return
        }
        if (e.key === 'Escape') {
          calibrationKeys.end(false)
          return
        }
      }
      const outroKeys = outroKeysRef.current
      if (outroKeys.active) {
        if (e.key === ' ') {
          e.preventDefault()
          if (!e.repeat) outroKeys.tap()
          return
        }
        if (e.key === 'Backspace') {
          e.preventDefault()
          outroKeys.undo()
          return
        }
        if (e.key === 'Escape') {
          outroKeys.finish(true)
          return
        }
      }
      switch (e.key) {
        case ' ':
          e.preventDefault()
          void playerController.togglePlay('key: space')
          break
        case 'ArrowLeft':
          e.preventDefault()
          void playerController.seek(pos - 5000, 'key: left')
          break
        case 'ArrowRight':
          e.preventDefault()
          void playerController.seek(pos + 5000, 'key: right')
          break
        case 'ArrowUp':
        case 'ArrowDown': {
          if (!synced) return
          e.preventDefault()
          const step = e.key === 'ArrowUp' ? -1 : 1
          let i = currentLine + step
          while (i >= 0 && i < lines.length && !isSung(lines[i])) i += step
          if (i >= 0 && i < lines.length) seekToLine(i)
          break
        }
        case 'l':
        case 'L': {
          if (selection) loop(selection.from, selection.to)
          else {
            const s = sectionOfLine(Math.max(currentLine, 0))
            if (s) loop(s.index, s.index)
          }
          break
        }
        case 'Escape':
          if (overlay === 'performance') setOverlay(null)
          else if (practice.status) stopLooping()
          else if (editSplits) setEditSplits(false)
          else if (editWords) setEditWords(false)
          break
        case 't':
        case 'T':
          if (synced) setTestMode((v) => !v)
          break
        case 'f':
        case 'F':
          if (synced && lines.length > 0) setOverlay((o) => (o === 'performance' ? null : 'performance'))
          break
        case '[':
          setOffset(offset - 100)
          break
        case ']':
          setOffset(offset + 100)
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    overlay,
    fixingWord,
    synced,
    currentLine,
    lines,
    seekToLine,
    selection,
    loop,
    sectionOfLine,
    practice.status,
    stopPractice,
    stopLooping,
    editSplits,
    editWords,
    setOffset,
    offset,
  ])

  const practiceRange = practice.status
    ? { startMs: practice.status.step.startMs, endMs: practice.status.step.endMs }
    : selection && synced && songTimings[selection.from] && songTimings[selection.to]
      ? { startMs: songTimings[selection.from].startMs, endMs: songTimings[selection.to].endMs }
      : null

  // --- Diagnostics -------------------------------------------------------------------------
  // When this screen is built or torn down (a rebuild resets test mode, loops and scrolling).
  useEffect(() => {
    log('song-view', 'opened', { trackId: track.id, name: track.name, artists: track.artists, durationMs: track.durationMs })
    return () => log('song-view', 'closed', { trackId: track.id })
  }, [track.id, track.name, track.artists, track.durationMs])
  useEffect(() => {
    log('song-view', 'lyrics state', {
      status: lyricsState.status,
      synced,
      lines: lines.length,
      sections: sections.length,
      customSplits: prefs.sectionStarts !== undefined,
    })
  }, [lyricsState.status, synced, lines.length, sections.length, prefs.sectionStarts])
  useEffect(() => {
    if (romaji.available) log('song-view', 'romaji state', { loading: romaji.loading, error: romaji.error, mode: romajiMode })
  }, [romaji.available, romaji.loading, romaji.error, romajiMode])
  useEffect(() => log('song-view', 'overlay', { overlay }), [overlay])
  useEffect(() => log('song-view', 'test mode', { on: testMode }), [testMode])
  useEffect(() => log('song-view', 'fix readings mode', { on: fixReadings }), [fixReadings])
  useEffect(() => logDebug('song-view', 'peek', { held: peek }), [peek])
  useEffect(() => {
    if (justPassed !== null) log('song-view', 'section learned', { section: justPassed })
  }, [justPassed])

  // Remember where you are, so going back to this song later resumes here.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (playerController.getSnapshot().track?.id === track.id) rememberPosition(track.id, playerController.clock.position())
    }, 1000)
    return () => window.clearInterval(id)
  }, [track.id])

  // Every 5 seconds, a snapshot of where things stand, so the logs read as a timeline.
  const heartbeatRef = useRef<() => Record<string, unknown>>(() => ({}))
  useEffect(() => {
    heartbeatRef.current = () => ({
      position: Math.round(playerController.clock.position()),
      playing: playerController.clock.isPlaying,
      paused: player.paused,
      playerStatus: player.status,
      currentLine,
      section: sectionOfLine(Math.max(currentLine, 0))?.index ?? null,
      offsetMs: offset,
      testMode,
      testAttempt,
      learned: learnedCount,
      practice: practice.status
        ? { step: practice.status.stepIndex, of: practice.status.stepCount, rep: practice.status.rep, reps: practice.status.reps }
        : null,
      overlay,
      visibility: document.visibilityState,
    })
  })
  useEffect(() => {
    const id = window.setInterval(() => logDebug('heartbeat', 'tick', heartbeatRef.current()), 5000)
    return () => window.clearInterval(id)
  }, [])
  // ------------------------------------------------------------------------------------------

  const closeOverlay = useCallback(() => setOverlay(null), [])

  return (
    <main className="song">
      <section className="song-lyrics">
        {lyricsState.status === 'loading' && <div className="lyrics-message">Looking for lyrics…</div>}
        {lyricsState.status === 'error' && (
          <div className="lyrics-message">
            <p>Couldn&apos;t reach the lyrics service: {lyricsState.message}</p>
            <button className="btn" onClick={refetch}>
              Try again
            </button>
          </div>
        )}
        {lyricsState.status === 'none' && (
          <div className="lyrics-message">
            <p>No lyrics found for this song on LRCLIB.</p>
            <div className="row">
              <button className="btn" onClick={() => setOverlay('versions')}>
                Search LRCLIB
              </button>
              <button className="btn btn-primary" onClick={() => setOverlay('paste')}>
                Paste lyrics
              </button>
            </div>
          </div>
        )}
        {saved?.instrumental && lines.length === 0 && (
          <div className="lyrics-message">LRCLIB lists this as an instrumental. Nothing to sing!</div>
        )}
        {lyrics && lines.length > 0 && (
          <>
            {karaoke && (
              <div className="karaoke-banner">
                <div>
                  <strong>
                    {karaoke.title} · song {karaoke.number} of {karaoke.total}
                    {karaoke.test ? ' · test' : ''}
                  </strong>
                  <div className="muted small">
                    {karaoke.nextName ? `Next up: ${karaoke.nextName}. It starts when this song ends.` : 'Last song of the set.'}
                  </div>
                </div>
                <div className="test-banner-actions">
                  <button className="btn btn-small" onClick={karaoke.onNext}>
                    {karaoke.nextName ? 'Next song' : 'Finish'}
                  </button>
                  <button className="btn btn-small btn-ghost" onClick={karaoke.onEnd}>
                    End set
                  </button>
                </div>
              </div>
            )}
            {testMode && synced && (
              <div className="test-banner">
                <div>
                  <strong>Test mode</strong> · {learnedCount} of {sections.length} sections learned
                  <div className="muted small">
                    Sing without the words. A section is marked learned when it plays from start to end
                    without pausing, skipping or peeking<span className="shortcuts"> (hold H to peek)</span>.
                  </div>
                </div>
                <div className="test-banner-actions">
                  <button
                    className="btn btn-small touch-only peek-btn"
                    onPointerDown={() => setTouchPeek(true)}
                    onPointerUp={() => setTouchPeek(false)}
                    onPointerCancel={() => setTouchPeek(false)}
                    onPointerLeave={() => setTouchPeek(false)}
                    onContextMenu={(e) => e.preventDefault()}
                  >
                    Hold to peek
                  </button>
                  {firstUnlearned >= 0 ? (
                    <button className="btn btn-primary btn-small" onClick={() => startSection(firstUnlearned)}>
                      Start from first unlearned
                    </button>
                  ) : (
                    <span className="learned-tag">✓ Whole song learned</span>
                  )}
                  <button className="btn btn-small" onClick={() => setTestMode(false)}>
                    Exit test (T)
                  </button>
                </div>
              </div>
            )}
            {calibration && (
              <div className="banner banner-inline calibrate-banner">
                <div>
                  <strong>Calibrating timing:</strong> tap <span className="shortcuts">Space</span>
                  <span className="touch-only">the Tap button</span> as each word starts, for a line or two.{' '}
                  <span className="muted">
                    {calibration.positions.length} {calibration.positions.length === 1 ? 'tap' : 'taps'}
                  </span>
                  <div className="small">
                    {calibrationResult === null ? (
                      <span className="muted">
                        Keep going: the result shows once {MIN_HITS} taps line up with words.
                      </span>
                    ) : Math.abs(calibrationResult.deltaMs) < 50 ? (
                      <span className="good">The timing already matches your taps.</span>
                    ) : (
                      <span>
                        The words are {Math.abs(calibrationResult.deltaMs / 1000).toFixed(2)}s{' '}
                        {calibrationResult.deltaMs > 0 ? 'late' : 'early'}: the timing becomes{' '}
                        {Math.abs((offset + calibrationResult.deltaMs) / 1000).toFixed(2)}s{' '}
                        {offset + calibrationResult.deltaMs >= 0 ? 'earlier' : 'later'}.
                      </span>
                    )}
                    {calibrationResult && (
                      <span className="muted">
                        {' '}
                        ({calibrationResult.hits} of {calibrationResult.taps} taps matched
                        {calibrationResult.spreadMs > 150 ? '; your taps were uneven, so a few more will help' : ''})
                      </span>
                    )}
                  </div>
                </div>
                <span className="calibrate-actions">
                  <button className="btn btn-primary touch-only calibrate-tap" onPointerDown={tapCalibration}>
                    Tap
                  </button>
                  <button
                    className="btn btn-small btn-primary"
                    disabled={!calibrationResult}
                    onClick={() => endCalibration(true)}
                  >
                    Apply
                  </button>
                  <button
                    className="btn btn-small"
                    disabled={calibration.positions.length === 0}
                    onClick={() => setCalibration({ positions: [] })}
                  >
                    Start over
                  </button>
                  <button className="btn btn-small btn-ghost" onClick={() => endCalibration(false)}>
                    Cancel (Esc)
                  </button>
                </span>
              </div>
            )}
            {editWords && !testMode && (
              <div className="banner banner-inline edit-words-banner">
                <span>
                  Click a line to change its words, then press Enter. The timing stays the same.
                </span>
                <button className="btn btn-small" onClick={() => setEditWords(false)}>
                  Done
                </button>
              </div>
            )}
            {!synced && (
              <div className="banner banner-inline">
                These lyrics aren&apos;t timed, so they won&apos;t scroll by themselves.{' '}
                <button className="link" onClick={() => setOverlay('tapsync')}>
                  Time them yourself
                </button>{' '}
                (one listen) or{' '}
                <button className="link" onClick={() => setOverlay('versions')}>
                  look for a timed version
                </button>
                .
              </div>
            )}
            <LyricsPane
              lines={lines}
              synced={synced}
              sections={displaySections}
              romaji={romajiLines}
              fixReadings={fixReadings && romajiLines !== null}
              onWordClick={setFixingWord}
              onChooseReading={saveReading}
              pickLines={
                outro && outro.taps.length === 0
                  ? {
                      from: outro.from,
                      to: outro.to ?? (outro.from !== null ? outro.baseLines.length - 1 : null),
                      onPick: pickOutroLine,
                    }
                  : null
              }
              endNotice={
                showEndNotice && !testMode ? (
                  <EndOfLyrics
                    endsAtMs={lyricsEndSongMs}
                    durationMs={track.durationMs}
                    hasAdditions={hasAdditions}
                    outro={
                      outro && {
                        from: outro.from,
                        to: outro.to ?? (outro.from !== null ? outro.baseLines.length - 1 : null),
                        taps: outro.taps.length,
                        lines: outro.baseLines,
                      }
                    }
                    onStart={startOutro}
                    onTap={tapOutro}
                    onUndoTap={undoOutroTap}
                    onFinish={finishOutro}
                    onRemoveAdditions={() => void removeAdditions()}
                  />
                ) : null
              }
              romajiMode={romajiMode}
              currentLine={currentLine}
              hideFor={hideFor}
              peek={peek}
              activeLines={activeLines}
              selection={selection}
              mastery={masteryFor}
              editSplits={editSplits}
              onToggleSplit={toggleSplit}
              onEditLine={editWords && !testMode && !outro ? editLine : null}
              fill={fill}
              leadIn={synced ? leadIn : null}
              onLineClick={seekToLine}
              onSectionClick={selectSection}
              onSectionLoop={(i) => loop(i, i)}
              test={
                testMode && synced
                  ? { attempt: testAttempt, justPassed, onStartSection: startSection, onSetLearned: markLearned }
                  : null
              }
            />
          </>
        )}
      </section>

      <aside className={`song-side ${sheetOpen ? 'is-open' : ''}`}>
        <button
          className="sheet-handle"
          onClick={() => setSheetOpen((v) => !v)}
          aria-expanded={sheetOpen}
        >
          <span className="sheet-grip" aria-hidden="true" />
          <span>{sheetOpen ? 'Hide practice tools' : 'Practice tools'}</span>
          {synced && sections.length > 0 && (
            <span className="muted small">
              {learnedCount}/{sections.length} learned
            </span>
          )}
        </button>
        <div className="track-card">
          {track.imageUrl ? <img src={track.imageUrl} alt="" /> : <span className="art-placeholder" />}
          <div>
            <div className="track-name">{track.name}</div>
            <div className="muted">{track.artists.join(', ')}</div>
            <div className="muted small">{track.album}</div>
          </div>
        </div>

        <Transport durationMs={track.durationMs} practiceRange={practiceRange} />

        {synced && sections.length > 0 && (
          <button
            className={`btn test-toggle ${testMode ? 'is-active' : 'btn-primary'}`}
            onClick={() => setTestMode((v) => !v)}
          >
            {testMode ? 'Exit test mode (T)' : `Test yourself (T) · ${learnedCount}/${sections.length} learned`}
          </button>
        )}

        {synced && (
          <TimingControl
            offsetMs={offset}
            onChange={setOffset}
            onCalibrate={wordTiming && !calibration && !testMode ? startCalibration : undefined}
          />
        )}

        {sections.length > 0 && (
          <SectionPanel
            sections={displaySections}
            timings={timings}
            synced={synced}
            selection={selection}
            onSelect={selectSection}
            mastery={masteryFor}
            onMastery={(s, m) => updatePrefs((p) => ({ ...p, mastery: { ...p.mastery, [s.startLine]: m } }))}
            hide={hideForSection}
            onHide={(s, h) => updatePrefs((p) => ({ ...p, hide: { ...p.hide, [s.startLine]: h } }))}
            onHideAll={(h) =>
              updatePrefs((p) => ({ ...p, hide: Object.fromEntries(sections.map((s) => [s.startLine, h])) }))
            }
            onRename={(s, name) =>
              updatePrefs((p) => {
                const names = { ...p.sectionNames }
                if (name) names[s.startLine] = name
                else delete names[s.startLine]
                return { ...p, sectionNames: names }
              })
            }
            editSplits={editSplits}
            onToggleEditSplits={() => setEditSplits((v) => !v)}
            customSplits={prefs.sectionStarts !== undefined}
            onResetSplits={() => updatePrefs((p) => ({ ...p, sectionStarts: undefined }))}
            settings={settings}
            onSettings={(next) => {
              // Turning looping off stops whatever is looping now.
              if (settings.autoLoop && !next.autoLoop) stopPractice()
              setSettings(next)
            }}
            onLoop={loop}
            loopReps={loopRepsFor}
            onLoopReps={saveLoopReps}
            savedLoopReps={(sec) => prefs.loopReps?.[String(sec.startLine)]}
            onBuildUp={buildUp}
            onMerge={mergeSections}
            canSplit={canSplit}
            onSplit={splitSection}
            practice={practice.status}
            finished={practice.finished}
            onStop={stopLooping}
            onRateFinished={(m) => {
              const range = practice.finished
              if (range) {
                updatePrefs((p) => {
                  const mastery = { ...p.mastery }
                  for (let i = range.fromSection; i <= range.toSection; i++) {
                    if (sections[i]) mastery[sections[i].startLine] = m
                  }
                  return { ...p, mastery }
                })
              }
              practice.dismissFinished()
            }}
          />
        )}

        <div className="panel">
          <div className="panel-title-row">
            <span className="panel-title">Lyrics</span>
            {synced && lines.length > 0 && (
              <button className="btn btn-small btn-primary" onClick={() => setOverlay('performance')}>
                Performance mode (F)
              </button>
            )}
          </div>
          {romaji.available && (
            <div className="romaji-row">
              <span className="small">Romaji</span>
              <span className="segmented" role="group" aria-label="Romaji display">
                {(
                  [
                    ['below', 'Under the lyrics'],
                    ['only', 'Romaji only'],
                    ['off', 'Off'],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    className={`btn btn-small ${romajiMode === mode ? 'is-active' : ''}`}
                    onClick={() => setRomajiMode(mode)}
                  >
                    {label}
                  </button>
                ))}
              </span>
              {romajiMode !== 'off' && romaji.loading && (
                <span className="muted small">Loading the Japanese dictionary (about 17MB, first time only)…</span>
              )}
              {romaji.error && <span className="error-text small">Couldn&apos;t make romaji: {romaji.error}</span>}
              {romajiMode !== 'off' && romaji.lines && (
                <div className="fix-readings">
                  <button
                    className={`btn btn-small ${fixReadings ? 'is-active' : ''}`}
                    onClick={() => setFixReadings((v) => !v)}
                    title="Click a romaji word in the lyrics to change how it's read"
                  >
                    {fixReadings ? 'Done fixing' : 'Fix a reading'}
                  </button>
                  <span className="muted small">
                    {fixReadings
                      ? 'Click any romaji word in the lyrics to change it.'
                      : 'Dotted words are often sung differently in songs.'}
                  </span>
                  {Object.keys(prefs.readings ?? {}).length > 0 && (
                    <div className="fix-list">
                      {Object.entries(prefs.readings ?? {}).map(([source, reading]) => (
                        <span key={source} className="fix-chip">
                          {source} → {reading}
                          <button
                            className="fix-chip-remove"
                            aria-label={`Remove the fix for ${source}`}
                            onClick={() =>
                              updatePrefs((p) => {
                                const readings = { ...p.readings }
                                delete readings[source]
                                return { ...p, readings }
                              })
                            }
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {saved && (
            <WordAlignPanel
              trackId={track.id}
              artist={track.artists[0] ?? ''}
              title={track.name}
              durationMs={track.durationMs}
              ready={alignReady}
              notReadyReason={synced ? 'Waiting for the romaji…' : 'The lyrics need to be timed first.'}
              buildLines={buildAlignLines}
              timing={wordTiming}
              onTiming={saveWordTiming}
              fillOn={fillOn}
              onFillOn={setFillOn}
              autoAlign={autoAlign}
              onAutoAlign={setAutoAlign}
            />
          )}
          {romaji.available && romajiMode !== 'off' && (
            <div className="review-box">
              {reviewPending && (
                <p className="small">
                  <span className="spinner" aria-hidden="true" /> Claude is checking how this song is sung. This can
                  take a minute; the romaji updates when it&apos;s done.
                </p>
              )}
              {reviewFailed &&
                (reviewError.kind === 'no_api_key' ? (
                  <p className="muted small">
                    To have Claude check how Japanese songs are sung, add <code>ANTHROPIC_API_KEY</code> to{' '}
                    <code>.env.local</code> and restart the dev server.
                  </p>
                ) : (
                  <p className="small">
                    <span className="error-text">Claude&apos;s check failed: {reviewError.message}</span>{' '}
                    <button className="link" onClick={() => setReviewError(null)}>
                      Try again
                    </button>
                  </p>
                ))}
              {review && (
                <>
                  <div className="panel-title-row">
                    <span className="small">
                      <strong>Checked by Claude</strong>
                      <span className="muted">
                        {' '}
                        ·{' '}
                        {review.suggestions.length === 0
                          ? 'no reading changes needed'
                          : `${review.suggestions.length} reading ${review.suggestions.length === 1 ? 'change' : 'changes'}`}
                      </span>
                    </span>
                    <button
                      className="btn btn-small btn-ghost"
                      onClick={() => updatePrefs((p) => ({ ...p, aiReview: undefined }))}
                      title="Ask Claude to check this song again"
                    >
                      Check again
                    </button>
                  </div>
                  {review.notes && <p className="muted small">{review.notes}</p>}
                  {review.suggestions.length > 0 && (
                    <ul className="review-list">
                      {review.suggestions.map((s) => (
                        <li key={s.source}>
                          <label>
                            <input
                              type="checkbox"
                              checked={s.applied}
                              onChange={(e) =>
                                updatePrefs((p) =>
                                  p.aiReview
                                    ? {
                                        ...p,
                                        aiReview: {
                                          ...p.aiReview,
                                          suggestions: p.aiReview.suggestions.map((x) =>
                                            x.source === s.source ? { ...x, applied: e.target.checked } : x,
                                          ),
                                        },
                                      }
                                    : p,
                                )
                              }
                            />
                            <span>
                              <span lang="ja">{s.source}</span> → <strong>{s.reading}</strong>{' '}
                              <span className={`tag confidence-${s.confidence}`}>{s.confidence}</span>
                              <span className="muted small review-reason">{s.reason}</span>
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          )}
          {saved && (
            <p className="muted small">
              {saved.source === 'user' ? 'Added by you' : saved.label}
              {saved.edited ? ' · words edited by you' : ''} · {synced ? 'timed' : 'not timed'}
            </p>
          )}
          <div className="tool-buttons">
            {lines.some(isSung) && !testMode && (
              <button
                className={`btn btn-small ${editWords ? 'is-active' : ''}`}
                onClick={() => {
                  setEditWords((v) => !v)
                  setEditSplits(false)
                  setFixReadings(false)
                }}
                title="Click a line in the lyrics to change its words"
              >
                {editWords ? 'Done editing' : 'Edit words'}
              </button>
            )}
            <button className="btn btn-small" onClick={() => setOverlay('versions')}>
              Find another version
            </button>
            {lines.some(isSung) && (
              <button className="btn btn-small" onClick={() => setOverlay('tapsync')}>
                {synced ? 'Re-time them yourself' : 'Time them yourself'}
              </button>
            )}
            <button className="btn btn-small" onClick={() => setOverlay('paste')}>
              Paste lyrics
            </button>
            <button
              className="btn btn-small btn-ghost"
              onClick={() => {
                updatePrefs(resetLineKeyedPrefs)
                refetch()
              }}
              title="Throw away the saved lyrics and download them again"
            >
              Re-download
            </button>
          </div>
        </div>
      </aside>

      {overlay === 'tapsync' && (
        <TapSync
          lines={lines.filter(isSung)}
          romaji={romajiLines && lines.flatMap((l, i) => (isSung(l) ? [romajiLines[i]?.text ?? null] : []))}
          onClose={closeOverlay}
          onSave={(lrc) => applyLyrics({ text: lrc, synced: true, source: 'user', label: 'Timed by you' })}
        />
      )}
      {overlay === 'performance' && (
        <PerformanceView
          romaji={romajiLines}
          romajiMode={romajiMode}
          fill={fill}
          leadIn={leadIn}
          lines={lines}
          offsetMs={offset}
          durationMs={track.durationMs}
          hideFor={hideFor}
          peek={peek}
          onClose={closeOverlay}
        />
      )}
      {overlay === 'paste' && (
        <PasteDialog
          onClose={closeOverlay}
          onSave={(text) =>
            applyLyrics({ text, synced: parseLyrics(text).synced, source: 'user', label: 'Pasted by you' })
          }
        />
      )}
      {overlay === 'versions' && <VersionsDialog track={track} onPick={pickVersion} onClose={closeOverlay} />}
      {fixingWord && (
        <ReadingDialog
          word={fixingWord}
          onClose={() => setFixingWord(null)}
          onSave={(reading) => {
            saveReading(fixingWord, reading)
            setFixingWord(null)
          }}
        />
      )}
    </main>
  )
}
