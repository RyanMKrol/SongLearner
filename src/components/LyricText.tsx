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
