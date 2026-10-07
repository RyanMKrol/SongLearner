// Wraps the Spotify Web Playback SDK: loads the script, creates the "SongLearner" device in this
// tab, and exposes a small store that React can subscribe to.
import { PlaybackClock } from '../playback/clock'
import { log, logDebug, logError, logWarn } from '../log'
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
  /** Every ID and URI the SDK has used for the current track. */
  private currentTrackKeys = new Set<string>()
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
    if (patch.status && patch.status !== this.snapshot.status) {
      log('player', 'status', { from: this.snapshot.status, to: patch.status, error: patch.error ?? this.snapshot.error })
    }
    if (patch.error && patch.error !== this.snapshot.error) logWarn('player', 'error shown', { error: patch.error })
    this.snapshot = { ...this.snapshot, ...patch }
    this.listeners.forEach((l) => l())
  }

  async connect(): Promise<void> {
    if (this.player || this.snapshot.status === 'connecting') return
    this.update({ status: 'connecting', error: null })
    const started = performance.now()
    try {
      await loadSdk()
      log('player', 'sdk loaded', { ms: performance.now() - started })
    } catch (e) {
      logError('player', 'sdk failed to load', { error: e })
      this.update({ status: 'error', error: e instanceof Error ? e.message : String(e) })
      return
    }

    const player = new window.Spotify.Player({
      name: 'SongLearner',
      volume: 0.8,
      getOAuthToken: (cb) => {
        logDebug('player', 'sdk asked for a token')
        getAccessToken()
          .then(cb)
          .catch((e) => {
            logError('player', 'token for sdk failed', { error: e })
            this.update({ status: 'error', error: String(e) })
          })
      },
    })
    this.player = player

    player.addListener('ready', ({ device_id }) => {
      log('player', 'device ready', { deviceId: device_id })
      this.update({ status: 'ready', deviceId: device_id, error: null })
    })
    player.addListener('not_ready', ({ device_id }) => {
      logWarn('player', 'device went offline', { deviceId: device_id })
      this.update({ status: 'connecting' })
    })
    player.addListener('player_state_changed', (state) => this.applyState(state))
    player.addListener('autoplay_failed', () => {
      logWarn('player', 'autoplay blocked by browser')
      this.update({ error: 'The browser blocked autoplay. Press play to start.' })
    })
    for (const type of ['account_error', 'authentication_error', 'initialization_error'] as const) {
      player.addListener(type, ({ message }) => {
        logError('player', type, { message })
        this.update({ status: 'error', error: `${ERROR_MESSAGES[type]} (${message})` })
      })
    }
    player.addListener('playback_error', ({ message }) => {
      logError('player', 'playback_error', { message })
      this.update({ error: `${ERROR_MESSAGES.playback_error} (${message})` })
    })

    const ok = await player.connect()
    log('player', 'connect', { ok })
    if (!ok) this.update({ status: 'error', error: 'Could not connect to Spotify.' })

    this.pollTimer = window.setInterval(() => void this.poll(), POLL_MS)
  }

  private applyState(state: Spotify.PlaybackState | null): void {
    if (!state) {
      log('player', 'state: none (playback moved to another device?)')
      // Playback moved to another device.
      this.clock.setPlaying(false)
      this.update({ paused: true, version: this.snapshot.version + 1 })
      return
    }
    // `timestamp` is when the SDK produced this state. Use it to correct for delivery delay,
    // but only if it looks sane (clock skew could make it nonsense).
    const lag = Date.now() - state.timestamp
    const position = state.paused || lag < 0 || lag > 2000 ? state.position : state.position + lag
    const predicted = this.clock.position()
    this.clock.sync(position, state.paused, state.duration)
    const current = state.track_window.current_track
    log('player', 'state', {
      position: Math.round(position),
      drift: Math.round(position - predicted),
      paused: state.paused,
      loading: state.loading,
      duration: state.duration,
      lag,
      trackId: current?.id ?? null,
      linkedFrom: current?.linked_from?.id ?? null,
      track: current?.name ?? null,
    })

    // Keep the same track object unless a genuinely different song starts, so the song screen
    // isn't rebuilt (and doesn't lose test mode or a running loop) over a glitchy report. The SDK
    // can briefly report no track, or the same song under its relinked ID instead of the original.
    let track = this.snapshot.track
    if (!current) logWarn('player', 'state has no current track; keeping the previous one')
    if (current) {
      const keys = [current.id, current.uri, current.linked_from?.id, current.linked_from?.uri].filter(
        (k): k is string => Boolean(k),
      )
      if (track && keys.some((k) => this.currentTrackKeys.has(k))) {
        const added = keys.filter((k) => !this.currentTrackKeys.has(k))
        if (added.length > 0) log('player', 'same track reported under another id', { trackId: track.id, added })
        keys.forEach((k) => this.currentTrackKeys.add(k))
      } else {
        track = toTrack(current)
        log('player', 'track changed', { from: this.snapshot.track?.id ?? null, to: track.id, name: track.name, artists: track.artists, durationMs: track.durationMs })
        this.currentTrackKeys = new Set(keys)
      }
    }
    this.update({ track, paused: state.paused, version: this.snapshot.version + 1 })
  }

  private async poll(): Promise<void> {
    if (!this.player || this.snapshot.paused) return
    const state = await this.player.getCurrentState()
    if (!state) return
    const lag = Date.now() - state.timestamp
    const position = state.paused || lag < 0 || lag > 2000 ? state.position : state.position + lag
    const drift = position - this.clock.position()
    if (Math.abs(drift) > 250) logDebug('player', 'clock corrected by poll', { position: Math.round(position), drift: Math.round(drift) })
    // Small corrections only; bigger jumps come through player_state_changed.
    this.clock.sync(position, state.paused, state.duration)
  }

  /** Must be called from a click handler so browsers allow audio to start. */
  activate(): void {
    void this.player?.activateElement()
  }

  /** `reason` says who asked (a loop, a key press, a click), for the logs. */
  async seek(positionMs: number, reason = 'unspecified'): Promise<void> {
    const target = Math.max(0, Math.round(positionMs))
    log('player', 'seek', { from: Math.round(this.clock.position()), to: target, reason })
    this.clock.jumpTo(target)
    await this.player?.seek(target)
  }

  async togglePlay(reason = 'unspecified'): Promise<void> {
    log('player', 'toggle play', { wasPaused: this.snapshot.paused, position: Math.round(this.clock.position()), reason })
    this.activate()
    await this.player?.togglePlay()
  }

  async pause(reason = 'unspecified'): Promise<void> {
    log('player', 'pause', { position: Math.round(this.clock.position()), reason })
    this.clock.setPlaying(false)
    await this.player?.pause()
  }

  async resume(reason = 'unspecified'): Promise<void> {
    log('player', 'resume', { position: Math.round(this.clock.position()), reason })
    this.activate()
    this.clock.setPlaying(true)
    await this.player?.resume()
  }

  async setVolume(volume: number): Promise<void> {
    logDebug('player', 'volume', { volume })
    await this.player?.setVolume(volume)
  }

  disconnect(): void {
    log('player', 'disconnect')
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer)
    this.pollTimer = null
    this.player?.disconnect()
    this.player = null
    this.update({ status: 'idle', deviceId: null, track: null, paused: true })
  }
}

export const playerController = new PlayerController()
