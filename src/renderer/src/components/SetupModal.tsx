import { useEffect, useMemo, useState } from 'react'
import { api, type Loader, type VersionChoice } from '../lib/api'

interface Props {
  onClose: () => void
  onCreated: (dir: string) => void
  onToast: (text: string, kind?: 'ok' | 'err') => void
}

const LOADER_LABEL: Record<Loader, string> = { neoforge: 'NeoForge', forge: 'Forge', fabric: 'Fabric' }
const LOADER_ORDER: Loader[] = ['neoforge', 'forge', 'fabric']

interface EraInfo {
  id: string
  label: string
  buildable: boolean
  java: number
  notes: string[]
}

export default function SetupModal({ onClose, onCreated, onToast }: Props): JSX.Element {
  const [parent, setParent] = useState('')
  const [modId, setModId] = useState('')
  const [modName, setModName] = useState('')
  const [group, setGroup] = useState('')
  const [author, setAuthor] = useState('')
  const [version, setVersion] = useState('1.0.0')

  const [versions, setVersions] = useState<VersionChoice[]>([])
  const [mc, setMc] = useState('')
  const [loader, setLoader] = useState<Loader>('neoforge')
  const [loaderVersions, setLoaderVersions] = useState<string[]>([])
  const [loaderVersion, setLoaderVersion] = useState('')
  const [era, setEra] = useState<EraInfo | null>(null)
  const [snapshots, setSnapshots] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [search, setSearch] = useState('')
  const [catalogNote, setCatalogNote] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<{ modId?: string | null; group?: string | null; other?: string }>({})

  /* ---------------------------------------------------------------- catalog */

  async function loadCatalog(force: boolean, withSnapshots = snapshots): Promise<void> {
    force ? setRefreshing(true) : setLoading(true)
    try {
      const res = await api.versions.catalog({ force, snapshots: withSnapshots })
      const list = res.versions ?? []
      setVersions(list)
      setCatalogNote(res.errors?.length ? res.errors.join(' · ') : '')
      if (!list.length) {
        setErrors({ other: 'Could not load the Minecraft version list. Check your connection and press Refresh.' })
        return
      }
      // Keep the current pick if it survived; otherwise fall back to 1.21.1, then newest.
      setMc((prev) => {
        if (prev && list.some((v) => v.id === prev)) return prev
        const preferred = list.find((v) => v.id === '1.21.1') ?? list[0]
        return preferred.id
      })
    } catch (e) {
      setErrors({ other: (e as Error).message })
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    void loadCatalog(false, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const current = versions.find((v) => v.id === mc)

  /* -------------------------------------------------- loader + build target */

  useEffect(() => {
    if (!current) return
    const available = LOADER_ORDER.filter((l) => current.loaders.includes(l))
    if (!available.length) {
      setLoaderVersions([])
      setLoaderVersion('')
      setEra(null)
      return
    }
    const next = available.includes(loader) ? loader : available[0]
    if (next !== loader) setLoader(next)
    let cancelled = false
    void (async () => {
      const res = await api.versions.loaders({ mcVersion: mc, loader: next })
      if (cancelled) return
      setLoaderVersions(res.versions ?? [])
      setLoaderVersion(res.versions?.[0] ?? '')
    })()
    return () => {
      cancelled = true
    }
  }, [mc, loader, current])

  useEffect(() => {
    if (!mc) return
    let cancelled = false
    void (async () => {
      const res = await api.versions.era({ loader, mcVersion: mc })
      if (!cancelled) setEra(res.ok && res.era ? res.era : null)
    })()
    return () => {
      cancelled = true
    }
  }, [loader, mc])

  const availableLoaders = current ? LOADER_ORDER.filter((l) => current.loaders.includes(l)) : []

  /* ------------------------------------------------------------- version list */

  /** Newest-first list, filtered by the search box and the "show everything" toggle. */
  const shownVersions = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (q) return versions.filter((v) => v.id.toLowerCase().includes(q))
    if (showAll || snapshots) return versions
    // Compact view: the recent releases plus whatever is selected, so 100+ rows don't bury it.
    const recent = versions.filter((v) => v.type === 'release').slice(0, 14)
    if (mc && !recent.some((v) => v.id === mc)) {
      const sel = versions.find((v) => v.id === mc)
      if (sel) return [...recent, sel]
    }
    return recent
  }, [versions, search, showAll, snapshots, mc])

  const hiddenCount = versions.length - shownVersions.length

  function suggestId(name: string): void {
    setModName(name)
    const id = name
      .toLowerCase()
      .replace(/[^a-z0-9_ ]/g, '')
      .trim()
      .replace(/\s+/g, '_')
    if (id && /^[a-z]/.test(id)) setModId(id)
  }

  async function validate(): Promise<boolean> {
    const res = await api.project.validate({ modId, group })
    setErrors({ modId: res.modId, group: res.group })
    return !res.modId && !res.group
  }

  async function create(): Promise<void> {
    if (!(await validate())) return
    if (!mc || !loaderVersion) {
      setErrors({ other: 'Pick a Minecraft and loader version first.' })
      return
    }
    let parentDir = parent
    if (!parentDir) {
      const picked = await api.dialog.pickFolder({ title: 'Where should the mod project live?' })
      if (!picked) return
      parentDir = picked
      setParent(picked)
    }
    setBusy(true)
    try {
      const res = await api.project.scaffold({
        parentDir,
        modId,
        modName: modName || modId,
        group,
        modVersion: version,
        author,
        loader,
        mcVersion: mc,
        loaderVersion
      })
      if (!res.ok) {
        setErrors({ other: res.error })
        return
      }
      onToast(`Created ${LOADER_LABEL[loader]} ${mc} project`)
      onCreated(res.dir)
      onClose()
    } catch (e) {
      setErrors({ other: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const blocked = !era?.buildable || !loaderVersions.length

  return (
    <div className="modal">
      <div className="box">
        <h2>New mod project</h2>
        <div className="sub">
          Pick a loader and a Minecraft version. Everything from 1.2.5 to the latest release is listed; the build files are
          generated to match the version you choose.
        </div>

        <div className="two-col">
          <div className="field">
            <label>Mod display name</label>
            <input value={modName} placeholder="Ruby Tools" onChange={(e) => suggestId(e.target.value)} autoFocus />
          </div>
          <div className="field">
            <label>Mod id (lowercase, a-z 0-9 _)</label>
            <input value={modId} placeholder="rubytools" onChange={(e) => setModId(e.target.value)} />
            {errors.modId && <div className="hint" style={{ color: 'var(--red)' }}>{errors.modId}</div>}
          </div>
        </div>

        <div className="field">
          <label>Base package</label>
          <input value={group} placeholder="com.yourname.rubytools" onChange={(e) => setGroup(e.target.value)} />
          {errors.group ? <div className="hint" style={{ color: 'var(--red)' }}>{errors.group}</div> : <div className="hint">Becomes the java package and the maven group.</div>}
        </div>

        <div className="field">
          <label>Loader</label>
          <div className="seg">
            {LOADER_ORDER.map((l) => {
              const ok = availableLoaders.includes(l)
              return (
                <button
                  key={l}
                  type="button"
                  className={`seg-btn${loader === l ? ' on' : ''}`}
                  disabled={!ok}
                  title={ok ? '' : `No ${LOADER_LABEL[l]} build is published for Minecraft ${mc || 'that version'}.`}
                  onClick={() => setLoader(l)}
                >
                  {LOADER_LABEL[l]}
                </button>
              )
            })}
          </div>
          {!loading && !availableLoaders.length && mc ? (
            <div className="hint warn">No loader has a build for {mc}. Pick another Minecraft version.</div>
          ) : null}
        </div>

        <div className="field">
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 5 }}>
            <label style={{ margin: 0 }}>Minecraft version</label>
            <div className="row" style={{ gap: 10 }}>
              <label className="chk">
                <input
                  type="checkbox"
                  checked={snapshots}
                  onChange={(e) => {
                    setSnapshots(e.target.checked)
                    void loadCatalog(false, e.target.checked)
                  }}
                />
                Snapshots
              </label>
              <button className="tiny" disabled={refreshing} onClick={() => void loadCatalog(true)}>
                {refreshing ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>
          </div>

          <input
            value={search}
            placeholder={loading ? 'Loading versions…' : 'Search versions, e.g. 1.12 or 1.21.4'}
            onChange={(e) => setSearch(e.target.value)}
          />

          <div className="ver-list">
            {loading ? <div className="ver-empty">Loading the version list…</div> : null}
            {!loading && !shownVersions.length ? <div className="ver-empty">No version matches “{search}”.</div> : null}
            {shownVersions.map((v) => (
              <button
                key={v.id}
                type="button"
                className={`ver-row${v.id === mc ? ' on' : ''}`}
                onClick={() => setMc(v.id)}
              >
                <span className="ver-id">{v.id}</span>
                {v.type === 'snapshot' ? <span className="ver-tag">snapshot</span> : null}
                <span className="ver-loaders">
                  {LOADER_ORDER.filter((l) => v.loaders.includes(l)).map((l) => (
                    <span key={l} className={`dot ${l}`} title={LOADER_LABEL[l]} />
                  ))}
                </span>
              </button>
            ))}
          </div>

          {!search && hiddenCount > 0 ? (
            <div className="hint">
              Showing recent releases.{' '}
              <a className="link" onClick={() => setShowAll(true)}>
                Show all {versions.length} versions
              </a>
            </div>
          ) : null}
          {showAll && !search ? (
            <div className="hint">
              Showing every version from 1.2.5 up. <a className="link" onClick={() => setShowAll(false)}>Show fewer</a>
            </div>
          ) : null}
        </div>

        <div className="two-col">
          <div className="field">
            <label>{LOADER_LABEL[loader]} version</label>
            <select value={loaderVersion} disabled={!loaderVersions.length} onChange={(e) => setLoaderVersion(e.target.value)}>
              {loaderVersions.length === 0 ? <option value="">—</option> : null}
              {loaderVersions.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
            {!loading && !loaderVersions.length && current ? (
              <div className="hint warn">No {LOADER_LABEL[loader]} build for {mc}.</div>
            ) : null}
          </div>
          <div className="field">
            <label>Toolchain</label>
            <div className="hint" style={{ marginTop: 8 }}>
              {era ? (
                <>
                  {era.label} · Java {era.java}
                  {!era.buildable ? <div style={{ color: 'var(--amber)', marginTop: 3 }}>Reference only — no Gradle build for this era.</div> : null}
                </>
              ) : (
                '—'
              )}
            </div>
          </div>
        </div>

        {era?.notes?.length ? (
          <div className="hint" style={{ marginBottom: 10 }}>
            {era.notes.map((n) => (
              <div key={n}>• {n}</div>
            ))}
          </div>
        ) : null}

        {catalogNote ? (
          <div className="hint" style={{ marginBottom: 10, color: 'var(--amber)' }}>
            Some version sources failed to load: {catalogNote}
          </div>
        ) : null}

        <div className="two-col">
          <div className="field">
            <label>Author</label>
            <input value={author} placeholder="Your name" onChange={(e) => setAuthor(e.target.value)} />
          </div>
          <div className="field">
            <label>Mod version</label>
            <input value={version} onChange={(e) => setVersion(e.target.value)} />
          </div>
        </div>

        <div className="field">
          <label>Location</label>
          <div className="row">
            <input value={parent} placeholder="Choose a folder…" onChange={(e) => setParent(e.target.value)} />
            <button
              onClick={async () => {
                const picked = await api.dialog.pickFolder({ title: 'Where should the mod project live?' })
                if (picked) setParent(picked)
              }}
            >
              Browse
            </button>
          </div>
          {parent && modId ? <div className="hint">Project folder: {parent}/{modId}</div> : null}
        </div>

        {errors.other && <div style={{ color: 'var(--red)', fontSize: 12.5 }}>{errors.other}</div>}

        <div className="actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || !modId || !group || !mc || blocked} onClick={() => void create()}>
            {busy ? 'Creating…' : `Create ${LOADER_LABEL[loader]} ${mc || ''} project`}
          </button>
        </div>
      </div>
    </div>
  )
}
