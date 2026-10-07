import { useState } from 'react'
import { formatTime } from '../hooks'
import type { Section, SectionTiming } from '../lyrics/sections'
import type { LoopStatus } from '../playback/loop'
import type { HideLevel } from '../practice/mask'
import type { PracticeSettings } from '../practice/settings'
import type { Mastery } from '../practice/storage'

const MASTERY_LABELS = ['Not started', 'Learning', 'Almost', 'Know it'] as const
const HIDE_LABELS = ['Aa', 'A…', '…'] as const
const HIDE_TITLES = ['Showing all words', 'First letters only', 'Words hidden'] as const

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
  onBuildUp: (from: number, to: number) => void
  practice: LoopStatus | null
  finished: { fromSection: number; toSection: number } | null
  onStop: () => void
  onRateFinished: (value: Mastery) => void
}

export function SectionPanel(props: Props) {
  const { sections, timings, selection, settings, practice } = props
  const [renaming, setRenaming] = useState<number | null>(null)

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
            <strong>Done! How well do you know it now?</strong>
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
          return (
            <div
              key={section.startLine}
              className={`section-row ${selected ? 'is-selected' : ''}`}
              onClick={(e) => props.onSelect(section.index, e.shiftKey)}
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
              </span>
              <span className="section-row-controls" onClick={(e) => e.stopPropagation()}>
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
                  onClick={() => props.onHide(section, ((hide + 1) % 3) as HideLevel)}
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
        {([0, 1, 2] as HideLevel[]).map((level) => (
          <button key={level} className="btn btn-small" onClick={() => props.onHideAll(level)} title={HIDE_TITLES[level]}>
            {level === 0 ? 'Show' : level === 1 ? 'First letters' : 'Hide'}
          </button>
        ))}
      </div>

      {props.synced ? (
        <div className="practice-box">
          <div className="muted small">
            {selName ? (
              <>
                Selected: <strong className="text">{selName}</strong>
              </>
            ) : (
              'Click a section to select it. Shift-click another to select a run.'
            )}
          </div>
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
                value={settings.loopReps ?? 0}
                onChange={(e) => set({ loopReps: Number(e.target.value) || null })}
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
