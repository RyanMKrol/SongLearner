import type { RomajiMode } from '../hooks'
import { hasJapanese, type RomajiLine, type RomajiWord } from '../lyrics/romaji'
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
 * Romaji for a line, word by word. Words that songs often read differently get a dotted
 * underline; in fix mode every Japanese word becomes a button for correcting its reading.
 */
function RomajiWords({
  line,
  level,
  peek,
  fixMode,
  onWordClick,
}: {
  line: RomajiLine
  level: HideLevel
  peek: boolean
  fixMode: boolean
  onWordClick?: (word: RomajiWord) => void
}) {
  // Hidden words are drawn by LyricText; word-level styling only matters when they're visible.
  if (level !== 0 && !peek && !fixMode) return <LyricText text={line.text} level={level} peek={peek} />
  return (
    <>
      {line.words.map((word, i) => {
        const space = word.spaceBefore ? ' ' : ''
        const clickable = fixMode && word.kind === 'word' && hasJapanese(word.source)
        const hint = !word.fixed && word.alternatives.length > 0
        const title = word.fixed
          ? `${word.source}: you set this to "${word.text}" (dictionary says "${word.standard}")`
          : hint
            ? `${word.source}: songs often sing this as "${word.alternatives.join('" or "')}"`
            : undefined
        const className = ['romaji-word', hint ? 'has-hint' : '', word.fixed ? 'is-fixed' : '', clickable ? 'is-clickable' : '']
          .filter(Boolean)
          .join(' ')
        return (
          <span key={i}>
            {space}
            {clickable ? (
              <button
                className={className}
                title={title}
                onClick={(e) => {
                  e.stopPropagation()
                  onWordClick?.(word)
                }}
              >
                {word.text}
              </button>
            ) : (
              <span className={className} title={title}>
                {word.text}
              </span>
            )}
          </span>
        )
      })}
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
  fixMode = false,
  onWordClick,
}: {
  text: string
  romaji: RomajiLine | null | undefined
  mode: RomajiMode
  level: HideLevel
  peek: boolean
  fixMode?: boolean
  onWordClick?: (word: RomajiWord) => void
}) {
  if (!romaji || mode === 'off') return <LyricText text={text} level={level} peek={peek} />
  const words = <RomajiWords line={romaji} level={level} peek={peek} fixMode={fixMode} onWordClick={onWordClick} />
  if (mode === 'only') return words
  return (
    <>
      <span className="line-original">
        <LyricText text={text} level={level} peek={peek} />
      </span>
      <span className="romaji">{words}</span>
    </>
  )
}
