import { useState } from 'react'
import { formatTime, usePosition } from '../hooks'
import type { Section } from '../lyrics/sections'

/**
 * Shown after the last lyric line when the song carries on well past it. Lyric files often leave
 * out an outro that repeats an earlier part; this lets you add that repeat yourself.
 */
export function EndOfLyrics({
  endsAtMs,
  durationMs,
  sections,
  onAdd,
  onUndo,
}: {
  /** Song time of the last lyric line. */
  endsAtMs: number
  durationMs: number
  sections: Section[]
  onAdd: (sectionIndex: number) => void
  /** Present when the last addition can be undone. */
  onUndo: (() => void) | null
}) {
  const position = usePosition(250)
  const [choice, setChoice] = useState(() => {
    // The last repeated part (usually the chorus) is the most likely outro.
    const repeated = [...sections].reverse().find((s) => s.repeatGroup)
    return repeated?.index ?? sections.length - 1
  })
  const pastEnd = position > endsAtMs + 500
  const missing = durationMs - endsAtMs

  return (
    <div className="end-notice" onClick={(e) => e.stopPropagation()}>
      {missing > 25000 && (
        <p>
          These lyrics end at <strong>{formatTime(endsAtMs)}</strong>, but the song runs to{' '}
          <strong>{formatTime(durationMs)}</strong>. If the singing carries on, it&apos;s often a repeat of an
          earlier part. Play to where it starts, pause, and add that part there.
        </p>
      )}
      <div className="end-notice-actions">
        <select value={choice} onChange={(e) => setChoice(Number(e.target.value))} aria-label="Part to repeat">
          {sections.map((s) => (
            <option key={s.startLine} value={s.index}>
              {s.repeatGroup ? `${s.repeatGroup} · ` : ''}
              {s.name}
            </option>
          ))}
        </select>
        <button className="btn btn-primary btn-small" disabled={!pastEnd} onClick={() => onAdd(choice)}>
          {pastEnd ? `Add it at ${formatTime(position)}` : 'Play past the last line first'}
        </button>
        {onUndo && (
          <button className="btn btn-small btn-ghost" onClick={onUndo}>
            Undo last addition
          </button>
        )}
      </div>
    </div>
  )
}
