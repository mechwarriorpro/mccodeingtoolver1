import { useState } from 'react'
import { api, type PackTransferEntry, type PackTransferPlan } from '../lib/api'

/**
 * Bringing the mods from one pack into another.
 *
 * Two packs, two folders, two loader jars. The point of doing this here rather
 * than in Explorer is that every decision is made against the *target's* version
 * and stated in a sentence before anything moves: this jar is new, this one
 * replaces an older copy, this one is already there and newer, this one cannot
 * run on the target at all.
 *
 * The comparison of the two loader jars is the part that is invisible by hand.
 * Both packs launch from `bin/modpack.jar` — normally a NeoForge installer — and
 * nothing in Windows shows you that one is 20.4.1 and the other is 21.1.80 until
 * the game starts.
 */
export default function PackTransfer({
  dir,
  onToast
}: {
  dir: string
  onToast: (text: string, kind?: 'ok' | 'err') => void
}): React.JSX.Element {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState(dir)
  const [plan, setPlan] = useState<PackTransferPlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [result, setResult] = useState<{
    ok: boolean
    error?: string
    copied?: number
    failed?: { file: string; error?: string }[]
  } | null>(null)

  const pick = async (which: 'from' | 'to'): Promise<void> => {
    const picked = await api.dialog.pickFolder()
    if (!picked) return
    if (which === 'from') setFrom(picked)
    else setTo(picked)
    setPlan(null)
    setResult(null)
  }

  const compare = async (): Promise<void> => {
    if (!from || !to) return
    setBusy(true)
    setError('')
    setResult(null)
    try {
      const res = await api.pack.compare({ from, to })
      if (!res.ok || !res.plan) {
        setError(res.error ?? 'The comparison failed.')
        setPlan(null)
      } else {
        setPlan(res.plan)
        setChosen(new Set(res.plan.entries.filter((e: PackTransferEntry) => e.selected).map((e: PackTransferEntry) => e.file)))
      }
    } finally {
      setBusy(false)
    }
  }

  const toggle = (file: string): void => {
    const next = new Set(chosen)
    if (next.has(file)) next.delete(file)
    else next.add(file)
    setChosen(next)
  }

  const run = async (): Promise<void> => {
    if (!plan) return
    setBusy(true)
    setError('')
    try {
      const res = await api.pack.transfer({ plan, selected: [...chosen] })
      setResult(res)
      if (!res.ok && res.error) setError(res.error)
      if (res.ok) onToast(`Copied ${res.copied ?? 0} mod(s) into ${plan.to.label}.`)
      else onToast(`Copied ${res.copied ?? 0}, ${res.failed?.length ?? 0} failed.`, 'err')
    } finally {
      setBusy(false)
    }
  }

  const transferable = plan ? plan.entries.filter((e) => e.status === 'copy' || e.status === 'upgrade') : []
  const allTicked = transferable.length > 0 && transferable.every((e) => chosen.has(e.file))

  const group = (title: string, status: PackTransferEntry['status'][], note?: string): React.JSX.Element | null => {
    if (!plan) return null
    const items = plan.entries.filter((e) => status.includes(e.status))
    if (items.length === 0) return null
    const warn = status.includes('incompatible')
    return (
      <div className={`upgrade-group${warn ? ' warn' : ''}`}>
        <div className="upgrade-group-head">
          <strong>{title}</strong>
          <span className="upgrade-reason">{items.length}</span>
        </div>
        {note ? <div className="upgrade-note">{note}</div> : null}
        {items.map((e) => {
          const boxed = status.includes('copy') || status.includes('upgrade')
          return (
            <label key={e.file} className={`upgrade-item${boxed ? '' : ' static'}`}>
              {boxed ? <input type="checkbox" checked={chosen.has(e.file)} onChange={() => toggle(e.file)} /> : null}
              <span className="upgrade-name">{e.name ?? e.modId ?? e.file}</span>
              {e.version ? <span className="upgrade-chip">{e.version}</span> : null}
              <span className="upgrade-reason">{e.reason}</span>
            </label>
          )
        })}
      </div>
    )
  }

  return (
    <div className="upgrade">
      <p className="upgrade-title">Bring mods across from another pack</p>
      <p className="upgrade-sub">
        Pick two packs. The mods in the source are checked against the <strong>target's</strong> Minecraft and
        loader version, and nothing is decided silently: every jar is listed as new, replacing an older copy, already
        there, or unable to run on the target. Only the target pack is written to.
      </p>

      <div className="upgrade-row">
        <label>
          Mods to bring from
          <span className="upgrade-dir">
            <code>{from || 'not chosen'}</code>
            <button onClick={() => void pick('from')} disabled={busy}>
              Browse…
            </button>
          </span>
        </label>
        <label>
          Into this pack
          <span className="upgrade-dir">
            <code>{to || 'not chosen'}</code>
            <button onClick={() => void pick('to')} disabled={busy}>
              Browse…
            </button>
          </span>
        </label>
        <button onClick={() => void compare()} disabled={busy || !from || !to}>
          {busy && !plan ? 'Comparing…' : 'Compare packs'}
        </button>
      </div>

      {error ? <div className="upgrade-error">{error}</div> : null}

      {plan ? (
        <>
          <div className="upgrade-plan">
            <div className="upgrade-summary">
              {plan.summary.map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            </div>

            {/* The two loader jars. This is the comparison that is invisible by hand. */}
            <div className={`upgrade-group${plan.loader.differs ? ' warn' : ''}`}>
              <div className="upgrade-group-head">
                <strong>Loader</strong>
                <span className="upgrade-reason">
                  {plan.loader.differs ? 'different builds' : 'no version change'}
                </span>
              </div>
              <div className="upgrade-item static">
                <span className="upgrade-name">from {plan.from.label}</span>
                <span className="upgrade-chip">{plan.loader.from.version ?? 'unknown'}</span>
                <span className="upgrade-reason">{plan.loader.from.present}</span>
              </div>
              <div className="upgrade-item static">
                <span className="upgrade-name">to {plan.to.label}</span>
                <span className="upgrade-chip">{plan.loader.to.version ?? 'unknown'}</span>
                <span className="upgrade-reason">{plan.loader.to.present}</span>
              </div>
              <div className="upgrade-note">{plan.loader.note}</div>
            </div>

            {group('New to the target', ['copy'])}
            {group('Replacing an older copy in the target', ['upgrade'])}
            {group(
              'Left where they are',
              ['same', 'newer-there'],
              'Nothing to do for these — the target already has them at the same version, or a newer one.'
            )}
            {group(
              'Cannot run on the target',
              ['incompatible'],
              'No build exists for the target version. Moving these in would break the target pack, so they are not selected.'
            )}
            {group('Not identified', ['unidentified'], 'Listed for information only.')}
          </div>

          <div className="upgrade-actions" style={{ marginTop: 12 }}>
            <button onClick={() => void run()} disabled={busy || chosen.size === 0}>
              {busy ? 'Copying…' : `Copy ${chosen.size} mod${chosen.size === 1 ? '' : 's'} into ${plan.to.label}`}
            </button>
            <button
              className="ghost"
              onClick={() => setChosen(new Set(transferable.map((e) => e.file)))}
              disabled={busy || allTicked}
            >
              Select all {transferable.length}
            </button>
            <button className="ghost" onClick={() => setChosen(new Set())} disabled={busy || chosen.size === 0}>
              Clear
            </button>
            <span className="upgrade-hint">
              The source pack is only read. A jar that is not a valid zip is refused rather than copied.
            </span>
          </div>
        </>
      ) : null}

      {result ? (
        <div className={`upgrade-done${result.ok ? '' : ' bad'}`}>
          {result.ok
            ? `Copied ${result.copied ?? 0} mod(s) into ${plan?.to.label ?? 'the target'} — it now has them at the versions listed above.`
            : `Copied ${result.copied ?? 0}, but ${result.failed?.length ?? 0} could not be copied. Nothing was removed, so the target is usable.`}
          {result.failed && result.failed.length > 0 ? (
            <ul>
              {result.failed.map((f) => (
                <li key={f.file}>
                  <code>{f.file}</code> — {f.error}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
