import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReferenceModUi, ReleaseOption } from '../../../shared/types'
import { api, type ProjectSummary } from '../lib/api'

interface Props {
  project: ProjectSummary | null
  onToast: (text: string, kind?: 'ok' | 'err') => void
}

const VINEFLOWER_VERSION = '1.12.0'

function mb(bytes: number): string {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/**
 * Add another mod as read-only reference material: pick a GitHub release jar (or
 * a jar on disk), decompile it with Vineflower, and copy the sources into
 * <project>/reference/ where the agent can Read and Grep them.
 *
 * Reference sources are never compiled into the user's mod and the folder is
 * git-ignored, so they cannot leak into a release.
 */
export default function ReferencePanel({ project, onToast }: Props): JSX.Element {
  const [mods, setMods] = useState<ReferenceModUi[]>([])
  const [repo, setRepo] = useState('')
  const [releases, setReleases] = useState<ReleaseOption[] | null>(null)
  const [pickedTag, setPickedTag] = useState('')
  const [pickedAsset, setPickedAsset] = useState('')
  const [busy, setBusy] = useState('')
  const [lines, setLines] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<{ id: string; file: string; line: number; text: string }[]>([])
  /** Kept in the log panel as well as the toast, so the text can be copied. */
  const [failure, setFailure] = useState<string | null>(null)
  const [openFile, setOpenFile] = useState<{ title: string; path: string; text: string } | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    setMods(await api.refs.list())
  }, [])

  useEffect(() => {
    void refresh()
    const offs = [
      api.events.onRefLine((p) => setLines((l) => [...l.slice(-400), p.line])),
      api.events.onRefListChanged(() => void refresh())
    ]
    return () => offs.forEach((off) => off())
  }, [refresh])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [lines])

  async function resolveRepo(): Promise<void> {
    if (!repo.trim()) return
    setBusy('resolve')
    setReleases(null)
    try {
      const res = await api.refs.resolve(repo.trim())
      if (!res.ok || !res.releases) {
        onToast(res.error ?? 'Could not list releases', 'err')
        if (res.needsAuth) onToast('Sign in from Settings → GitHub first', 'err')
        return
      }
      setReleases(res.releases)
      const first = res.releases.find((r) => !r.prerelease && r.jars.length) ?? res.releases.find((r) => r.jars.length)
      if (first) {
        setPickedTag(first.tag)
        const recommended = (first as ReleaseOption & { recommended?: string }).recommended
        setPickedAsset(recommended ?? first.jars[0]?.name ?? '')
      }
    } finally {
      setBusy('')
    }
  }

  async function addFromGithub(): Promise<void> {
    if (!releases || !pickedTag) return
    setBusy('add')
    setLines([])
    setFailure(null)
    try {
      const res = await api.refs.addGithub({ repo: repo.trim(), tag: pickedTag, assetName: pickedAsset || undefined })
      if (!res.ok) {
        setFailure(res.error ?? 'Could not add that mod')
        onToast(res.error ?? 'Could not add that mod', 'err')
      } else if (res.mod?.decompiled) {
        onToast(`Decompiled ${res.mod.title} (${res.mod.version})`)
      } else {
        setFailure(res.mod?.error ?? 'Decompiling failed for an unknown reason.')
        onToast(`Downloaded, but decompiling failed: ${res.mod?.error ?? 'unknown'}`, 'err')
      }
      await refresh()
    } finally {
      setBusy('')
    }
  }

  async function addFiles(): Promise<void> {
    setBusy('files')
    setLines([])
    setFailure(null)
    try {
      const res = await api.refs.addFiles()
      if (!res.ok) {
        if (res.error !== 'cancelled') onToast(res.error ?? 'Could not add that jar', 'err')
      } else {
        const okCount = res.mods?.filter((m) => m.decompiled).length ?? 0
        const failed = res.mods?.find((m) => !m.decompiled)?.error
        if (!okCount) setFailure(failed ?? res.error ?? 'Decompiling failed.')
        onToast(okCount ? `Decompiled ${okCount} jar(s)` : `Added, but decompiling failed${res.error ? `: ${res.error}` : ''}`, okCount ? 'ok' : 'err')
      }
      await refresh()
    } finally {
      setBusy('')
    }
  }

  async function link(id: string): Promise<void> {
    setBusy(`link:${id}`)
    try {
      const res = await api.refs.link(id)
      onToast(res.ok ? `Copied ${res.files} file(s) to ${res.dir}` : res.error ?? 'Could not link', res.ok ? 'ok' : 'err')
      await refresh()
    } finally {
      setBusy('')
    }
  }

  async function decompile(id: string): Promise<void> {
    setBusy(`dec:${id}`)
    setLines([])
    setFailure(null)
    try {
      const res = await api.refs.decompile(id)
      if (!res.ok) setFailure(res.error ?? 'Decompilation failed')
      else setFailure(res.mod?.error ?? null)
      onToast(res.ok ? 'Decompiled' : res.error ?? 'Decompilation failed', res.ok ? 'ok' : 'err')
      await refresh()
    } finally {
      setBusy('')
    }
  }

  /**
   * Turn a decompiled mod into a buildable project. The target version comes from
   * the jar's own metadata, because decompiled code only compiles against the
   * version it was written for.
   */
  async function makeFork(m: ReferenceModUi): Promise<void> {
    setBusy(`fork:${m.id}`)
    try {
      const hint = await api.forks.suggest(m.id)
      if (!hint.ok) {
        onToast(hint.error ?? 'Could not read the mod metadata', 'err')
        return
      }
      const target = `${hint.loader === 'fabric' ? 'Fabric' : hint.loader === 'neoforge' ? 'NeoForge' : 'Forge'} ${hint.mcVersion}`
      const res = await api.forks.create({
        referenceId: m.id,
        loader: hint.loader,
        mcVersion: hint.mcVersion
      })
      if (!res.ok) {
        onToast(res.error ?? 'Could not create the fork', 'err')
        return
      }
      setLines((l) => [...l, `Forked ${m.title} as a ${target} project at ${res.fork?.dir}`])
      if (res.fork) await api.forks.open(res.fork.id)
      onToast(res.warning ? `Fork created — ${res.warning}` : `Fork created as a ${target} project`, res.warning ? 'err' : 'ok')
    } finally {
      setBusy('')
    }
  }

  async function remove(id: string): Promise<void> {
    const res = await api.refs.remove(id)
    setMods(res.mods)
    onToast('Removed the cached copy')
  }

  async function search(): Promise<void> {
    if (!query.trim()) return
    const res = await api.refs.search({ query: query.trim() })
    setHits(res.hits)
    if (!res.hits.length) onToast('No matches in the decompiled sources', 'err')
  }

  async function openHit(id: string, path: string, title: string): Promise<void> {
    const res = await api.refs.readFile({ id, path })
    if (res.ok && res.text !== undefined) setOpenFile({ title, path, text: res.text })
    else onToast(res.error ?? 'Could not read that file', 'err')
  }

  const selectedRelease = releases?.find((r) => r.tag === pickedTag)

  return (
    <div className="refs">
      <div className="hint" style={{ marginBottom: 12 }}>
        Decompile another mod and read it as reference. Sources go to <code>{project?.dir ?? '<project>'}\reference\</code>, are
        git-ignored, and are <strong>not</strong> compiled into your mod.
      </div>

      <div className="refs-add">
        <label>Add from GitHub releases</label>
        <div className="row">
          <input
            value={repo}
            placeholder="owner/repo or https://github.com/owner/repo"
            onChange={(e) => {
              setRepo(e.target.value)
              setReleases(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void resolveRepo()
            }}
          />
          <button className="small" disabled={!repo.trim() || busy === 'resolve'} onClick={() => void resolveRepo()}>
            {busy === 'resolve' ? 'Listing…' : 'List releases'}
          </button>
        </div>

        {releases && (
          <div className="two-col" style={{ marginTop: 8 }}>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Release</label>
              <select
                value={pickedTag}
                onChange={(e) => {
                  setPickedTag(e.target.value)
                  const rel = releases.find((r) => r.tag === e.target.value)
                  setPickedAsset(rel?.jars[0]?.name ?? '')
                }}
              >
                {releases.map((r) => (
                  <option key={r.tag} value={r.tag}>
                    {r.tag}
                    {r.prerelease ? ' (pre-release)' : ''} · {r.jars.length} jar{r.jars.length === 1 ? '' : 's'}
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Jar</label>
              <select value={pickedAsset} onChange={(e) => setPickedAsset(e.target.value)}>
                {(selectedRelease?.jars ?? []).map((j) => (
                  <option key={j.name} value={j.name}>
                    {j.name} ({mb(j.size)})
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
          <button className="primary small" disabled={!releases || !pickedTag || busy === 'add'} onClick={() => void addFromGithub()}>
            {busy === 'add' ? 'Downloading + decompiling…' : 'Add & decompile'}
          </button>
          <button className="small ghost" disabled={busy === 'files'} onClick={() => void addFiles()}>
            {busy === 'files' ? 'Working…' : 'Add a jar from disk…'}
          </button>
        </div>
        <div className="dim small" style={{ marginTop: 8 }}>
          Needs a JDK 21 (the same one the build uses). The decompiler (Vineflower {VINEFLOWER_VERSION}) is downloaded once and checked
          against a pinned SHA-256. You can point Settings at a different decompiler jar.
        </div>
      </div>

      {(lines.length > 0 || failure) && (
        <div className="refs-log" ref={logRef}>
          {lines.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
          {failure && <div className="ref-failure">✗ {failure}</div>}
        </div>
      )}

      <div className="refs-list">
        {mods.length === 0 && <div className="dim" style={{ padding: 10, fontSize: 12.5 }}>No reference mods yet.</div>}
        {mods.map((m) => (
          <div className="ref-row" key={m.id}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="ref-title">
                {m.homepage ? (
                  <button className="linklike" onClick={() => void api.refs.openHomepage(m.homepage!)}>
                    {m.title}
                  </button>
                ) : (
                  m.title
                )}{' '}
                <span className="dim small">{m.version}</span>
                {m.decompiled ? <span className="badge green" style={{ marginLeft: 6 }}>decompiled</span> : <span className="badge red" style={{ marginLeft: 6 }}>no sources</span>}
                {m.linked && <span className="badge" style={{ marginLeft: 6 }}>in project</span>}
              </div>
              <div className="dim small">
                {m.jarName} · {mb(m.jarSize)}
                {m.modId ? ` · ${m.modId}` : ''}
                {m.loader ? ` · ${m.loader}` : ''}
                {m.mcVersion ? ` · MC ${m.mcVersion}` : ''}
                {m.license ? ` · ${m.license}` : ''}
              </div>
              {m.error && <div className="hint warn small">{m.error}</div>}
            </div>
            <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {m.decompiled ? (
                <>
                  <button className="small" disabled={busy === `link:${m.id}`} onClick={() => void link(m.id)}>
                    {busy === `link:${m.id}` ? 'Copying…' : 'Use as reference'}
                  </button>
                  <button className="small ghost" onClick={() => void api.refs.openFolder(m.id)}>
                    Open sources
                  </button>
                  <button className="small" disabled={busy === `fork:${m.id}`} onClick={() => void makeFork(m)} title="Copy the decompiled sources into a real project you can build and edit">
                    {busy === `fork:${m.id}` ? 'Forking…' : 'Make editable copy'}
                  </button>
                </>
              ) : (
                <button className="small" disabled={busy === `dec:${m.id}`} onClick={() => void decompile(m.id)}>
                  {busy === `dec:${m.id}` ? 'Decompiling…' : 'Decompile'}
                </button>
              )}
              <button className="small ghost" onClick={() => void remove(m.id)} title="Delete the cached jar and sources">
                ×
              </button>
            </div>
          </div>
        ))}
      </div>

      {mods.some((m) => m.decompiled) && (
        <div className="refs-search">
          <label>Search decompiled sources</label>
          <div className="row">
            <input
              value={query}
              placeholder="e.g. RegisterPayloadHandlersEvent"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void search()
              }}
            />
            <button className="small" disabled={!query.trim()} onClick={() => void search()}>
              Search
            </button>
          </div>
          {hits.length > 0 && (
            <div className="hits">
              {hits.map((h, i) => {
                const mod = mods.find((m) => m.id === h.id)
                return (
                  <button
                    key={`${h.file}:${h.line}:${i}`}
                    className="hit"
                    onClick={() => void openHit(h.id, h.file, `${mod?.title ?? h.id} — ${h.file.split('/').pop()}`)}
                  >
                    <span className="dim small">
                      {mod?.slug ?? h.id} · {h.file}:{h.line}
                    </span>
                    <span className="code-line">{h.text}</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}

      {openFile && (
        <div className="modal" onClick={() => setOpenFile(null)}>
          <div className="box wide" onClick={(e) => e.stopPropagation()}>
            <h2>{openFile.title}</h2>
            <div className="sub">{openFile.path}</div>
            <pre className="code-view">{openFile.text}</pre>
            <div className="actions">
              <button onClick={() => setOpenFile(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
