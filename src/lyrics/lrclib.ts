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

/** Spotify sometimes writes the katakana long-vowel mark as a hyphen (パ-ランマウム for パーランマウム). */
export function fixLongVowels(text: string): string {
  return text.replace(/(?<=[\u30a1-\u30fa])[-‐‑‒–—―－ｰ]/g, 'ー')
}

/** A name reduced to its letters, for comparing: width, case, spacing and punctuation ignored. */
export function normaliseName(text: string): string {
  return fixLongVowels(text.normalize('NFKC'))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}ー]/gu, '')
}

function similar(a: string, b: string): boolean {
  const x = normaliseName(cleanTrackName(a))
  const y = normaliseName(cleanTrackName(b))
  if (!x || !y) return false
  return x === y || (Math.min(x.length, y.length) >= 2 && (x.includes(y) || y.includes(x)))
}

export interface Choice {
  record: LrclibRecord
  /** False when the record's timing is for a different recording, so only its words are used. */
  timed: boolean
}

/** Timing from a recording more than this many seconds longer or shorter won't line up. */
const TIMING_TOLERANCE_S = 10

/**
 * Picks the record for a track, or null if none is really this song. A record must have the same
 * song name (or the same artist and practically the same length). Timed lyrics from the same
 * recording are best; lyrics from another recording of the song are used without their timing.
 */
export function chooseRecord(records: LrclibRecord[], track: { name: string; artist: string; durationMs: number }): Choice | null {
  const target = track.durationMs / 1000
  const scored = records
    .filter((r) => r.syncedLyrics || r.plainLyrics)
    .flatMap((r) => {
      const diff = r.duration === null ? 999 : Math.abs(r.duration - target)
      const sameName = similar(r.trackName, track.name)
      const sameArtist = similar(r.artistName, track.artist)
      if (!sameName && !(sameArtist && diff <= 2)) return []
      const timed = Boolean(r.syncedLyrics) && diff <= TIMING_TOLERANCE_S
      let score = timed ? 200 : 100
      if (sameName) score += 20
      if (sameArtist) score += 30
      if (normaliseName(r.trackName) === normaliseName(track.name)) score += 10
      score -= Math.min(diff, 60)
      return [{ choice: { record: r, timed }, score }]
    })
    .sort((a, b) => b.score - a.score)
  return scored[0]?.choice ?? null
}

/** Plain text of a timed lyric file, for when its timing belongs to another recording. */
function withoutTimestamps(lrc: string): string {
  return lrc
    .split(/\r?\n/)
    .map((line) => line.replace(/^(\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]\s*)+/, '').replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, ''))
    .filter((line) => !/^\[[a-z]+:.*\]$/i.test(line.trim()))
    .join('\n')
}

function toFound({ record, timed }: Choice): FoundLyrics {
  return {
    text: timed ? (record.syncedLyrics ?? '') : (record.plainLyrics ?? withoutTimestamps(record.syncedLyrics ?? '')),
    synced: timed,
    instrumental: record.instrumental,
    record,
  }
}

const RETRIES = 2

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: HEADERS, signal })
    if (res.status === 404) return null
    if (res.ok) return (await res.json()) as T
    // LRCLIB's server is sometimes briefly unavailable; try again before giving up.
    if (res.status >= 500 && attempt < RETRIES) {
      logWarn('lrclib', 'server error; retrying', { status: res.status, attempt: attempt + 1 })
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)))
      continue
    }
    throw new Error(`LRCLIB returned ${res.status}`)
  }
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

/**
 * Finds lyrics for a track, trying several lookups (exact match, then searches with the name
 * spelled a few ways) and stopping as soon as one finds timed lyrics for this recording.
 * Returns null rather than lyrics for a different song.
 */
export async function findLyrics(track: TrackQuery, signal?: AbortSignal): Promise<FoundLyrics | null> {
  const candidates = new Map<number, LrclibRecord>()
  const add = (records: LrclibRecord[]) => records.forEach((r) => candidates.set(r.id, r))
  const best = () => chooseRecord([...candidates.values()], track)
  const good = () => best()?.timed === true

  const name = cleanTrackName(track.name)
  const artists = [...new Set([track.artist, fixLongVowels(track.artist)])]
  const seconds = String(Math.round(track.durationMs / 1000))

  const steps: { label: string; run: () => Promise<LrclibRecord[]> }[] = [
    ...artists.map((artist) => ({
      label: `exact match (${artist})`,
      run: async () => {
        const r = await getJson<LrclibRecord>(
          `${BASE}/get?${new URLSearchParams({ track_name: track.name, artist_name: artist, album_name: track.album, duration: seconds })}`,
          signal,
        )
        return r ? [r] : []
      },
    })),
    ...artists.map((artist) => ({
      label: `search by song and artist (${artist})`,
      run: () => searchLrclib({ track_name: name, artist_name: artist }, signal),
    })),
    { label: 'search by song name', run: () => searchLrclib({ track_name: name }, signal) },
    ...artists.map((artist) => ({
      label: `free-text search (${artist})`,
      run: () => searchLrclib({ q: `${name} ${artist}` }, signal),
    })),
  ]

  let failures = 0
  for (const step of steps) {
    try {
      const found = await step.run()
      add(found)
      log('lrclib', step.label, { results: found.length, total: candidates.size })
    } catch (e) {
      if (signal?.aborted) throw e
      failures++
      logWarn('lrclib', `${step.label} failed`, { error: e })
    }
    if (good()) break
  }
  // Every request failed: say so, rather than reporting the song as having no lyrics.
  if (failures === steps.length) throw new Error('LRCLIB is not responding right now')

  const choice = best()
  log('lrclib', 'picked', {
    id: choice?.record.id ?? null,
    name: choice?.record.trackName,
    artist: choice?.record.artistName,
    timed: choice?.timed ?? false,
    duration: choice?.record.duration,
    wanted: Math.round(track.durationMs / 1000),
    considered: candidates.size,
  })
  return choice ? toFound(choice) : null
}
