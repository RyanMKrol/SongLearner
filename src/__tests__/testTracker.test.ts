import { describe, expect, it } from 'vitest'
import { TestTracker } from '../playback/testTracker'

const spans = [
  { startMs: 10000, endMs: 20000 },
  { startMs: 20000, endMs: 30000 },
  { startMs: 40000, endMs: 50000 },
]

/** Plays from `from` to `to` in 50ms steps, returning every event. */
function play(tracker: TestTracker, from: number, to: number, startAt = 0) {
  const events = []
  for (let pos = from, now = startAt; pos <= to; pos += 50, now += 50) {
    events.push(...tracker.tick(pos, true, now))
  }
  return events
}

describe('TestTracker', () => {
  it('passes each section heard from start to end', () => {
    const tracker = new TestTracker(spans)
    const events = play(tracker, 8000, 51000)
    expect(events.filter((e) => e.type === 'passed').map((e) => e.section)).toEqual([0, 1, 2])
  })

  it("doesn't count a section joined part-way through", () => {
    const tracker = new TestTracker(spans)
    const events = play(tracker, 14000, 31000)
    expect(events.filter((e) => e.type === 'passed').map((e) => e.section)).toEqual([1])
  })

  it('a pause cancels the section being tested', () => {
    const tracker = new TestTracker(spans)
    play(tracker, 9000, 15000)
    expect(tracker.current).toBe(0)
    tracker.tick(15000, false, 7000)
    expect(tracker.current).toBeNull()
    const events = play(tracker, 15000, 21000, 9000)
    expect(events.some((e) => e.type === 'passed' && e.section === 0)).toBe(false)
  })

  it('a seek cancels the attempt, but jumping back to the start retries it', () => {
    const tracker = new TestTracker(spans)
    play(tracker, 9000, 15000)
    // Jump back to just before section 0 (like a loop's run-up) and sing it through.
    const events = play(tracker, 8000, 20500, 7000)
    expect(events.filter((e) => e.type === 'passed').map((e) => e.section)).toEqual([0])
  })

  it('peeking cancels the attempt', () => {
    const tracker = new TestTracker(spans)
    play(tracker, 9000, 12000)
    tracker.interrupt()
    const events = play(tracker, 12050, 20500, 3050)
    expect(events.some((e) => e.type === 'passed' && e.section === 0)).toBe(false)
  })

  it('resuming after a pause outside any section is not treated as a jump', () => {
    const tracker = new TestTracker(spans)
    play(tracker, 35000, 36000)
    tracker.tick(36000, false, 1000)
    // Resumed much later in wall-clock time, same song position.
    const events = play(tracker, 36000, 51000, 60000)
    expect(events.filter((e) => e.type === 'passed').map((e) => e.section)).toEqual([2])
  })
})
