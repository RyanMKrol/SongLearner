// The karaoke set page: its songs, adding and removing them, how to order them, and a set's results.
import { useState } from 'react'
import { formatTime, usePlayer } from '../hooks'
import { log } from '../log'
import type { KaraokeOrder, SongSet } from '../karaoke'
import { loadKaraokeSongs, loadLibrary, loadSavedLyrics, masterySummary, setInKaraokeSet } from '../practice/storage'

/** The karaoke set page: its songs, adding and removing them, how to order them, and the last set's results. */
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
  const songs = loadKaraokeSongs()
  const inSet = new Set(songs.map((s) => s.id))
  const others = loadLibrary().filter((e) => !inSet.has(e.id))
  const [, setChanges] = useState(0)
  const choose = (trackId: string, join: boolean) => {
    log('karaoke', join ? 'added by hand' : 'taken out by hand', { trackId })
    setInKaraokeSet(trackId, join)
    setChanges((n) => n + 1)
  }
  const [order, setOrder] = useState<KaraokeOrder>('recent')
  const ready = player.status === 'ready' && Boolean(player.deviceId)

  if (set.finished) {
    const perfect = set.finished.filter((r) => r.song.sections > 0 && r.passed.length >= r.song.sections).length
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
                {r.song.sections > 0 ? (
                  <span className={`karaoke-score ${missed === 0 ? 'is-perfect' : ''}`}>
                    {r.passed.length}/{r.song.sections} sections
                  </span>
                ) : (
                  <span className="muted small">Not sung</span>
                )}
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
          Every song you&apos;ve fully learned, plus any you add here, back to back, with the words hidden. Sing them
          from memory and see what stuck.
        </p>
        {songs.length > 0 ? (
          <div className="home-actions">
            <label className="inline-field">
              <span className="muted small">Order</span>
              <select value={order} onChange={(e) => setOrder(e.target.value as KaraokeOrder)}>
                <option value="recent">Most recently added first</option>
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
            {others.length > 0 && ' Or add songs straight away below.'}
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
                  {song.addedByHand ? 'Added' : 'Learned'} {new Date(song.joinedAt).toLocaleDateString()}
                  {last
                    ? ` · last set: ${last.passed}/${last.total} on ${new Date(last.at).toLocaleDateString()}`
                    : ' · not rehearsed yet'}
                </span>
                <button
                  className="btn btn-small btn-ghost karaoke-row-action"
                  title="Take this song out of the karaoke set. Your progress on it is kept."
                  aria-label={`Take ${song.name} out of the karaoke set`}
                  onClick={() => choose(song.id, false)}
                >
                  ✕
                </button>
              </div>
            )
          })}
        </div>
      )}

      {others.length > 0 && (
        <section>
          <h3 className="section-title">Add to the set</h3>
          <div className="karaoke-results">
            {others.map((song) => {
              const summary = masterySummary(song.id)
              // The set scores you on timed sections, so a song without timed lyrics has nothing to sing against.
              const timed = loadSavedLyrics(song.id)?.synced ?? false
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
                    {!timed
                      ? 'Needs timed lyrics'
                      : summary?.complete
                        ? 'Learned, taken out of the set'
                        : summary
                          ? `${summary.known} of ${summary.total} sections learned`
                          : 'Not started'}
                  </span>
                  {timed && (
                    <button className="btn btn-small karaoke-row-action" onClick={() => choose(song.id, true)}>
                      Add
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      )}
    </main>
  )
}
