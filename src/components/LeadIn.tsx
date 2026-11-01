import { useEffect, useRef } from 'react'

/** Shortest wait worth counting down: anything quicker is just a breath between lines. */
const MIN_WAIT_MS = 3000
const DOTS = 3

/**
 * Counts in to the next sung line during an intro or instrumental break: "♪ 12s" while there's a
 * while to go, then three dots going out one a second, like a karaoke machine. Drawn every frame
 * without re-rendering. Hidden (but still taking its space, so nothing jumps) when not waiting.
 */
export function LeadIn({ waitFromMs, startMs, now }: { waitFromMs: number; startMs: number; now: () => number }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let frame = 0
    let shown = ''
    const paint = () => {
      const el = ref.current
      if (el) {
        const t = now()
        const left = startMs - t
        const waiting = t >= waitFromMs && left > 0 && startMs - waitFromMs >= MIN_WAIT_MS
        const seconds = Math.ceil(left / 1000)
        const key = waiting ? String(seconds) : 'off'
        if (key !== shown) {
          shown = key
          el.classList.toggle('is-on', waiting)
          el.classList.toggle('is-dots', waiting && seconds <= DOTS)
          const text = el.querySelector('.lead-in-text')
          if (text) text.textContent = waiting && seconds > DOTS ? `♪ ${seconds}s` : ''
          el.querySelectorAll('.lead-in-dot').forEach((dot, i) => dot.classList.toggle('is-lit', i < seconds))
        }
      }
      frame = requestAnimationFrame(paint)
    }
    paint()
    return () => cancelAnimationFrame(frame)
  }, [waitFromMs, startMs, now])

  return (
    <div ref={ref} className="lead-in" aria-hidden="true">
      <span className="lead-in-text" />
      <span className="lead-in-dots">
        {Array.from({ length: DOTS }, (_, i) => (
          <span key={i} className="lead-in-dot" />
        ))}
      </span>
    </div>
  )
}
