import { describe, expect, it } from 'vitest'
import { parseLrc } from '../lyrics/lrc'
import { alignmentLines, toWordTiming, wordTimesFor, type AlignJob } from '../lyrics/wordAlign'

const LYRICS = parseLrc(`[00:01.00] Yume naraba
[00:04.00]
[00:10.00] Imada ni anata
[00:13.00] Last line`).lines

describe('alignmentLines', () => {
  it('sends each sung line with its words and the time until the next line', () => {
    expect(alignmentLines(LYRICS, null)).toEqual([
      { index: 0, startMs: 1000, endMs: 4000, words: ['Yume', 'naraba'] },
      { index: 2, startMs: 10000, endMs: 13000, words: ['Imada', 'ni', 'anata'] },
      { index: 3, startMs: 13000, endMs: 21000, words: ['Last', 'line'] },
    ])
  })

  it('uses the romaji for lines that have it', () => {
    const romaji = [{ text: 'yume naraba dore', words: [] }, null, null, null]
    expect(alignmentLines(LYRICS, romaji)[0].words).toEqual(['yume', 'naraba', 'dore'])
  })
})

describe('word timings', () => {
  const sent = alignmentLines(LYRICS, null)
  const job: AlignJob = {
    state: 'done',
    stage: 'done',
    message: 'Done',
    pct: 100,
    startedAt: 0,
    result: {
      offsetMs: 40,
      medianLineShiftMs: 100,
      lines: {
        '0': { words: [{ startMs: 1100, endMs: 1500 }, { startMs: 1600, endMs: 2500 }], score: 0.7 },
        // Wrong number of words: dropped rather than misapplied.
        '2': { words: [{ startMs: 10100, endMs: 10500 }], score: 0.5 },
      },
    },
  }

  it('keeps only lines whose word count matches what was sent', () => {
    const timing = toWordTiming(job, sent, null)!
    expect(Object.keys(timing.lines)).toEqual(['0'])
    expect(timing.offsetMs).toBe(40)
  })

  it('applies to a line only while its words still match', () => {
    const timing = toWordTiming(job, sent, null)!
    expect(wordTimesFor(timing, 0, 'Yume naraba')).toHaveLength(2)
    expect(wordTimesFor(timing, 0, 'Yume  wa naraba')).toBeNull()
    expect(wordTimesFor(timing, 2, 'Imada ni anata')).toBeNull()
  })
})
