import { formatTime, usePosition } from '../hooks'
import type { LyricLine } from '../lyrics/lrc'
import { isSung } from '../lyrics/sections'

export interface OutroState {
  /** First and last line of the repeated part (indices into `lines`), once picked. */
  from: number | null
  to: number | null
  /** Lines added so far. */
  taps: number
  /** The lyrics as they were before adding the ending. */
  lines: LyricLine[]
}

/**
 * Shown after the last lyric line when the song carries on past it, or when you've added lines.
 * Lyric files often leave out an outro that repeats an earlier part, so you can tap it in: pick
 * the repeated lines, then tap as each one is sung.
 */
export function EndOfLyrics({
  endsAtMs,
  durationMs,
  hasAdditions,
  outro,
  onStart,
  onTap,
  onUndoTap,
  onFinish,
  onRemoveAdditions,
}: {
  /** Song time of the last lyric line. */
  endsAtMs: number
  durationMs: number
  hasAdditions: boolean
  outro: OutroState | null
  onStart: () => void
  onTap: () => void
  onUndoTap: () => void
  onFinish: (keep: boolean) => void
  onRemoveAdditions: () => void
}) {
  const position = usePosition(250)
  const missing = durationMs - endsAtMs

  if (!outro) {
    return (
      <div className="end-notice" onClick={(e) => e.stopPropagation()}>
        {missing > 25000 && (
          <p>
            These lyrics end at <strong>{formatTime(endsAtMs)}</strong>, but the song runs to{' '}
            <strong>{formatTime(durationMs)}</strong>. If the singing carries on, it&apos;s usually an earlier part
            repeated. You can tap it in.
          </p>
        )}
        <div className="end-notice-actions">
          {missing > 25000 && (
            <button className="btn btn-primary btn-small" onClick={onStart}>
              Add the ending by tapping
            </button>
          )}
          {hasAdditions && (
            <button className="btn btn-small" onClick={onRemoveAdditions}>
              Remove the lines you added
            </button>
          )}
        </div>
      </div>
    )
  }

  // The repeated part, in order, without instrumental markers.
  const sequence =
    outro.from === null || outro.to === null
      ? []
      : outro.lines.slice(outro.from, outro.to + 1).filter(isSung)
  const next = sequence.length > 0 ? sequence[outro.taps % sequence.length] : null

  return (
    <div className="end-notice is-active" onClick={(e) => e.stopPropagation()}>
      {outro.from === null ? (
        <p>
          <strong>Step 1:</strong> click the line in the lyrics above where the repeated part starts. Shift-click a
          later line to loop back after it; otherwise it runs to the last line.
        </p>
      ) : (
        <>
          <p>
            <strong>{outro.taps === 0 ? 'Step 2' : `${outro.taps} added`}:</strong> repeating {sequence.length}{' '}
            {sequence.length === 1 ? 'line' : 'lines'} (highlighted above). Play from just before the singing
            comes back and press <kbd>Space</kbd> the moment each line starts. <kbd>Backspace</kbd> undoes a tap.
            {outro.taps === 0 && ' You can still click a different line to change where it starts.'}
          </p>
          {next && (
            <div className="end-notice-next">
              <span className="muted small">Next line ({formatTime(position)})</span>
              <span className="end-notice-next-text">{next.text}</span>
            </div>
          )}
        </>
      )}
      <div className="end-notice-actions">
        {outro.from !== null && (
          <>
            <button className="btn btn-primary" onClick={onTap}>
              Tap (Space)
            </button>
            <button className="btn btn-small" onClick={onUndoTap} disabled={outro.taps === 0}>
              Undo tap
            </button>
          </>
        )}
        <button className="btn btn-small" onClick={() => onFinish(true)} disabled={outro.taps === 0}>
          Done
        </button>
        <button className="btn btn-small btn-ghost" onClick={() => onFinish(false)}>
          Cancel{outro.taps > 0 ? ' (remove these)' : ''}
        </button>
      </div>
    </div>
  )
}
