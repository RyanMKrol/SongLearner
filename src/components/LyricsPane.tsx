import { useEffect, useRef, useState, type ReactNode } from 'react'
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
  /** Picks a reading from a word's hover menu; null means the dictionary reading. */
  onChooseReading: (word: RomajiWord, reading: string | null) => void
  /** Lines being practised right now; everything else is dimmed. */
  activeLines: { from: number; to: number } | null
  selection: { from: number; to: number } | null
  mastery: (section: Section) => Mastery
  editSplits: boolean
  onToggleSplit: (lineIndex: number) => void
  onLineClick: (lineIndex: number) => void
  onSectionClick: (sectionIndex: number, extend: boolean) => void
  onSectionLoop: (sectionIndex: number) => void
  /** Test mode: words are blurred and learned sections fold away. */
  test: TestModeProps | null
  /** Shown after the last line (e.g. when the lyrics end before the song does). */
  endNotice?: ReactNode
  /** When set, clicking lines picks a range (for adding an ending) instead of seeking. */
  pickLines?: { from: number | null; to: number | null; onPick: (lineIndex: number, extend: boolean) => void } | null
}

export interface TestModeProps {
  /** Section being sung right now that will count if it gets to the end. */
  attempt: number | null
  /** Section that was just passed, for a moment of celebration. */
  justPassed: number | null
  onStartSection: (sectionIndex: number) => void
  onSetLearned: (sectionIndex: number, learned: boolean) => void
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
  const test = props.test
  /** In test mode, learned sections show only their header. */
  const collapsedSection = (lineIndex: number): Section | null => {
    if (!test) return null
    let found: Section | null = null
    for (const s of sections) if (s.startLine <= lineIndex) found = s
    return found && lineIndex <= found.endLine && props.mastery(found) === 3 ? found : null
  }
  const nextSung = (() => {
    for (let i = currentLine + 1; i < lines.length; i++) if (isSung(lines[i])) return i
    return -1
  })()

  return (
    <div className="lyrics-wrap">
      <div
        className={[
          'lyrics',
          synced ? 'is-synced' : 'is-plain',
          editSplits ? 'is-editing' : '',
          test ? 'is-test' : '',
          test && props.peek ? 'is-peeking' : '',
        ].join(' ')}
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
            props.pickLines ? 'is-pickable' : '',
            props.pickLines?.from != null && props.pickLines.to != null && i >= props.pickLines.from && i <= props.pickLines.to
              ? 'is-picked'
              : '',
            sung ? '' : 'is-gap',
          ]
            .filter(Boolean)
            .join(' ')

          const header = section && (
            <SectionHeader
              section={section}
              synced={synced}
              selected={selection !== null && section.index >= selection.from && section.index <= selection.to}
              mastery={props.mastery(section)}
              onClick={(extend) => props.onSectionClick(section.index, extend)}
              onLoop={() => props.onSectionLoop(section.index)}
              test={test}
              collapsed={collapsedSection(i) !== null}
              onHeaderElement={(el) => {
                // Folded sections scroll to their header, since their lines aren't drawn.
                if (collapsedSection(i)) for (let j = section.startLine; j <= section.endLine; j++) lineRefs.current[j] = el
              }}
            />
          )
          if (collapsedSection(i)) return <div key={i}>{header}</div>

          return (
            <div key={i}>
              {header}
              <div
                ref={(el) => {
                  lineRefs.current[i] = el
                }}
                className={classes}
                onClick={(e) => {
                  if (props.pickLines) {
                    props.pickLines.onPick(i, e.shiftKey)
                  } else if (editSplits) {
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
                    // Hover menus would give the words away in test mode.
                    onChooseReading={test ? undefined : props.onChooseReading}
                  />
                  </span>
                ) : (
                  '♪'
                )}
              </div>
            </div>
          )
        })}
        {props.endNotice}
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
  test: TestModeProps | null
  collapsed: boolean
  onHeaderElement: (el: HTMLDivElement | null) => void
}) {
  const { section, test, onHeaderElement } = props
  const learned = props.mastery === 3
  const testing = test?.attempt === section.index
  const passed = test?.justPassed === section.index
  const classes = [
    'section-header',
    props.selected ? 'is-selected' : '',
    props.collapsed ? 'is-collapsed' : '',
    testing ? 'is-testing' : '',
    passed ? 'is-passed' : '',
  ].join(' ')

  return (
    <div
      ref={onHeaderElement}
      className={classes}
      onClick={(e) => props.onClick(e.shiftKey)}
      title="Click to select, shift-click to select a run of sections"
    >
      {section.repeatGroup && <span className={`badge badge-${section.repeatGroup}`}>{section.repeatGroup}</span>}
      <span className="section-header-name">{section.name}</span>
      {test ? (
        <>
          {learned && <span className="learned-tag">✓ Learned</span>}
          {testing && <span className="testing-tag">Singing… keep going</span>}
          <span className="section-header-actions">
            <button
              className="btn btn-small"
              onClick={(e) => {
                e.stopPropagation()
                test.onStartSection(section.index)
              }}
            >
              Start here
            </button>
            <button
              className="btn btn-small btn-ghost"
              onClick={(e) => {
                e.stopPropagation()
                test.onSetLearned(section.index, !learned)
              }}
            >
              {learned ? 'Not learned yet' : 'Mark learned'}
            </button>
          </span>
        </>
      ) : (
        <>
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
        </>
      )}
    </div>
  )
}
