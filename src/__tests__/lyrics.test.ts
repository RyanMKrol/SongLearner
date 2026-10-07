import { describe, expect, it } from 'vitest'
import { appendTapped, lineIndexAt, parseLrc, parseLyrics, parsePlain, toLrc } from '../lyrics/lrc'
import { cleanTrackName, pickBest, type LrclibRecord } from '../lyrics/lrclib'
import { autoSectionStarts, buildSections, sectionTimings } from '../lyrics/sections'

// Made-up lyrics shaped like a typical LRCLIB file: verse, chorus, verse, chorus, outro.
const SONG = `[ar:Test Artist]
[ti:Test Song]
[00:10.00] Walking down the river road
[00:13.00] Carrying a heavy load
[00:16.00] Sun is setting in the west
[00:19.00] Time to lay it all to rest

[00:22.00] Oh sing it loud tonight
[00:25.00] Everything will be alright
[00:28.00] Oh sing it loud tonight
[00:31.00] Hold on till the morning light

[00:50.00] Walking down the river road
[00:53.00] Leaving all my fears behind
[00:56.00] Sun is rising in the east
[00:59.00] Peace of mind at last at least

[01:02.00] Oh sing it loud tonight
[01:05.00] Everything will be alright
[01:08.00] Oh sing it loud tonight
[01:11.00] Hold on till the morning light

[01:20.00] Goodbye
[01:24.00] Goodbye now
[01:30.00] `

describe('parseLrc', () => {
  it('parses timed lines and stanza breaks, skipping metadata', () => {
    const { synced, lines } = parseLrc(SONG)
    expect(synced).toBe(true)
    expect(lines[0]).toEqual({ timeMs: 10000, text: 'Walking down the river road', stanzaBreakBefore: false })
    expect(lines[4]).toMatchObject({ timeMs: 22000, stanzaBreakBefore: true })
    expect(lines.at(-1)).toMatchObject({ timeMs: 90000, text: '' })
  })

  it('handles several timestamps on one line, word tags and the offset tag', () => {
    const { lines } = parseLrc('[offset:+500]\n[00:05.00][00:20.50]Hey <00:05.50>there\n[00:10.000]Middle')
    expect(lines.map((l) => [l.timeMs, l.text])).toEqual([
      [4500, 'Hey there'],
      [9500, 'Middle'],
      [20000, 'Hey there'],
    ])
  })

  it('round-trips through toLrc', () => {
    const { lines } = parseLrc(SONG)
    const timed = lines.map((l) => ({ ...l, timeMs: l.timeMs ?? 0 }))
    expect(parseLrc(toLrc(timed)).lines).toEqual(lines)
  })
})

describe('parsePlain / parseLyrics', () => {
  it('keeps stanza breaks for plain lyrics', () => {
    const { synced, lines } = parsePlain('One\nTwo\n\n\nThree')
    expect(synced).toBe(false)
    expect(lines.map((l) => l.stanzaBreakBefore)).toEqual([false, false, true])
    expect(lines[0].timeMs).toBeNull()
  })

  it('detects LRC automatically', () => {
    expect(parseLyrics('[00:01.00] hi').synced).toBe(true)
    expect(parseLyrics('just words').synced).toBe(false)
  })
})

describe('lineIndexAt', () => {
  const { lines } = parseLrc(SONG)
  it('finds the line being sung', () => {
    expect(lineIndexAt(lines, 0)).toBe(-1)
    expect(lineIndexAt(lines, 10000)).toBe(0)
    expect(lineIndexAt(lines, 14500)).toBe(1)
    expect(lineIndexAt(lines, 999999)).toBe(lines.length - 1)
  })
})

