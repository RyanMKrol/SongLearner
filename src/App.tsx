import { AlignmentsPage } from './components/AlignmentsPage'
import { useEffect, useRef, useState } from 'react'
import { Home } from './components/Home'
import { KaraokePage } from './components/Karaoke'
import { useSongSet } from './karaoke'
import { PlaylistPage } from './components/Playlists'
import { Landing } from './components/Landing'
import { SongView } from './components/SongView'
import { TopBar } from './components/TopBar'
import { usePlayer } from './hooks'
import { lastPosition } from './playback/positions'
import { loadLibrary } from './practice/storage'
import { navigate, routePath, songRoute, useRoute } from './router'
import { getProfile, playTrack } from './spotify/api'
import { AUTH_LOST_EVENT, handleCallback, hasClientId, isLoggedIn, logout } from './spotify/auth'
import { log, logError, logWarn } from './log'
import { playerController } from './spotify/player'

export default function App() {
  const [ready, setReady] = useState(false)
  const [loggedIn, setLoggedIn] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void handleCallback().then((error) => {
      if (cancelled) return
      setLoginError(error)
      setLoggedIn(isLoggedIn())
      setReady(true)
      log('app', 'started', { loggedIn: isLoggedIn(), loginError: error, hasClientId: hasClientId() })
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const onLost = () => {
      logWarn('app', 'session lost; back to login')
      playerController.disconnect()
      setLoginError('Your Spotify session expired. Please log in again.')
      setLoggedIn(false)
    }
    window.addEventListener(AUTH_LOST_EVENT, onLost)
    return () => window.removeEventListener(AUTH_LOST_EVENT, onLost)
  }, [])

  if (!ready) return null

  if (!hasClientId()) {
    return (
      <div className="landing">
        <div className="landing-card">
          <h1>SongLearner</h1>
          <p>
            Set <code>VITE_SPOTIFY_CLIENT_ID</code> in <code>.env.local</code> and restart the dev
            server. See the README for setup steps.
          </p>
        </div>
      </div>
    )
  }

  if (!loggedIn) return <Landing error={loginError} />

  return (
    <Workspace
      onLogout={() => {
        playerController.disconnect()
        logout()
        setLoggedIn(false)
      }}
    />
  )
}

function Workspace({ onLogout }: { onLogout: () => void }) {
  const player = usePlayer()
  const route = useRoute()
  const karaoke = useSongSet()
  const [notPremium, setNotPremium] = useState(false)

  useEffect(() => {
    void playerController.connect()
    getProfile()
      .then((p) => {
        log('app', 'spotify profile', { product: p.product ?? 'unknown' })
        setNotPremium(p.product !== undefined && p.product !== 'premium')
      })
      .catch(() => {})
  }, [])

  // Keep the address and the player in step:
  // - when a different song starts playing (a karaoke set moving on, or a song started from your
  //   phone), show it;
  // - when the address changes to a song that isn't playing (back/forward, a refresh), play it from
  //   where you left off.
  const trackId = player.track?.id ?? null
  const deviceId = player.deviceId
  const routeKey = routePath(route)
  const previous = useRef({ trackId, routeKey })
  const requested = useRef<string | null>(null)
  useEffect(() => {
    const trackChanged = trackId !== previous.current.trackId
    previous.current = { trackId, routeKey }
    if (trackId && trackId === requested.current) requested.current = null

    if (trackChanged && trackId && (route.name === 'home' || route.name === 'song')) {
      const showing = route.name === 'song' ? route.trackId : null
      // Still switching to the song the address asked for; this is the old song's last report.
      const waiting = showing !== null && showing === requested.current
      if (showing !== trackId && !waiting) {
        navigate(songRoute(trackId), { replace: route.name === 'song' })
        return
      }
    }

    if (route.name === 'song' && deviceId && trackId !== route.trackId && requested.current !== route.trackId) {
      const target = route.trackId
      requested.current = target
      const uri = loadLibrary().find((e) => e.id === target)?.uri ?? `spotify:track:${target}`
      const position = lastPosition(target)
      log('nav', 'playing the song the address asked for', { trackId: target, position })
      playTrack(deviceId, uri, position).catch((e: unknown) => {
        logError('nav', 'could not play the song for this address', { trackId: target, error: e })
        if (requested.current === target) requested.current = null
      })
    }
  }, [trackId, routeKey, deviceId, route])

  useEffect(() => {
    log('app', 'route', { route: routeKey, trackId })
    const name = route.name === 'song' ? (player.track?.id === route.trackId ? player.track.name : null) : null
    document.title =
      route.name === 'karaoke'
        ? 'Karaoke set · SongLearner'
        : route.name === 'alignments'
          ? 'Word alignment · SongLearner'
          : name
            ? `${name} · SongLearner`
            : 'SongLearner'
    // Only the route and the shown song's name matter for the title.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey, player.track?.name])

  const openSong = (id: string) => navigate(songRoute(id))
  const songTrack = route.name === 'song' && player.track?.id === route.trackId ? player.track : null
  const songEntry = route.name === 'song' ? loadLibrary().find((e) => e.id === route.trackId) : undefined

  return (
    <div className="app">
      <TopBar
        onHome={() => navigate({ name: 'home' })}
        onKaraoke={() => navigate({ name: 'karaoke' })}
        onAlignments={() => navigate({ name: 'alignments' })}
        onLogout={onLogout}
        onPicked={openSong}
      />
      {notPremium && (
        <div className="banner banner-error">
          This Spotify account isn&apos;t on Premium. The in-browser player needs full Premium.
        </div>
      )}
      {player.status === 'error' && <div className="banner banner-error">{player.error}</div>}
      {player.status !== 'error' && player.error && <div className="banner">{player.error}</div>}
      {route.name === 'karaoke' || karaoke.finished ? (
        <KaraokePage
          set={karaoke}
          onOpenSong={openSong}
          onDone={() => {
            const back = karaoke.returnTo
            karaoke.close()
            navigate(back)
          }}
        />
      ) : route.name === 'alignments' ? (
        <AlignmentsPage onOpenSong={openSong} />
      ) : route.name === 'playlist' ? (
        <PlaylistPage playlistId={route.playlistId} set={karaoke} />
      ) : route.name === 'song' ? (
        songTrack ? (
          <SongView
            key={songTrack.id}
            track={songTrack}
            karaoke={
              karaoke.active && karaoke.current?.id === songTrack.id
                ? {
                    title: karaoke.title,
                    test: karaoke.test,
                    number: karaoke.number,
                    total: karaoke.total,
                    nextName: karaoke.nextName,
                    onPass: karaoke.onPass,
                    onNext: karaoke.next,
                    onEnd: karaoke.end,
                  }
                : null
            }
          />
        ) : (
          <main className="home">
            <p className="muted">
              {player.status === 'ready'
                ? `Loading ${songEntry?.name ?? 'the song'}…`
                : 'Connecting to Spotify…'}
            </p>
          </main>
        )
      ) : (
        <Home onOpenSong={openSong} onKaraoke={() => navigate({ name: 'karaoke' })} />
      )}
    </div>
  )
}
