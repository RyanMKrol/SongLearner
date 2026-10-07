import { useEffect, useState } from 'react'
import { Home } from './components/Home'
import { KaraokePage } from './components/Karaoke'
import { useKaraokeSet } from './karaoke'
import { Landing } from './components/Landing'
import { SongView } from './components/SongView'
import { TopBar } from './components/TopBar'
import { usePlayer } from './hooks'
import { getProfile } from './spotify/api'
import { AUTH_LOST_EVENT, handleCallback, hasClientId, isLoggedIn, logout } from './spotify/auth'
import { log, logWarn } from './log'
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
  const [view, setView] = useState<'home' | 'song' | 'karaoke'>('home')
  const karaoke = useKaraokeSet()
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

  // Follow the player: when a new track starts playing here, show it.
  const trackId = player.track?.id
  const [seenTrackId, setSeenTrackId] = useState(trackId)
  if (trackId !== seenTrackId) {
    setSeenTrackId(trackId)
    if (trackId) setView('song')
  }

  useEffect(() => log('app', 'view', { view, trackId: player.track?.id ?? null }), [view, player.track?.id])

  return (
    <div className="app">
      <TopBar
        onHome={() => setView('home')}
        onKaraoke={() => setView('karaoke')}
        onLogout={onLogout}
        onPicked={() => setView('song')}
      />
      {notPremium && (
        <div className="banner banner-error">
          This Spotify account isn&apos;t on Premium. The in-browser player needs full Premium.
        </div>
      )}
      {player.status === 'error' && <div className="banner banner-error">{player.error}</div>}
      {player.status !== 'error' && player.error && <div className="banner">{player.error}</div>}
      {view === 'karaoke' || karaoke.finished ? (
        <KaraokePage
          set={karaoke}
          onOpenSong={() => setView('song')}
          onDone={() => {
            karaoke.close()
            setView('karaoke')
          }}
        />
      ) : view === 'song' && player.track ? (
        <SongView
          key={player.track.id}
          track={player.track}
          karaoke={
            karaoke.active && karaoke.current?.id === player.track.id
              ? {
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
        <Home onOpenSong={() => setView('song')} onKaraoke={() => setView('karaoke')} />
      )}
    </div>
  )
}
