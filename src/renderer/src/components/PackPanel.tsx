import { useCallback, useEffect, useState } from 'react'
import { api, type PackDependencyAction, type PackScan, type PackUpdate, type UpdatePlan } from '../lib/api'

interface Props {
  onToast: (text: string, kind?: 'ok' | 'err') => void
}

/** The outcome of one dependency, said in words rather than in a status code. */
const OUTCOME_LABEL: Record<string, string> = {
  'already-present': 'in this folder',
  'present-wrong-version': 'wrong version',
  missing: 'not in this folder',
  'needs-confirmation': 'could not confirm'
}

/**
 * Update the mods in a whole modpack, starting from the folder.
 *
 * A pack that runs is a pack whose dependencies are already there — every one of
 * them, in versions the mods accept. So the folder is read first, and the answer
 * to "what does this update need" is almost always "nothing":
 *
 *   1. pick the `mods` folder (or the pack root that holds one),
 *   2. every jar's declared dependencies are read and checked against the folder,
 *   3. anything the folder covers is listed as covered and never offered,
 *   4. only a genuinely missing or out-of-range dependency becomes a download.
 *
 * The scan is local and instant; naming the mods needs Modrinth, which is why
 * that is a separate step with its own button. Nothing is downloaded by scanning.
 */
export default function PackPanel({ onToast }: Props): JSX.Element {
  const [dir, setDir] = useState('')
  const [scan, setScan] = useState<PackScan | null>(null)
  const [verdict, setVerdict] = useState<{ headline: string; detail: string; healthy: boolean } | null>(null)
  const [versions, setVersions] = useState<{ mcVersion?: string; loader?: string }>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const [updates, setUpdates] = useState<PackUpdate[]>([])
  const [checked, setChecked] = useState(false)
  /** Compiled against the folder for one mod, shown before anything is downloaded. */
  const [plan, setPlan] = useState<{ file: string; plan: UpdatePlan; replaces?: string } | null>(null)
  const [working, setWorking] = useState<string | null>(null)

  /**
   * The one-mod flow: choose the jar you are updating to, see which of *its*
   * dependencies are already in this folder, then bring the rest along with it.
   */
  const [modPlan, setModPlan] = useState<{
    jar: string
    modId?: string
    name?: string
    replaces?: string
    summary: string
    dependencies: PackDependencyAction[]
  } | null>(null)
  const [includeDeps, setIncludeDeps] = useState(true)
  const [decompile, setDecompile] = useState(true)
  const [applied, setApplied] = useState<{ modId: string; ok: boolean; error?: string; replaced?: string; sources?: string; sourcesError?: string }[]>([])
  /** Jars recognised only by name: decompiled, checked, and linked as reference. */
  const [referenced, setReferenced] = useState<
    { file: string; modId?: string; verified?: string; found?: string; linked?: boolean; error?: string }[]
  >([])

  const load = useCallback(async (chosen: string) => {
    setBusy(true)
    setError('')
    setPlan(null)
    setUpdates([])
    setChecked(false)
    try {
      const res = await api.pack.scan(chosen)
      if (!res.ok || !res.scan) {
        setError(res.error ?? 'Could not read that folder.')
        setScan(null)
        setVerdict(null)
        return
      }
      setDir(chosen)
      setScan(res.scan)
      setVerdict(res.verdict ?? null)
      setVersions(res.versions ?? {})
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  async function pick(): Promise<void> {
    const chosen = await api.dialog.pickFolder({ title: 'Select your mods folder, or the modpack folder that holds it' })
    if (chosen) await load(chosen)
  }

  /** Ask Modrinth which mods have newer builds for this pack's own version. */
  async function checkUpdates(): Promise<void> {
    if (!scan) return
    setBusy(true)
    setError('')
    try {
      const res = await api.pack.updates({ dir: scan.dir })
      if (!res.ok) {
        setError(res.error ?? 'Could not check for updates.')
        return
      }
      setUpdates(res.updates)
      setChecked(true)
      if (!res.updates.length) onToast('Every mod in this folder is on its newest build for this pack.')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /**
   * Choose the mod being updated to, and ask the folder what it already has.
   *
   * This is the flow the feature exists for: the jar you are moving to names its
   * own dependencies, and every one of those is looked for *in the pack* before
   * any download is considered.
   */
  async function planMod(): Promise<void> {
    if (!scan) return
    const [jar] = await api.dialog.pickFiles({
      title: 'Choose the mod jar you are updating to',
      filters: [{ name: 'Mod jar', extensions: ['jar'] }]
    })
    if (!jar) return
    setBusy(true)
    setError('')
    setApplied([])
    try {
      const res = await api.pack.updatePlan({ dir: scan.dir, incomingJar: jar })
      if (!res.ok || !res.preview) {
        onToast(res.error ?? 'Could not read that jar.', 'err')
        return
      }
      setModPlan({
        jar,
        modId: res.preview.modId,
        name: res.preview.name,
        replaces: res.preview.replaces,
        summary: res.preview.summary,
        dependencies: res.dependencies ?? []
      })
    } finally {
      setBusy(false)
    }
  }

  /**
   * Bring the dependencies along, then the mod itself.
   *
   * Only the ones the folder cannot satisfy are downloaded. The compatible ones
   * are already there — they get decompiled in place, so the agent can read the
   * API it is compiling against without a download that would duplicate them.
   */
  async function applyMod(): Promise<void> {
    if (!scan || !modPlan) return
    const toFetch = modPlan.dependencies.filter((d) => d.action === 'download' && d.target)
    const toDecompile = includeDeps ? modPlan.dependencies.filter((d) => d.action === 'keep' && d.path) : []
    setWorking(modPlan.jar)
    try {
      if (toFetch.length) {
        const res = await api.pack.updateApply({
          dir: scan.dir,
          decompile: decompile,
          modJar: modPlan.jar,
          items: toFetch.map((d) => ({
            modId: d.modId,
            url: d.target?.url ?? '',
            name: d.target?.name ?? '',
            replacePath: d.path
          }))
        })
        setApplied(res.results)
        const failed = res.results.filter((r) => !r.ok)
        if (failed.length) {
          onToast(
            `${failed.length} dependenc${failed.length === 1 ? 'y' : 'ies'} could not be updated: ${failed.map((f) => f.modId).join(', ')}`,
            'err'
          )
        } else {
          onToast(`Updated ${toFetch.length} dependenc${toFetch.length === 1 ? 'y' : 'ies'} alongside ${modPlan.modId ?? 'the mod'}`)
        }
      } else if (modPlan.replaces) {
        // Nothing to fetch: the folder already satisfies the new build, so the
        // only thing left is to put the updated jar in.
        const res = await api.pack.adopt({ dir: scan.dir, from: modPlan.jar, replace: true })
        if (!res.ok) onToast(res.error ?? 'Could not place the updated jar', 'err')
        else onToast(`${modPlan.modId ?? 'The mod'} updated; every dependency it needs was already in the folder.`)
      }

      if (toDecompile.length) {
        const res = await api.pack.decompile({
          dir: scan.dir,
          jars: toDecompile.map((d) => d.path ?? '')
        })
        if (res.ok) onToast(`Decompiled ${res.done ?? toDecompile.length} dependenc${toDecompile.length === 1 ? 'y' : 'ies'} the folder already had.`)
      }

      // Dependencies that could only be recognised by their file name: the name
      // is a guess until the code is read, so the decompiled sources are where
      // the guess gets confirmed — and linked as reference once it is.
      const guessedDeps = modPlan.dependencies.filter((d) => d.inferred && d.path)
      if (includeDeps && guessedDeps.length) {
        const res = await api.pack.reference({ dir: scan.dir, modIds: guessedDeps.map((d) => d.modId) })
        setReferenced(res.results ?? [])
        const confirmed = (res.results ?? []).filter((r) => r.verified === 'confirmed').length
        const contradicted = (res.results ?? []).filter((r) => r.verified === 'contradicted')
        if (contradicted.length) {
          onToast(
            `${contradicted.length} jar${contradicted.length === 1 ? ' was' : 's were'} named wrong in the folder — the code says ${contradicted[0].found}. Left unlinked.`,
            'err'
          )
        } else if (confirmed) {
          onToast(`Confirmed ${confirmed} dependency id${confirmed === 1 ? '' : 's'} from the decompiled code, and linked them as reference.`)
        }
      }
      setModPlan(null)
      await load(dir)
    } finally {
      setWorking(null)
    }
  }

  /** Download the newer build, removing the old copy only once it is on disk. */
  async function install(u: PackUpdate): Promise<void> {
    if (!scan || !u.newestFile) return
    setWorking(u.file)
    try {
      const res = await api.pack.download({
        dir: scan.dir,
        url: u.newestFile.url,
        name: u.newestFile.name,
        replacePath: u.path
      })
      if (!res.ok) {
        onToast(res.error ?? 'Download failed', 'err')
        return
      }
      onToast(`Updated ${u.projectName ?? u.modId ?? u.file} to ${u.newestVersion ?? 'the newest build'}`)
      setPlan(null)
      await load(dir)
      await checkUpdates()
    } finally {
      setWorking(null)
    }
  }

  /**
   * Check a jar the user already has — usually already in Downloads — against
   * the folder, to see what it would need before it is copied anywhere.
   */
  async function previewPicked(): Promise<void> {
    if (!scan) return
    const [jar] = await api.dialog.pickFiles({ title: 'Choose the mod jar you want to put in this pack', filters: [{ name: 'Mod jar', extensions: ['jar'] }] })
    if (!jar) return
    setBusy(true)
    try {
      const res = await api.pack.preview({ dir: scan.dir, jar })
      if (!res.ok || !res.plan) {
        onToast(res.error ?? 'Could not read that jar.', 'err')
        return
      }
      setPlan({ file: jar, plan: res.plan, replaces: res.replaces })
    } finally {
      setBusy(false)
    }
  }

  /** Copy a previewed jar into the folder, replacing the old copy of the same mod. */
  async function adopt(): Promise<void> {
    if (!scan || !plan) return
    setWorking(plan.file)
    try {
      const res = await api.pack.adopt({ dir: scan.dir, from: plan.file, replace: !!plan.replaces })
      if (!res.ok) {
        onToast(res.error ?? 'Could not copy that jar in', 'err')
        return
      }
      onToast(`Added ${res.mod?.modId ?? plan.file}${res.mod?.version ? ` ${res.mod.version}` : ''}`)
      setPlan(null)
      await load(dir)
    } finally {
      setWorking(null)
    }
  }

  return (
    <div>
      <p className="muted small">
        Choose a modpack&apos;s <code>mods</code> folder — or the pack folder itself. Then pick the mod you are
        updating to: its dependencies are looked for <b>in this folder first</b>, and the ones already here come along
        with it — decompiled, so the code can be read — without being downloaded again.
      </p>

      <div className="row wrap">
        <button className="small primary" disabled={busy} onClick={() => void pick()}>
          {busy && !scan ? 'Reading…' : scan ? 'Choose another folder' : 'Choose a mods folder'}
        </button>
        {scan && (
          <button className="small primary" disabled={busy} onClick={() => void planMod()}>
            Update a mod…
          </button>
        )}
        {scan && (
          <button className="small" disabled={busy} onClick={() => void checkUpdates()}>
            {busy ? 'Checking…' : 'Check for mod updates'}
          </button>
        )}
        {scan && (
          <button className="small ghost" disabled={busy} onClick={() => void previewPicked()}>
            Add a jar you already have
          </button>
        )}
        {scan && (
          <button className="small ghost" disabled={busy} onClick={() => void load(dir)}>
            Rescan
          </button>
        )}
      </div>

      {error && <p className="warn">{error}</p>}

      {scan && verdict && (
        <div className="card" style={{ marginTop: 8 }}>
          <div className="row wrap">
            <b className={verdict.healthy ? '' : 'warn'}>{verdict.headline}</b>
            {versions.mcVersion && <span className="chip">Minecraft {versions.mcVersion}</span>}
            {versions.loader && <span className="chip">{versions.loader}</span>}
          </div>
          <p className="muted small" style={{ marginTop: 4 }}>
            {verdict.detail}
          </p>
          <p className="muted small">
            <code>{scan.dir}</code>
          </p>
        </div>
      )}

      {scan && scan.missing.length > 0 && (
        <div className="card">
          <b>Not in this folder</b>
          <p className="muted small" style={{ marginTop: 4 }}>
            Nothing in this folder provides these. They are the only things here worth downloading.
          </p>
          {scan.missing.map((m) => (
            <div key={m.modId} className="row wrap" style={{ marginTop: 4 }}>
              <b>{m.modId}</b>
              {m.versionRange && <span className="chip">{m.versionRange}</span>}
              <span className="muted small">wanted by {m.requiredBy.join(', ')}</span>
            </div>
          ))}
        </div>
      )}

      {scan && scan.mismatched.length > 0 && (
        <div className="card">
          <b>Present, but the wrong version</b>
          <p className="muted small" style={{ marginTop: 4 }}>
            The folder has these, just not the version that was asked for. Update that mod rather than adding a second
            copy of it.
          </p>
          {scan.mismatched.map((m, i) => (
            <div key={`${m.modId}-${i}`} className="row wrap" style={{ marginTop: 4 }}>
              <b>{m.modId}</b>
              <span className="chip">
                have {m.have ?? '?'} · want {m.versionRange}
              </span>
              <span className="muted small">wanted by {m.requiredBy.join(', ')}</span>
            </div>
          ))}
        </div>
      )}

      {modPlan && (
        <div className="card">
          <div className="row wrap">
            <b>Updating {modPlan.name ?? modPlan.modId ?? 'this mod'}</b>
            {modPlan.modId && <span className="chip">{modPlan.modId}</span>}
            {modPlan.replaces && <span className="chip">replaces {modPlan.replaces}</span>}
          </div>
          <p className="muted small" style={{ marginTop: 4 }}>
            {modPlan.summary}
          </p>

          {modPlan.dependencies.length > 0 && (
            <div style={{ marginTop: 6 }}>
              {modPlan.dependencies.map((d) => (
                <div key={d.modId} className="row wrap" style={{ marginTop: 3 }}>
                  <span className={d.action === 'keep' ? 'chip on' : 'chip'}>{d.action === 'keep' ? 'in folder' : 'download'}</span>
                  <b>{d.displayName}</b>
                  {d.version && <span className="muted small">{d.version}</span>}
                  {d.versionRange && <span className="muted small">wants {d.versionRange}</span>}
                  <span className={d.action === 'keep' ? 'muted small' : 'warn small'}>{d.reason}</span>
                  {d.action === 'download' && !d.target && <span className="warn small">· no build found for this version</span>}
                </div>
              ))}
            </div>
          )}

          <label className="chk" style={{ marginTop: 8, display: 'flex' }}>
            <input type="checkbox" checked={includeDeps} onChange={(e) => setIncludeDeps(e.target.checked)} />
            Bring the dependencies in this folder along
          </label>
          <label className="chk" style={{ marginTop: 4, display: 'flex' }}>
            <input type="checkbox" checked={decompile} onChange={(e) => setDecompile(e.target.checked)} />
            Decompile them so the code can be read
          </label>

          <div className="row wrap" style={{ marginTop: 8 }}>
            <button className="small primary" disabled={working === modPlan.jar} onClick={() => void applyMod()}>
              {working === modPlan.jar
                ? 'Working…'
                : modPlan.dependencies.some((d) => d.action === 'download')
                  ? `Update mod and ${modPlan.dependencies.filter((d) => d.action === 'download').length} dependenc${modPlan.dependencies.filter((d) => d.action === 'download').length === 1 ? 'y' : 'ies'}`
                  : 'Update the mod — every dependency is already here'}
            </button>
            <button className="small ghost" onClick={() => setModPlan(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {applied.length > 0 && (
        <div className="card">
          <b>What happened</b>
          {applied.map((r) => (
            <p key={r.modId} className={r.ok ? 'muted small' : 'warn small'} style={{ marginTop: 3 }}>
              {r.modId === 'self' ? 'the mod itself' : r.modId}: {r.ok ? 'updated' : (r.error ?? 'failed')}
              {r.replaced ? ` (replaced ${r.replaced})` : ''}
              {r.sources ? ` · sources in ${r.sources}` : ''}
              {r.sourcesError ? ` · could not decompile: ${r.sourcesError}` : ''}
            </p>
          ))}
        </div>
      )}

      {referenced.length > 0 && (
        <div className="card">
          <b>Read from the code, not the file name</b>
          <p className="muted small" style={{ marginTop: 4 }}>
            These jars had no readable metadata, so they were recognised by name and then decompiled to check it.
          </p>
          {referenced.map((r) => (
            <p key={r.file} className={r.verified === 'contradicted' ? 'warn small' : 'muted small'} style={{ marginTop: 3 }}>
              <b>{r.file}</b>{' '}
              {r.verified === 'confirmed'
                ? `— confirmed as ${r.modId}${r.linked ? ', linked as reference' : ''}`
                : r.verified === 'contradicted'
                  ? `— the code says ${r.found}, not ${r.modId}; left unlinked`
                  : r.error
                    ? `— ${r.error}`
                    : `— decompiled${r.linked ? ' and linked as reference' : ''}, no @Mod id found to confirm it`}
            </p>
          ))}
        </div>
      )}

      {plan && (
        <div className="card">
          <div className="row wrap">
            <b>{plan.plan.modId ?? plan.file}</b>
            {plan.replaces ? <span className="chip">replaces {plan.replaces}</span> : <span className="chip">new mod</span>}
          </div>
          <p className="muted small" style={{ marginTop: 4 }}>
            {plan.plan.summary}
          </p>
          {plan.plan.dependencies.map((d) => (
            <div key={d.modId} className="row wrap" style={{ marginTop: 2 }}>
              <span className={d.outcome === 'already-present' ? 'muted small' : 'warn small'}>
                {OUTCOME_LABEL[d.outcome] ?? d.outcome}
              </span>
              <b>{d.modId}</b>
              {d.providedBy && <span className="muted small">· {d.providedBy}</span>}
              {d.versionRange && <span className="chip">{d.versionRange}</span>}
            </div>
          ))}
          <div className="row wrap" style={{ marginTop: 8 }}>
            <button className="small primary" disabled={working === plan.file} onClick={() => void adopt()}>
              {working === plan.file ? 'Adding…' : plan.replaces ? `Replace ${plan.replaces}` : 'Add to folder'}
            </button>
            <button className="small ghost" onClick={() => setPlan(null)}>
              Cancel
            </button>
          </div>
          {plan.plan.toDownload.length > 0 && (
            <p className="muted small" style={{ marginTop: 6 }}>
              This pack is missing {plan.plan.toDownload.map((d) => d.modId).join(', ')} — add or update{' '}
              {plan.plan.toDownload.length === 1 ? 'it' : 'them'} separately. Nothing else needs downloading.
            </p>
          )}
        </div>
      )}

      {checked && updates.length === 0 && (
        <p className="muted small">No mod in this folder has a newer build for Minecraft {versions.mcVersion ?? 'this version'}.</p>
      )}

      {updates.map((u) => (
        <div key={u.path} className="card">
          <div className="row wrap">
            <b>{u.projectName ?? u.modId ?? u.file}</b>
            <span className="chip">
              {u.haveVersion ?? '?'} → {u.newestVersion ?? 'newer'}
            </span>
          </div>
          <p className="muted small" style={{ marginTop: 4 }}>
            {u.file} — downloading replaces this file, it does not add a second copy.
          </p>
          <button className="small primary" disabled={working === u.file} onClick={() => void install(u)}>
            {working === u.file ? 'Downloading…' : 'Download and replace'}
          </button>
        </div>
      ))}

      {scan && scan.mods.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary className="muted small">
            {scan.mods.length} jar{scan.mods.length === 1 ? '' : 's'} read
            {scan.ignored.length ? `, ${scan.ignored.length} file${scan.ignored.length === 1 ? '' : 's'} skipped` : ''}
          </summary>
          {scan.mods.map((m) => (
            <div key={m.path} className="row wrap" style={{ marginTop: 2 }}>
              <b>{m.modId ?? m.file}</b>
              {m.version && <span className="chip">{m.version}</span>}
              <span className="muted small">
                {m.loader}
                {m.depends.filter((d) => !d.isLoaderOrGame).length
                  ? ` · needs ${m.depends
                      .filter((d) => !d.isLoaderOrGame)
                      .map((d) => d.modId)
                      .join(', ')}`
                  : ' · no dependencies'}
              </span>
            </div>
          ))}
        </details>
      )}
    </div>
  )
}