describe('sections', () => {
  const { lines } = parseLrc(SONG)

  it('splits on stanza breaks and folds the outro together', () => {
    const starts = autoSectionStarts(lines)
    expect(starts).toEqual([0, 4, 8, 12, 16])
  })

  it('marks repeated parts with the same letter', () => {
    const sections = buildSections(lines, autoSectionStarts(lines))
    expect(sections.map((s) => s.repeatGroup)).toEqual([null, 'A', null, 'A', null])
    expect(sections[1].name).toBe('Oh sing it loud tonight')
    expect(sections[4]).toMatchObject({ startLine: 16, endLine: 17 })
  })

  it('uses saved names and ignores invalid starts', () => {
    const sections = buildSections(lines, [4, 999, 18], { 4: 'Chorus' })
    expect(sections.map((s) => s.startLine)).toEqual([0, 4])
    expect(sections[1].name).toBe('Chorus')
  })

  it('splits by time gaps when there are no stanza breaks', () => {
    const flat = parseLrc(SONG.replace(/\n\n/g, '\n')).lines
    expect(autoSectionStarts(flat)).toEqual([0, 8, 16])
  })

  it('treats music-note lines as instrumental breaks', () => {
    const { lines } = parseLrc('[00:01.00] One\n[00:03.00] Two\n[00:05.00] ♪\n[00:20.00] Three\n[00:22.00] Four')
    expect(autoSectionStarts(lines)).toEqual([0, 3])
    expect(buildSections(lines, [0, 3])[0].endLine).toBe(1)
  })

  it('splits very long blocks into chunks', () => {
    const text = Array.from({ length: 20 }, (_, i) => `[00:${String(i * 2).padStart(2, '0')}.00] Line ${i}`).join('\n')
    expect(autoSectionStarts(parseLrc(text).lines)).toEqual([0, 7, 14])
  })

  it('ends a section at the next line, but caps long instrumental tails', () => {
    const sections = buildSections(lines, autoSectionStarts(lines))
    const timings = sectionTimings(sections, lines, 100000)
    expect(timings[0]).toEqual({ startMs: 10000, endMs: 22000 })
    // Chorus 1 is followed by a 19s gap; the loop should stop well before verse 2.
    expect(timings[1]).toEqual({ startMs: 22000, endMs: 31000 + 7500 })
    expect(timings[4]).toEqual({ startMs: 80000, endMs: 90000 })
  })
})

describe('lrclib helpers', () => {
  it('cleans track names for fuzzy search', () => {
    expect(cleanTrackName('Song (feat. Someone) - Remastered 2011')).toBe('Song')
    expect(cleanTrackName('Another [with X]')).toBe('Another')
  })

  const record = (over: Partial<LrclibRecord>): LrclibRecord => ({
    id: 1,
    trackName: 't',
    artistName: 'a',
    albumName: null,
    duration: 200,
    instrumental: false,
    plainLyrics: 'x',
    syncedLyrics: null,
    ...over,
  })

  it('prefers timed lyrics with a matching duration', () => {
    const best = pickBest(
      [
        record({ id: 1, duration: 200, syncedLyrics: null }),
        record({ id: 2, duration: 260, syncedLyrics: '[00:01.00]x' }),
        record({ id: 3, duration: 201, syncedLyrics: '[00:01.00]x' }),
      ],
      200_000,
    )
    expect(best?.id).toBe(3)
  })

  it('returns null when nothing has lyrics', () => {
    expect(pickBest([record({ plainLyrics: null })], 200_000)).toBeNull()
  })
})

describe('appendTapped', () => {
  const { lines } = parseLrc(SONG)

  it('adds the chosen lines in order at each tap, looping back to the first', () => {
    // Repeat lines 5-6 (the middle of the chorus) three times with free timing.
    const text = appendTapped(lines, 5, 6, [95000, 98500, 101000, 103000, 106200])
    const after = parseLrc(text ?? '').lines
    expect(after.slice(0, lines.length)).toEqual(lines)
    expect(after.slice(lines.length).map((l) => [l.timeMs, l.text, l.stanzaBreakBefore])).toEqual([
      [95000, lines[5].text, true],
      [98500, lines[6].text, false],
      [101000, lines[5].text, true],
      [103000, lines[6].text, false],
      [106200, lines[5].text, true],
    ])
  })

  it('skips instrumental markers in the chosen range', () => {
    const text = appendTapped(lines, 16, 18, [95000, 97000, 99000])
    const added = parseLrc(text ?? '').lines.slice(lines.length)
    expect(added.map((l) => l.text)).toEqual([lines[16].text, lines[17].text, lines[16].text])
  })

  it('refuses taps before the last line or out of order, and untimed lyrics', () => {
    expect(appendTapped(lines, 4, 7, [60000])).toBeNull()
    expect(appendTapped(lines, 4, 7, [95000, 94000])).toBeNull()
    expect(appendTapped(parsePlain('a\nb').lines, 0, 1, [99999])).toBeNull()
  })
})
