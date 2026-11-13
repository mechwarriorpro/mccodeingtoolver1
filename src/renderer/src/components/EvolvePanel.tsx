import { useCallback, useEffect, useState } from 'react'
import { api, type EvolveRules, type EvolveStatus } from '../lib/api'

interface Props {
  onToast: (text: string, kind?: 'ok' | 'err') => void
}

const RULE_META: { key: keyof EvolveRules; label: string; blurb: string }[] = [
  { key: 'quality', label: 'Quality of code', blurb: 'Correct and readable. A candidate that does not compile always scores zero.' },
  { key: 'speed', label: 'Speed', blurb: 'How fast the result builds and runs.' },
  { key: 'size', label: 'Size', blurb: 'Bytes of compiled classes plus source.' },
  { key: 'ram', label: 'RAM usage', blurb: 'The heap the code needs to compile. The one that makes a small machine viable.' }
]

export default function EvolvePanel({ onToast }: Props): JSX.Element {
  const [status, setStatus] = useState<EvolveStatus | null>(null)
  const [rules, setRules] = useState<EvolveRules>({ quality: 70, speed: 10, size: 10, ram: 10 })
  const [instructions, setInstructions] = useState('')
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState<string>('')
  const [openGen, setOpenGen] = useState<number | null>(null)
  const [genome, setGenome] = useState<{ path: string; text: string }[] | null>(null)

  const refresh = useCallback(async () => {
    const s = await api.evolve.status()
    setStatus(s)
    setRules(s.rules)
    setInstructions(s.instructions)
  }, [])

  useEffect(() => {
    void refresh()
    const offStep = api.evolve.onStep((p) => setStep(`${p.phase}${p.generation !== undefined ? ` #${p.generation}` : ''}${p.detail ? ` — ${p.detail}` : ''}`))
    const offDone = api.evolve.onDone(() => {
      setStep('')
      void refresh()
    })
    return () => {
      offStep()
      offDone()
    }
  }, [refresh])

  async function saveRules(next: EvolveRules): Promise<void> {
    setRules(next)
    const res = await api.evolve.rules(next)
    setInstructions(res.instructions)
  }

  async function run(): Promise<void> {
    setBusy(true)
    try {
      const res = await api.evolve.run(status?.config.evolveCount ?? 3)
      if (!res.ok) {
        onToast(res.error ?? 'The loop could not start', 'err')
        return
      }
      const promoted = res.promoted ?? 0
      onToast(promoted ? `${promoted} generation(s) promoted` : 'No generation beat its parent — nothing promoted')
      await refresh()
    } finally {
      setBusy(false)
      setStep('')
    }
  }

  async function showGenome(id: number): Promise<void> {
    if (openGen === id) {
      setOpenGen(null)
      setGenome(null)
      return
    }
    const res = await api.evolve.genome(id)
    if (!res.ok) {
      onToast(res.error ?? 'Could not read that generation', 'err')
      return
    }
    setGenome(res.files ?? [])
    setOpenGen(id)
  }

  if (!status) return <p className="hint">Loading…</p>

  const active = status.active
  const total = rules.quality + rules.speed + rules.size + rules.ram || 1

  return (
    <div className="evolve">
      <div className="mode-banner">
        <span>Running</span>
        <b>generation {active?.id ?? 0}</b>
        <span className="hint">
          {active?.thesis}
          {typeof active?.score === 'number' ? ` · score ${active.score.toFixed(3)}` : ''}
        </span>
      </div>

      {/* ------------------------------------------------------- the rules */}
      <div className="mode-card">
        <div className="mode-head">
          <b>The four rules</b>
          <span className="badge">weights, normalized</span>
        </div>
        {RULE_META.map((r) => (
          <div key={r.key} className="rule-row">
            <div className="rule-head">
              <span>{r.label}</span>
              <b>{Math.round((rules[r.key] / total) * 100)}%</b>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              value={rules[r.key]}
              onChange={(e) => void saveRules({ ...rules, [r.key]: Number(e.target.value) })}
            />
            <div className="hint">{r.blurb}</div>
          </div>
        ))}
        <details>
          <summary>What this tells the agent</summary>
          <pre className="diag-detail">{instructions}</pre>
        </details>
      </div>

      {/* -------------------------------------------------------- the loop */}
      <div className="mode-card">
        <div className="mode-head">
          <b>Evolve</b>
          <span className={`badge ${status.running ? 'green' : ''}`}>{status.running ? 'running' : status.paused ? 'paused' : 'idle'}</span>
        </div>
        <p>
          Forks this agent's own prompt, tool descriptions and subagent instructions, mutates them, then makes the
          candidate write real NeoForge code and <b>compiles it</b>. A candidate is promoted only if it compiles and
          beats its parent on the weights above. The loser is kept as a record, not deleted.
        </p>
        <p className="hint">
          The mutator is <b>{status.mutator}</b> — whatever model the chat uses, including a local one. Nothing outside the
          three genome files can be changed, and the evaluation code itself is never touched.
        </p>

        {step && <div className="hint warn">Working: {step}</div>}

        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button className="primary" disabled={busy || status.running} onClick={() => void run()}>
            {busy ? 'Evolving…' : `Run ${status.config.evolveCount} generation(s)`}
          </button>
          {status.running ? (
            <button onClick={() => void api.evolve.pause(true).then(refresh)}>Stop after this one</button>
          ) : (
            <button onClick={() => void api.evolve.pause(!status.paused).then(refresh)}>
              {status.paused ? 'Resume loop' : 'Pause loop'}
            </button>
          )}
          <button onClick={() => void api.shell.openPath(status.sourcesDir)}>Open sources</button>
        </div>
        {status.config.evolveMaxHeapMb > 0 && (
          <p className="hint">
            A candidate whose code needs more than {status.config.evolveMaxHeapMb} MB to compile is rejected, whatever it
            scores elsewhere.
          </p>
        )}
      </div>

      {/* ------------------------------------------------------ the lineage */}
      <div className="mode-card">
        <div className="mode-head">
          <b>Generations</b>
          <span className="badge">
            {status.generations.length} / {status.config.evolveMaxGenerations + 1}
          </span>
        </div>
        {status.generations.length <= 1 && (
          <p className="hint">
            Only the baseline exists. Run a generation to create the first mutation — it is compared against this one.
          </p>
        )}
        <div className="lineage">
          {status.generations.map((g) => (
            <div key={g.id} className={`gen-row ${g.status}`} onClick={() => void showGenome(g.id)}>
              <span className="gen-id">g{g.id}</span>
              <span className={`gen-status ${g.status}`}>{g.status}</span>
              <span className="gen-score">{typeof g.score === 'number' ? g.score.toFixed(3) : '—'}</span>
              <span className="gen-thesis">{g.thesis}</span>
              {g.status !== 'active' && (
                <button
                  className="why"
                  onClick={(e) => {
                    e.stopPropagation()
                    void api.evolve.promote(g.id).then((r) => {
                      onToast(r.ok ? `Generation ${g.id} is now active — restart the app to use it` : (r.error ?? 'Failed'))
                      void refresh()
                    })
                  }}
                >
                  use
                </button>
              )}
            </div>
          ))}
        </div>
        {openGen !== null && genome && (
          <div className="genome-view">
            <div className="hint">Generation {openGen}: {genome.map((f) => f.path.split('/').pop()).join(', ')}</div>
            {genome.slice(0, 1).map((f) => (
              <pre key={f.path} className="diag-detail">
                {f.text.slice(0, 6000)}
              </pre>
            ))}
          </div>
        )}
        {status.generations.some((g) => g.status !== 'active' && g.status !== 'failed') && (
          <p className="hint">Click a generation to see its prompt, or “use” to switch to it. A switch takes effect on restart.</p>
        )}
      </div>

      {/* -------------------------------------------------- what is real */}
      <div className="mode-card">
        <div className="mode-head">
          <b>What these numbers actually measure</b>
        </div>
        <ul className="hint" style={{ margin: 0, paddingLeft: 16 }}>
          <li>
            <b>Quality</b> — does the candidate's code compile against the real NeoForge jars. A floor, not a ceiling:
            compiling is not the same as working.
          </li>
          <li>
            <b>Size</b> — bytes of <code>.class</code> files plus source, measured from disk.
          </li>
          <li>
            <b>RAM</b> — the smallest JVM heap that still compiles it, found by halving until it fails. This is{' '}
            <b>compile-time heap, not in-game memory</b>. Runtime RAM needs a launched game and is not claimed here.
          </li>
          <li>
            <b>Speed</b> — how long the evaluation took, which includes the model's own generation time. That is the honest
            number for "generation speed" on a local model, and it is why a faster model raises this score without any code
            getting better.
          </li>
        </ul>
      </div>
    </div>
  )
}
