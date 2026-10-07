import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  isTyping,
  useDerivedFromPosition,
  useKeyHeld,
  useLyrics,
  usePlayer,
  usePractice,
  useTestMode,
  useRomaji,
  type RomajiMode,
} from '../hooks'
import { lineIndexAt, parseLyrics } from '../lyrics/lrc'
import type { LrclibRecord } from '../lyrics/lrclib'
import type { RomajiWord } from '../lyrics/romaji'
import { autoSectionStarts, buildSections, isSung, sectionTimings, truncate, type Section } from '../lyrics/sections'
import { buildUpPlan, chainPlan } from '../playback/loop'
import type { HideLevel } from '../practice/mask'
import { addToLibrary, useLocalSetting, useTrackPrefs, type Mastery, type SavedLyrics, type TrackPrefs } from '../practice/storage'
import { playerController, type PlayerTrack } from '../spotify/player'
import { LyricsPane } from './LyricsPane'
import { PasteDialog, ReadingDialog, VersionsDialog } from './LyricsDialogs'
import { PerformanceView } from './PerformanceView'
import { DEFAULT_PRACTICE_SETTINGS, type PracticeSettings } from '../practice/settings'
import { SectionPanel } from './SectionPanel'
import { TapSync } from './TapSync'
import { TimingControl, Transport } from './Transport'

type Overlay = null | 'tapsync' | 'performance' | 'paste' | 'versions'

const NO_FIXES: Record<string, string> = {}

/** Line-index-keyed prefs no longer line up once the lyrics text changes, so clear them. */
const resetLineKeyedPrefs = (p: TrackPrefs): TrackPrefs => ({
  ...p,
  sectionStarts: undefined,
  sectionNames: {},
  mastery: {},
  hide: {},
})

export function SongView({ track }: { track: PlayerTrack }) {
  const player = usePlayer()
  const { state: lyricsState, replace, refetch } = useLyrics(track)
  const [prefs, updatePrefs] = useTrackPrefs(track.id)
  const practice = usePractice()
  const [settings, setSettings] = useLocalSetting<PracticeSettings>('practice', DEFAULT_PRACTICE_SETTINGS)
  const [selection, setSelection] = useState<{ from: number; to: number } | null>(null)
  const [editSplits, setEditSplits] = useState(false)
  const [overlay, setOverlay] = useState<Overlay>(null)
  const peek = useKeyHeld('h')
  const [testMode, setTestMode] = useState(false)
  const [justPassed, setJustPassed] = useState<number | null>(null)
  const [romajiMode, setRomajiMode] = useLocalSetting<RomajiMode>('romaji', 'below')
  const [fixReadings, setFixReadings] = useState(false)
  const [fixingWord, setFixingWord] = useState<RomajiWord | null>(null)
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
  const readingFixes = prefs.readings ?? NO_FIXES
  const romaji = useRomaji(lines, readingFixes)
  const romajiLines = romajiMode === 'off' ? null : romaji.lines
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
  const onSectionPassed = useCallback(
    (sectionIndex: number) => {
      markLearned(sectionIndex, true)
      setJustPassed(sectionIndex)
    },
    [markLearned],
  )
  useEffect(() => {
    if (justPassed === null) return
    const id = window.setTimeout(() => setJustPassed(null), 2500)
    return () => window.clearTimeout(id)
  }, [justPassed])
  const testAttempt = useTestMode(testMode && synced, songTimings, peek, onSectionPassed)
  const learnedCount = sections.filter((s) => prefs.mastery[s.startLine] === 3).length

  const startSection = useCallback(
    (sectionIndex: number) => {
      const t = songTimings[sectionIndex]
      if (!t) return
      playerController.activate()
      void playerController.seek(t.startMs - settings.leadInMs).then(() => playerController.resume())
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
  const hideFor = useCallback(
    (lineIndex: number): HideLevel => {
      const s = sectionOfLine(lineIndex)
      return s ? hideForSection(s) : 0
    },
    [sectionOfLine, hideForSection],
  )
  const masteryFor = useCallback((s: Section): Mastery => prefs.mastery[s.startLine] ?? 0, [prefs.mastery])

  // Practice actions.
  const { start: startPractice, stop: stopPractice } = practice
  const loop = useCallback(
    (from: number, to: number) => {
      if (!synced || sections.length === 0) return
      playerController.activate()
      setSelection({ from, to })
      startPractice(chainPlan(songTimings, from, to, settings.loopReps), settings)
    },
    [synced, sections.length, songTimings, settings, startPractice],
  )
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
      void playerController.seek(t - offset - 500)
      if (player.paused) void playerController.resume()
    },
    [lines, offset, activeLines, stopPractice, player.paused],
  )

  const selectSection = (index: number, extend: boolean) => {
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

  const setOffset = useCallback(
    (ms: number) => updatePrefs((p) => ({ ...p, offsetMs: Math.max(-5000, Math.min(5000, Math.round(ms))) })),
    [updatePrefs],
  )

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
      switch (e.key) {
        case ' ':
          e.preventDefault()
          void playerController.togglePlay()
          break
        case 'ArrowLeft':
          e.preventDefault()
          void playerController.seek(pos - 5000)
          break
        case 'ArrowRight':
          e.preventDefault()
          void playerController.seek(pos + 5000)
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
          else if (practice.status) stopPractice()
          else if (editSplits) setEditSplits(false)
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
    editSplits,
    setOffset,
    offset,
  ])

  const practiceRange = practice.status
    ? { startMs: practice.status.step.startMs, endMs: practice.status.step.endMs }
    : selection && synced && songTimings[selection.from] && songTimings[selection.to]
      ? { startMs: songTimings[selection.from].startMs, endMs: songTimings[selection.to].endMs }
      : null

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
            {testMode && synced && (
              <div className="test-banner">
                <div>
                  <strong>Test mode</strong> · {learnedCount} of {sections.length} sections learned
                  <div className="muted small">
                    Sing without the words. A section is marked learned when it plays from start to end
                    without pausing, skipping or peeking (hold H to peek).
                  </div>
                </div>
                <div className="test-banner-actions">
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
              romajiMode={romajiMode}
              currentLine={currentLine}
              hideFor={hideFor}
              peek={peek}
              activeLines={activeLines}
              selection={selection}
              mastery={masteryFor}
              editSplits={editSplits}
              onToggleSplit={toggleSplit}
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

      <aside className="song-side">
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

        {synced && <TimingControl offsetMs={offset} onChange={setOffset} />}

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
            onSettings={setSettings}
            onLoop={loop}
            onBuildUp={buildUp}
            practice={practice.status}
            finished={practice.finished}
            onStop={stopPractice}
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
                  {Object.keys(readingFixes).length > 0 && (
                    <div className="fix-list">
                      {Object.entries(readingFixes).map(([source, reading]) => (
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
            <p className="muted small">
              {saved.source === 'user' ? 'Added by you' : saved.label} · {synced ? 'timed' : 'not timed'}
            </p>
          )}
          <div className="tool-buttons">
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
            updatePrefs((p) => {
              const readings = { ...p.readings }
              if (reading === null || reading === fixingWord.standard) delete readings[fixingWord.source]
              else readings[fixingWord.source] = reading
              return { ...p, readings }
            })
            setFixingWord(null)
          }}
        />
      )}
    </main>
  )
}
