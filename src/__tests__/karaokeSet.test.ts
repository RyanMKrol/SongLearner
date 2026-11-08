import { describe, expect, it } from 'vitest'
import { karaokeChoiceFor, karaokeJoinedAt } from '../practice/karaokeSet'

const learned = { progress: { sections: 4, learned: 4, completedAt: 1000 } }
const learning = { progress: { sections: 4, learned: 2 } }

describe('karaoke set membership', () => {
  it('includes fully learned songs by itself', () => {
    expect(karaokeJoinedAt(learned)).toBe(1000)
    expect(karaokeJoinedAt(learning)).toBeNull()
    expect(karaokeJoinedAt({})).toBeNull()
    expect(karaokeJoinedAt(null)).toBeNull()
  })

  it('adds a song you are still learning, and it stays until you take it out', () => {
    const choice = karaokeChoiceFor(learning, true, 5000)
    expect(choice).toBe(5000)
    expect(karaokeJoinedAt({ ...learning, karaokeChoice: choice })).toBe(5000)
    expect(karaokeChoiceFor({ ...learning, karaokeChoice: choice }, false, 6000)).toBeUndefined()
  })

  it('keeps a learned song out once you take it out, until you add it back', () => {
    const out = { ...learned, karaokeChoice: karaokeChoiceFor(learned, false, 5000) }
    expect(out.karaokeChoice).toBeNull()
    expect(karaokeJoinedAt(out)).toBeNull()
    const back = { ...learned, karaokeChoice: karaokeChoiceFor(out, true, 6000) }
    expect(karaokeJoinedAt(back)).toBe(1000)
  })

  it('lets a song taken out before it was learned join once it is learned', () => {
    const added = { ...learning, karaokeChoice: 5000 }
    const out = { ...added, karaokeChoice: karaokeChoiceFor(added, false, 6000) }
    expect(karaokeJoinedAt(out)).toBeNull()
    expect(karaokeJoinedAt({ ...out, ...learned })).toBe(1000)
  })
})
