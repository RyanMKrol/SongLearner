import { describe, expect, it } from 'vitest'
import { PlaybackClock } from '../playback/clock'
import { LoopController, buildUpPlan, chainPlan } from '../playback/loop'
import { maskText } from '../practice/mask'

const timings = [
  { startMs: 10000, endMs: 20000 },
  { startMs: 20000, endMs: 30000 },
  { startMs: 30000, endMs: 40000 },
]

describe('plans', () => {
  it('chains sections into one block', () => {
    expect(chainPlan(timings, 0, 2, null)).toEqual([
      { fromSection: 0, toSection: 2, startMs: 10000, endMs: 40000, reps: null },
    ])
  })

  it('builds up cumulatively', () => {
    const steps = buildUpPlan(timings, 0, 2, 2, false)
    expect(steps.map((s) => [s.fromSection, s.toSection])).toEqual([
      [0, 0],
      [0, 1],
      [0, 2],
    ])
  })

  it('can practise each new section alone before joining it on', () => {
    const steps = buildUpPlan(timings, 0, 2, 2, true)
    expect(steps.map((s) => [s.fromSection, s.toSection])).toEqual([
      [0, 0],
      [1, 1],
      [0, 1],
      [2, 2],
      [0, 2],
    ])
  })
})

describe('LoopController', () => {
  it('seeks to the lead-in, repeats, advances steps and finishes', () => {
    const loop = new LoopController(buildUpPlan(timings, 0, 1, 2, false), { leadInMs: 2000, gapMs: 0 })
    expect(loop.start(0)).toEqual({ type: 'seek', positionMs: 8000, pauseMs: 0 })

    let now = 1000
    expect(loop.tick(15000, now)).toEqual({ type: 'none' })
    expect(loop.tick(20000, (now += 100))).toEqual({ type: 'seek', positionMs: 8000, pauseMs: 0 })
    expect(loop.status.rep).toBe(2)

    // Stale position reports right after a seek are ignored.
    expect(loop.tick(20050, (now += 100))).toEqual({ type: 'none' })

    now += 1000
    expect(loop.tick(20000, now)).toEqual({ type: 'seek', positionMs: 8000, pauseMs: 0 })
    expect(loop.status).toMatchObject({ stepIndex: 1, rep: 1 })

    now += 1000
    loop.tick(30000, now)
    now += 1000
    expect(loop.tick(30000, now)).toEqual({ type: 'finished' })
  })

  it('repeats forever when reps is null', () => {
    const loop = new LoopController(chainPlan(timings, 1, 1, null), { leadInMs: 0, gapMs: 500 })
    loop.start(0)
    for (let i = 1; i <= 5; i++) {
      expect(loop.tick(30000, i * 2000)).toEqual({ type: 'seek', positionMs: 20000, pauseMs: 500 })
    }
    expect(loop.status.rep).toBe(6)
  })
})

describe('PlaybackClock', () => {
  it('extrapolates while playing and holds while paused', () => {
    let now = 0
    const clock = new PlaybackClock(() => now)
    clock.sync(5000, false, 60000)
    now = 1500
    expect(clock.position()).toBe(6500)
    clock.setPlaying(false)
    now = 9000
    expect(clock.position()).toBe(6500)
    clock.jumpTo(100)
    expect(clock.position()).toBe(100)
    clock.sync(59900, false)
    now = 20000
    expect(clock.position()).toBe(60000)
  })
})

describe('maskText', () => {
  it('shows first letters', () => {
    expect(maskText("Don't stop, believin'", 1)).toEqual([
      { text: 'D', masked: false },
      { text: "on't", masked: true },
      { text: ' s', masked: false },
      { text: 'top', masked: true },
      { text: ', b', masked: false },
      { text: "elievin'", masked: true },
    ])
  })

  it('hides whole words but keeps punctuation', () => {
    expect(maskText('Hey, you!', 2)).toEqual([
      { text: 'Hey', masked: true },
      { text: ', ', masked: false },
      { text: 'you', masked: true },
      { text: '!', masked: false },
    ])
  })

  it('leaves text alone at level 0', () => {
    expect(maskText('Hey', 0)).toEqual([{ text: 'Hey', masked: false }])
  })
})
