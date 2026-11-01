import { useEffect, useRef } from 'react'
import type { RomajiMode } from '../hooks'
import type { WordTime } from '../lyrics/wordAlign'
import { hasJapanese, type RomajiLine, type RomajiWord } from '../lyrics/romaji'
import { maskText, type Mask } from '../practice/mask'

/** A lyric line, with words partly or fully hidden in memorise mode. */
export function LyricText({ text, level, peek }: { text: string; level: Mask; peek: boolean }) {
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

/** Word timings for the line being sung, and the current lyric time, for the karaoke fill. */
export interface FillProps {
  /** Times for the words of the text as shown, or null if there aren't any that fit. */
  words: (shownText: string) => WordTime[] | null
  now: () => number
}

/** A line whose words fill in from left to right as they're sung. */
function KaraokeText({ text, words, now }: { text: string; words: WordTime[]; now: () => number }) {
  const refs = useRef<(HTMLSpanElement | null)[]>([])
  useEffect(() => {
    let frame = 0
    const paint = () => {
      const t = now()
      words.forEach((w, i) => {
        const el = refs.current[i]
        if (!el) return
        const share = w.endMs > w.startMs ? (t - w.startMs) / (w.endMs - w.startMs) : t >= w.startMs ? 1 : 0
        el.style.setProperty('--fill', `${Math.round(Math.min(1, Math.max(0, share)) * 1000) / 10}%`)
      })
      frame = requestAnimationFrame(paint)
    }
    paint()
    return () => cancelAnimationFrame(frame)
  }, [words, now])

  let k = 0
  return (
    <>
      {text.split(/(\s+)/).map((part, i) => {
        if (!part.trim()) return part
        const index = k++
        return (
          <span
            key={i}
            className="karaoke-word"
            ref={(el) => {
              refs.current[index] = el
            }}
          >
            {part}
          </span>
        )
      })}
    </>
  )
}

/**
 * Romaji for a line, word by word. Words that songs often read differently get a dotted
 * underline; in fix mode every Japanese word becomes a button for correcting its reading.
 */
/**
 * A word with a known alternative reading (or one you've changed). Hovering shows a small menu
 * to switch readings; "Other…" opens the full dialog for typing one in.
 */
function HintWord({
  word,
  className,
  onChooseReading,
  onOther,
}: {
  word: RomajiWord
  className: string
  onChooseReading: (word: RomajiWord, reading: string | null) => void
  onOther?: (word: RomajiWord) => void
}) {
  const options = [...new Set([word.standard, ...word.alternatives, word.text])]
  return (
    <span className="hint-word" onClick={(e) => e.stopPropagation()}>
      <span className={className} tabIndex={0}>
        {word.text}
      </span>
      <span className="hint-menu" role="menu" aria-label={`Readings for ${word.source}`}>
        <span className="hint-menu-head" lang="ja">
          {word.source}
        </span>
        {options.map((option) => (
          <button
            key={option}
            role="menuitemradio"
            aria-checked={option === word.text}
            className={`hint-option ${option === word.text ? 'is-current' : ''}`}
            onClick={() => onChooseReading(word, option === word.standard ? null : option)}
          >
            <span className="hint-check">{option === word.text ? '✓' : ''}</span>
            {option}
            {option === word.standard && <span className="hint-note">dictionary</span>}
          </button>
        ))}
        {onOther && (
          <button role="menuitem" className="hint-option hint-other" onClick={() => onOther(word)}>
            <span className="hint-check" />
            Other…
          </button>
        )}
      </span>
    </span>
  )
}

function RomajiWords({
  line,
  level,
  peek,
  fixMode,
  onWordClick,
  onChooseReading,
}: {
  line: RomajiLine
  level: Mask
  peek: boolean
  fixMode: boolean
  onWordClick?: (word: RomajiWord) => void
  onChooseReading?: (word: RomajiWord, reading: string | null) => void
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
            ) : onChooseReading && (hint || word.fixed) ? (
              <HintWord word={word} className={className} onChooseReading={onChooseReading} onOther={onWordClick} />
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
  onChooseReading,
  fill,
}: {
  text: string
  romaji: RomajiLine | null | undefined
  mode: RomajiMode
  level: Mask
  peek: boolean
  fixMode?: boolean
  onWordClick?: (word: RomajiWord) => void
  onChooseReading?: (word: RomajiWord, reading: string | null) => void
  /** Set on the line being sung when its word timings are known. */
  fill?: FillProps | null
}) {
  const withRomaji = romaji && mode !== 'off'
  const shown = withRomaji ? romaji.text : text
  // Hidden words stay hidden; the fill only runs over words you can see.
  const fillWords = fill && (level === 0 || peek) && !fixMode ? fill.words(shown) : null
  const filled = fill && fillWords ? <KaraokeText text={shown} words={fillWords} now={fill.now} /> : null
  if (!withRomaji) return filled ?? <LyricText text={text} level={level} peek={peek} />
  const words = filled ?? (
    <RomajiWords
      line={romaji}
      level={level}
      peek={peek}
      fixMode={fixMode}
      onWordClick={onWordClick}
      onChooseReading={onChooseReading}
    />
  )
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
