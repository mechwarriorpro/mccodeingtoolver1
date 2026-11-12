import { useCallback, useEffect, useState } from 'react'
import { api, type ForkInfo, type Loader } from '../lib/api'

interface Props {
  onToast: (text: string, kind?: 'ok' | 'err') => void
}

/**
 * Editable copies of decompiled reference mods.
 *
 * A reference mod is read-only context. A fork is the same sources as a real
 * Gradle project in its own folder, so an idea that starts as "how does this mod
 * do X?" can end as working code without the user rebuilding a project from
 * scratch — and without the decompiled code ever landing in their own mod.
 */
export default function ForkPanel({ onToast }: Props): JSX.Element {
  const [forks, setForks] = useState<ForkInfo[]>([])
  const [open, setOpen] = useState<ForkInfo | null>(null)
  const [files, setFiles] = useState<{ path: string; dir: boolean }[]>([])
  const [editing, setEditing] = useState<{ path: string; text: string; dirty: boolean } | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setForks(await api.forks.list())
  }, [])

  useEffect(() => {
    void refresh()
    return api.events.onForkListChanged(() => void refresh())
  }, [refresh])

  async function openFork(f: ForkInfo): Promise<void> {
    setOpen(f)
    setEditing(null)
    setFiles(await api.forks.tree(f.id))
  }

  async function openFile(rel: string): Promise<void> {
    if (!open) return
    const res = await api.forks.readFile({ id: open.id, path: rel })
    if (!res.ok) {
      onToast(res.error ?? 'Could not read that file', 'err')
      return
    }
    setEditing({ path: rel, text: res.text ?? '', dirty: false })
  }

  async function save(): Promise<void> {
    if (!open || !editing) return
    setBusy(true)
    try {
      const res = await api.forks.writeFile({ id: open.id, path: editing.path, text: editing.text })
      if (!res.ok) {
        onToast(res.error ?? 'Could not save', 'err')
        return
      }
      setEditing({ ...editing, dirty: false })
      onToast('Saved to the fork')
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  async function remove(f: ForkInfo): Promise<void> {
    const res = await api.forks.remove(f.id)
    setForks(res)
    if (open?.id === f.id) {
      setOpen(null)
      setEditing(null)
    }
    onToast(`Removed the fork of ${f.title}`)
  }

  if (open) {
    return (
      <div className="forks">
        <div className="row" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
          <button className="small" onClick={() => { setOpen(null); setEditing(null) }}>
            ← All forks
          </button>
          <button className="small ghost" onClick={() => void api.shell.openPath(open.dir)}>
            Open folder
          </button>
          <span className="dim small" style={{ marginLeft: 'auto' }}>
            {loaderLabel(open.loader)} {open.mcVersion} · {open.files} java files
            {open.license ? ` · ${open.license}` : ''}
          </span>
        </div>
        {open.license && /arr|all rights/i.test(open.license) ? (
          <div className="hint warn" style={{ marginBottom: 10 }}>
            Upstream declares {open.license}. You can edit and run this locally; publishing a modified build may not be allowed.
          </div>
        ) : null}

        <div className="fork-split">
          <div className="fork-tree">
            {files.map((f) => (
              <button
                key={f.path}
                className={`fork-file${editing?.path === f.path ? ' on' : ''}${f.dir ? ' dir' : ''}`}
                onClick={() => {
                  if (!f.dir) void openFile(f.path)
                }}
                title={f.path}
              >
                {f.path.split('/').pop()}
              </button>
            ))}
          </div>
          <div className="fork-editor">
            {editing ? (
              <>
                <div className="row" style={{ marginBottom: 6 }}>
                  <span className="dim small" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {editing.path}
                  </span>
                  <button className="small primary" disabled={busy || !editing.dirty} onClick={() => void save()}>
                    {busy ? 'Saving…' : editing.dirty ? 'Save' : 'Saved'}
                  </button>
                </div>
                <textarea
                  className="fork-text"
                  spellCheck={false}
                  value={editing.text}
                  onChange={(e) => setEditing({ ...editing, text: e.target.value, dirty: true })}
                />
              </>
            ) : (
              <div className="dim small" style={{ padding: 16 }}>
                Pick a java file to read or edit. Changes are saved into the fork only — your project and the
                cached decompiled sources are untouched.
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="forks">
      <div className="hint" style={{ marginBottom: 12 }}>
        A <strong>fork</strong> turns a decompiled reference mod into a real Gradle project you can build, edit and run.
        It lives in its own folder and is never compiled into your mod. Create one from the References tab with
        “Make editable copy”.
      </div>

      {forks.length === 0 ? (
        <div className="dim" style={{ padding: 10, fontSize: 12.5 }}>
          No forks yet. Decompile a mod in References, then choose “Make editable copy”.
        </div>
      ) : null}

      {forks.map((f) => (
        <div className="ref-row" key={f.id}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="ref-title">
              {f.title}{' '}
              {f.dirty ? <span className="badge" style={{ marginLeft: 6 }}>edited</span> : null}
              {f.repo ? (
                <button className="linklike dim small" style={{ marginLeft: 6 }} onClick={() => void api.shell.openPath(f.dir)}>
                  {f.repo}
                </button>
              ) : null}
            </div>
            <div className="dim small">
              {loaderLabel(f.loader)} {f.mcVersion} · {f.files} java files
              {f.packages[0] ? ` · ${f.packages[0]}` : ''}
              {f.license ? ` · ${f.license}` : ''}
            </div>
          </div>
          <div className="row">
            <button className="small" onClick={() => void openFork(f)}>
              Browse sources
            </button>
            <button className="small ghost" onClick={() => void api.shell.openPath(f.dir)}>
              Open folder
            </button>
            <button className="small ghost" onClick={() => void remove(f)} title="Remove the fork from this app (deletes its folder)">
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

function loaderLabel(loader: Loader): string {
  return loader === 'neoforge' ? 'NeoForge' : loader === 'fabric' ? 'Fabric' : 'Forge'
}
