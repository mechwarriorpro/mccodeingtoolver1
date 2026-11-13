import { useEffect, useMemo, useState } from 'react'
import { api, type DetectedProject, type Loader, type PortPlan } from '../lib/api'

interface Props {
  onToast: (text: string, kind?: 'ok' | 'err') => void
  /** Make the ported project the active one, so the agent can carry on with it. */
  onEditProject: (dir: string) => void
  /** The project the agent is working on right now, offered as an input. */
  activeDir?: string
}

const LOADERS: { id: Loader; label: string }[] = [
  { id: 'neoforge', label: 'NeoForge' },
  { id: 'forge', label: 'Forge' },
  { id: 'fabric', label: 'Fabric' }
]

/** A folder path without assuming which separator the OS uses. */
function joinPath(parent: string, name: string): string {
  const sep = parent.includes('\\') && !parent.includes('/') ? '\\' : '/'
  return parent.replace(/[\\/]+$/, '') + sep + name
}

function loaderLabel(l: string): string {
  return LOADERS.find((x) => x.id === l)?.label ?? l
}

/**
 * Move an existing project to another Minecraft version, another loader, or both.
 *
 * The distinction that matters: nothing here rewrites your code. It reads what
 * the project actually is, generates a correct project for the target, carries
 * the sources and assets across, and writes down precisely which API changes are
 * left. The old folder is never modified — a half-ported mod is the one thing you
 * do not want to be holding the only copy of.
 */
