// Talks to the dev server's /api/align endpoints (server/wordAlign.ts), which work out when each
// word of a song is sung so the current line can fill in karaoke-style.
import { log, logError } from '../log'
import type { LyricLine } from './lrc'
import type { RomajiLine } from './romaji'
import { isSung } from './sections'

export interface WordTime {
  startMs: number
  endMs: number
}

export interface AlignedLine {
  /** The text that was aligned: the romaji for Japanese lines, the lyric itself otherwise. */
  text: string
  /** One per whitespace-separated word of `text`. */
  words: WordTime[]
  /** The aligner's average confidence, 0 to 1. */
  score: number
}

export interface AudioSource {
  kind: 'youtube' | 'upload'
  title: string
  channel?: string
  url?: string
  durationMs?: number
}

/** Saved with the song once it's been aligned. */
export interface WordTiming {
  alignedAt: number
  /** How much later the song happens in the aligned audio than on Spotify. */
  offsetMs: number
  source: AudioSource | null
  lines: Record<number, AlignedLine>
}

export interface AlignJob {
  state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  stage: string
  message: string
  pct: number | null
  /** When the job was queued. */
  startedAt: number
  /** For a queued job: how many jobs will run before it. */
  ahead?: number
  /** The words that were aligned, line by line. */
  sent?: { index: number; words: string[] }[]
  error?: { kind: string; message: string }
  result?: { offsetMs: number; lines: Record<string, { words: WordTime[]; score: number }>; medianLineShiftMs: number | null }
}

export interface AlignState {
  source: AudioSource | null
  job: AlignJob | null
}

export class AlignError extends Error {
  readonly kind: string
  constructor(kind: string, message: string) {
    super(message)
    this.kind = kind
  }
}

export const splitWords = (text: string) => text.split(/\s+/).filter(Boolean)

/** The text each line is aligned (and filled) by: the romaji where there is some. */
export function alignedText(line: LyricLine, romaji: RomajiLine | null | undefined): string {
  return romaji?.text ?? line.text
}

/** What to send for aligning: each sung line's words and the time window it's sung in. */
export function alignmentLines(lines: LyricLine[], romaji: (RomajiLine | null)[] | null) {
  return lines.flatMap((line, i) => {
    if (!isSung(line) || line.timeMs === null) return []
    const next = lines.slice(i + 1).find((l) => l.timeMs !== null)
    const endMs = next?.timeMs ?? line.timeMs + 8000
    return [{ index: i, startMs: line.timeMs, endMs, words: splitWords(alignedText(line, romaji?.[i])) }]
  })
}

/** Turns a finished job into what's saved with the song. `fallback` is used if the job didn't record what it aligned. */
export function toWordTiming(
  job: AlignJob,
  fallback: { index: number; words: string[] }[],
  source: AudioSource | null,
): WordTiming | null {
  if (job.state !== 'done' || !job.result) return null
  const lines: Record<number, AlignedLine> = {}
  for (const line of job.sent ?? fallback) {
    const r = job.result.lines[String(line.index)]
    if (r && r.words.length === line.words.length) lines[line.index] = { text: line.words.join(' '), words: r.words, score: r.score }
  }
  return { alignedAt: Date.now(), offsetMs: job.result.offsetMs, source, lines }
}

/** Word times for a line as it's shown, or null if the words have changed since it was aligned. */
export function wordTimesFor(timing: WordTiming | undefined, lineIndex: number, shownText: string): WordTime[] | null {
  const aligned = timing?.lines[lineIndex]
  if (!aligned) return null
  return splitWords(shownText).length === aligned.words.length ? aligned.words : null
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api/align/${path}`, init)
  } catch {
    throw new AlignError('network', 'Could not reach the dev server.')
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string }
  if (!res.ok) throw new AlignError(data.error ?? 'failed', data.message ?? `Request failed (${res.status})`)
  return data
}

/** One song's job, summarised for the alignments page. */
export interface AlignJobRow {
  trackId: string
  title?: string
  artist?: string
  auto?: boolean
  state: AlignJob['state']
  stage: string
  message: string
  pct: number | null
  startedAt: number
  finishedAt?: number
  error?: { kind: string; message: string }
  ahead: number
  source: AudioSource | null
  linesSent?: number
  linesTimed?: number
  offsetMs?: number
  medianLineShiftMs?: number | null
  /** What happened, step by step. */
  log: { t: number; message: string }[]
}

export const listAlignJobs = () => call<{ jobs: AlignJobRow[] }>('jobs').then((r) => r.jobs)

export const isActive = (job: AlignJob | null | undefined) => job?.state === 'queued' || job?.state === 'running'

export const alignerInstalled = () => call<{ installed: boolean }>('status').then((r) => r.installed)

export const getAlignState = (trackId: string) => call<AlignState>(trackId)

export function startAlignment(
  trackId: string,
  body: {
    artist: string
    title: string
    durationMs: number
    lines: ReturnType<typeof alignmentLines>
    youtubeUrl?: string
    auto?: boolean
  },
) {
  log('align', 'start', { trackId, lines: body.lines.length, youtubeUrl: body.youtubeUrl, auto: body.auto })
  return call<{ job: AlignJob }>(`${trackId}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function cancelAlignment(trackId: string) {
  log('align', 'cancel', { trackId })
  return call<{ job: AlignJob | null }>(`${trackId}/cancel`, { method: 'POST' })
}

export async function uploadAudio(trackId: string, file: File) {
  log('align', 'uploading audio', { trackId, name: file.name, bytes: file.size })
  try {
    return await call<{ source: AudioSource }>(`${trackId}/upload`, {
      method: 'POST',
      headers: { 'X-File-Name': encodeURIComponent(file.name) },
      body: file,
    })
  } catch (e) {
    logError('align', 'upload failed', { error: e instanceof Error ? e.message : String(e) })
    throw e
  }
}

/** Forgets the song's audio on the server. Fire and forget: used when a song is deleted. */
export function forgetAudio(trackId: string): void {
  void fetch(`/api/align/${trackId}`, { method: 'DELETE' }).catch(() => {})
}
