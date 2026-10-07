// Wraps the Spotify Web Playback SDK: loads the script, creates the "SongLearner" device in this
// tab, and exposes a small store that React can subscribe to.
import { PlaybackClock } from '../playback/clock'
import { getAccessToken } from './auth'

const SDK_URL = 'https://sdk.scdn.co/spotify-player.js'
const POLL_MS = 1000

export interface PlayerTrack {
  id: string
  uri: string
  name: string
  artists: string[]
  album: string
  imageUrl: string | null
  durationMs: number
}

export interface PlayerSnapshot {
  status: 'idle' | 'connecting' | 'ready' | 'error'
  deviceId: string | null
  error: string | null
  track: PlayerTrack | null
  paused: boolean
  /** Bumps whenever the SDK reports a new state, so views can react to seeks. */
  version: number
}

let sdkPromise: Promise<void> | null = null

function loadSdk(): Promise<void> {
  sdkPromise ??= new Promise<void>((resolve, reject) => {
    if (window.Spotify) {
      resolve()
      return
    }
    window.onSpotifyWebPlaybackSDKReady = () => resolve()
    const script = document.createElement('script')
    script.src = SDK_URL
    script.async = true
    script.onerror = () => reject(new Error('Could not load the Spotify Web Playback SDK'))
    document.body.appendChild(script)
  })
  return sdkPromise
}

function toTrack(t: Spotify.Track): PlayerTrack {
  // When Spotify relinks a track (e.g. a regional version), keep the ID the user picked.
  const id = t.linked_from?.id ?? t.id ?? t.uri
  const uri = t.linked_from?.uri ?? t.uri
  const images = [...(t.album.images ?? [])].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))
  return {
    id,
    uri,
    name: t.name,
    artists: t.artists.map((a) => a.name),
    album: t.album.name,
    imageUrl: images[0]?.url ?? null,
    durationMs: t.duration_ms,
  }
}

const ERROR_MESSAGES: Record<string, string> = {
  account_error: 'Spotify says this account can\'t use the web player. It needs full Spotify Premium.',
  authentication_error: 'Spotify rejected the login for the web player. Try logging out and in again.',
  initialization_error: 'The Spotify web player could not start in this browser.',
  playback_error: 'Spotify couldn\'t play that track.',
}

class PlayerController {
  readonly clock = new PlaybackClock()
  private player: Spotify.Player | null = null
  private pollTimer: number | null = null
  private listeners = new Set<() => void>()
  private snapshot: PlayerSnapshot = {
    status: 'idle',
    deviceId: null,
    error: null,
    track: null,
    paused: true,
    version: 0,
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): PlayerSnapshot => this.snapshot

  private update(patch: Partial<PlayerSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    this.listeners.forEach((l) => l())
  }

  async connect(): Promise<void> {
    if (this.player || this.snapshot.status === 'connecting') return
    this.update({ status: 'connecting', error: null })
    try {
      await loadSdk()
    } catch (e) {
      this.update({ status: 'error', error: e instanceof Error ? e.message : String(e) })
      return
    }

    const player = new window.Spotify.Player({
      name: 'SongLearner',
      volume: 0.8,
      getOAuthToken: (cb) => {
        getAccessToken()
          .then(cb)
          .catch((e) => this.update({ status: 'error', error: String(e) }))
      },
    })
    this.player = player

    player.addListener('ready', ({ device_id }) => {
      this.update({ status: 'ready', deviceId: device_id, error: null })
    })
    player.addListener('not_ready', () => {
      this.update({ status: 'connecting' })
    })
    player.addListener('player_state_changed', (state) => this.applyState(state))
    player.addListener('autoplay_failed', () => {
      this.update({ error: 'The browser blocked autoplay. Press play to start.' })
    })
    for (const type of ['account_error', 'authentication_error', 'initialization_error'] as const) {
      player.addListener(type, ({ message }) => {
        this.update({ status: 'error', error: `${ERROR_MESSAGES[type]} (${message})` })
      })
    }
    player.addListener('playback_error', ({ message }) => {
      this.update({ error: `${ERROR_MESSAGES.playback_error} (${message})` })
    })

    const ok = await player.connect()
    if (!ok) this.update({ status: 'error', error: 'Could not connect to Spotify.' })

    this.pollTimer = window.setInterval(() => void this.poll(), POLL_MS)
  }

  private applyState(state: Spotify.PlaybackState | null): void {
    if (!state) {
      // Playback moved to another device.
      this.clock.setPlaying(false)
      this.update({ paused: true, version: this.snapshot.version + 1 })
      return
    }
    // `timestamp` is when the SDK produced this state. Use it to correct for delivery delay,
    // but only if it looks sane (clock skew could make it nonsense).
    const lag = Date.now() - state.timestamp
    const position = state.paused || lag < 0 || lag > 2000 ? state.position : state.position + lag
    this.clock.sync(position, state.paused, state.duration)

    const current = state.track_window.current_track
    const track = current ? toTrack(current) : null
    const sameTrack = track?.id === this.snapshot.track?.id
    this.update({
      track: sameTrack ? this.snapshot.track : track,
      paused: state.paused,
      version: this.snapshot.version + 1,
    })
  }

  private async poll(): Promise<void> {
    if (!this.player || this.snapshot.paused) return
    const state = await this.player.getCurrentState()
    if (!state) return
    const lag = Date.now() - state.timestamp
    const position = state.paused || lag < 0 || lag > 2000 ? state.position : state.position + lag
    // Small corrections only; bigger jumps come through player_state_changed.
    this.clock.sync(position, state.paused, state.duration)
  }

  /** Must be called from a click handler so browsers allow audio to start. */
  activate(): void {
    void this.player?.activateElement()
  }

  async seek(positionMs: number): Promise<void> {
    const target = Math.max(0, Math.round(positionMs))
    this.clock.jumpTo(target)
    await this.player?.seek(target)
  }

  async togglePlay(): Promise<void> {
    this.activate()
    await this.player?.togglePlay()
  }

  async pause(): Promise<void> {
    this.clock.setPlaying(false)
    await this.player?.pause()
  }

  async resume(): Promise<void> {
    this.activate()
    this.clock.setPlaying(true)
    await this.player?.resume()
  }

  async setVolume(volume: number): Promise<void> {
    await this.player?.setVolume(volume)
  }

  disconnect(): void {
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer)
    this.pollTimer = null
    this.player?.disconnect()
    this.player = null
    this.update({ status: 'idle', deviceId: null, track: null, paused: true })
  }
}

export const playerController = new PlayerController()
