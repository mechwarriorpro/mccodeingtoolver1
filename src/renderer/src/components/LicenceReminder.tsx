import { useEffect, useState } from 'react'
import { api } from '../lib/api'

interface Props {
  /** Called once the reminder is gone, so the shell can stop rendering it. */
  onClose: () => void
}

/**
 * The one reminder that this is a solo project.
 *
 * It appears after fifteen launches of real use, once per session, and never
 * while an agent run, a build or a download is in flight — the parent only calls
 * `licence.launch` when the app is idle. Nothing in the app is locked behind it:
 * every feature works whether this is dismissed or never seen.
 *
 * The structure is deliberate. What it is, who pays, what is free, what is not,
 * and a way to record a commercial licence. No countdown, no second dialog, no
 * "remind me later" that puts it back tomorrow.
 */
export default function LicenceReminder({ onClose }: Props): JSX.Element {
  const [state, setState] = useState<{
    text: { title: string; body: string[]; free: string[]; commercial: string[]; action: string }
  } | null>(null)
  const [key, setKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    let cancelled = false
    // Read-only: the launch was already counted by the shell, which is the only
    // place that knows whether the app was idle enough to ask.
    void api.licence.status().then((res) => {
      if (cancelled) return
      setState({
        text: {
          title: 'MC Forge Agent is a solo project',
          body: [res.terms.why, `You have opened it ${res.launches} times, so this is probably worth a moment:`],
          free: [...res.terms.freeFor],
          commercial: [...res.terms.commercialFor],
          action: 'Keep building — this is free unless you are making money from it.'
        }
      })
    })
    return () => {
      cancelled = true
    }
  }, [])

  async function dismiss(): Promise<void> {
    await api.licence.dismiss()
    onClose()
  }

  async function saveKey(): Promise<void> {
    setSaving(true)
    try {
      const res = await api.licence.setKey(key)
      if (!res.ok) {
        setMessage(res.summary.detail)
        return
      }
      setMessage(res.summary.title)
      setTimeout(onClose, 1200)
    } finally {
      setSaving(false)
    }
  }

  if (!state) {
    return (
      <div className="modal">
        <div className="box">
          <p className="muted small">Reading the licence…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Licence reminder">
      <div className="box">
        <h2>{state.text.title}</h2>
        {state.text.body.map((line, i) => (
          <p key={i} className="muted small">
            {line}
          </p>
        ))}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 10 }}>
          <div>
            <b className="small">Free, no licence needed</b>
            <ul>
              {state.text.free.map((item) => (
                <li key={item} className="muted small">
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <b className="small">Needs a commercial licence</b>
            <ul>
              {state.text.commercial.map((item) => (
                <li key={item} className="muted small">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <p className="small" style={{ marginTop: 8 }}>
          {state.text.action}
        </p>

        {showKey ? (
          <div style={{ marginTop: 10 }}>
            <label className="muted small" htmlFor="licence-key">
              Commercial licence key
            </label>
            <div className="row" style={{ marginTop: 4 }}>
              <input
                id="licence-key"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="MCFA…"
                spellCheck={false}
              />
              <button className="small primary" disabled={saving || !key.trim()} onClick={() => void saveKey()}>
                {saving ? 'Saving…' : 'Record it'}
              </button>
            </div>
            {message && <p className="muted small">{message}</p>}
            <p className="muted small">
              Stored on this machine only. There is no account and no phone-home — a commercial licence is a record, not a
              lock.
            </p>
          </div>
        ) : (
          <div className="row wrap" style={{ marginTop: 10 }}>
            <button className="small primary" onClick={() => void dismiss()}>
              Keep building
            </button>
            <button className="small ghost" onClick={() => setShowKey(true)}>
              I have a commercial licence
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
