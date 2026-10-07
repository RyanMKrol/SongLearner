// The karaoke set page: your learned songs, how to order them, and the results of a set.
import { useState } from 'react'
import { formatTime, usePlayer } from '../hooks'
import type { KaraokeOrder, SongSet } from '../karaoke'
import { loadLearnedSongs } from '../practice/storage'

/** The karaoke set page: your learned songs, how to order them, and the last set's results. */
export function KaraokePage({
  set,
  onOpenSong,
  onDone,
}: {
  set: SongSet
  onOpenSong: (trackId: string) => void
  onDone: () => void
}) {
  const player = usePlayer()
  // Read fresh each time: a set's results can send songs back to learning.
  const songs = loadLearnedSongs()
  const [order, setOrder] = useState<KaraokeOrder>('recent')
  const ready = player.status === 'ready' && Boolean(player.deviceId)

  if (set.finished) {
    const perfect = set.finished.filter((r) => r.passed.length >= r.song.sections).length
    return (
      <main className="home">
        <section className="home-hero">
          <h2>{set.title}: finished</h2>
          <p className="muted">
            {perfect} of {set.finished.length} {set.finished.length === 1 ? 'song' : 'songs'} sung all the way
            through from memory.
          </p>
        </section>
        <div className="karaoke-results">
          {set.finished.map((r) => {
            const missed = r.song.sections - r.passed.length
            return (
              <div key={r.song.id} className="karaoke-result">
                {r.song.imageUrl ? <img src={r.song.imageUrl} alt="" /> : <span className="art-placeholder" />}
                <div className="karaoke-result-text">
                  <strong>{r.song.name}</strong>
                  <span className="muted small">{r.song.artists.join(', ')}</span>
                </div>
                <span className={`karaoke-score ${missed === 0 ? 'is-perfect' : ''}`}>
                  {r.passed.length}/{r.song.sections} sections
                </span>
                {missed > 0 &&
                  (r.sentBack ? (
                    <span className="muted small">Back in learning</span>
                  ) : (
                    <button
                      className="btn btn-small"
                      title="Mark the sections you didn't get through as not learned yet"
                      onClick={() => set.sendBack(r.song.id)}
                    >
                      Send back to learning
                    </button>
                  ))}
              </div>
            )
          })}
        </div>
        <div className="home-actions">
          <button className="btn btn-primary" onClick={onDone}>
            Done
          </button>
        </div>
        <p className="muted small">
          A section counts when you sing it from start to end without pausing, skipping or peeking. Sections
          missed because a song was skipped count as missed too.
        </p>
      </main>
    )
  }

  return (
    <main className="home">
      <section className="home-hero">
        <h2>Karaoke set</h2>
        <p className="muted">
          Every song you&apos;ve fully learned, back to back, with the words hidden. Sing them from memory and see what
          stuck.
        </p>
        {songs.length > 0 ? (
          <div className="home-actions">
            <label className="inline-field">
              <span className="muted small">Order</span>
              <select value={order} onChange={(e) => setOrder(e.target.value as KaraokeOrder)}>
                <option value="recent">Most recently learned first</option>
                <option value="least-rehearsed">Least recently rehearsed first</option>
                <option value="shuffle">Shuffle</option>
              </select>
            </label>
            <button
              className="btn btn-primary"
              disabled={!ready}
              onClick={() => {
                const first = set.startKaraoke(order)
                if (first) onOpenSong(first)
              }}
            >
              Start the set ({songs.length} {songs.length === 1 ? 'song' : 'songs'})
            </button>
          </div>
        ) : (
          <p className="muted">
            No songs here yet. A song joins the set once every section is learned: use test mode (T) on a song and
            sing each section through, or mark sections as known yourself.
          </p>
        )}
      </section>

      {songs.length > 0 && (
        <div className="karaoke-results">
          {songs.map((song) => {
            const last = song.rehearsals.at(-1)
            return (
              <div key={song.id} className="karaoke-result">
                {song.imageUrl ? <img src={song.imageUrl} alt="" /> : <span className="art-placeholder" />}
                <div className="karaoke-result-text">
                  <strong>{song.name}</strong>
                  <span className="muted small">
                    {song.artists.join(', ')} · {formatTime(song.durationMs)}
                  </span>
                </div>
                <span className="muted small">
                  Learned {new Date(song.completedAt).toLocaleDateString()}
                  {last
                    ? ` · last set: ${last.passed}/${last.total} on ${new Date(last.at).toLocaleDateString()}`
                    : ' · not rehearsed yet'}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </main>
  )
}
