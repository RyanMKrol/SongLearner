import { useEffect, useState, type ReactNode } from 'react'
import { formatTime } from '../hooks'
import { cleanTrackName, searchLrclib, type LrclibRecord } from '../lyrics/lrclib'
import type { PlayerTrack } from '../spotify/player'

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

/** Lets you pick a different LRCLIB entry, e.g. one recorded from the right album version. */
export function VersionsDialog({
  track,
  onPick,
  onClose,
}: {
  track: PlayerTrack
  onPick: (record: LrclibRecord) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState(`${cleanTrackName(track.name)} ${track.artists[0] ?? ''}`.trim())
  const [results, setResults] = useState<LrclibRecord[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    const id = window.setTimeout(() => {
      setResults(null)
      searchLrclib({ q: query }, controller.signal)
        .then((records) => {
          const target = track.durationMs / 1000
          // Closest duration first: that's usually the same recording.
          records.sort((a, b) => Math.abs((a.duration ?? 9999) - target) - Math.abs((b.duration ?? 9999) - target))
          setResults(records)
          setError(null)
        })
        .catch((e: unknown) => !controller.signal.aborted && setError(e instanceof Error ? e.message : String(e)))
    }, 300)
    return () => {
      controller.abort()
      window.clearTimeout(id)
    }
  }, [query, track.durationMs])

  return (
    <Modal title="Choose lyrics" onClose={onClose}>
      <p className="muted small">
        If the timing is off, a version with a duration close to {formatTime(track.durationMs)} usually fits best.
      </p>
      <input className="search-input" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
      {error && <p className="error-text">{error}</p>}
      <div className="versions">
        {results === null && !error && <p className="muted">Searching…</p>}
        {results?.length === 0 && <p className="muted">No matches on LRCLIB.</p>}
        {results?.map((r) => {
          const diff = r.duration === null ? null : Math.round(r.duration - track.durationMs / 1000)
          return (
            <button key={r.id} className="version" onClick={() => onPick(r)}>
              <span className="version-main">
                <strong>{r.trackName}</strong> · {r.artistName}
                <span className="muted small"> · {r.albumName ?? 'unknown album'}</span>
              </span>
              <span className="version-meta small">
                {r.syncedLyrics ? (
                  <span className="tag tag-good">timed</span>
                ) : r.instrumental ? (
                  <span className="tag">instrumental</span>
                ) : (
                  <span className="tag">plain</span>
                )}
                {r.duration !== null && (
                  <span className={diff !== null && Math.abs(diff) <= 3 ? 'good' : 'muted'}>
                    {formatTime(r.duration * 1000)}
                    {diff !== null && diff !== 0 ? ` (${diff > 0 ? '+' : ''}${diff}s)` : ''}
                  </span>
                )}
              </span>
            </button>
          )
        })}
      </div>
    </Modal>
  )
}

export function PasteDialog({ onSave, onClose }: { onSave: (text: string) => void; onClose: () => void }) {
  const [text, setText] = useState('')
  return (
    <Modal title="Paste lyrics" onClose={onClose}>
      <p className="muted small">
        Paste plain lyrics (leave a blank line between verses), or LRC with timestamps like{' '}
        <code>[00:12.34] line</code>. Plain lyrics can be timed afterwards.
      </p>
      <textarea className="paste-area" value={text} onChange={(e) => setText(e.target.value)} autoFocus rows={16} />
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!text.trim()} onClick={() => onSave(text)}>
          Use these lyrics
        </button>
      </div>
    </Modal>
  )
}
