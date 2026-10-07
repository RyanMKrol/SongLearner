import { useCallback, useEffect, useState } from 'react'
import { formatTime, usePosition } from '../hooks'
import { toLrc, type LyricLine } from '../lyrics/lrc'
import { playerController } from '../spotify/player'

// People tap a little after they hear a line start; pull each tap back slightly.
const REACTION_MS = 120

/**
 * Time lyrics by hand: play the song and tap at the start of each line.
 * Used when LRCLIB only has plain lyrics, or its timing is wrong.
 */
export function TapSync({
  lines,
  romaji,
  onSave,
  onClose,
}: {
  lines: LyricLine[]
  /** Romaji for each of `lines`, shown underneath so Japanese lines can be followed. */
  romaji?: (string | null)[] | null
  onSave: (lrc: string) => void
  onClose: () => void
}) {
  const [taps, setTaps] = useState<number[]>([])
  const [started, setStarted] = useState(false)
  const position = usePosition(100)
  const done = taps.length >= lines.length

  const start = () => {
    setTaps([])
    setStarted(true)
    void playerController.seek(0).then(() => playerController.resume())
  }

  const tap = useCallback(() => {
    setTaps((prev) => {
      if (prev.length >= lines.length) return prev
      const last = prev.at(-1) ?? -1
      const t = Math.max(playerController.clock.position() - REACTION_MS, last + 50, 0)
      return [...prev, t]
    })
  }, [lines.length])

  const undo = useCallback(() => {
    setTaps((prev) => {
      if (prev.length === 0) return prev
      const next = prev.slice(0, -1)
      // Jump back to just before the previous line so you can hear the run-up again.
      void playerController.seek(Math.max(0, (next.at(-1) ?? 0) - 1500))
      return next
    })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation()
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (!started) {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault()
          start()
        }
      } else if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault()
        if (!e.repeat) tap()
      } else if (e.key === 'Backspace') {
        e.preventDefault()
        undo()
      }
    }
    // Capture phase, so the song view's own shortcuts don't also fire.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const save = () => {
    const timed = lines.map((line, i) => ({ timeMs: taps[i], text: line.text, stanzaBreakBefore: line.stanzaBreakBefore }))
    onSave(toLrc(timed))
  }

  const current = taps.length
  const text = (i: number) => {
    const line = lines[i]
    if (!line) return ' '
    const r = romaji?.[i]
    return r ? (
      <>
        {line.text}
        <span className="romaji">{r}</span>
      </>
    ) : (
      line.text
    )
  }
  return (
    <div className="overlay">
      <div className="tapsync">
        <div className="tapsync-head">
          <h2>Time the lyrics yourself</h2>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel (Esc)
          </button>
        </div>
        {!started ? (
          <div className="tapsync-intro">
            <p>
              The song will restart from the beginning. Press <kbd>Space</kbd> the moment each line
              starts. Made a mistake? <kbd>Backspace</kbd> undoes the last tap and rewinds a little.
            </p>
            <button className="btn btn-primary btn-big" onClick={start}>
              Start
            </button>
          </div>
        ) : (
          <>
            <div className="muted small">
              {formatTime(position)} · line {Math.min(current + 1, lines.length)} of {lines.length}
            </div>
            <div className="tapsync-lines">
              <div className="tapsync-prev">{current > 0 ? text(current - 1) : ' '}</div>
              <div className="tapsync-current">{done ? 'All lines timed!' : text(current)}</div>
              <div className="tapsync-next">{text(current + 1)}</div>
              <div className="tapsync-next faint">{text(current + 2)}</div>
            </div>
            <div className="tapsync-actions">
              {done ? (
                <>
                  <button className="btn" onClick={start}>
                    Start over
                  </button>
                  <button className="btn btn-primary btn-big" onClick={save}>
                    Save timing
                  </button>
                </>
              ) : (
                <>
                  <button className="btn" onClick={undo} disabled={taps.length === 0}>
                    Undo (Backspace)
                  </button>
                  <button className="btn btn-primary btn-big" onClick={tap}>
                    Tap (Space)
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
