import { useEffect, useState } from 'react'
import { log } from '../log'
import { alignmentRequestFor } from '../lyrics/alignSong'
import {
  alignerInstalled,
  cancelAlignment,
  listAlignJobs,
  startAlignment,
  type AlignJobRow,
  type AudioSource,
} from '../lyrics/wordAlign'
import { loadLibrary, loadPrefs, type LibraryEntry } from '../practice/storage'

const POLL_ACTIVE_MS = 2000
const POLL_IDLE_MS = 10000

const STATE_LABELS: Record<AlignJobRow['state'], string> = {
  queued: 'Queued',
  running: 'Aligning',
  done: 'Aligned',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

function ago(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return new Date(ms).toLocaleDateString()
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

/** A job's step-by-step log, behind a toggle. */
function JobLog({ log: entries }: { log: AlignJobRow['log'] }) {
  const [open, setOpen] = useState(false)
  if (entries.length === 0) return null
  return (
    <div className="job-log">
      <button className="link small" onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide log' : `Show log (${entries.length})`}
      </button>
      {open && (
        <pre className="job-log-lines">
          {entries
            .map((e) => `${new Date(e.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}  ${e.message}`)
            .join('\n')}
        </pre>
      )}
    </div>
  )
}

function SourceLink({ source }: { source: AudioSource | null | undefined }) {
  if (!source) return <span className="muted">no audio yet</span>
  const label = `${source.title}${source.channel ? ` · ${source.channel}` : ''}`
  if (source.kind === 'upload') return <span>{source.title} (your file)</span>
  return source.url ? (
    <a href={source.url} target="_blank" rel="noreferrer">
      {label}
    </a>
  ) : (
    <span>{label}</span>
  )
}

/** Progress of the karaoke fill's word alignment for every song: the queue, the running job and past results. */
export function AlignmentsPage({ onOpenSong }: { onOpenSong: (trackId: string) => void }) {
  const [rows, setRows] = useState<AlignJobRow[] | null>(null)
  const [installed, setInstalled] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  /** Per song: why it couldn't be queued, or that it's being prepared. */
  const [queueing, setQueueing] = useState<Record<string, string>>({})

  const active = rows?.some((r) => r.state === 'queued' || r.state === 'running') ?? false
  useEffect(() => {
    let cancelled = false
    const load = () =>
      listAlignJobs()
        .then((jobs) => {
          if (cancelled) return
          setRows(jobs)
          setError(null)
        })
        .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
    void load()
    const id = window.setInterval(() => void load(), active ? POLL_ACTIVE_MS : POLL_IDLE_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [active, tick])

  useEffect(() => {
    alignerInstalled()
      .then(setInstalled)
      .catch(() => setInstalled(false))
  }, [])

  const library = loadLibrary()
  const names = new Map(library.map((e) => [e.id, { name: e.name, artists: e.artists.join(', ') }]))
  const withJob = new Set(rows?.map((r) => r.trackId))
  // Songs aligned before results were kept on the server only have their timings in the song's data.
  const earlier = library.flatMap((e) => {
    const timing = withJob.has(e.id) ? undefined : loadPrefs(e.id).wordTiming
    return timing ? [{ entry: e, timing }] : []
  })
  const untouched = library.filter((e) => !withJob.has(e.id) && !loadPrefs(e.id).wordTiming)

  const current = rows?.filter((r) => r.state === 'running' || r.state === 'queued') ?? []
  const past = rows?.filter((r) => r.state !== 'running' && r.state !== 'queued') ?? []
  const counts = {
    running: current.filter((r) => r.state === 'running').length,
    queued: current.filter((r) => r.state === 'queued').length,
    aligned: past.filter((r) => r.state === 'done').length + earlier.length,
    failed: past.filter((r) => r.state === 'failed').length,
  }

  const cancel = (trackId: string) => {
    log('alignments', 'cancel', { trackId })
    cancelAlignment(trackId)
      .then(() => setTick((t) => t + 1))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  /** Queues songs from what's saved for them, one after another. */
  const align = async (entries: LibraryEntry[]) => {
    for (const entry of entries) {
      setQueueing((q) => ({ ...q, [entry.id]: 'Preparing…' }))
      try {
        const request = await alignmentRequestFor(entry)
        if (!request.ok) {
          setQueueing((q) => ({ ...q, [entry.id]: request.reason }))
          continue
        }
        await startAlignment(entry.id, request.body)
        setQueueing((q) => {
          const next = { ...q }
          delete next[entry.id]
          return next
        })
      } catch (e) {
        setQueueing((q) => ({ ...q, [entry.id]: e instanceof Error ? e.message : String(e) }))
      }
      setTick((t) => t + 1)
    }
  }
  const entryFor = (trackId: string) => library.find((e) => e.id === trackId)

  const songName = (r: { trackId: string; title?: string; artist?: string }) => {
    const known = names.get(r.trackId)
    return (
      <button className="link align-song" onClick={() => onOpenSong(r.trackId)} title="Open this song">
        <strong>{known?.name ?? r.title ?? r.trackId}</strong>
        <span className="muted"> · {known?.artists ?? r.artist ?? ''}</span>
      </button>
    )
  }

  return (
    <main className="home alignments-page">
      <section className="home-hero">
        <h2>Word alignment</h2>
        <p className="muted">
          The karaoke fill&apos;s background jobs. Songs are aligned one at a time; this page updates by itself.
        </p>
        {rows && (
          <p className="small">
            {counts.running} aligning · {counts.queued} queued · {counts.aligned} aligned
            {counts.failed > 0 ? ` · ${counts.failed} failed` : ''} · {untouched.length} not aligned yet
          </p>
        )}
        {installed === false && (
          <p className="error-text small">
            The aligner isn&apos;t installed. Run <code>npm run aligner:setup</code> and restart the dev server.
          </p>
        )}
        {error && <p className="error-text small">Couldn&apos;t load the jobs: {error}</p>}
      </section>

      <section className="align-section">
        <h3>Now</h3>
        {rows === null ? (
          <p className="muted small">Loading…</p>
        ) : current.length === 0 ? (
          <p className="muted small">Nothing aligning right now.</p>
        ) : (
          current.map((r) => (
            <div key={r.trackId} className={`align-row is-${r.state}`}>
              <div className="align-row-main">
                {songName(r)}
                <span className="small">
                  {r.state === 'queued' ? (
                    <>Waiting: {r.ahead} ahead</>
                  ) : (
                    <>
                      <span className="spinner" aria-hidden="true" /> {r.message}
                      {r.pct != null ? ` (${r.pct}%)` : ''}
                    </>
                  )}
                  {r.auto ? <span className="tag">automatic</span> : null}
                </span>
                {r.state === 'running' && (
                  <div className="align-bar" aria-hidden="true">
                    <span style={{ width: `${r.pct ?? 0}%` }} />
                  </div>
                )}
                <span className="muted small">
                  Queued {ago(r.startedAt)} · <SourceLink source={r.source} />
                </span>
                <JobLog log={r.log} />
              </div>
              <button className="btn btn-small btn-ghost" onClick={() => cancel(r.trackId)}>
                Cancel
              </button>
            </div>
          ))
        )}
      </section>

      <section className="align-section">
        <h3>Finished</h3>
        {past.length === 0 && earlier.length === 0 ? (
          <p className="muted small">No songs aligned yet.</p>
        ) : (
          <>
            {past.map((r) => (
              <div key={r.trackId} className={`align-row is-${r.state}`}>
                <div className="align-row-main">
                  {songName(r)}
                  <span className="small">
                    <span className={`tag align-tag-${r.state}`}>{STATE_LABELS[r.state]}</span>
                    {r.state === 'done' && (
                      <>
                        {' '}
                        {r.linesTimed}/{r.linesSent} lines timed
                        {r.offsetMs != null ? ` · audio shifted ${r.offsetMs}ms` : ''}
                      </>
                    )}
                    {r.auto ? <span className="tag">automatic</span> : null}
                  </span>
                  {r.error && <span className="error-text small">{r.error.message}</span>}
                  {queueing[r.trackId] && <span className="muted small">{queueing[r.trackId]}</span>}
                  <span className="muted small">
                    {r.finishedAt ? `${ago(r.finishedAt)} · took ${duration(r.finishedAt - r.startedAt)}` : ago(r.startedAt)} ·{' '}
                    <SourceLink source={r.source} />
                  </span>
                  <JobLog log={r.log} />
                </div>
                {r.state !== 'done' && entryFor(r.trackId) && (
                  <button className="btn btn-small" onClick={() => void align([entryFor(r.trackId)!])}>
                    Try again
                  </button>
                )}
              </div>
            ))}
            {earlier.map(({ entry, timing }) => (
              <div key={entry.id} className="align-row is-done">
                <div className="align-row-main">
                  {songName({ trackId: entry.id })}
                  <span className="small">
                    <span className="tag align-tag-done">Aligned</span> {Object.keys(timing.lines).length} lines timed
                    {` · audio shifted ${timing.offsetMs}ms`}
                  </span>
                  <span className="muted small">
                    {ago(timing.alignedAt)} · <SourceLink source={timing.source} />
                  </span>
                </div>
              </div>
            ))}
          </>
        )}
      </section>

      {untouched.length > 0 && (
        <section className="align-section">
          <div className="panel-title-row">
            <h3>Not aligned yet</h3>
            <button className="btn btn-small btn-primary" onClick={() => void align(untouched)}>
              Align all ({untouched.length})
            </button>
          </div>
          <p className="muted small">
            Queue them here, or they&apos;re queued the next time you open them (if &quot;Align new songs
            automatically&quot; is on). Songs need timed lyrics, so open a song once if it hasn&apos;t downloaded any.
          </p>
          {untouched.map((e) => (
            <div key={e.id} className="align-row">
              <div className="align-row-main">
                {songName({ trackId: e.id })}
                {queueing[e.id] && <span className="muted small">{queueing[e.id]}</span>}
              </div>
              <span className="align-row-actions">
                <button className="btn btn-small btn-ghost" onClick={() => onOpenSong(e.id)}>
                  Open
                </button>
                <button className="btn btn-small" onClick={() => void align([e])}>
                  Align
                </button>
              </span>
            </div>
          ))}
        </section>
      )}
    </main>
  )
}
