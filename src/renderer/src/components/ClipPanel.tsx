import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type ClipRecord } from '../lib/api'

interface Props {
  onToast: (text: string, kind?: 'ok' | 'err') => void
  onOpenImage: (path: string) => void
  /** Drop a clip digest into the chat so the agent can act on it. */
  onSendToAgent: (text: string) => void
}

const DURATIONS = [10, 20, 30]

/**
 * Record a short gameplay clip and have a vision model look at it.
 *
 * The cap is 30 seconds because that is what the user asked for and because a
 * handful of frames is what a model reasons about well. The panel shows the
 * frames as they land, so the developer can see coverage without waiting for
 * the clip to finish.
 */
export default function ClipPanel({ onToast, onOpenImage, onSendToAgent }: Props): JSX.Element {
  const [clips, setClips] = useState<ClipRecord[]>([])
  const [recording, setRecording] = useState(false)
  const [progress, setProgress] = useState<{ index: number; total: number; t: number } | null>(null)
  const [duration, setDuration] = useState(30)
  const [note, setNote] = useState('')
  const [selected, setSelected] = useState<ClipRecord | null>(null)
  const [analysing, setAnalysing] = useState(false)
  const [goal, setGoal] = useState('')
  /**
   * 'bug' reads the frames for what is broken; 'look' reads them as a look
   * reference and produces a shader plan. The same footage answers both, so the
   * choice belongs next to the analyse button rather than in a second recorder.
   */
  const [mode, setMode] = useState<'bug' | 'look'>('bug')
  const [error, setError] = useState<string | null>(null)
  const stopRef = useRef(false)

  const refresh = useCallback(async () => {
    setClips(await api.clips.list())
  }, [])

  useEffect(() => {
    void refresh()
    const offs = [
      api.events.onClipFrame((p) => {
        setProgress({ index: p.index, total: p.total, t: p.t })
        // Show the newest frame straight away; the clip object is only complete at the end.
        setSelected((cur) =>
          cur
            ? { ...cur, frames: [...cur.frames, { path: p.path, t: p.t }] }
            : { id: 'live', dir: '', startedAt: Date.now(), durationMs: 0, fps: 2, frames: [{ path: p.path, t: p.t }], ended: 'duration' }
        )
      }),
      api.events.onClipDone((p) => {
        setSelected(p.clip)
        void refresh()
      }),
      api.events.onClipAnalysing(() => setAnalysing(true))
    ]
    return () => offs.forEach((off) => off())
  }, [refresh])

  async function record(): Promise<void> {
    if (recording) return
    setError(null)
    setRecording(true)
    stopRef.current = false
    setProgress(null)
    setSelected({ id: 'live', dir: '', startedAt: Date.now(), durationMs: 0, fps: 2, frames: [], ended: 'duration', note })
    try {
      const res = await api.clips.start({ durationMs: duration * 1000, fps: 2, note })
      if (!res.ok) {
        setError(res.error ?? 'Could not record')
        onToast(res.error ?? 'Could not record', 'err')
        return
      }
      setSelected(res.clip ?? null)
      onToast(`Captured ${((res.clip?.durationMs ?? 0) / 1000).toFixed(1)}s of gameplay — ${res.clip?.frames.length ?? 0} frames`)
      await refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRecording(false)
      setProgress(null)
    }
  }

  async function analyse(clip: ClipRecord): Promise<void> {
    if (clip.id === 'live') return
    setAnalysing(true)
    setError(null)
    try {
      const res = await api.clips.analyse({ id: clip.id, goal: goal || undefined, mode })
      if (!res.ok) {
        setError(res.error ?? 'Analysis failed')
        return
      }
      const fresh = await api.clips.get(clip.id)
      setSelected(fresh)
      await refresh()
      onToast('Analysis ready')
    } finally {
      setAnalysing(false)
    }
  }

  async function sendToAgent(clip: ClipRecord): Promise<void> {
    const res = await api.clips.digest(clip.id)
    if (!res.ok) {
      onToast(res.error ?? 'Could not read that clip', 'err')
      return
    }
    onSendToAgent(
      `${res.text}\n\nThese frames are also on disk under ${clip.dir}. Read them if you need to look closer, then tell me what to fix.`
    )
  }

  async function remove(clip: ClipRecord): Promise<void> {
    if (clip.id === 'live') return
    setClips(await api.clips.remove(clip.id))
    if (selected?.id === clip.id) setSelected(null)
  }

  const liveFrames = selected?.frames ?? []

  return (
    <div className="clips">
      <div className="hint" style={{ marginBottom: 10 }}>
        Record up to <strong>30 seconds</strong> of gameplay, then let a vision model say what it sees: what happened, what
        looks broken (pink textures, missing names, crashes) and what to change. Get the game to the screen you want to
        test first — recording grabs the screen twice a second.
      </div>

      <div className="row" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
        <div className="seg">
          {DURATIONS.map((d) => (
            <button key={d} className={`seg-btn${duration === d ? ' on' : ''}`} disabled={recording} onClick={() => setDuration(d)}>
              {d}s
            </button>
          ))}
        </div>
        <input
          style={{ flex: 1, minWidth: 180 }}
          value={note}
          placeholder="What are you testing? e.g. 'new ruby pickaxe in survival inventory'"
          onChange={(e) => setNote(e.target.value)}
          disabled={recording}
        />
        {recording ? (
          <button className="small" onClick={() => void api.clips.stop()}>
            {progress ? `Stop (${progress.index}/${progress.total})` : 'Stop'}
          </button>
        ) : (
          <button className="primary small" onClick={() => void record()}>
            ● Record {duration}s
          </button>
        )}
      </div>

      {recording ? (
        <div className="progress" style={{ marginBottom: 10 }}>
          <div className="bar" style={{ width: progress ? `${Math.round((progress.index / progress.total) * 100)}%` : '2%' }} />
        </div>
      ) : null}

      {error ? (
        <div className="hint" style={{ color: 'var(--red)', marginBottom: 10 }}>
          {error}
        </div>
      ) : null}

      {selected ? (
        <div className="card" style={{ marginBottom: 10 }}>
          <div className="row" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
            <b style={{ fontSize: 12.5 }}>
              {selected.id === 'live' ? 'Recording…' : `${(selected.durationMs / 1000).toFixed(1)}s clip`}
            </b>
            <span className="dim small">{liveFrames.length} frames</span>
            {selected.ended === 'error' ? <span className="badge red">capture error</span> : null}
            {selected.id !== 'live' ? (
              <>
                <button
                  className="small primary"
                  style={{ marginLeft: 'auto' }}
                  disabled={analysing || !liveFrames.length}
                  onClick={() => void analyse(selected)}
                >
                  {analysing ? 'Analysing…' : 'Analyse with AI'}
                </button>
                <button className="small" disabled={!selected.analysis} onClick={() => void sendToAgent(selected)}>
                  Send to agent
                </button>
              </>
            ) : null}
          </div>

          {selected.id !== 'live' && !selected.analysis ? (
            <>
              <div className="row" style={{ marginBottom: 8 }}>
                <button className={mode === 'bug' ? 'small primary' : 'small'} onClick={() => setMode('bug')}>
                  Find bugs
                </button>
                <button className={mode === 'look' ? 'small primary' : 'small'} onClick={() => setMode('look')}>
                  Use as a look reference
                </button>
              </div>
              <p className="dim small" style={{ marginBottom: 8 }}>
                {mode === 'bug'
                  ? 'What broke: missing textures, wrong models, crash screens.'
                  : 'What it should look like: light, water, colour, atmosphere — and which real pack and renderer get there. A mod cannot ship a shader pack, and the analysis says which part is the player’s install.'}
              </p>
              <input
                style={{ marginBottom: 8 }}
                value={goal}
                placeholder={mode === 'look' ? 'Optional: the look you are after, e.g. "warm sunset with reflective water"' : 'Optional: what should the model focus on?'}
                onChange={(e) => setGoal(e.target.value)}
              />
            </>
          ) : null}

          <div className="filmstrip">
            {liveFrames.map((f, i) => (
              <button key={`${f.path}:${i}`} className="strip-frame" onClick={() => onOpenImage(f.path)} title={`${(f.t / 1000).toFixed(1)}s`}>
                <img src={`file://${f.path.replace(/\\/g, '/')}`} alt={`frame ${i}`} loading="lazy" />
                <span>{(f.t / 1000).toFixed(1)}s</span>
              </button>
            ))}
            {liveFrames.length === 0 ? <div className="dim small">No frames yet.</div> : null}
          </div>

          {selected.analysis ? (
            <div style={{ marginTop: 10 }}>
              <div className="dim small" style={{ marginBottom: 4 }}>
                {selected.analysis.model} · {selected.analysis.frames} frames · {new Date(selected.analysis.at).toLocaleTimeString()}
                {selected.analysis.mode === 'look' ? ' · look reference' : ''}
              </div>
              <pre className="clip-analysis">{selected.analysis.text}</pre>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="refs-list">
        {clips.length === 0 ? <div className="dim small" style={{ padding: 8 }}>No clips yet.</div> : null}
        {clips.map((c) => (
          <div className="ref-row" key={c.id}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="ref-title">
                {(c.durationMs / 1000).toFixed(1)}s
                {c.analysis ? <span className="badge green" style={{ marginLeft: 6 }}>analysed</span> : null}
                {c.ended === 'stopped' ? <span className="badge" style={{ marginLeft: 6 }}>stopped early</span> : null}
              </div>
              <div className="dim small">
                {new Date(c.startedAt).toLocaleString()} · {c.frames.length} frames{c.note ? ` · ${c.note}` : ''}
              </div>
            </div>
            <div className="row">
              <button className="small" onClick={() => setSelected(c)}>
                Open
              </button>
              <button className="small ghost" onClick={() => void api.shell.openPath(c.dir)}>
                Folder
              </button>
              <button className="small ghost" onClick={() => void remove(c)} title="Delete this clip and its frames">
                ×
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
