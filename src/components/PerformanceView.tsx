import { useEffect } from 'react'
import { usePlayer, usePosition, useDerivedFromPosition, type RomajiMode } from '../hooks'
import { lineIndexAt, type LyricLine } from '../lyrics/lrc'
import { isSung } from '../lyrics/sections'
import type { HideLevel } from '../practice/mask'
import { playerController } from '../spotify/player'
import { LyricWithRomaji } from './LyricText'

/** Full-screen, distraction-free view for singing the whole song through. */
export function PerformanceView({
  lines,
  offsetMs,
  durationMs,
  hideFor,
  peek,
  romaji,
  romajiMode,
  onClose,
}: {
  lines: LyricLine[]
  offsetMs: number
  durationMs: number
  hideFor: (lineIndex: number) => HideLevel
  peek: boolean
  romaji: (string | null)[] | null
  romajiMode: RomajiMode
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
    <LyricWithRomaji text={lines[i].text} romaji={romaji?.[i]} mode={romajiMode} level={hideFor(i)} peek={peek} />
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
        <button className="btn btn-ghost" onClick={() => void playerController.togglePlay()}>
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
