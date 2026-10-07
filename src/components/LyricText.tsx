import type { RomajiMode } from '../hooks'
import { maskText, type HideLevel } from '../practice/mask'

/** A lyric line, with words partly or fully hidden in memorise mode. */
export function LyricText({ text, level, peek }: { text: string; level: HideLevel; peek: boolean }) {
  if (level === 0 || peek) return <>{text}</>
  return (
    <>
      {maskText(text, level).map((segment, i) =>
        segment.masked ? (
          <span key={i} className="masked" aria-hidden="true">
            {segment.text}
          </span>
        ) : (
          <span key={i}>{segment.text}</span>
        ),
      )}
    </>
  )
}

/**
 * A lyric line with its romaji. "below" shows the original with romaji underneath, "only" shows
 * just the romaji. Lines without romaji (e.g. English ones) always show the original.
 */
export function LyricWithRomaji({
  text,
  romaji,
  mode,
  level,
  peek,
}: {
  text: string
  romaji: string | null | undefined
  mode: RomajiMode
  level: HideLevel
  peek: boolean
}) {
  if (!romaji || mode === 'off') return <LyricText text={text} level={level} peek={peek} />
  if (mode === 'only') return <LyricText text={romaji} level={level} peek={peek} />
  return (
    <>
      <span className="line-original">
        <LyricText text={text} level={level} peek={peek} />
      </span>
      <span className="romaji">
        <LyricText text={romaji} level={level} peek={peek} />
      </span>
    </>
  )
}
