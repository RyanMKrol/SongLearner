// Asks the dev server's /api/review-readings endpoint (server/readingReview.ts) to have Claude
// check how the words of a Japanese song are sung.
import { log, logError } from '../log'
import type { AiReview } from '../practice/storage'
import type { ReadingFixes } from './romaji'

export interface ReviewSuggestion {
  source: string
  reading: string
  confidence: 'high' | 'medium' | 'low'
  reason: string
}

export interface ReviewResult {
  suggestions: ReviewSuggestion[]
  notes: string
  model: string
}

export interface ReviewRequestBody {
  title: string
  artist: string
  album: string
  lines: string[]
  words: { source: string; standard: string }[]
}

export class ReviewError extends Error {
  /** "no_api_key" when the server has no Anthropic key configured. */
  readonly kind: string
  constructor(kind: string, message: string) {
    super(message)
    this.kind = kind
  }
}

export async function requestReadingReview(body: ReviewRequestBody, signal?: AbortSignal): Promise<ReviewResult> {
  let res: Response
  const started = performance.now()
  log('review', 'asking Claude to check readings', { title: body.title, artist: body.artist, lines: body.lines.length, words: body.words.length })
  try {
    res = await fetch('/api/review-readings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  } catch (e) {
    if (signal?.aborted) throw e
    throw new ReviewError('network', 'Could not reach the dev server to run the check.')
  }
  const data = (await res.json().catch(() => ({}))) as Partial<ReviewResult> & { error?: string; message?: string }
  if (!res.ok) {
    logError('review', 'failed', { status: res.status, error: data.error, message: data.message, ms: performance.now() - started })
    throw new ReviewError(data.error ?? 'failed', data.message ?? `Check failed (${res.status})`)
  }
  log('review', 'done', {
    ms: performance.now() - started,
    model: data.model,
    suggestions: (data.suggestions ?? []).map((s) => ({ source: s.source, reading: s.reading, confidence: s.confidence })),
    notes: data.notes,
  })
  return { suggestions: data.suggestions ?? [], notes: data.notes ?? '', model: data.model ?? '' }
}

/**
 * A song's reading fixes: Claude's applied suggestions first, then your own, which win. Undefined
 * when there are none. `review` must already be checked to belong to the current lyrics.
 */
export function combineReadingFixes(review: AiReview | null, readings: ReadingFixes | undefined): ReadingFixes | undefined {
  const fromReview = review?.suggestions.filter((s) => s.applied).map((s) => [s.source, s.reading]) ?? []
  if (fromReview.length === 0) return readings
  return { ...Object.fromEntries(fromReview), ...readings }
}

/** Short fingerprint of a lyrics text, so a review is redone if the lyrics change. */
export function lyricsKey(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  return (hash >>> 0).toString(36)
}
