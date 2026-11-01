// Builds a song's alignment request from what's saved for it, so songs can be aligned from the
// alignments page without opening each one. Mirrors what the song screen sends.
import { loadPrefs, loadSavedLyrics, type LibraryEntry } from '../practice/storage'
import { parseLyrics } from './lrc'
import { combineReadingFixes, lyricsKey } from './readingReview'
import { hasJapanese, romanizeLines } from './romaji'
import { isSung } from './sections'
import { alignmentLines, startAlignment } from './wordAlign'

export type AlignRequestResult =
  | { ok: true; body: Parameters<typeof startAlignment>[1] }
  | { ok: false; reason: string }

export async function alignmentRequestFor(entry: LibraryEntry): Promise<AlignRequestResult> {
  const saved = loadSavedLyrics(entry.id)
  if (!saved) return { ok: false, reason: 'No lyrics saved yet. Open the song once.' }
  const { lines, synced } = parseLyrics(saved.text)
  if (!synced) return { ok: false, reason: "The lyrics aren't timed. Time them on the song's page first." }
  if (!lines.some(isSung)) return { ok: false, reason: 'No sung lines to align.' }

  // Japanese lines are aligned by their romaji, with the song's reading fixes applied.
  let romaji = null
  if (lines.some((l) => hasJapanese(l.text))) {
    const prefs = loadPrefs(entry.id)
    const review = prefs.aiReview?.lyricsKey === lyricsKey(saved.text) ? prefs.aiReview : null
    romaji = await romanizeLines(
      lines.map((l) => l.text),
      combineReadingFixes(review, prefs.readings) ?? {},
    )
  }
  return {
    ok: true,
    body: {
      artist: entry.artists[0] ?? '',
      title: entry.name,
      durationMs: entry.durationMs,
      lines: alignmentLines(lines, romaji),
    },
  }
}
