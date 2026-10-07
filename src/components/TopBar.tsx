import { useEffect, useRef, useState } from 'react'
import { usePlayer } from '../hooks'
import { playTrack, searchTracks, type SpotifyTrack } from '../spotify/api'
import { playerController } from '../spotify/player'

interface Props {
  onHome: () => void
  onLogout: () => void
  onPicked: () => void
}

export function TopBar({ onHome, onLogout, onPicked }: Props) {
  return (
    <header className="topbar">
      <button className="brand" onClick={onHome} title="Your songs">
        Song<span className="accent">Learner</span>
      </button>
      <SearchBox onPicked={onPicked} />
      <button className="btn btn-ghost" onClick={onLogout}>
        Log out
      </button>
    </header>
  )
}

function SearchBox({ onPicked }: { onPicked: () => void }) {
  const player = usePlayer()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SpotifyTrack[]>([])
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [highlight, setHighlight] = useState(0)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const q = query.trim()
    if (!q) return
    let cancelled = false
    const id = window.setTimeout(() => {
      searchTracks(q)
        .then((tracks) => {
          if (cancelled) return
          setResults(tracks)
          setHighlight(0)
          setError(null)
        })
        .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(id)
    }
  }, [query])

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  const visible = query.trim() ? results : []

  const pick = async (track: SpotifyTrack) => {
    setOpen(false)
    setQuery('')
    if (!player.deviceId) {
      setError('The player is still connecting. Try again in a second.')
      return
    }
    playerController.activate()
    try {
      await playTrack(player.deviceId, track.uri)
      onPicked()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setOpen(true)
    }
  }

  return (
    <div className="search" ref={boxRef}>
      <input
        className="search-input"
        type="search"
        placeholder="Search for a song…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setHighlight((h) => Math.min(h + 1, visible.length - 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setHighlight((h) => Math.max(h - 1, 0))
          } else if (e.key === 'Enter' && visible[highlight]) {
            void pick(visible[highlight])
          } else if (e.key === 'Escape') {
            setOpen(false)
            ;(e.target as HTMLInputElement).blur()
          }
        }}
      />
      {open && (visible.length > 0 || error) && (
        <div className="search-results">
          {error && <div className="search-error">{error}</div>}
          {visible.map((track, i) => {
            const image = track.album.images.at(-1)?.url
            return (
              <button
                key={track.id}
                className={`search-result ${i === highlight ? 'is-highlighted' : ''}`}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => void pick(track)}
              >
                {image ? <img src={image} alt="" /> : <span className="art-placeholder" />}
                <span className="search-result-text">
                  <span className="search-result-name">{track.name}</span>
                  <span className="muted small">
                    {track.artists.map((a) => a.name).join(', ')} · {track.album.name}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
