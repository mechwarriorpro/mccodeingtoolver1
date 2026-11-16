import { useEffect, useState } from 'react'
import { api, type Loader, type PackPlan, type PackPlanMod, type VersionChoice } from '../lib/api'

interface Props {
  /** The pack folder the rest of this panel is working on. */
  dir: string
  onToast: (text: string, kind?: 'ok' | 'err') => void
}

const LOADERS: { id: Loader; label: string }[] = [
  { id: 'neoforge', label: 'NeoForge' },
  { id: 'forge', label: 'Forge' },
  { id: 'fabric', label: 'Fabric' }
]

/**
 * Update a whole pack folder to a Minecraft version, except the game jar.
 *
 * The ask was exact: take the entire Technic pack folder and update everything
 * that has to change, leaving the Minecraft jar alone. The existing flows here
 * update *jars*, one at a time or all at once, and none of them touch `bin/` —
 * so a pack could have every mod on 1.21.1 and still launch 1.20.1 because
 * `bin/version` said so.
 *
 * This is a three-step flow on purpose:
 *
 *   1. **Choose the target.** Minecraft version and loader version, both real
 *      values from the same catalog the project scaffolding uses.
 *   2. **Read the plan.** Every jar with the version it has and the version it
 *      would become, every loader file that changes, and every mod with no build
 *      for the target — named individually, because those are the only ones that
 *      can cost someone their setup.
 *   3. **Apply.** A backup is written first, downloads happen second, and no jar
 *      is replaced until all of them are on disk. If a download fails the pack is
 *      left exactly as it was.
 *
 * Per-mod checkboxes, because "update every needed file" and "change a mod I care
 * about" are not the same decision and the user should not have to accept both.
 */
