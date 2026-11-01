import { describe, expect, it } from 'vitest'
import { AutoLoopWatcher } from '../playback/autoLoop'
import { LoopController, chainPlan } from '../playback/loop'

const spans = [
  { startMs: 0, endMs: 10_000, loops: false },
  { startMs: 10_000, endMs: 20_000, loops: true },
  { startMs: 20_000, endMs: 30_000, loops: false },
]

describe('AutoLoopWatcher', () => {
  it('starts a loop when playback reaches a section that loops', () => {
    const w = new AutoLoopWatcher(spans)
    expect(w.tick(9_900)).toBeNull()
    expect(w.tick(10_050)).toBe(1)
    // Only once per arrival.
    expect(w.tick(10_100)).toBeNull()
  })

  it('ignores sections that do not loop', () => {
    const w = new AutoLoopWatcher(spans)
    expect(w.tick(19_900)).toBeNull()
    expect(w.tick(20_050)).toBeNull()
  })

  it('does not loop a section you jump into the middle of', () => {
    const w = new AutoLoopWatcher(spans)
    expect(w.tick(2_000)).toBeNull()
    expect(w.tick(15_000)).toBeNull()
  })

  it('picks up right where a finished loop hands over', () => {
    const w = new AutoLoopWatcher([...spans.slice(0, 2), { startMs: 20_000, endMs: 30_000, loops: true }])
    w.tick(15_000)
    // A loop of section 1 ran; it ends exactly at section 2's start.
    w.reset()
    expect(w.tick(20_020)).toBe(2)
  })

  it('leaves a section alone after you stop looping it, until you move away', () => {
    const w = new AutoLoopWatcher(spans)
    w.suppress(1, 1)
    w.reset()
    // Stopped during the run-up: playback crosses the start again.
    expect(w.tick(9_000)).toBeNull()
    expect(w.tick(10_050)).toBeNull()
    // Played on past it, then came back to its start.
    expect(w.tick(20_100)).toBeNull()
    expect(w.tick(9_500)).toBeNull()
    expect(w.tick(10_020)).toBe(1)
  })
})

describe('LoopController.join', () => {
  it('counts the pass already playing as the first rep', () => {
    const loop = new LoopController(chainPlan(spans, 1, 1, 2), { leadInMs: 2000, gapMs: 0 })
    expect(loop.join(0)).toEqual({ type: 'none' })
    expect(loop.tick(15_000, 100)).toEqual({ type: 'none' })
    expect(loop.tick(20_000, 200)).toEqual({ type: 'seek', positionMs: 8_000, pauseMs: 0 })
    expect(loop.tick(20_000, 1_000)).toEqual({ type: 'finished' })
  })
})
