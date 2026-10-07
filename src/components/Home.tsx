import { useState } from 'react'
import { usePlayer } from '../hooks'
import { getPlaybackState, playTrack, transferPlayback } from '../spotify/api'
import { log, logError } from '../log'
import { playerController } from '../spotify/player'
import { deleteSong, loadLibrary, masterySummary, type LibraryEntry } from '../practice/storage'

export function Home({ onOpenSong }: { onOpenSong: () => void }) {
  const player = usePlayer()
  const [library, setLibrary] = useState(loadLibrary)
  const [message, setMessage] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const ready = player.status === 'ready' && player.deviceId

  const open = async (entry: LibraryEntry) => {
    log('home', 'open song', { trackId: entry.id, name: entry.name, deviceReady: Boolean(player.deviceId) })
    if (!player.deviceId) return
    playerController.activate()
    if (player.track?.id === entry.id) {
      onOpenSong()
      return
    }
    try {
      await playTrack(player.deviceId, entry.uri)
      onOpenSong()
    } catch (e) {
      logError('home', 'could not start song', { trackId: entry.id, error: e })
      setMessage(e instanceof Error ? e.message : String(e))
    }
  }

  const bringHere = async () => {
    log('home', 'use what is playing on Spotify')
    if (!player.deviceId) return
    playerController.activate()
    try {
      const state = await getPlaybackState()
      if (!state?.item) {
        setMessage('Nothing is playing on your Spotify account right now.')
        return
      }
      if (state.device.id === player.deviceId) {
        onOpenSong()
        return
      }
      await transferPlayback(player.deviceId, true)
      onOpenSong()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <main className="home">
      <section className="home-hero">
        <h2>What are we learning?</h2>
        <p className="muted">
          Search for a song above, or pull in whatever you&apos;re playing on Spotify right now.
        </p>
        <div className="home-actions">
          <button className="btn btn-primary" disabled={!ready} onClick={() => void bringHere()}>
            Use what&apos;s playing on Spotify
          </button>
          {player.track && (
            <button className="btn" onClick={onOpenSong}>
              Back to {player.track.name}
            </button>
          )}
        </div>
        <p className="muted small">
          Player:{' '}
          {player.status === 'ready'
            ? 'connected as “SongLearner”'
            : player.status === 'error'
              ? 'not available'
              : 'connecting…'}
        </p>
        {message && <p className="error-text">{message}</p>}
      </section>

      {library.length > 0 && (
        <section>
          <h3 className="section-title">Your songs</h3>
          <div className="library">
            {library.map((entry) => {
              const summary = masterySummary(entry.id)
              return (
                <div key={entry.id} className="library-card">
                  <button className="library-open" disabled={!ready} onClick={() => void open(entry)}>
                    {entry.imageUrl ? <img src={entry.imageUrl} alt="" /> : <span className="art-placeholder" />}
                    <span className="library-name">{entry.name}</span>
                    <span className="muted small">{entry.artists.join(', ')}</span>
                    {summary && (
                      <span className="library-progress small">
                        {summary.known} {summary.known === 1 ? 'section' : 'sections'} known
                      </span>
                    )}
                  </button>
                  <button
                    className="library-remove"
                    title="Delete this song and everything saved for it"
                    aria-label={`Delete ${entry.name}`}
                    onClick={() => setConfirmDelete(entry.id)}
                  >
                    ×
                  </button>
                  {confirmDelete === entry.id && (
                    <div className="library-confirm" role="alertdialog" aria-label={`Delete ${entry.name}?`}>
                      <p className="small">
                        Delete <strong>{entry.name}</strong> and everything saved for it: lyrics, your edits, sections
                        and progress?
                      </p>
                      <div className="library-confirm-actions">
                        <button
                          className="btn btn-small btn-danger"
                          onClick={() => {
                            log('home', 'delete song', { trackId: entry.id })
                            deleteSong(entry.id)
                            setConfirmDelete(null)
                            setLibrary(loadLibrary())
                          }}
                        >
                          Delete
                        </button>
                        <button className="btn btn-small" onClick={() => setConfirmDelete(null)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      )}

      <section className="tips">
        <h3 className="section-title">How to practise</h3>
        <ol>
          <li>Listen through once with the lyrics scrolling.</li>
          <li>Loop one section at a time until you can sing along.</li>
          <li>Use Build up to chain sections: A, then A+B, then A+B+C.</li>
          <li>Turn on Memorise to fade the words to first letters, then hide them.</li>
          <li>Finish with Performance mode for a full run-through.</li>
        </ol>
        <p className="muted small">
          Shortcuts: Space play/pause · ←/→ 5 seconds · ↑/↓ previous/next line · L loop the current
          section · Esc stop looping · F performance mode · hold H to peek at hidden words · [ and ]
          nudge lyric timing
        </p>
      </section>
    </main>
  )
}
