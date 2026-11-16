import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type KnownProject } from '../lib/api'

interface Props {
  /** The project currently on screen, so the list can mark it. */
  activeDir?: string
  /** Open a project. */
  onOpen: (dir: string) => void | Promise<void>
  /** Create a new one — the same flow as "New mod", reachable from here. */
  onNew: () => void
  onToast: (text: string, kind?: 'ok' | 'err') => void
}

/**
 * Every project this app knows about, in one list.
 *
 * "Switch" used to be a folder picker: to change project you had to already know
 * its path, and a fork that lived under the app's own data folder was impossible
 * to find again. This lists what exists instead of asking you to remember it.
 *
 * Two sources, and the distinction is visible on purpose:
 *
 *   - *opened* — projects this app has opened or created. A fork lives under the
 *     app's data folder and nothing else would ever find it.
 *   - *found* — projects discovered by looking in the folder the others live in.
 *     A fresh install pointed at an existing projects folder gets the whole list
 *     on first open, rather than needing each one opened by hand.
 *
 * A project whose folder has gone is still listed, greyed, with `missing`. A
 * name that silently disappears from a list reads as data loss, and the fix —
 * reopening it, or deleting the entry — should be the user's decision.
 */
export default function ProjectPicker({ activeDir, onOpen, onNew, onToast }: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const [projects, setProjects] = useState<KnownProject[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.project.list()
      if (!res.ok) {
        setError('Could not read the project list.')
        return
      }
      setProjects(res.projects)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  // Loaded when the menu opens, not on mount: the list is cheap but it touches
  // the disk, and a sidebar that reads directories on every render is a sidebar
  // that stutters. Opening the menu is the moment the answer is needed.
  useEffect(() => {
    if (!open) return
    void refresh()
    // Focus the filter so a long list can be narrowed by typing immediately.
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [open, refresh])

  // Close on a click outside, and on Escape — a menu that traps the pointer is
  // worse than no menu.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const shown = filter.trim()
    ? projects.filter((p) => {
        const q = filter.trim().toLowerCase()
        return (
          p.name.toLowerCase().includes(q) ||
          p.dir.toLowerCase().includes(q) ||
          (p.modId ?? '').toLowerCase().includes(q)
        )
      })
    : projects

  const openProject = async (p: KnownProject): Promise<void> => {
    if (!p.exists) {
      onToast(`That folder is gone: ${p.dir}`, 'err')
      return
    }
    setOpen(false)
    await onOpen(p.dir)
  }

  const current = projects.find((p) => p.active)

  return (
    <div className="projpick" ref={boxRef}>
      <button
        className="small projpick-toggle"
        onClick={() => setOpen((o) => !o)}
        title="Switch to another project, or create one"
        aria-expanded={open}
      >
        <span className="projpick-label">{current?.name ?? 'Projects'}</span>
        <span className="projpick-caret">{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div className="projpick-menu">
          <input
            ref={inputRef}
            className="projpick-filter"
            placeholder="Filter by name, mod id or path…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />

          <div className="projpick-list">
            {loading && <div className="projpick-empty">Reading your projects…</div>}
            {!loading && error && <div className="projpick-empty bad">{error}</div>}
            {!loading && !error && shown.length === 0 && (
              <div className="projpick-empty">
                {projects.length === 0
                  ? 'No projects yet. Create one below.'
                  : `Nothing matches “${filter}”.`}
              </div>
            )}
            {shown.map((p) => (
              <button
                key={p.dir}
                className={`projpick-item ${p.active ? 'on' : ''} ${p.exists ? '' : 'gone'}`}
                onClick={() => void openProject(p)}
                title={p.exists ? p.dir : `${p.dir} — this folder no longer exists`}
                disabled={!p.exists}
              >
                <span className="projpick-name">
                  {p.name}
                  {p.active && <span className="projpick-tag">open</span>}
                  {!p.exists && <span className="projpick-tag bad">missing</span>}
                </span>
                <span className="projpick-meta">
                  {[p.modId, p.mcVersion ? `MC ${p.mcVersion}` : '', p.loader ?? ''].filter(Boolean).join(' · ') ||
                    p.dir}
                </span>
                <span className="projpick-src">{p.source === 'scanned' ? 'found' : 'opened'}</span>
              </button>
            ))}
          </div>

          <div className="projpick-actions">
            <button className="small primary" onClick={() => { setOpen(false); onNew() }}>
              + New project
            </button>
            <button
              className="small ghost"
              onClick={async () => {
                const dir = await api.dialog.pickFolder({ title: 'Open an existing mod project' })
                if (!dir) return
                setOpen(false)
                await onOpen(dir)
              }}
            >
              Browse…
            </button>
            <button className="small ghost" onClick={() => void refresh()} title="Look for projects again">
              Rescan
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
