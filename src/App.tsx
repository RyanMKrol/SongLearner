import { useEffect, useState } from 'react'
import { Home } from './components/Home'
import { Landing } from './components/Landing'
import { SongView } from './components/SongView'
import { TopBar } from './components/TopBar'
import { usePlayer } from './hooks'
import { getProfile } from './spotify/api'
import { AUTH_LOST_EVENT, handleCallback, hasClientId, isLoggedIn, logout } from './spotify/auth'
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
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const onLost = () => {
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
  const [view, setView] = useState<'home' | 'song'>('home')
  const [notPremium, setNotPremium] = useState(false)

  useEffect(() => {
    void playerController.connect()
    getProfile()
      .then((p) => setNotPremium(p.product !== undefined && p.product !== 'premium'))
      .catch(() => {})
  }, [])

  // Follow the player: when a new track starts playing here, show it.
  const trackId = player.track?.id
  const [seenTrackId, setSeenTrackId] = useState(trackId)
  if (trackId !== seenTrackId) {
    setSeenTrackId(trackId)
    if (trackId) setView('song')
  }

  return (
    <div className="app">
      <TopBar onHome={() => setView('home')} onLogout={onLogout} onPicked={() => setView('song')} />
      {notPremium && (
        <div className="banner banner-error">
          This Spotify account isn&apos;t on Premium. The in-browser player needs full Premium.
        </div>
      )}
      {player.status === 'error' && <div className="banner banner-error">{player.error}</div>}
      {player.status !== 'error' && player.error && <div className="banner">{player.error}</div>}
      {view === 'song' && player.track ? (
        <SongView key={player.track.id} track={player.track} />
      ) : (
        <Home onOpenSong={() => setView('song')} />
      )}
    </div>
  )
}
