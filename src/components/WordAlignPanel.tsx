import { useCallback, useEffect, useRef, useState } from 'react'
import { log } from '../log'
import {
  AlignError,
  alignerInstalled,
  cancelAlignment,
  getAlignState,
  isActive,
  startAlignment,
  toWordTiming,
  uploadAudio,
  type AlignState,
  type alignmentLines,
  type WordTiming,
} from '../lyrics/wordAlign'

const POLL_MS = 1500

/**
 * Karaoke fill: finds when each word is sung by aligning the lyrics to a copy of the song's audio
 * (from YouTube, or a file you upload). Optional; songs without it highlight whole lines as before.
 * With `autoAlign` on, a song that has never been aligned is queued as soon as it's opened.
 */
export function WordAlignPanel({
  trackId,
  artist,
  title,
  durationMs,
  ready,
  notReadyReason,
  buildLines,
  timing,
  onTiming,
  fillOn,
  onFillOn,
  autoAlign,
  onAutoAlign,
}: {
  trackId: string
  artist: string
  title: string
  durationMs: number
  /** False until the lyrics are timed (and the romaji is ready, for Japanese songs). */
  ready: boolean
  notReadyReason: string
  buildLines: () => ReturnType<typeof alignmentLines>
  timing: WordTiming | undefined
  onTiming: (timing: WordTiming) => void
  fillOn: boolean
  onFillOn: (on: boolean) => void
  autoAlign: boolean
  onAutoAlign: (on: boolean) => void
}) {
  const [installed, setInstalled] = useState<boolean | null>(null)
  const [state, setState] = useState<AlignState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [changing, setChanging] = useState(false)
  const [link, setLink] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const savedAt = timing?.alignedAt ?? 0

  const refresh = useCallback(async () => {
    try {
      const next = await getAlignState(trackId)
      setState(next)
      const job = next.job
      // Save a finished job's timings once (a job that finished before they were saved).
      if (job?.state === 'done' && job.startedAt > savedAt) {
        const result = toWordTiming(job, buildLines(), next.source)
        if (result) {
          log('align', 'word timings saved', { lines: Object.keys(result.lines).length, offsetMs: result.offsetMs })
          onTiming(result)
          setChanging(false)
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [trackId, savedAt, buildLines, onTiming])

  // On opening the song; polling below takes over while a job runs.
  const refreshRef = useRef(refresh)
  useEffect(() => {
    refreshRef.current = refresh
  })
  useEffect(() => {
    alignerInstalled()
      .then(setInstalled)
      .catch(() => setInstalled(false))
      .finally(() => void refreshRef.current())
  }, [trackId])

  const active = isActive(state?.job)
  useEffect(() => {
    if (!active) return
    const id = window.setInterval(() => void refresh(), POLL_MS)
    return () => window.clearInterval(id)
  }, [active, refresh])

  const start = useCallback(
    async (youtubeUrl?: string, auto = false) => {
      setError(null)
      try {
        const { job } = await startAlignment(trackId, { artist, title, durationMs, lines: buildLines(), youtubeUrl, auto })
        setState((s) => ({ source: s?.source ?? null, job }))
      } catch (e) {
        setError(e instanceof AlignError || e instanceof Error ? e.message : String(e))
      }
    },
    [trackId, artist, title, durationMs, buildLines],
  )

  const cancel = async () => {
    try {
      const { job } = await cancelAlignment(trackId)
      setState((s) => ({ source: s?.source ?? null, job }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // A song that's never been tried (no audio, no job, no timings) is queued when it's opened. One
  // that failed or was cancelled isn't retried by itself.
  const autoTried = useRef<string | null>(null)
  const untried = state !== null && !state.source && !state.job && !timing
  useEffect(() => {
    if (!autoAlign || installed !== true || !ready || !untried || autoTried.current === trackId) return
    autoTried.current = trackId
    log('align', 'queueing automatically', { trackId })
    void start(undefined, true)
  }, [autoAlign, installed, ready, untried, trackId, start])

  const upload = async (file: File) => {
    setError(null)
    try {
      const { source } = await uploadAudio(trackId, file)
      setState({ source, job: null })
      await start()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  if (installed === false) {
    return (
      <div className="align-box">
        <span className="small">
          <strong>Karaoke fill</strong>
        </span>
        <p className="muted small">
          Fills in each word as it&apos;s sung. It needs a one-off setup: run <code>npm run aligner:setup</code>, then
          restart the dev server. The first song aligned also downloads about 1.3GB of models, once.
        </p>
      </div>
    )
  }

  const job = state?.job
  const source = state?.source ?? timing?.source ?? null
  const failed = job?.state === 'failed' ? job.error?.message : null
  const lineCount = timing ? Object.keys(timing.lines).length : 0

  return (
    <div className="align-box">
      <div className="panel-title-row">
        <span className="small">
          <strong>Karaoke fill</strong>
          {timing && <span className="muted"> · {lineCount} lines timed word by word</span>}
        </span>
        {timing && (
          <label className="inline-field checkbox">
            <input type="checkbox" checked={fillOn} onChange={(e) => onFillOn(e.target.checked)} />
            <span className="small">Show</span>
          </label>
        )}
      </div>

      {active ? (
        <div className="align-progress">
          <p className="small">
            <span className="spinner" aria-hidden="true" />{' '}
            {job?.state === 'queued'
              ? `Queued: waiting for ${job.ahead ?? 1} other ${job.ahead === 1 ? 'song' : 'songs'} to finish first`
              : `${job?.message ?? 'Working'}${job?.pct != null ? ` (${job.pct}%)` : ''}…`}
          </p>
          <button className="btn btn-small btn-ghost" onClick={() => void cancel()}>
            Cancel
          </button>
        </div>
      ) : !timing ? (
        <>
          <p className="muted small">
            Fills in each word as it&apos;s sung. It finds the song on YouTube, separates the vocals and works out when
            each word starts, in about two minutes. You can leave the song while it runs.
          </p>
          {job?.state === 'cancelled' && <p className="muted small">Cancelled.</p>}
          <button className="btn btn-small btn-primary" disabled={!ready} title={ready ? undefined : notReadyReason} onClick={() => void start()}>
            Align words to the music
          </button>
          {!ready && <span className="muted small"> {notReadyReason}</span>}
        </>
      ) : null}

      {(failed || error) && <p className="error-text small">{failed ?? error}</p>}

      {source && !active && (
        <p className="muted small">
          Audio:{' '}
          {source.url ? (
            <a href={source.url} target="_blank" rel="noreferrer">
              {source.title}
            </a>
          ) : (
            source.title
          )}
          {source.channel ? ` · ${source.channel}` : ''}
          {source.kind === 'upload' ? ' (your file)' : ''}
        </p>
      )}

      {!active && (timing || source || failed) && (
        <div className="tool-buttons">
          <button className="btn btn-small" onClick={() => setChanging((v) => !v)}>
            {changing ? 'Cancel' : 'Change audio'}
          </button>
          {(timing || source) && (
            <button className="btn btn-small btn-ghost" disabled={!ready} onClick={() => void start()} title="Align again with the same audio">
              Align again
            </button>
          )}
        </div>
      )}

      {changing && !active && (
        <div className="align-change">
          <p className="muted small">
            If the fill is off, the audio may be a different version of the song. Use a YouTube link to the right one,
            or upload a file.
          </p>
          <div className="align-link-row">
            <input
              className="search-input"
              placeholder="https://www.youtube.com/watch?v=…"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && link.trim()) void start(link.trim())
              }}
            />
            <button className="btn btn-small btn-primary" disabled={!link.trim() || !ready} onClick={() => void start(link.trim())}>
              Use link
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="audio/*,.webm,.mp4"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) void upload(file)
            }}
          />
          <button className="btn btn-small" disabled={!ready} onClick={() => fileRef.current?.click()}>
            Upload an audio file…
          </button>
        </div>
      )}

      <label className="inline-field checkbox">
        <input type="checkbox" checked={autoAlign} onChange={(e) => onAutoAlign(e.target.checked)} />
        <span className="small muted">Align new songs automatically when they&apos;re first opened</span>
      </label>
    </div>
  )
}
