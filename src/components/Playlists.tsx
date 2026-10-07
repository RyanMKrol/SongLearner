// Playlists: the + menu on song cards, the list on the home page, and each playlist's own page.
import { useEffect, useRef, useState } from 'react'
import { formatTime, usePlayer } from '../hooks'
import { ordered, type SongSet } from '../karaoke'
import { log } from '../log'
import {
  createPlaylist,
  deletePlaylist,
  loadLibrary,
  movePlaylistSong,
  playlistSongs,
  renamePlaylist,
  togglePlaylistSong,
  usePlaylists,
} from '../practice/storage'
import { navigate } from '../router'

/** The + button on a song card: tick which playlists the song is in, or start a new one. */
export function PlaylistMenu({ trackId, songName }: { trackId: string; songName: string }) {
  const playlists = usePlaylists()
  const [open, setOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const create = () => {
    if (!newName.trim()) return
    createPlaylist(newName, trackId)
    setNewName('')
  }

  return (
    <div className="playlist-menu-wrap" ref={ref}>
      <button
        className="library-add"
        title="Add to a playlist"
        aria-label={`Add ${songName} to a playlist`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        +
      </button>
      {open && (
        <div className="playlist-menu" role="menu">
          <div className="playlist-menu-head">Add to playlist</div>
          {playlists.map((p) => {
            const inList = p.trackIds.includes(trackId)
            return (
              <button
                key={p.id}
                role="menuitemcheckbox"
                aria-checked={inList}
                className={`hint-option ${inList ? 'is-current' : ''}`}
                onClick={() => togglePlaylistSong(p.id, trackId)}
              >
                <span className="hint-check">{inList ? '✓' : ''}</span>
                {p.name}
                <span className="hint-note">{p.trackIds.length}</span>
              </button>
            )
          })}
          <form
            className="playlist-menu-new"
            onSubmit={(e) => {
              e.preventDefault()
              create()
            }}
          >
            <input
              className="rename-input"
              placeholder="New playlist…"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              autoFocus={playlists.length === 0}
              aria-label="New playlist name"
            />
            <button className="btn btn-small btn-primary" type="submit" disabled={!newName.trim()}>
              Add
            </button>
          </form>
        </div>
      )}
    </div>
  )
}

/** Your playlists, on the home page. */
export function PlaylistsSection() {
  const playlists = usePlaylists()
  const library = new Map(loadLibrary().map((e) => [e.id, e]))
  if (playlists.length === 0) return null
  return (
    <section>
      <h3 className="section-title">Playlists</h3>
      <div className="playlists">
        {playlists.map((p) => {
          const covers = p.trackIds.flatMap((id) => (library.get(id)?.imageUrl ? [library.get(id)!.imageUrl!] : [])).slice(0, 4)
          return (
            <button key={p.id} className="playlist-card" onClick={() => navigate({ name: 'playlist', playlistId: p.id })}>
              <span className={`playlist-covers covers-${Math.max(covers.length, 1)}`}>
                {covers.length > 0 ? covers.map((url, i) => <img key={i} src={url} alt="" />) : <span className="art-placeholder" />}
              </span>
              <span className="library-name">{p.name}</span>
              <span className="muted small">
                {p.trackIds.length} {p.trackIds.length === 1 ? 'song' : 'songs'}
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

/** One playlist: its songs in order, and ways to play through them. */
export function PlaylistPage({ playlistId, set }: { playlistId: string; set: SongSet }) {
  const player = usePlayer()
  const playlist = usePlaylists().find((p) => p.id === playlistId)
  const [renaming, setRenaming] = useState(false)
  const [shuffle, setShuffle] = useState(false)
  const ready = player.status === 'ready' && Boolean(player.deviceId)

  if (!playlist) {
    return (
      <main className="home">
        <p className="muted">This playlist doesn&apos;t exist anymore.</p>
        <button className="btn" onClick={() => navigate({ name: 'home' })}>
          Back to your songs
        </button>
      </main>
    )
  }

  const songs = playlistSongs(playlist)
  const total = songs.reduce((ms, s) => ms + s.durationMs, 0)

  const play = (test: boolean) => {
    const queue = shuffle ? ordered(songs, 'shuffle') : songs
    log('playlists', test ? 'test started' : 'play started', { id: playlist.id, shuffle })
    const first = set.start(queue, { title: playlist.name, test, returnTo: { name: 'playlist', playlistId: playlist.id } })
    if (first) navigate({ name: 'song', trackId: first })
  }

  return (
    <main className="home">
      <section className="home-hero">
        {renaming ? (
          <input
            className="playlist-title-input"
            defaultValue={playlist.name}
            autoFocus
            aria-label="Playlist name"
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') setRenaming(false)
            }}
            onBlur={(e) => {
              renamePlaylist(playlist.id, e.target.value)
              setRenaming(false)
            }}
          />
        ) : (
          <h2 className="playlist-title" title="Click to rename" onClick={() => setRenaming(true)}>
            {playlist.name}
          </h2>
        )}
        <p className="muted">
          {songs.length} {songs.length === 1 ? 'song' : 'songs'}
          {songs.length > 0 ? ` · ${formatTime(total)}` : ''}
        </p>
        {songs.length > 0 ? (
          <div className="home-actions">
            <button className="btn btn-primary" disabled={!ready} onClick={() => play(false)} title="Go through the songs with the lyrics showing">
              ▶ Play
            </button>
            <button className="btn btn-primary" disabled={!ready} onClick={() => play(true)} title="Words hidden; see which sections you know">
              🎤 Test yourself
            </button>
            <label className="inline-field checkbox">
              <input type="checkbox" checked={shuffle} onChange={(e) => setShuffle(e.target.checked)} />
              <span className="small">Shuffle</span>
            </label>
          </div>
        ) : (
          <p className="muted">
            Empty for now. Add songs with the <strong>+</strong> on a song card on the home page.
          </p>
        )}
      </section>

      {songs.length > 0 && (
        <div className="karaoke-results">
          {songs.map((song, i) => {
            const last = song.rehearsals.at(-1)
            return (
              <div key={song.id} className="karaoke-result">
                <span className="playlist-index muted">{i + 1}</span>
                {song.imageUrl ? <img src={song.imageUrl} alt="" /> : <span className="art-placeholder" />}
                <div className="karaoke-result-text">
                  <strong>{song.name}</strong>
                  <span className="muted small">
                    {song.artists.join(', ')} · {formatTime(song.durationMs)}
                    {last ? ` · last test ${last.passed}/${last.total}` : ''}
                  </span>
                </div>
                <span className="playlist-row-actions">
                  <button className="btn btn-small btn-ghost" disabled={i === 0} onClick={() => movePlaylistSong(playlist.id, i, i - 1)} aria-label="Move up">
                    ↑
                  </button>
                  <button
                    className="btn btn-small btn-ghost"
                    disabled={i === songs.length - 1}
                    onClick={() => movePlaylistSong(playlist.id, i, i + 1)}
                    aria-label="Move down"
                  >
                    ↓
                  </button>
                  <button
                    className="btn btn-small btn-ghost"
                    onClick={() => togglePlaylistSong(playlist.id, song.id)}
                    title="Remove from this playlist (the song stays in your library)"
                    aria-label="Remove from playlist"
                  >
                    ✕
                  </button>
                </span>
              </div>
            )
          })}
        </div>
      )}

      <div className="home-actions">
        <button
          className="btn btn-small btn-ghost"
          onClick={() => {
            deletePlaylist(playlist.id)
            navigate({ name: 'home' })
          }}
        >
          Delete playlist
        </button>
      </div>
    </main>
  )
}
