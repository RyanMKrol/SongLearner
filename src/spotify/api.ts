// Thin wrapper over the few Spotify Web API endpoints the app needs.
import { getAccessToken } from './auth'

const API = 'https://api.spotify.com/v1'

export interface SpotifyImage {
  url: string
  width?: number | null
  height?: number | null
}

export interface SpotifyTrack {
  id: string
  uri: string
  name: string
  duration_ms: number
  artists: { name: string }[]
  album: { name: string; images: SpotifyImage[] }
}

export class SpotifyApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init: RequestInit = {}, retried = false): Promise<T | null> {
  const token = await getAccessToken()
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })

  if (res.status === 401 && !retried) {
    await getAccessToken(true)
    return request<T>(path, init, true)
  }
  if (res.status === 429 && !retried) {
    const wait = Number(res.headers.get('Retry-After') ?? '1')
    await new Promise((r) => setTimeout(r, Math.min(wait, 10) * 1000))
    return request<T>(path, init, true)
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`
    try {
      const body = (await res.json()) as { error?: { message?: string } }
      if (body.error?.message) message = body.error.message
    } catch {
      // Body wasn't JSON; keep the status text.
    }
    throw new SpotifyApiError(res.status, message)
  }
  if (res.status === 204) return null
  const text = await res.text()
  return text ? (JSON.parse(text) as T) : null
}

export async function searchTracks(query: string): Promise<SpotifyTrack[]> {
  // Development Mode apps get at most 10 results per page.
  const params = new URLSearchParams({ q: query, type: 'track', limit: '10' })
  const res = await request<{ tracks: { items: SpotifyTrack[] } }>(`/search?${params}`)
  return res?.tracks.items ?? []
}

export async function playTrack(deviceId: string, uri: string, positionMs = 0): Promise<void> {
  const body = JSON.stringify({ uris: [uri], position_ms: Math.max(0, Math.round(positionMs)) })
  try {
    await request(`/me/player/play?device_id=${encodeURIComponent(deviceId)}`, { method: 'PUT', body })
  } catch (e) {
    // A freshly created device sometimes isn't known yet. Transfer to it, then try once more.
    if (e instanceof SpotifyApiError && e.status === 404) {
      await transferPlayback(deviceId, false)
      await request(`/me/player/play?device_id=${encodeURIComponent(deviceId)}`, { method: 'PUT', body })
    } else {
      throw e
    }
  }
}

/** Moves whatever the user is playing (on any device) to this browser tab. */
export async function transferPlayback(deviceId: string, play = true): Promise<void> {
  await request('/me/player', {
    method: 'PUT',
    body: JSON.stringify({ device_ids: [deviceId], play }),
  })
}

export interface PlaybackStateResponse {
  is_playing: boolean
  progress_ms: number | null
  item: SpotifyTrack | null
  device: { id: string | null; name: string }
}

export async function getPlaybackState(): Promise<PlaybackStateResponse | null> {
  return request<PlaybackStateResponse>('/me/player')
}

export async function getProfile(): Promise<{ display_name: string | null; product?: string }> {
  const res = await request<{ display_name: string | null; product?: string }>('/me')
  return res ?? { display_name: null }
}
