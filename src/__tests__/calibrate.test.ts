import { describe, expect, it } from 'vitest'
import { estimateOffset } from '../playback/calibrate'

// Word starts with uneven gaps, like real singing (some only 300ms apart).
const WORDS = [1000, 1300, 1700, 2600, 2900, 3200, 4100, 4500, 4800, 5600, 5900, 6800, 7100, 7500]

describe('estimateOffset', () => {
  it('finds a shift bigger than the gap between words, where nearest-word matching would go wrong', () => {
    // You hear (and tap) each word 450ms before the fill reaches it, with a little wobble.
    const wobble = [20, -30, 10, 0, -15, 25, -10, 5, 30, -20, 0, 15]
    const taps = WORDS.slice(0, 12).map((w, i) => w - 450 + wobble[i])
    const result = estimateOffset(taps, WORDS)!
    expect(result.deltaMs).toBeGreaterThanOrEqual(430)
    expect(result.deltaMs).toBeLessThanOrEqual(470)
    expect(result.hits).toBe(12)
  })

  it('works when the fill is early too', () => {
    const taps = WORDS.slice(2, 12).map((w) => w + 300)
    expect(estimateOffset(taps, WORDS)!.deltaMs).toBe(-300)
  })

  it('ignores stray taps', () => {
    const taps = [...WORDS.slice(0, 10).map((w) => w - 200), 2100, 5000]
    const result = estimateOffset(taps, WORDS)!
    expect(result.deltaMs).toBe(200)
    expect(result.hits).toBe(10)
    expect(result.taps).toBe(12)
  })

  it('waits for enough taps', () => {
    expect(estimateOffset([900, 1200, 1600], WORDS)).toBeNull()
    expect(estimateOffset([], WORDS)).toBeNull()
  })
})
