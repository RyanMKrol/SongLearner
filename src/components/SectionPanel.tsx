import { useState } from 'react'
import { formatTime } from '../hooks'
import type { Section, SectionTiming } from '../lyrics/sections'
import type { LoopStatus } from '../playback/loop'
import type { HideLevel } from '../practice/mask'
import type { PracticeSettings } from '../practice/settings'
import type { Mastery } from '../practice/storage'

const MASTERY_LABELS = ['Not started', 'Learning', 'Almost', 'Know it'] as const
const HIDE_LABELS = ['Aa', 'A…', '…', 'Fade'] as const
const HIDE_TITLES = [
  'Showing all words',
  'First letters only',
  'Words hidden',
  'Fades as you loop: more of each word hidden every time round',
] as const

interface Props {
  sections: Section[]
  timings: (SectionTiming | null)[]
  synced: boolean
  selection: { from: number; to: number } | null
  onSelect: (index: number, extend: boolean) => void
  mastery: (section: Section) => Mastery
  onMastery: (section: Section, value: Mastery) => void
  hide: (section: Section) => HideLevel
  onHide: (section: Section, value: HideLevel) => void
  onHideAll: (value: HideLevel) => void
  onRename: (section: Section, name: string | null) => void
  editSplits: boolean
  onToggleEditSplits: () => void
  customSplits: boolean
  onResetSplits: () => void
  settings: PracticeSettings
  onSettings: (s: PracticeSettings) => void
  onLoop: (from: number, to: number) => void
  /** Times sections from..to will loop: what's saved for them, or the default. */
  loopReps: (from: number, to: number) => number | null
  onLoopReps: (from: number, to: number, reps: number | null) => void
  /** What's saved for one section, if anything. */
  savedLoopReps: (section: Section) => number | null | undefined
  onBuildUp: (from: number, to: number) => void
  /** Turn sections from..to into one. */
  onMerge: (from: number, to: number) => void
  /** Whether a section was merged (has automatic splits inside it). */
  canSplit: (section: Section) => boolean
  onSplit: (index: number) => void
  practice: LoopStatus | null
  finished: { fromSection: number; toSection: number } | null
  onStop: () => void
  onRateFinished: (value: Mastery) => void
}