export default function PortPanel({ onToast, onEditProject, activeDir }: Props): JSX.Element {
  const [sourceDir, setSourceDir] = useState('')
  const [project, setProject] = useState<DetectedProject | null>(null)
  const [detectError, setDetectError] = useState('')

  const [mcVersions, setMcVersions] = useState<{ id: string; loaders: Loader[] }[]>([])
  const [mc, setMc] = useState('1.21.1')
  const [loader, setLoader] = useState<Loader>('neoforge')

  const [plan, setPlan] = useState<PortPlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{
    dir: string
    reportPath?: string
    copiedSources: number
    copiedResources: number
    /** What the sources still need; the port copies code, not build files. */
    dependencies?: { package: string; name?: string; kind: string; files: number; declared?: string[] }[]
  } | null>(null)

  /* every project that can be an input: forks of examples, and the active one */
  const [candidates, setCandidates] = useState<{ dir: string; label: string }[]>([])

  useEffect(() => {
    void (async () => {
      const res = await api.versions.catalog({})
      setMcVersions((res.versions ?? []).filter((v) => v.loaders.length))
      const forks = await api.forks.list()
      setCandidates(
        forks.map((f) => ({
          dir: f.dir,
          label: `${f.title} · ${loaderLabel(f.loader)} ${f.mcVersion}`
        }))
      )
    })()
  }, [])

  /* The version list decides which loaders make sense. */
  useEffect(() => {
    const entry = mcVersions.find((v) => v.id === mc)
    if (entry && entry.loaders.length && !entry.loaders.includes(loader)) {
      setLoader(entry.loaders[0])
    }
  }, [mc, mcVersions, loader])

  async function detect(dir: string): Promise<void> {
    setSourceDir(dir)
    setPlan(null)
    setResult(null)
    setDetectError('')
    setProject(null)
    if (!dir) return
    const res = await api.port.detect(dir)
    if (!res.ok || !res.project) {
      setDetectError(res.error ?? 'That folder could not be read as a mod project.')
      return
    }
    setProject(res.project)
  }

  async function pick(): Promise<void> {
    const dir = await api.dialog.pickFolder({ title: 'Pick the mod project to update' })
    if (dir) await detect(dir)
  }

  async function makePlan(): Promise<void> {
    if (!project) return
    setBusy(true)
    try {
      const res = await api.port.plan({ dir: sourceDir, loader, mcVersion: mc })
      if (!res.ok || !res.plan) {
        onToast(res.error ?? 'Could not work out a plan', 'err')
        return
      }
      setPlan(res.plan)
    } finally {
      setBusy(false)
    }
  }

  async function convert(): Promise<void> {
    if (!project) return
    const parent = await api.dialog.pickFolder({ title: 'Where should the updated project go?' })
    if (!parent) return
    const name = `${project.modId ?? 'mod'}-${mc}-${loader}`
    setBusy(true)
    try {
      const res = await api.port.convert({
        sourceDir,
        targetDir: joinPath(parent, name),
        loader,
        mcVersion: mc,
        backup: true
      })
      if (!res.ok) {
        onToast(res.error ?? 'The conversion failed', 'err')
        return
      }
      setResult({
        dir: res.dir ?? '',
        reportPath: res.reportPath,
        copiedSources: res.copiedSources ?? 0,
        copiedResources: res.copiedResources ?? 0,
        dependencies: res.dependencies
      })
      setPlan(res.plan ?? plan)
      onToast(`Created ${name}`)
    } finally {
      setBusy(false)
    }
  }

  const summaryLine = useMemo(() => {
    if (!project) return ''
    const bits = [loaderLabel(project.loader), project.mcVersion ?? 'unknown version']
    if (project.modId) bits.push(project.modId)
    return bits.join(' · ')
  }, [project])

  const blockers = plan?.blockers ?? []
  const apiSteps = (plan?.manual ?? []).filter((m) => m.kind === 'api')

  return (
    <div className="port">
      <p className="hint">
        Takes a finished mod — an old release, a fork of an example, or the project you are working on — and builds it for a
        different Minecraft version, a different loader, or both.
      </p>

      {activeDir && (
        <button className={sourceDir === activeDir ? 'on' : ''} onClick={() => void detect(activeDir)}>
          Use the project you are working on
        </button>
      )}

      <label className="field">
        <span>Project to update</span>
        <div className="row">
          <input
            value={sourceDir}
            placeholder="No folder chosen"
            onChange={(e) => void detect(e.target.value)}
            spellCheck={false}
          />
          <button onClick={() => void pick()}>Browse…</button>
        </div>
      </label>

      {candidates.length > 0 && (
        <label className="field">
          <span>…or one of your forks</span>
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) void detect(e.target.value)
            }}
          >
            <option value="">Choose a fork</option>
            {candidates.map((c) => (
              <option key={c.dir} value={c.dir}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {detectError && <div className="hint warn">{detectError}</div>}

      {project && (
        <div className="card">
          <h4>Detected</h4>
          <div className="kv">
            <span>Loader</span>
            <b>{project.loader === 'unknown' ? 'not recognised' : loaderLabel(project.loader)}</b>
            <span>Minecraft</span>
            <b>{project.mcVersion ?? 'not declared'}</b>
            <span>Layout</span>
            <b>{project.layout}</b>
            <span>Sources</span>
            <b>
              <code>{project.sourceRoot}</code>
            </b>
            <span>Mod id</span>
            <b>{project.modId ?? '—'}</b>
          </div>
          <p className="hint">
            Read from {summaryLine ? 'the build files' : 'the project'}, not from the folder name — old mods are usually
            named after the version they were built for.
          </p>
          {project.midUpgrade && (
            <div className="hint warn">
              This project is already part way through an upgrade: the sources ask for Java {project.declaredJava} but
              gradle.properties declares {project.mcVersion}, which needs Java {project.expectedJava}. The port starts
              from the declared version and copies the sources as they are, so some of the work may already be done.
            </div>
          )}
          {project.legacyFiles.length > 0 && (
            <p className="hint">
              Left behind on the way out: {project.legacyFiles.join(', ')} — the new loader cannot read them, and the new
              project gets its own metadata.
            </p>
          )}
        </div>
      )}

      <div className="card">
        <h4>Target</h4>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <label className="field">
            <span>Minecraft version</span>
            <select value={mc} onChange={(e) => setMc(e.target.value)}>
              {mcVersions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.id}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Loader</span>
            <select value={loader} onChange={(e) => setLoader(e.target.value as Loader)}>
              {(mcVersions.find((v) => v.id === mc)?.loaders ?? ['neoforge', 'forge', 'fabric']).map((l) => (
                <option key={l} value={l}>
                  {loaderLabel(l)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button disabled={!project || busy} onClick={() => void makePlan()}>
          {busy ? 'Working…' : 'Show what this involves'}
        </button>
      </div>

      {plan && (
        <div className="card">
          <h4>{plan.alreadyTarget ? 'Already there' : 'Plan'}</h4>
          <p>{plan.summary}</p>

          {blockers.length > 0 && (
            <div className="hint warn">
              {blockers.map((b) => (
                <div key={b}>{b}</div>
              ))}
            </div>
          )}

          {!plan.alreadyTarget && blockers.length === 0 && (
            <>
              <h4 style={{ marginTop: 12 }}>Done for you</h4>
              <ul>
                {plan.automatic.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>

              {plan.manual.length > 0 && (
                <>
                  <h4 style={{ marginTop: 12 }}>Needs real edits</h4>
                  {apiSteps.length > 0 && (
                    <p className="hint">
                      {apiSteps.length} API-level {apiSteps.length === 1 ? 'change' : 'changes'} cannot be done by
                      search-and-replace. The new project will compile-fail until they are worked through; ask the agent
                      to &quot;work through MIGRATION.md&quot; and it will do them in dependency order.
                    </p>
                  )}
                  <ul>
                    {plan.manual.map((m) => (
                      <li key={m.title}>
                        <b>{m.title}</b> <span className="hint">({m.kind})</span>
                        <div className="hint">{m.detail}</div>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              <button disabled={busy} onClick={() => void convert()}>
                {busy ? 'Converting…' : 'Create the updated project'}
              </button>
              <p className="hint">
                The original folder is not touched. A <code>backup-…</code> copy is written inside it first, and the new
                project goes in a folder of its own.
              </p>
            </>
          )}
        </div>
      )}

      {result && (
        <div className="card">
          <h4>Done</h4>
          <p>
            {result.copiedSources} Java {result.copiedSources === 1 ? 'file' : 'files'} and {result.copiedResources}{' '}
            resource {result.copiedResources === 1 ? 'file' : 'files'} carried across.
          </p>
          <p className="hint">
            <code>{result.dir}</code>
          </p>
          {result.reportPath && (
            <p className="hint">
              The list of what is left is in <code>MIGRATION.md</code>.
            </p>
          )}
          {result.dependencies && result.dependencies.length > 0 && (
            <div className="card">
              <b>Dependencies this port did not carry ({result.dependencies.length})</b>
              <p className="muted small" style={{ marginTop: 4 }}>
                The sources import these, but the old build files that declared them are not part of a port — so the
                new project will not compile until they are added back. The Build tab has a Dependencies panel that
                finds and declares them.
              </p>
              <ul className="files">
                {result.dependencies.map((d) => (
                  <li key={d.package}>
                    <b>{d.name ?? d.package}</b>{' '}
                    <span className="muted small">
                      <code>{d.package}</code>
                      {d.files ? ` · ${d.files} file${d.files === 1 ? '' : 's'}` : ''}
                      {d.declared?.length ? ` · was ${d.declared.join(', ')}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="row">
            <button
              onClick={() => {
                onEditProject(result.dir)
                onToast('Switched to the updated project')
              }}
            >
              Work on it
            </button>
            <button onClick={() => void api.shell.openPath(result.dir)}>Open folder</button>
          </div>
        </div>
      )}
    </div>
  )
}
