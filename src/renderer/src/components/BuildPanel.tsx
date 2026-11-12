import { useState } from 'react'
import type { AppConfig } from '../../../shared/types'
import type { ProjectSummary } from '../lib/api'
import { api } from '../lib/api'

interface Props {
  project: ProjectSummary | null
  config: (AppConfig & { apiKeySet: boolean }) | null
  onRefreshProject: () => void
  onOpenImage: (path: string) => void
  onToast: (text: string, kind?: 'ok' | 'err') => void
}

export default function BuildPanel({ project, config, onRefreshProject, onOpenImage, onToast }: Props): JSX.Element {
  const [busy, setBusy] = useState<string | null>(null)
  const [result, setResult] = useState<{ ok: boolean; jarPath?: string; errors: string[]; logPath: string; seconds?: number } | null>(null)
  const [openFile, setOpenFile] = useState<{ path: string; text: string } | null>(null)

  async function build(mode: 'local' | 'actions'): Promise<void> {
    setBusy(mode)
    setResult(null)
    const started = Date.now()
    try {
      const res = mode === 'local' ? await api.build.local({ task: 'build' }) : await api.build.actions()
      setResult({ ok: res.ok, jarPath: res.jarPath, errors: res.errors, logPath: res.logPath, seconds: Math.round((Date.now() - started) / 1000) })
      onToast(res.ok ? `Build succeeded (${Math.round((Date.now() - started) / 1000)}s)` : 'Build failed — see errors', res.ok ? 'ok' : 'err')
      onRefreshProject()
    } catch (e) {
      onToast((e as Error).message, 'err')
    } finally {
      setBusy(null)
    }
  }

  const props = project?.props ?? {}
  const dirty = project?.git?.dirty ?? []

  return (
    <div>
      <div className="card">
        <h4>Mod project</h4>
        {project?.open ? (
          <div className="kv">
            <div className="k">Mod</div>
            <div className="v">
              {props.mod_name ?? '?'} <span className="badge">{props.mod_id}</span>
            </div>
            <div className="k">Version</div>
            <div className="v">{props.mod_version}</div>
            <div className="k">Minecraft</div>
            <div className="v">{props.minecraft_version}</div>
            <div className="k">NeoForge</div>
            <div className="v">{props.neo_version}</div>
            <div className="k">Java</div>
            <div className="v">21 (toolchain)</div>
            <div className="k">Git</div>
            <div className="v">
              {project.git?.branch ?? 'no repo'} {dirty.length ? <span className="badge amber">{dirty.length} changed</span> : <span className="badge green">clean</span>}
            </div>
            <div className="k">Latest jar</div>
            <div className="v">{project.latestJar ? `${project.latestJar.name}` : 'none yet'}</div>
          </div>
        ) : (
          <div style={{ color: 'var(--dim)', fontSize: 12.5 }}>No project open. Create one from the sidebar.</div>
        )}
      </div>

      <div className="card">
        <h4>Build</h4>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button className="primary small" disabled={!!busy || !project?.open} onClick={() => void build('local')}>
            {busy === 'local' ? 'Building…' : 'Build locally'}
          </button>
          <button className="small" disabled={!!busy || !project?.open} onClick={() => void build('actions')}>
            {busy === 'actions' ? 'Running Actions…' : 'Build on GitHub'}
          </button>
        </div>
        <div className="field" style={{ marginTop: 10, marginBottom: 0 }}>
          <div className="hint">
            Local build runs <code>./gradlew build</code> with your JDK 21. GitHub build commits, pushes, runs the workflow and downloads the jar artifact.
          </div>
        </div>
        {result && (
          <div style={{ marginTop: 10 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, marginBottom: 6 }}>
              <span className={`badge ${result.ok ? 'green' : 'red'}`}>{result.ok ? 'success' : 'failed'}</span>
              <span style={{ color: 'var(--dim)' }}>{result.seconds}s</span>
              <button className="small ghost" style={{ marginLeft: 'auto' }} onClick={() => void api.build.openLog(result.logPath)}>
                Open log
              </button>
            </div>
            {result.jarPath && (
              <div style={{ fontSize: 12, color: 'var(--muted)', wordBreak: 'break-all', marginBottom: 6 }}>
                jar: {result.jarPath}
                <button
                  className="small ghost"
                  style={{ marginLeft: 6 }}
                  onClick={() =>
                    void api.game.installJar(result.jarPath).then((r) => onToast(r.ok ? 'Installed into instance' : r.error ?? 'failed', r.ok ? 'ok' : 'err'))
                  }
                >
                  Install
                </button>
              </div>
            )}
            {result.errors.slice(0, 12).map((e, i) => (
              <div key={i} style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--red)', marginBottom: 3, wordBreak: 'break-word' }}>
                {e}
              </div>
            ))}
          </div>
        )}
      </div>

      {project?.open && (
        <div className="card">
          <h4>
            Files
            <button className="small ghost" style={{ marginLeft: 'auto' }} onClick={onRefreshProject}>
              Refresh
            </button>
          </h4>
          <div className="file-tree" style={{ maxHeight: 260, overflowY: 'auto' }}>
            {(project.files ?? [])
              .filter((f) => !f.dir)
              .slice(0, 140)
              .map((f) => (
                <div
                  key={f.path}
                  className="row"
                  onClick={() =>
                    void api.project.readFile(f.path).then((r) => {
                      if (r.ok) setOpenFile({ path: f.path, text: r.text ?? '' })
                      else onToast(r.error ?? 'could not read file', 'err')
                    })
                  }
                >
                  {f.path}
                </div>
              ))}
          </div>
        </div>
      )}

      <div className="card">
        <h4>GitHub</h4>
        <div className="kv">
          <div className="k">Repo</div>
          <div className="v">{config?.github.owner ? `${config.github.owner}/${config.github.repo}` : 'not set'}</div>
          <div className="k">Branch</div>
          <div className="v">{config?.github.branch || 'main'}</div>
        </div>
        <button
          className="small ghost"
          style={{ marginTop: 8 }}
          onClick={() =>
            void api.build
              .preflight()
              .then((r) => onToast(r.messages.length ? r.messages.join(' · ') : 'GitHub CLI ready', r.ghFound && r.authed && r.repoOk ? 'ok' : 'err'))
          }
        >
          Test connection
        </button>
      </div>

      {openFile && (
        <div className="modal" onClick={() => setOpenFile(null)}>
          <div className="box" onClick={(e) => e.stopPropagation()} style={{ width: 900 }}>
            <h2 style={{ fontFamily: 'var(--mono)', fontSize: 14 }}>{openFile.path}</h2>
            <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, fontFamily: 'var(--mono)', maxHeight: '65vh', overflow: 'auto' }}>{openFile.text}</pre>
            <div className="actions">
              <button onClick={() => void navigator.clipboard.writeText(openFile.text)}>Copy</button>
              <button onClick={() => setOpenFile(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
