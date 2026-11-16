import { useCallback, useEffect, useState } from 'react'
import { api, type DependencyScan, type DependencyCandidate } from '../lib/api'

interface Props {
  /** The project folder being worked on, so the panel refreshes with it. */
  dir?: string
  onToast: (text: string, kind?: 'ok' | 'err') => void
}

const KIND_LABEL: Record<string, string> = {
  mod: 'mod',
  library: 'library',
  unknown: 'unrecognised'
}

/**
 * What the project needs beyond Minecraft.
 *
 * The failure this panel exists for: port a mod with the Update tab, build it, and
 * gradle answers
 *
 *   error: package com.simibubi.create.content.kinetics does not exist
 *
 * A port carries sources and regenerates the build file; it does not carry the
 * dependencies the old build file declared. Nothing said so, and a jar dropped in
 * `libs/` would not have been enough either — gradle has to be told.
 *
 * The panel is a list with one button per row rather than a "fix everything"
 * button on purpose. Adding a mod the code does not need is not free: two versions
 * of the same library on a classpath is its own afternoon. The user picks.
 */
export default function DependenciesPanel({ dir, onToast }: Props): JSX.Element {
  const [scan, setScan] = useState<DependencyScan | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  /** Per dependency, the candidates found for it. */
  const [found, setFound] = useState<Record<string, DependencyCandidate[]>>({})
  const [installing, setInstalling] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})

  const load = useCallback(async () => {
    try {
      const res = await api.deps.scan()
      setScan(res)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, dir])

  async function search(pkg: string, name?: string): Promise<void> {
    setBusy(pkg)
    try {
      const res = await api.deps.find({ package: pkg, name })
      setFound((f) => ({ ...f, [pkg]: res.candidates }))
      if (!res.ok) onToast(res.error ?? 'Could not reach Modrinth', 'err')
      else if (!res.candidates.length) onToast(`Nothing found for ${name ?? pkg} on ${res.mcVersion}`, 'err')
    } finally {
      setBusy(null)
    }
  }

  async function install(pkg: string, c: DependencyCandidate & { file?: { url: string; name: string; versionNumber?: string } }): Promise<void> {
    if (!c.file) {
      onToast('That candidate has no build for this version — open its page instead.', 'err')
      return
    }
    setInstalling(pkg)
    try {
      const res = await api.deps.install({ url: c.file.url, name: c.file.name })
      if (!res.ok) {
        onToast(res.error ?? 'Install failed', 'err')
        return
      }
      onToast(`Added ${c.file.name}${res.added ? ' and declared it in the build file' : ' (already declared)'}`)
      await load()
    } finally {
      setInstalling(null)
    }
  }

  const deps = scan?.dependencies ?? []
  const gameProblem = (scan?.gameClassErrors ?? []).length > 0

  return (
    <div>
      <p className="muted small">
        Mods and libraries the sources import that are not part of Minecraft. A port copies code but not the build
        files that declared what it compiles against, so these have to be added by name. A jar in <code>libs/</code> is
        not enough on its own — the build file has to mention it, and this adds both.
      </p>

      {error && <p className="warn">{error}</p>}

      {gameProblem && (
        <div className="card">
          <b className="warn">Minecraft itself is not resolving</b>
          <p className="muted small" style={{ marginTop: 4 }}>
            The build reported missing Minecraft classes
            {scan?.gameClassErrors.length ? ` (${scan.gameClassErrors.slice(0, 2).join(', ')})` : ''}. That is not a
            dependency you can download — the loader version in <code>gradle.properties</code> is empty or wrong for
            this Minecraft version, so gradle never puts the game on the classpath. Fix that first; the list below is
            separate.
          </p>
        </div>
      )}

      {scan && deps.length === 0 && !gameProblem && (
        <p className="muted small">
          Nothing outside Minecraft found in {scan.filesScanned} source file{scan.filesScanned === 1 ? '' : 's'}.
        </p>
      )}

      {deps.map((d) => {
        const candidates = found[d.package]
        return (
          <div key={d.package} className="card">
            <div className="row wrap">
              <b>{d.name ?? d.package}</b>
              <span className="chip">{KIND_LABEL[d.kind] ?? d.kind}</span>
              {d.files > 0 ? <span className="chip">{d.files} file{d.files === 1 ? '' : 's'}</span> : null}
              {d.declared?.length ? <span className="chip">was {d.declared.join(', ')}</span> : null}
            </div>
            <p className="muted small" style={{ marginTop: 4 }}>
              <code>{d.package}</code>
            </p>
            {d.note && <p className="muted small">{d.note}</p>}

            <div className="row wrap" style={{ marginTop: 6 }}>
              <button className="small" disabled={busy === d.package} onClick={() => void search(d.package, d.name)}>
                {busy === d.package ? 'Searching…' : 'Find a download'}
              </button>
              {d.homepage && (
                <button className="small ghost" onClick={() => void api.shell.openPath(d.homepage ?? '')}>
                  Project page
                </button>
              )}
              <button className="small ghost" onClick={() => setRevealed((r) => ({ ...r, [d.package]: !r[d.package] }))}>
                {revealed[d.package] ? 'Hide' : 'What is this?'}
              </button>
            </div>

            {revealed[d.package] && (
              <p className="muted small" style={{ marginTop: 6 }}>
                Group <code>{d.package}</code> was {d.files > 0 ? `imported by ${d.files} source file(s)` : 'declared in the old build file'}.
                You will need a build of it for Minecraft {scan?.mcVersion ?? 'this version'} on {scan?.loader ?? 'this loader'}.
                If the dependency supports a range of versions, the newest build that lists your version is the one to take.
              </p>
            )}

            {candidates && candidates.length > 0 && (
              <div style={{ marginTop: 8 }}>
                {candidates.map((c) => {
                  const withFile = c as typeof c & { file?: { name: string; versionNumber?: string }; missing?: string }
                  return (
                    <div key={c.projectId ?? c.name} className="row wrap" style={{ marginBottom: 6 }}>
                      <span style={{ minWidth: 0 }}>
                        <b>{c.name}</b>
                        {withFile.file ? (
                          <span className="muted small"> · {withFile.file.versionNumber ?? withFile.file.name}</span>
                        ) : (
                          <span className="warn small"> · {withFile.missing ?? 'no file'}</span>
                        )}
                      </span>
                      <button
                        className="small primary"
                        disabled={!withFile.file || installing === d.package}
                        onClick={() => void install(d.package, c)}
                      >
                        {installing === d.package ? 'Adding…' : 'Download & declare'}
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}

      <button className="small ghost" onClick={() => void load()}>
        Rescan the project
      </button>
    </div>
  )
}
