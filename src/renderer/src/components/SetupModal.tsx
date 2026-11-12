import { useState } from 'react'
import { api } from '../lib/api'

interface Props {
  onClose: () => void
  onCreated: (dir: string) => void
  onToast: (text: string, kind?: 'ok' | 'err') => void
}

const NEO_VERSIONS = ['21.1.265', '21.1.209', '21.1.193', '21.1.171', '21.1.133']
const MC_VERSION = '1.21.1'

export default function SetupModal({ onClose, onCreated, onToast }: Props): JSX.Element {
  const [parent, setParent] = useState('')
  const [modId, setModId] = useState('')
  const [modName, setModName] = useState('')
  const [group, setGroup] = useState('')
  const [author, setAuthor] = useState('')
  const [version, setVersion] = useState('1.0.0')
  const [neo, setNeo] = useState(NEO_VERSIONS[0])
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<{ modId?: string | null; group?: string | null; other?: string }>({})

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
    let parentDir = parent
    if (!parentDir) {
      const picked = await api.dialog.pickFolder({ title: 'Where should the mod project live?' })
      if (!picked) return
      parentDir = picked
      setParent(picked)
    }
    setBusy(true)
    try {
      const res = await api.project.scaffold({ parentDir, modId, modName: modName || modId, group, modVersion: version, author, neoVersion: neo })
      if (!res.ok) {
        setErrors({ other: res.error })
        return
      }
      onToast('Project created')
      onCreated(res.dir)
      onClose()
    } catch (e) {
      setErrors({ other: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal">
      <div className="box">
        <h2>New NeoForge mod</h2>
        <div className="sub">
          Uses the official NeoForge 1.21.1 ModDevGradle template (Java 21, Gradle wrapper, GitHub Actions build).
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

        <div className="two-col">
          <div className="field">
            <label>Minecraft</label>
            <input value={MC_VERSION} disabled />
          </div>
          <div className="field">
            <label>NeoForge</label>
            <select value={neo} onChange={(e) => setNeo(e.target.value)}>
              {NEO_VERSIONS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
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
          <button className="primary" disabled={busy || !modId || !group} onClick={() => void create()}>
            {busy ? 'Creating…' : 'Create project'}
          </button>
        </div>
      </div>
    </div>
  )
}