/** `1536000` → `1.5 MB`. A size that rounds to zero is worse than no size. */
function humanBytes(n: number): string {
  if (n < 1000) return `${n} B`
  if (n < 1_000_000) return `${Math.round(n / 1000)} kB`
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)} MB`
  return `${(n / 1_000_000_000).toFixed(1)} GB`
}

export default function PackUpgrade({ dir, onToast }: Props): JSX.Element {
  const [versions, setVersions] = useState<VersionChoice[]>([])
  const [mc, setMc] = useState('')
  const [loader, setLoader] = useState<Loader>('neoforge')
  const [loaderVersion, setLoaderVersion] = useState('')
  const [loaderChoices, setLoaderChoices] = useState<string[]>([])
  const [current, setCurrent] = useState<{ mcVersion?: string; family?: string; loaderVersion?: string }>({})

  const [plan, setPlan] = useState<PackPlan | null>(null)
  /** Which mods the user has ticked. Separate from the plan so re-planning resets it. */
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  /** Ticked for removal — a mod with no build for the target. */
  const [removing, setRemoving] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [applying, setApplying] = useState(false)
  const [porting, setPorting] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState<{ backup?: string; updated: number; removed: number; failed: { file: string; error?: string }[] } | null>(null)

  // What the pack says it currently runs, so the target starts somewhere sensible.
  useEffect(() => {
    if (!dir) return
    void api.pack.version(dir).then((v) => {
      setCurrent(v)
      if (v.mcVersion) setMc((m) => m || v.mcVersion || '')
      if (v.family === 'neoforge' || v.family === 'forge' || v.family === 'fabric') setLoader(v.family)
    })
  }, [dir])

  useEffect(() => {
    void api.versions.catalog().then((res) => {
      if (res.ok) setVersions(res.versions.filter((v) => v.type === 'release' && v.loaders.length > 0))
    })
  }, [])

  // Loader builds are per Minecraft version; asking for them is what makes the
  // target a real version rather than a guess typed into a box.
  useEffect(() => {
    if (!mc || !loader) return
    void api.versions.loaders({ mcVersion: mc, loader }).then((res) => {
      if (!res.ok) return
      setLoaderChoices(res.versions)
      setLoaderVersion((cur) => (res.versions.includes(cur) ? cur : res.versions[0] ?? ''))
    })
  }, [mc, loader])

  async function buildPlan(): Promise<void> {
    if (!dir) {
      onToast('Pick the pack folder first — the button above does that', 'err')
      return
    }
    if (!mc || !loaderVersion) {
      onToast('Choose a Minecraft version and a loader version first', 'err')
      return
    }
    setBusy(true)
    setError('')
    setPlan(null)
    setDone(null)
    try {
      const res = await api.pack.wholePlan({ dir, mcVersion: mc, family: loader, loaderVersion })
      if (!res.ok || !res.plan) {
        setError(res.error ?? 'Could not work out an update plan.')
        return
      }
      setPlan(res.plan)
      setChosen(new Set(res.plan.mods.filter((m: PackPlanMod) => m.selected).map((m: PackPlanMod) => m.file)))
      setRemoving(new Set())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function apply(): Promise<void> {
    if (!plan) return
    setApplying(true)
    setError('')
    try {
      const res = await api.pack.applyWhole({ plan, selected: [...chosen], alsoRemove: [...removing] })
      if (!res.ok && res.failed?.length) {
        setError(`${res.failed.length} step(s) did not complete — see below. Your pack was backed up to ${res.backup ?? 'the backup folder'} first.`)
      }
      if (res.updated !== undefined) {
        setDone({ backup: res.backup, updated: res.updated, removed: res.removed ?? 0, failed: res.failed ?? [] })
        onToast(`Updated ${res.updated} mod${res.updated === 1 ? '' : 's'}${res.removed ? `, removed ${res.removed}` : ''}`)
      }
      if (res.error) setError(res.error)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setApplying(false)
    }
  }

  const toggle = (file: string, on: boolean): void => {
    setChosen((prev) => {
      const next = new Set(prev)
      if (on) next.add(file)
      else next.delete(file)
      return next
    })
  }
  const toggleRemove = (file: string, on: boolean): void => {
    setRemoving((prev) => {
      const next = new Set(prev)
      if (on) next.add(file)
      else next.delete(file)
      return next
    })
  }

  const updates = plan?.mods.filter((m) => m.status === 'update') ?? []
  const keeps = plan?.mods.filter((m) => m.status === 'keep') ?? []
  const missing = plan?.mods.filter((m) => m.status === 'missing-build') ?? []
  const unknown = plan?.mods.filter((m) => m.status === 'unidentified') ?? []
  const chosenCount = [...chosen].length

  return (
    <div className="upgrade">
      <h3 className="upgrade-title">Update the whole pack</h3>
      <div style={{ marginBottom: 8 }}>
        <button
          type="button"
          className="secondary-btn"
          disabled={porting}
          onClick={async () => {
            const files = await api.dialog.pickFiles({
              title: 'Select mod .jar(s) to decompile & port',
              filters: [{ name: 'Mod Jars', extensions: ['jar'] }],
              multi: true
            })
            if (!files.length) return
            setPorting(true)
            try {
              const jarDir = files[0].replace(/[\\/][^\\/]+$/, '')
              const targetLoader = family === 'fabric' ? 'fabric' : family === 'forge' ? 'forge' : 'neoforge'
              const res = await api.pack.portMissing({
                dir: dir || jarDir,
                jarPaths: files,
                targetMc: mcVersion,
                targetLoader,
                includeDependencies: true
              })
              const depCount = res.ported.filter((p) => p.isDependency).length
              onToast(
                `Decompiled & created ${res.ported.length} port workspace(s)` +
                  (depCount ? ` (including ${depCount} pack dependency/ies)` : '') +
                  (res.skipped?.length ? `; ${res.skipped.length} already-ported dependency/ies skipped` : '') +
                  (res.failed.length ? `; ${res.failed.length} failed` : '')
              )
            } catch (err) {
              onToast(err instanceof Error ? err.message : String(err))
            } finally {
              setPorting(false)
            }
          }}
        >
          {porting ? 'Decompiling…' : 'Port mod .jar(s) (+ scan dependencies)…'}
        </button>
      </div>
      <div className="upgrade-sub">
        Brings every mod and the loader's own files to the version you pick. The Minecraft jar and everything in
        <code>bin/</code> are never touched, your configs are kept, and a backup is written before anything changes.
      </div>

      {current.mcVersion && (
        <div className="upgrade-current">
          This pack currently launches <strong>{current.mcVersion}</strong>
          {current.family && current.family !== 'unknown' ? ` with ${current.family}` : ''}
          {current.loaderVersion ? ` ${current.loaderVersion}` : ''} — from <code>bin/version</code>.
        </div>
      )}

      <div className="upgrade-row">
        <label>
          <span>Minecraft</span>
          <select value={mc} onChange={(e) => setMc(e.target.value)}>
            <option value="">choose…</option>
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.id}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Loader</span>
          <select value={loader} onChange={(e) => setLoader(e.target.value as Loader)}>
            {LOADERS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{loader === 'fabric' ? 'Fabric loader' : `${loader} build`}</span>
          <select value={loaderVersion} onChange={(e) => setLoaderVersion(e.target.value)}>
            {loaderChoices.length === 0 && <option value="">none published for {mc || 'this version'}</option>}
            {loaderChoices.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <button className="small primary" onClick={() => void buildPlan()} disabled={busy || !dir || !mc || !loaderVersion}>
          {busy ? 'Reading the pack…' : plan ? 'Re-plan' : 'Work out the update'}
        </button>
      </div>

      {error && <div className="upgrade-error">{error}</div>}

      {plan && (
        <div className="upgrade-plan">
          {plan.summary.map((line, i) => (
            <div key={i} className="upgrade-summary">
              {line}
            </div>
          ))}

          {updates.length > 0 && (
            <div className="upgrade-group">
              <div className="upgrade-group-head">
                <strong>{updates.length} mod{updates.length === 1 ? '' : 's'} to replace</strong>
                <button className="small ghost" onClick={() => setChosen(new Set(updates.map((m) => m.file)))}>
                  all
                </button>
                <button className="small ghost" onClick={() => setChosen(new Set())}>
                  none
                </button>
              </div>
              {updates.map((m) => (
                <label key={m.file} className="upgrade-item">
                  <input type="checkbox" checked={chosen.has(m.file)} onChange={(e) => toggle(m.file, e.target.checked)} />
                  <span className="upgrade-name">{m.name ?? m.modId ?? m.file}</span>
                  <span className="upgrade-reason">{m.reason}</span>
                </label>
              ))}
            </div>
          )}

          {missing.length > 0 && (
            <div className="upgrade-group warn">
              <div className="upgrade-group-head">
                <strong>{missing.length} mod{missing.length === 1 ? '' : 's'} with no {plan.target.mcVersion} build</strong>
                <button
                  type="button"
                  className="secondary-btn"
                  disabled={porting || !dir}
                  onClick={async () => {
                    if (!dir || !plan) return
                    setPorting(true)
                    try {
                      const targetLoader = plan.target.family === 'fabric' ? 'fabric' : plan.target.family === 'forge' ? 'forge' : 'neoforge'
                      const res = await api.pack.portMissing({
                        dir,
                        jarPaths: missing.map((m) => m.file),
                        targetMc: plan.target.mcVersion,
                        targetLoader,
                        includeDependencies: true
                      })
                      const depCount = res.ported.filter((p) => p.isDependency).length
                      onToast(
                        `Decompiled & created ${res.ported.length} port workspace(s)` +
                          (depCount ? ` (including ${depCount} pack dependency/ies)` : '') +
                          (res.skipped?.length ? `; ${res.skipped.length} already-ported dependency/ies skipped` : '') +
                          (res.failed.length ? `; ${res.failed.length} failed` : '')
                      )
                    } catch (err) {
                      onToast(err instanceof Error ? err.message : String(err))
                    } finally {
                      setPorting(false)
                    }
                  }}
                >
                  {porting ? 'Decompiling…' : 'Decompile & Port (+ dependencies)'}
                </button>
              </div>
              <div className="upgrade-note">
                Leaving these on disk keeps your pack complete but they will not load on {plan.target.mcVersion}. Tick one to
                <em> remove</em> it — that is the only way this update deletes anything, and it is backed up first.
              </div>
              {missing.map((m) => (
                <label key={m.file} className="upgrade-item">
                  <input type="checkbox" checked={removing.has(m.file)} onChange={(e) => toggleRemove(m.file, e.target.checked)} />
                  <span className="upgrade-name">{m.name ?? m.modId ?? m.file}</span>
                  <span className="upgrade-reason">{removing.has(m.file) ? 'will be removed' : `keep on disk (no build for ${plan.target.mcVersion})`}</span>
                </label>
              ))}
            </div>
          )}

          {/*
            The loader jar, first among the loader files — it is the one that
            decides which loader actually starts, and on an old pack it is the
            difference between 1.7.10 and 1.21.1 booting.
          */}
          {plan.loaderJar && (
            <div className={`upgrade-group${plan.loaderJar.download ? ' warn' : ''}`}>
              <div className="upgrade-group-head">
                <strong>Loader jar</strong>
                <span className="upgrade-reason">
                  {plan.loaderJar.present.kind === 'not-a-jar'
                    ? 'unreadable'
                    : plan.loaderJar.present.version
                      ? `currently ${plan.loaderJar.present.version}`
                      : 'version unknown'}
                </span>
              </div>
              <div className="upgrade-item static">
                <code>{plan.loaderJar.rel}</code>
                <span className="upgrade-reason">{plan.loaderJar.present.note}</span>
              </div>
              <div className="upgrade-note">
                {plan.loaderJar.download ? (
                  <>
                    Will be replaced with <code>{plan.loaderJar.download.name}</code> — {plan.loaderJar.why}. The
                    download is verified as a real installer before it goes near <code>bin/</code>, and if it cannot
                    be fetched the whole update stops with the pack untouched.
                  </>
                ) : (
                  plan.loaderJar.why
                )}
              </div>
            </div>
          )}

          {/*
            Old-version game files. Reported and left alone: a 1.7.10 pack keeps
            LWJGL 2 and its own asset index under bin/, which a 1.21.1 launch does
            not use — but deleting folders from a working pack on a guess is not
            this tool's call.
          */}
          {plan.legacyLeftovers && plan.legacyLeftovers.length > 0 && (
            <div className="upgrade-group muted">
              <div className="upgrade-group-head">
                <strong>Left over from {plan.current.mcVersion ?? 'the old version'}</strong>
                <span className="upgrade-reason">
                  {humanBytes(plan.legacyLeftovers.reduce((n, l) => n + l.bytes, 0))}, not used by{' '}
                  {plan.target.mcVersion}
                </span>
              </div>
              {plan.legacyLeftovers.map((l) => (
                <div key={l.rel} className="upgrade-item static">
                  <code>{l.rel}</code>
                  <span className="upgrade-reason">{l.note}</span>
                </div>
              ))}
              <div className="upgrade-note">
                These are not deleted — they are listed so you can remove them yourself once the new version runs.
              </div>
            </div>
          )}

          {plan.loaderFiles.filter((l) => l.changed).length > 0 && (
            <div className="upgrade-group">
              <div className="upgrade-group-head">
                <strong>Launcher files to rewrite</strong>
              </div>
              {plan.loaderFiles.filter((l) => l.changed).map((l) => (
                <div key={l.rel} className="upgrade-item static">
                  <code>{l.rel}</code>
                  <span className="upgrade-reason">{l.note}</span>
                </div>
              ))}
            </div>
          )}

          {keeps.length > 0 && (
            <div className="upgrade-group muted">
              <div className="upgrade-group-head">
                <strong>{keeps.length} already correct</strong>
              </div>
              <div className="upgrade-chips">
                {keeps.map((m) => (
                  <span key={m.file} className="upgrade-chip" title={m.reason}>
                    {m.name ?? m.modId ?? m.file}
                  </span>
                ))}
              </div>
            </div>
          )}

          {unknown.length > 0 && (
            <div className="upgrade-group muted">
              <div className="upgrade-group-head">
                <strong>{unknown.length} could not be identified</strong>
              </div>
              <div className="upgrade-note">These are left exactly as they are. Decompiling one with the tools above will tell you what it is.</div>
              <div className="upgrade-chips">
                {unknown.map((m) => (
                  <span key={m.file} className="upgrade-chip">{m.file}</span>
                ))}
              </div>
            </div>
          )}

          <div className="upgrade-actions">
            <button
              className="small primary"
              disabled={applying || (chosenCount === 0 && removing.size === 0)}
              onClick={() => void apply()}
            >
              {applying
                ? 'Updating…'
                : `Back up and update ${chosenCount} mod${chosenCount === 1 ? '' : 's'}${removing.size ? `, remove ${removing.size}` : ''}`}
            </button>
            <span className="upgrade-hint">Backup goes to <code>{plan.backup.dir}</code></span>
          </div>
        </div>
      )}

      {done && (
        <div className={`upgrade-done ${done.failed.length ? 'bad' : ''}`}>
          <strong>
            {done.updated} mod{done.updated === 1 ? '' : 's'} updated
            {done.removed ? `, ${done.removed} removed` : ''}
          </strong>
          {done.backup && (
            <div>
              Backup: <code>{done.backup}</code> — copy its contents back over the pack to undo.
            </div>
          )}
          {done.failed.length > 0 && (
            <div>
              {done.failed.length} did not complete:
              <ul>
                {done.failed.map((f) => (
                  <li key={f.file}>
                    <code>{f.file}</code> — {f.error}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
