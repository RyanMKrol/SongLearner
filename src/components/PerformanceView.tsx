import { useEffect } from 'react'
import { usePlayer, usePosition, useDerivedFromPosition, type RomajiMode } from '../hooks'
import { lineIndexAt, type LyricLine } from '../lyrics/lrc'
import type { RomajiLine } from '../lyrics/romaji'
import { isSung } from '../lyrics/sections'
import type { Mask } from '../practice/mask'
import { playerController } from '../spotify/player'
import { LyricWithRomaji } from './LyricText'
import type { LineFill } from './LyricsPane'

/** Full-screen, distraction-free view for singing the whole song through. */
export function PerformanceView({
  lines,
  offsetMs,
  durationMs,
  hideFor,
  peek,
  romaji,
  romajiMode,
  fill,
  onClose,
}: {
  lines: LyricLine[]
  offsetMs: number
  durationMs: number
  hideFor: (lineIndex: number) => Mask
  peek: boolean
  romaji: (RomajiLine | null)[] | null
  romajiMode: RomajiMode
  fill?: LineFill | null
  onClose: () => void
}) {
  const player = usePlayer()
  const position = usePosition(250)
  const current = useDerivedFromPosition((pos) => lineIndexAt(lines, pos + offsetMs))

  useEffect(() => {
    const el = document.documentElement
    if (!document.fullscreenElement) el.requestFullscreen?.().catch(() => {})
    const onChange = () => {
      if (!document.fullscreenElement) onClose()
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    }
  }, [onClose])

  const show = (i: number) => (
    <LyricWithRomaji
      text={lines[i].text}
      romaji={romaji?.[i]}
      mode={romajiMode}
      level={hideFor(i)}
      peek={peek}
      fill={fill && i === current ? { words: (shown) => fill.words(i, shown), now: fill.now } : null}
    />
  )

  const sungAfter = (from: number, count: number) => {
    const out: number[] = []
    for (let i = from + 1; i < lines.length && out.length < count; i++) if (isSung(lines[i])) out.push(i)
    return out
  }

  const currentIsSung = current >= 0 && isSung(lines[current])
  const upcoming = sungAfter(current, currentIsSung ? 2 : 3)
  const main = currentIsSung ? current : null
  const previous = (() => {
    for (let i = current - (currentIsSung ? 1 : 0); i >= 0; i--) if (isSung(lines[i])) return i
    return null
  })()

  return (
    <div className="performance" onDoubleClick={onClose}>
      <div className="performance-lines">
        <div className="perf-prev">
          {previous !== null && show(previous)}
        </div>
        <div className={`perf-current ${main === null ? 'is-waiting' : ''}`}>
          {main !== null ? show(main) : '♪'}
        </div>
        {upcoming.map((i, k) => (
          <div key={i} className={k === 0 ? 'perf-next' : 'perf-later'}>
            {show(i)}
          </div>
        ))}
      </div>
      <div className="performance-footer">
        <button className="btn btn-ghost" onClick={() => void playerController.togglePlay('performance mode button')}>
          {player.paused ? '▶ Play' : '❚❚ Pause'}
        </button>
        <div className="perf-progress">
          <div style={{ width: `${Math.min(100, (position / Math.max(durationMs, 1)) * 100)}%` }} />
        </div>
        <button className="btn btn-ghost" onClick={onClose}>
          Exit (Esc)
        </button>
      </div>
    </div>
  )
}