export function SectionPanel(props: Props) {
  const { sections, timings, selection, settings, practice } = props
  const [renaming, setRenaming] = useState<number | null>(null)
  // Touch screens have no Shift-click: this makes the next tap extend the selection instead.
  const [extending, setExtending] = useState(false)

  const sel = selection ?? null
  const selName =
    sel === null
      ? null
      : sel.from === sel.to
        ? sections[sel.from]?.name
        : `${sections[sel.from]?.name} → ${sections[sel.to]?.name}`

  const set = (patch: Partial<PracticeSettings>) => props.onSettings({ ...settings, ...patch })

  return (
    <div className="panel">
      <div className="panel-title-row">
        <span className="panel-title">Sections</span>
        <span className="panel-actions">
          {props.customSplits && (
            <button className="btn btn-small btn-ghost" onClick={props.onResetSplits}>
              Reset splits
            </button>
          )}
          <button
            className={`btn btn-small ${props.editSplits ? 'btn-primary' : ''}`}
            onClick={props.onToggleEditSplits}
            title="Click lyric lines to choose where sections start"
          >
            {props.editSplits ? 'Done' : 'Edit splits'}
          </button>
        </span>
      </div>
      {props.editSplits && (
        <p className="muted small">Click a lyric line to start a new section there. Click again to remove it.</p>
      )}

      {practice && (
        <div className="practice-status">
          <div>
            <strong>
              {practice.stepCount > 1 ? 'Building up' : 'Looping'}:{' '}
              {practice.step.fromSection === practice.step.toSection
                ? sections[practice.step.fromSection]?.name
                : `${sections[practice.step.fromSection]?.name} → ${sections[practice.step.toSection]?.name}`}
            </strong>
            <div className="muted small">
              Rep {practice.rep}
              {practice.reps !== null ? ` of ${practice.reps}` : ''}
              {practice.stepCount > 1 ? ` · step ${practice.stepIndex + 1} of ${practice.stepCount}` : ''}
            </div>
          </div>
          <button className="btn btn-small" onClick={props.onStop}>
            Stop (Esc)
          </button>
        </div>
      )}

      {props.finished && (
        <div className="practice-status is-finished">
          <div>
            <strong>Done! The song carries on. How well do you know it now?</strong>
            <div className="rate-row">
              {([1, 2, 3] as Mastery[]).map((m) => (
                <button key={m} className={`btn btn-small mastery-btn-${m}`} onClick={() => props.onRateFinished(m)}>
                  {MASTERY_LABELS[m]}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="section-list">
        {sections.map((section) => {
          const timing = timings[section.index]
          const selected = sel !== null && section.index >= sel.from && section.index <= sel.to
          const mastery = props.mastery(section)
          const hide = props.hide(section)
          const savedReps = props.savedLoopReps(section)
          return (
            <div
              key={section.startLine}
              className={`section-row ${selected ? 'is-selected' : ''}`}
              onClick={(e) => {
                props.onSelect(section.index, e.shiftKey || extending)
                setExtending(false)
              }}
            >
              <span className="section-row-main">
                {section.repeatGroup ? (
                  <span className={`badge badge-${section.repeatGroup}`}>{section.repeatGroup}</span>
                ) : (
                  <span className="badge badge-none" />
                )}
                {renaming === section.index ? (
                  <input
                    className="rename-input"
                    autoFocus
                    defaultValue={section.name}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                      if (e.key === 'Escape') setRenaming(null)
                    }}
                    onBlur={(e) => {
                      const value = e.target.value.trim()
                      props.onRename(section, value || null)
                      setRenaming(null)
                    }}
                  />
                ) : (
                  <span
                    className="section-row-name"
                    title="Double-click to rename"
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      setRenaming(section.index)
                    }}
                  >
                    {section.name}
                  </span>
                )}
                {timing && <span className="muted small section-row-time">{formatTime(timing.startMs)}</span>}
                {savedReps !== undefined && savedReps !== 1 && (
                  <span className="muted small section-row-reps" title="Times you loop this section">
                    {savedReps === null ? '∞' : `${savedReps}×`}
                  </span>
                )}
              </span>
              <span className="section-row-controls" onClick={(e) => e.stopPropagation()}>
                {props.canSplit(section) && (
                  <button
                    className="btn btn-small btn-ghost"
                    title="Split this merged section back into its parts"
                    onClick={() => props.onSplit(section.index)}
                  >
                    Split
                  </button>
                )}
                <span className="mastery-picker" title={`Mastery: ${MASTERY_LABELS[mastery]}`}>
                  {([1, 2, 3] as Mastery[]).map((m) => (
                    <button
                      key={m}
                      className={`mastery-pip ${m <= mastery ? `mastery-${mastery}` : ''}`}
                      title={m === mastery ? 'Click to clear' : MASTERY_LABELS[m]}
                      aria-label={`Mark as ${MASTERY_LABELS[m]}`}
                      onClick={() => props.onMastery(section, m === mastery ? 0 : m)}
                    />
                  ))}
                </span>
                <button
                  className={`btn btn-small hide-btn hide-${hide}`}
                  title={`${HIDE_TITLES[hide]} (click to change)`}
                  onClick={() => props.onHide(section, ((hide + 1) % 4) as HideLevel)}
                >
                  {HIDE_LABELS[hide]}
                </button>
              </span>
            </div>
          )
        })}
      </div>

      <div className="memorise-row">
        <span className="muted small">Memorise all:</span>
        {([0, 1, 2, 3] as HideLevel[]).map((level) => (
          <button key={level} className="btn btn-small" onClick={() => props.onHideAll(level)} title={HIDE_TITLES[level]}>
            {(['Show', 'First letters', 'Hide', 'Fade'] as const)[level]}
          </button>
        ))}
      </div>

      {props.synced ? (
        <div className="practice-box">
          <div className="muted small">
            {selName ? (
              <>
                Selected: <strong className="text">{selName}</strong>{' '}
                <button
                  className={`btn btn-small touch-only ${extending ? 'is-active' : ''}`}
                  onClick={() => setExtending((v) => !v)}
                >
                  {extending ? 'Now tap the last one' : 'Select more'}
                </button>
              </>
            ) : (
              <>
                <span className="shortcuts">Click a section to select it. Shift-click another to select a run.</span>
                <span className="touch-only">Tap a section to select it.</span>
              </>
            )}
          </div>
          {sel && sel.from !== sel.to && (
            <div className="practice-actions">
              <button
                className="btn"
                title="Make the selected sections one bigger section, to loop, rate and test as a whole"
                onClick={() => props.onMerge(sel.from, sel.to)}
              >
                Merge into one section
              </button>
            </div>
          )}
          <div className="practice-actions">
            <button
              className="btn btn-primary"
              disabled={!sel}
              onClick={() => sel && props.onLoop(sel.from, sel.to)}
            >
              Loop
            </button>
            <label className="inline-field">
              <select
                value={(sel ? props.loopReps(sel.from, sel.to) : 1) ?? 0}
                disabled={!sel}
                title="Saved for the selected section. With “Loop sections as you play” on, sections set above 1× loop by themselves when the song reaches them."
                onChange={(e) => sel && props.onLoopReps(sel.from, sel.to, Number(e.target.value) || null)}
              >
                <option value={0}>forever</option>
                {[1, 2, 3, 5, 10].map((n) => (
                  <option key={n} value={n}>
                    {n}×
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="practice-actions">
            <label
              className="inline-field checkbox"
              title="Sections set above 1× loop by themselves when the song reaches them. Turn off for a full run-through; the counts are kept."
            >
              <input type="checkbox" checked={settings.autoLoop} onChange={(e) => set({ autoLoop: e.target.checked })} />
              <span className="small">Loop sections as you play</span>
            </label>
          </div>
          <div className="practice-actions">
            <button
              className="btn btn-primary"
              disabled={!sel || sel.from === sel.to}
              title={sel && sel.from === sel.to ? 'Select two or more sections to build up' : 'A, then A+B, then A+B+C…'}
              onClick={() => sel && props.onBuildUp(sel.from, sel.to)}
            >
              Build up
            </button>
            <label className="inline-field">
              <select value={settings.buildReps} onChange={(e) => set({ buildReps: Number(e.target.value) })}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n}× each step
                  </option>
                ))}
              </select>
            </label>
            <label className="inline-field checkbox">
              <input
                type="checkbox"
                checked={settings.soloFirst}
                onChange={(e) => set({ soloFirst: e.target.checked })}
              />
              <span className="small">new part alone first</span>
            </label>
          </div>
          <div className="practice-actions">
            <label className="inline-field">
              <span className="muted small">Run-up</span>
              <select value={settings.leadInMs} onChange={(e) => set({ leadInMs: Number(e.target.value) })}>
                {[0, 1000, 2000, 3000, 5000].map((ms) => (
                  <option key={ms} value={ms}>
                    {ms / 1000}s
                  </option>
                ))}
              </select>
            </label>
            <label className="inline-field" title="For sections set to Fade: how many loops until every letter is hidden">
              <span className="muted small">Fade over</span>
              <select value={settings.fadeLoops} onChange={(e) => set({ fadeLoops: Number(e.target.value) })}>
                {[2, 3, 4, 5, 6, 8, 10].map((n) => (
                  <option key={n} value={n}>
                    {n} loops
                  </option>
                ))}
              </select>
            </label>
            <label className="inline-field">
              <span className="muted small">Pause between reps</span>
              <select value={settings.gapMs} onChange={(e) => set({ gapMs: Number(e.target.value) })}>
                {[0, 1000, 2000, 3000].map((ms) => (
                  <option key={ms} value={ms}>
                    {ms / 1000}s
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      ) : (
        <p className="muted small">Looping needs timed lyrics. Use “Time them yourself” below.</p>
      )}
    </div>
  )
}
