import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type DiagEntry } from '../lib/api'

interface Props {
  onToast: (text: string, kind?: 'ok' | 'err') => void
}

const LEVELS: { value: 0 | 1 | 2 | 3; label: string; blurb: string }[] = [
  { value: 0, label: 'Off', blurb: 'Nothing recorded. The default.' },
  { value: 1, label: 'Errors', blurb: 'Only things that went wrong, plus each run’s outcome.' },
  { value: 2, label: 'Every step', blurb: 'Tool calls with arguments, results, status changes, build and game output.' },
  { value: 3, label: 'Everything', blurb: 'The above, plus raw SDK traffic and streaming deltas. Big.' }
]

const SOURCE_COLOURS: Record<string, string> = {
  tool: 'var(--accent)',
  sdk: 'var(--muted)',
  stream: 'var(--dim)',
  agent: 'var(--text)',
  provider: 'var(--amber)',
  build: '#7aa2f7',
  game: '#9ece6a',
  app: 'var(--dim)',
  ipc: 'var(--dim)'
}

/**
 * What the agent actually did, and why.
 *
 * Three levels exist because the question changes as you get closer to the
 * problem. "It said 0" needs the raw SDK traffic; "why did it edit that file"
 * needs the tool calls and the reasoning before them; "did the build fail" needs
 * one line. Showing all three at once is how a log becomes unreadable, so the
 * level decides what gets recorded at all, and the panel only renders what was
 * recorded.
 */
export default function DiagPanel({ onToast }: Props): JSX.Element {
  const [level, setLevel] = useState<0 | 1 | 2 | 3>(0)
  const [logPath, setLogPath] = useState('')
  const [entries, setEntries] = useState<DiagEntry[]>([])
  const [source, setSource] = useState<string>('all')
  const [query, setQuery] = useState('')
  const [paused, setPaused] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const pausedRef = useRef(false)

  useEffect(() => {
    pausedRef.current = paused
  }, [paused])

  useEffect(() => {
    void (async () => {
      const state = await api.diag.level()
      setLevel(state.level)
      setLogPath(state.logPath)
      setEntries(await api.diag.history())
    })()
    return api.diag.onEntry((entry) => {
      if (pausedRef.current) return
      setEntries((prev) => [...prev.slice(-2500), entry])
    })
  }, [])

  useEffect(() => {
    if (!paused) bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [entries, paused])

  const change = useCallback(
    async (value: 0 | 1 | 2 | 3) => {
      const state = await api.diag.setLevel(value)
      setLevel(state.level)
      onToast(value === 0 ? 'Diagnostics off' : `Diagnostics: ${state.name}`)
    },
    [onToast]
  )

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return entries.filter((e) => {
      if (source !== 'all' && e.source !== source) return false
      if (!q) return true
      return `${e.label} ${e.source} ${e.note ?? ''} ${e.detail ? JSON.stringify(e.detail) : ''}`.toLowerCase().includes(q)
    })
  }, [entries, source, query])

  const sources = useMemo(() => ['all', ...new Set(entries.map((e) => e.source))], [entries])

  async function copyAll(): Promise<void> {
    const text = await api.diag.exportText()
    try {
      await navigator.clipboard.writeText(text)
      onToast('Copied the diagnostics — paste them into the issue')
    } catch {
      onToast('Could not copy; use Open log file instead', 'err')
    }
  }

  return (
    <div className="diag">
      <p className="hint">
        Records what the agent does, so a bad run can be explained instead of guessed at. Levels are cumulative: each one
        includes the one above it.
      </p>

      <div className="diag-levels">
        {LEVELS.map((l) => (
          <button
            key={l.value}
            className={`diag-level${level === l.value ? ' on' : ''}`}
            onClick={() => void change(l.value)}
            title={l.blurb}
          >
            <b>{l.label}</b>
            <span>{l.blurb}</span>
          </button>
        ))}
      </div>

      {level > 0 && (
        <>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            <select value={source} onChange={(e) => setSource(e.target.value)} title="Filter by where it came from">
              {sources.map((s) => (
                <option key={s} value={s}>
                  {s === 'all' ? 'All sources' : s}
                </option>
              ))}
            </select>
            <input
              placeholder="Search…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ flex: 1, minWidth: 120 }}
              spellCheck={false}
            />
            <button onClick={() => setPaused((p) => !p)}>{paused ? 'Resume' : 'Pause'}</button>
          </div>

          <div className="diag-list">
            {visible.length === 0 && (
              <p className="hint" style={{ padding: 10 }}>
                Nothing yet. {level < 3 ? 'Raise the level if what you need is not appearing.' : 'The next run will fill this.'}
              </p>
            )}
            {visible.map((e) => (
              <div
                key={e.id}
                className={`diag-row lvl${e.level}${open === e.id ? ' open' : ''}`}
                onClick={() => setOpen(open === e.id ? null : e.id)}
              >
                <span className="diag-time">{new Date(e.at).toLocaleTimeString()}</span>
                <span className="diag-src" style={{ color: SOURCE_COLOURS[e.source] ?? 'var(--muted)' }}>
                  {e.source}
                </span>
                <span className="diag-label">{e.label}</span>
                {e.note && <span className="diag-note">{e.note}</span>}
                {open === e.id && e.detail !== undefined && (
                  <pre className="diag-detail">{JSON.stringify(e.detail, null, 2).slice(0, 20000)}</pre>
                )}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button onClick={() => void copyAll()}>Copy for a bug report</button>
            <button onClick={() => void api.diag.openLog()}>Open log file</button>
            <button
              onClick={() => {
                void api.diag.clear()
                setEntries([])
              }}
            >
              Clear
            </button>
          </div>
          <p className="hint">
            Also written to <code>{logPath}</code>, so the evidence survives closing the app.
          </p>
        </>
      )}

      {level === 0 && (
        <p className="hint">
          With diagnostics off, nothing is recorded. Turn on <b>Errors</b> if something misbehaves — it stays quiet
          otherwise and the log file is the only place it wakes up.
        </p>
      )}
    </div>
  )
}
