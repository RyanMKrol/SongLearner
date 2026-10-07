// LRCLIB (https://lrclib.net) is a free, community-run lyrics database with timed lyrics.
// No API key is needed and it allows browser requests.

import { log, logWarn } from '../log'

const BASE = 'https://lrclib.net/api'
const HEADERS = { 'Lrclib-Client': 'SongLearner (personal karaoke practice app)' }

export interface LrclibRecord {
  id: number
  trackName: string
  artistName: string
  albumName: string | null
  duration: number | null
  instrumental: boolean
  plainLyrics: string | null
  syncedLyrics: string | null
}

export interface TrackQuery {
  name: string
  artist: string
  album: string
  durationMs: number
}

export interface FoundLyrics {
  text: string
  synced: boolean
  instrumental: boolean
  record: LrclibRecord
}

/** Strips "(feat. X)", "- Remastered 2011" and similar so fuzzy searches match more often. */
export function cleanTrackName(name: string): string {
  return name
    .replace(/\s*[([](?:feat\.?|ft\.?|with)\s[^)\]]*[)\]]/gi, '')
    .replace(/\s+-\s+.*$/, '')
    .trim()
}

/**
 * Picks the best record for a track: timed lyrics beat plain ones, and closer durations win.
 * Records whose duration is far off are probably a different version of the song.
 */
export function pickBest(records: LrclibRecord[], durationMs: number): LrclibRecord | null {
  const target = durationMs / 1000
  const scored = records
    .filter((r) => r.instrumental || r.syncedLyrics || r.plainLyrics)
    .map((r) => {
      const diff = r.duration === null ? 30 : Math.abs(r.duration - target)
      let score = 0
      if (r.syncedLyrics) score += 100
      if (diff <= 3) score += 60
      else if (diff <= 10) score += 20
      score -= Math.min(diff, 60)
      return { r, score }
    })
    .sort((a, b) => b.score - a.score)
  return scored[0]?.r ?? null
}

function toFound(record: LrclibRecord): FoundLyrics {
  return {
    text: record.syncedLyrics ?? record.plainLyrics ?? '',
    synced: Boolean(record.syncedLyrics),
    instrumental: record.instrumental,
    record,
  }
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T | null> {
  const res = await fetch(url, { headers: HEADERS, signal })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`LRCLIB returned ${res.status}`)
  return (await res.json()) as T
}

export async function getLrclibRecord(id: number, signal?: AbortSignal): Promise<LrclibRecord | null> {
  return getJson<LrclibRecord>(`${BASE}/get/${id}`, signal)
}

export async function searchLrclib(
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<LrclibRecord[]> {
  return (await getJson<LrclibRecord[]>(`${BASE}/search?${new URLSearchParams(params)}`, signal)) ?? []
}

export async function findLyrics(track: TrackQuery, signal?: AbortSignal): Promise<FoundLyrics | null> {
  // 1. Exact match on name, artist, album and duration (LRCLIB allows about 2s of slack).
  // This endpoint sometimes answers 503 when it can't find a match, so treat errors as a miss.
  let exact: LrclibRecord | null = null
  try {
    exact = await getJson<LrclibRecord>(
      `${BASE}/get?${new URLSearchParams({
        track_name: track.name,
        artist_name: track.artist,
        album_name: track.album,
        duration: String(Math.round(track.durationMs / 1000)),
      })}`,
      signal,
    )
  } catch (e) {
    if (signal?.aborted) throw e
    logWarn('lrclib', 'exact match request failed; falling back to search', { error: e })
  }
  log('lrclib', 'exact match', { found: Boolean(exact), id: exact?.id, synced: Boolean(exact?.syncedLyrics) })
  if (exact && (exact.syncedLyrics || exact.instrumental)) return toFound(exact)

  // 2. Search by track and artist. Many songs exist on several albums with the same lyrics.
  const cleaned = cleanTrackName(track.name)
  let candidates = await searchLrclib({ track_name: cleaned, artist_name: track.artist }, signal)
  log('lrclib', 'search by track and artist', { query: cleaned, artist: track.artist, results: candidates.length })

  // 3. Free-text search as a last resort.
  if (candidates.length === 0) {
    candidates = await searchLrclib({ q: `${cleaned} ${track.artist}` }, signal)
    log('lrclib', 'free-text search', { query: `${cleaned} ${track.artist}`, results: candidates.length })
  }

  const best = pickBest(exact ? [exact, ...candidates] : candidates, track.durationMs)
  log('lrclib', 'picked', { id: best?.id ?? null, synced: Boolean(best?.syncedLyrics), duration: best?.duration, wanted: Math.round(track.durationMs / 1000) })
  return best ? toFound(best) : null
}
