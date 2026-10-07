import { useEffect, useRef, useState } from 'react'
import type { LyricLine } from '../lyrics/lrc'
import { isSung, type Section } from '../lyrics/sections'
import type { HideLevel } from '../practice/mask'
import type { Mastery } from '../practice/storage'
import type { RomajiMode } from '../hooks'
import type { RomajiLine, RomajiWord } from '../lyrics/romaji'
import { LyricWithRomaji } from './LyricText'

interface Props {
  lines: LyricLine[]
  synced: boolean
  sections: Section[]
  currentLine: number
  hideFor: (lineIndex: number) => HideLevel
  peek: boolean
  /** Romaji per line for Japanese lyrics, once it's ready. */
  romaji: (RomajiLine | null)[] | null
  romajiMode: RomajiMode
  /** When on, romaji words are buttons for correcting their reading. */
  fixReadings: boolean
  onWordClick: (word: RomajiWord) => void
  /** Lines being practised right now; everything else is dimmed. */
  activeLines: { from: number; to: number } | null
  selection: { from: number; to: number } | null
  mastery: (section: Section) => Mastery
  editSplits: boolean
  onToggleSplit: (lineIndex: number) => void
  onLineClick: (lineIndex: number) => void
  onSectionClick: (sectionIndex: number, extend: boolean) => void
  onSectionLoop: (sectionIndex: number) => void
}

const FOLLOW_PAUSE_MS = 4000

export function LyricsPane(props: Props) {
  const { lines, synced, sections, currentLine, activeLines, selection, editSplits } = props
  const containerRef = useRef<HTMLDivElement>(null)
  const lineRefs = useRef<(HTMLDivElement | null)[]>([])
  const userScrolledAt = useRef(0)
  const [following, setFollowing] = useState(true)

  const scrollToLine = (index: number, smooth: boolean) => {
    const container = containerRef.current
    const el = lineRefs.current[index]
    if (!container || !el) return
    const top = el.offsetTop - container.clientHeight * 0.4 + el.clientHeight / 2
    container.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' })
  }

  useEffect(() => {
    if (!synced || currentLine < 0) return
    if (Date.now() - userScrolledAt.current < FOLLOW_PAUSE_MS) return
    setFollowing(true)
    scrollToLine(currentLine, true)
  }, [currentLine, synced])

  const markUserScroll = () => {
    userScrolledAt.current = Date.now()
    if (synced) setFollowing(false)
  }

  const sectionByStart = new Map(sections.map((s) => [s.startLine, s]))
  const nextSung = (() => {
    for (let i = currentLine + 1; i < lines.length; i++) if (isSung(lines[i])) return i
    return -1
  })()

  return (
    <div className="lyrics-wrap">
      <div
        className={`lyrics ${synced ? 'is-synced' : 'is-plain'} ${editSplits ? 'is-editing' : ''}`}
        ref={containerRef}
        onWheel={markUserScroll}
        onTouchMove={markUserScroll}
      >
        <div className="lyrics-pad" />
        {lines.map((line, i) => {
          const section = sectionByStart.get(i)
          const sung = isSung(line)
          const outside = activeLines !== null && (i < activeLines.from || i > activeLines.to)
          const classes = [
            'line',
            synced && i === currentLine ? 'is-current' : '',
            synced && i < currentLine ? 'is-past' : '',
            synced && i === nextSung ? 'is-next' : '',
            outside ? 'is-outside' : '',
            sung ? '' : 'is-gap',
          ]
            .filter(Boolean)
            .join(' ')

          return (
            <div key={i}>
              {section && (
                <SectionHeader
                  section={section}
                  synced={synced}
                  selected={
                    selection !== null &&
                    section.index >= selection.from &&
                    section.index <= selection.to
                  }
                  mastery={props.mastery(section)}
                  onClick={(extend) => props.onSectionClick(section.index, extend)}
                  onLoop={() => props.onSectionLoop(section.index)}
                />
              )}
              <div
                ref={(el) => {
                  lineRefs.current[i] = el
                }}
                className={classes}
                onClick={() => {
                  if (editSplits) {
                    if (sung) props.onToggleSplit(i)
                  } else if (synced && line.timeMs !== null) {
                    userScrolledAt.current = 0
                    props.onLineClick(i)
                  }
                }}
              >
                {editSplits && sung && (
                  <span className={`split-marker ${section ? 'is-split' : ''}`}>
                    {section ? '✂ starts here' : '✂'}
                  </span>
                )}
                {sung ? (
                  <span className="line-text">
                  <LyricWithRomaji
                    text={line.text}
                    romaji={props.romaji?.[i]}
                    mode={props.romajiMode}
                    level={props.hideFor(i)}
                    peek={props.peek}
                    fixMode={props.fixReadings}
                    onWordClick={props.onWordClick}
                  />
                  </span>
                ) : (
                  '♪'
                )}
              </div>
            </div>
          )
        })}
        <div className="lyrics-pad" />
      </div>
      {synced && !following && currentLine >= 0 && (
        <button
          className="btn follow-btn"
          onClick={() => {
            userScrolledAt.current = 0
            setFollowing(true)
            scrollToLine(currentLine, true)
          }}
        >
          Back to current line
        </button>
      )}
    </div>
  )
}

const MASTERY_LABELS = ['Not started', 'Learning', 'Almost', 'Know it'] as const

function SectionHeader(props: {
  section: Section
  synced: boolean
  selected: boolean
  mastery: Mastery
  onClick: (extend: boolean) => void
  onLoop: () => void
}) {
  const { section } = props
  return (
    <div
      className={`section-header ${props.selected ? 'is-selected' : ''}`}
      onClick={(e) => props.onClick(e.shiftKey)}
      title="Click to select, shift-click to select a run of sections"
    >
      {section.repeatGroup && <span className={`badge badge-${section.repeatGroup}`}>{section.repeatGroup}</span>}
      <span className="section-header-name">{section.name}</span>
      <span className={`mastery-dot mastery-${props.mastery}`} title={MASTERY_LABELS[props.mastery]} />
      {props.synced && (
        <button
          className="btn btn-small"
          onClick={(e) => {
            e.stopPropagation()
            props.onLoop()
          }}
        >
          Loop
        </button>
      )}
    </div>
  )
}
