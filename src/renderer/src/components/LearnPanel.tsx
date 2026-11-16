import { useEffect, useState } from 'react'
import { api, type Lesson } from '../lib/api'

interface Props {
  onToast: (text: string, kind?: 'ok' | 'err') => void
}

/**
 * The mistakes this app has learned from.
 *
 * Visible on purpose: a tool that claims to learn should show its work. Each row
 * is editable (the rule is what the model actually reads), deletable (a wrong
 * lesson is worse than none), and shows how many times it happened.
 */
export default function LearnPanel({ onToast }: Props): JSX.Element {
  const [lessons, setLessons] = useState<Lesson[]>([])
  const [editing, setEditing] = useState<{ id: string; rule: string; fix: string } | null>(null)

  useEffect(() => {
    void api.learn.list().then(setLessons)
  }, [])

  async function save(): Promise<void> {
    if (!editing) return
    await api.learn.update(editing)
    setLessons(await api.learn.list())
    setEditing(null)
    onToast('Lesson updated')
  }

  async function remove(id: string): Promise<void> {
    setLessons(await api.learn.remove(id))
    onToast('Lesson deleted — it will not be recalled again')
  }

  return (
    <div className="learn">
      <div className="hint" style={{ marginBottom: 12 }}>
        Every build error, crash and failed test this app sees is fingerprinted. When the same mistake comes back, the agent
        gets the rule and the fix that worked <em>before</em> it starts guessing. Lessons are matched across files and line
        numbers, so the same bug in a different class still counts.
      </div>

      {lessons.length === 0 ? (
        <div className="dim" style={{ padding: 10, fontSize: 12.5 }}>
          Nothing learned yet. Fail a build — the lessons appear here, and the agent can also record one with
          <code> remember_fix</code>.
        </div>
      ) : null}

      {lessons.map((l) => (
        <div className="ref-row" key={l.id}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="ref-title">
              {l.rule}
              {l.confirmed ? <span className="badge green" style={{ marginLeft: 6 }}>confirmed</span> : null}
              {l.seen > 1 ? <span className="badge" style={{ marginLeft: 6 }}>seen {l.seen}×</span> : null}
            </div>
            {l.fix ? <div className="dim small">Fix: {l.fix}</div> : null}
            {l.avoid ? <div className="dim small">Avoid: {l.avoid}</div> : null}
            <div className="dim small">
              {[l.loader, l.mcVersion, l.source, new Date(l.lastSeen).toLocaleDateString()].filter(Boolean).join(' · ')}
            </div>
            {editing?.id === l.id ? (
              <div style={{ marginTop: 6 }}>
                <input value={editing.rule} placeholder="The rule" onChange={(e) => setEditing({ ...editing, rule: e.target.value })} />
                <input
                  style={{ marginTop: 6 }}
                  value={editing.fix}
                  placeholder="The fix that worked"
                  onChange={(e) => setEditing({ ...editing, fix: e.target.value })}
                />
                <div className="row" style={{ marginTop: 6 }}>
                  <button className="small primary" onClick={() => void save()}>
                    Save
                  </button>
                  <button className="small" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
          </div>
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <button className="small" onClick={() => setEditing({ id: l.id, rule: l.rule, fix: l.fix ?? '' })}>
              Edit
            </button>
            <button className="small ghost" onClick={() => void remove(l.id)} title="Delete this lesson">
              ×
            </button>
          </div>
        </div>
      ))}

      {lessons.length > 0 ? (
        <button
          className="small ghost"
          style={{ marginTop: 8, alignSelf: 'flex-start' }}
          onClick={async () => {
            setLessons(await api.learn.clear())
            onToast('All lessons cleared')
          }}
        >
          Clear all lessons
        </button>
      ) : null}
    </div>
  )
}
