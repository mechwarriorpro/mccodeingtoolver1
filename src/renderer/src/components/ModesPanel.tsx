import { useCallback, useEffect, useState } from 'react'
import { api, type LessonSummary, type ModesStatus } from '../lib/api'

interface Props {
  onToast: (text: string, kind?: 'ok' | 'err') => void
  /** Deep research writes a full reply; the chat is where the user reads it. */
  onSend: (text: string) => void
}

/**
 * The three modes, in one place.
 *
 * They are one feature rather than three, and the panel reflects that: AutoSwitch
 * keeps a turn alive, Learning turns study into lessons, Deep Research spends the
 * strongest model to write lessons a weak model can follow. The bottom half shows
 * the payoff — the lessons themselves — because a mode that says "learning" and
 * produces nothing visible is indistinguishable from a mode that does nothing.
 */
export default function ModesPanel({ onToast, onSend }: Props): JSX.Element {
  const [status, setStatus] = useState<ModesStatus | null>(null)
  const [lessons, setLessons] = useState<LessonSummary[]>([])
  const [topic, setTopic] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    const s = await api.modes.status()
    setStatus(s)
    setTopic((t) => t || s.researchTopic)
    setLessons(await api.modes.knowledge())
  }, [])

  useEffect(() => {
    void refresh()
    return api.modes.onChanged(() => void refresh())
  }, [refresh])

  async function toggle(key: 'learningMode' | 'deepResearch', on: boolean): Promise<void> {
    setBusy(true)
    try {
      const res = await api.modes.set({ [key]: on })
      if (on && key === 'deepResearch' && res.needsTopic) {
        onToast('Deep research needs a topic — set one below before starting a run', 'err')
      }
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  /** AutoSwitch settings live in the config; write then re-read so the panel shows the truth. */
  async function setConfig(patch: { autoSwitch?: boolean; autoSwitchLimit?: number; autoSwitchIncludeLocal?: boolean }): Promise<void> {
    setBusy(true)
    try {
      await api.config.set(patch)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  async function startResearch(): Promise<void> {
    const clean = topic.trim()
    if (!clean) {
      onToast('Type what to research first', 'err')
      return
    }
    setBusy(true)
    try {
      const res = await api.modes.startResearch(clean)
      if (!res.ok) {
        onToast(res.error ?? 'Could not start', 'err')
        return
      }
      await refresh()
      onToast(`Researching “${clean}” on the strongest available model`)
      onSend(`Research this properly and write it up for a smaller model: ${clean}`)
    } finally {
      setBusy(false)
    }
  }

  async function stopResearch(): Promise<void> {
    await api.modes.stopResearch()
    await refresh()
    onToast('Deep research off')
  }

  if (!status) return <p className="hint">Loading…</p>

  const modeLabel = status.mode === 'research' ? 'Deep research' : status.mode === 'learn' ? 'Learning' : 'Coding'

  return (
    <div className="modes">
      <div className="mode-banner">
        <span>Next run uses</span>
        <b>{status.runningOn}</b>
        <span className="badge">{modeLabel}</span>
      </div>

      {/* ---------------------------------------------------- AutoSwitch */}
      <div className={`mode-card${status.autoSwitch ? ' on' : ''}`}>
        <div className="mode-head">
          <label>
            <input
              type="checkbox"
              checked={status.autoSwitch}
              disabled={busy}
              onChange={(e) => void setConfig({ autoSwitch: e.target.checked })}
            />
            <b>AutoSwitch</b>
          </label>
          <span className="badge green">on by default</span>
        </div>
        <p>
          When a chat dies because a free tier ran out, a model was retired, or the provider is overloaded, carry the turn
          on with the next free model instead of ending it. A wrong key is not switchable — every provider would fail the
          same way, and hiding that behind a slow rotation would waste your time.
        </p>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <label className="inline">
            Try up to
            <input
              type="number"
              min={1}
              max={6}
              value={status.autoSwitchLimit}
              onChange={(e) => void setConfig({ autoSwitchLimit: Number(e.target.value) })}
              style={{ width: 56 }}
            />
            models per turn
          </label>
          <label className="inline">
            <input
              type="checkbox"
              checked={status.autoSwitchIncludeLocal}
              onChange={(e) => void api.config.set({ autoSwitchIncludeLocal: e.target.checked } as never)}
            />
            include local models
          </label>
        </div>
        <p className="hint">
          A switch is announced in the chat and recorded on the conversation. Paid models are only used as a last resort,
          and only if you have a key that can pay.
        </p>
      </div>

      {/* ------------------------------------------------------ Learning */}
      <div className={`mode-card${status.learningMode ? ' on' : ''}`}>
        <div className="mode-head">
          <label>
            <input
              type="checkbox"
              checked={status.learningMode}
              disabled={busy || status.deepResearch}
              onChange={(e) => void toggle('learningMode', e.target.checked)}
            />
            <b>Learning mode</b>
          </label>
          {status.deepResearch && <span className="badge amber">research takes priority</span>}
        </div>
        <p>
          Study the topic instead of coding. It reads decompiled reference mods and documentation, then writes what it
          found into <b>Lessons</b> — which every later run starts with. A run that would otherwise produce a
          half-finished mod and a vague answer produces notes the next run can actually use.
        </p>
        {status.learningMode && (
          <button onClick={() => onSend('Study this and teach me before changing anything: ')}>
            Start a study run
          </button>
        )}
      </div>

      {/* -------------------------------------------------- Deep research */}
      <div className={`mode-card${status.deepResearch ? ' on research' : ''}`}>
        <div className="mode-head">
          <label>
            <input
              type="checkbox"
              checked={status.deepResearch}
              disabled={busy}
              onChange={(e) => void toggle('deepResearch', e.target.checked)}
            />
            <b>Deep research</b>
          </label>
          {status.best ? (
            <span className={`badge ${status.best.free ? 'green' : 'amber'}`}>
              spends: {status.best.label}
              {status.best.free ? ' (free)' : ''}
            </span>
          ) : (
            <span className="badge red">no capable model with a key</span>
          )}
        </div>
        <p>
          Use the strongest model you have, whatever it costs, to research a topic properly — then write lessons a weaker
          model can follow to produce the code without doing the research itself. This is the mode that makes a free
          model punch above its weight.
        </p>
        {status.best && !status.best.free && (
          <p className="hint warn">
            {status.best.label} is paid. A research run is long and will cost real money on your{' '}
            {status.best.provider} key.
          </p>
        )}

        <label className="field">
          <span>What to research</span>
          <input
            value={topic}
            placeholder="e.g. custom block entities and their renderer in 1.21.1"
            onChange={(e) => setTopic(e.target.value)}
            spellCheck={false}
          />
        </label>
        <div className="row">
          {status.deepResearch ? (
            <>
              <button className="primary" disabled={busy} onClick={() => void startResearch()}>
                {busy ? 'Starting…' : 'Research it'}
              </button>
              <button onClick={() => void stopResearch()}>Stop deep research</button>
            </>
          ) : (
            <button disabled={busy || !status.best} onClick={() => void startResearch()}>
              Turn on and research this
            </button>
          )}
        </div>
        {status.research && (
          <p className="hint">
            Current topic: <b>{status.research.topic}</b> — on {status.research.model}. Notes go to{' '}
            <code>docs/research/</code> in the project; lessons go everywhere.
          </p>
        )}
      </div>

      {/* ------------------------------------------------------ the payoff */}
      <div className="mode-card">
        <div className="mode-head">
          <b>Learned so far</b>
          <span className="badge">
            {lessons.length} {lessons.length === 1 ? 'fact' : 'facts'}
          </span>
        </div>
        {lessons.length === 0 && (
          <p className="hint">
            Nothing yet. A learning or research run writes here, and every later run — including a free model on its
            third switch — starts with these.
          </p>
        )}
        {lessons.slice(0, 12).map((l) => (
          <div key={l.id} className="knowledge-row">
            <span className={`kind ${l.kind ?? 'topic'}`}>{l.kind === 'research' ? 'research' : 'studied'}</span>
            <div>
              <div>{l.rule}</div>
              {l.fix && <div className="hint">→ {l.fix}</div>}
              {l.sources?.length ? <div className="hint">sources: {l.sources.slice(0, 3).join(', ')}</div> : null}
            </div>
          </div>
        ))}
        {lessons.length > 12 && <p className="hint">…and {lessons.length - 12} more in the Lessons tab.</p>}
      </div>
    </div>
  )
}
