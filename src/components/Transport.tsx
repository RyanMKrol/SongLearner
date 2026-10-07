import { useEffect, useState } from 'react'
import { formatTime, usePlayer, usePosition } from '../hooks'
import { playerController } from '../spotify/player'
import { useLocalSetting } from '../practice/storage'

interface Props {
  durationMs: number
  /** Song-time range being practised, drawn on the scrub bar. */
  practiceRange: { startMs: number; endMs: number } | null
}

export function Transport({ durationMs, practiceRange }: Props) {
  const player = usePlayer()
  const position = usePosition(150)
  const [dragging, setDragging] = useState<number | null>(null)
  const [volume, setVolume] = useLocalSetting('volume', 0.8)
  const shown = dragging ?? position

  // Apply the remembered volume once the player is up.
  useEffect(() => {
    if (player.status === 'ready') void playerController.setVolume(volume)
  }, [player.status, volume])
  const pct = (ms: number) => `${(Math.min(Math.max(ms / Math.max(durationMs, 1), 0), 1) * 100).toFixed(2)}%`

  const commit = () => {
    if (dragging !== null) void playerController.seek(dragging, 'scrub bar')
    setDragging(null)
  }

  return (
    <div className="transport">
      <div className="transport-row">
        <button
          className="btn btn-primary play-btn"
          onClick={() => void playerController.togglePlay('play button')}
          aria-label={player.paused ? 'Play' : 'Pause'}
        >
          {player.paused ? '▶' : '❚❚'}
        </button>
        <button className="btn btn-small" onClick={() => void playerController.seek(position - 5000, 'button: back 5s')} title="Back 5s (←)">
          −5s
        </button>
        <button className="btn btn-small" onClick={() => void playerController.seek(position + 5000, 'button: forward 5s')} title="Forward 5s (→)">
          +5s
        </button>
        <span className="time">
          {formatTime(shown)} / {formatTime(durationMs)}
        </span>
      </div>
      <div className="scrub">
        {practiceRange && (
          <div
            className="scrub-range"
            style={{ left: pct(practiceRange.startMs), width: `calc(${pct(practiceRange.endMs)} - ${pct(practiceRange.startMs)})` }}
          />
        )}
        <input
          type="range"
          min={0}
          max={Math.max(durationMs, 1)}
          step={100}
          value={Math.min(shown, durationMs)}
          onChange={(e) => setDragging(Number(e.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
          aria-label="Song position"
        />
      </div>
      <label className="volume">
        <span className="muted small">Volume</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={volume}
          onChange={(e) => {
            const v = Number(e.target.value)
            setVolume(v)
            void playerController.setVolume(v)
          }}
        />
      </label>
    </div>
  )
}

export function TimingControl({ offsetMs, onChange }: { offsetMs: number; onChange: (ms: number) => void }) {
  const describe =
    offsetMs === 0
      ? 'as published'
      : `${Math.abs(offsetMs / 1000).toFixed(2)}s ${offsetMs > 0 ? 'earlier' : 'later'}`
  return (
    <div className="panel">
      <div className="panel-title">
        Lyric timing <span className="muted small">({describe})</span>
      </div>
      <div className="timing-row">
        <button className="btn btn-small" onClick={() => onChange(offsetMs - 100)} title="Show lyrics later ([)">
          Later
        </button>
        <input
          type="range"
          min={-3000}
          max={3000}
          step={50}
          value={offsetMs}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label="Lyric timing offset"
        />
        <button className="btn btn-small" onClick={() => onChange(offsetMs + 100)} title="Show lyrics earlier (])">
          Earlier
        </button>
        {offsetMs !== 0 && (
          <button className="btn btn-small btn-ghost" onClick={() => onChange(0)}>
            Reset
          </button>
        )}
      </div>
    </div>
  )
}
