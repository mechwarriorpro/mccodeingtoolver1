import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  api,
  type BundleDef,
  type BundleProgress,
  type InstallProgress,
  type LocalInfo,
  type LocalModelDef,
  type LocalRoleDef,
  type PullProgress
} from '../lib/api'

/**
 * Local models: install Ollama, download a bundle, then say which model fills
 * each use case.
 *
 * The ordering is deliberate. A role picker is meaningless before models exist,
 * and a 20 GB download is hostile without knowing where it lands first — so the
 * page reads top to bottom as install → choose what to download → assign roles.
 */

const ROLE_ORDER: LocalRoleDef['id'][] = ['agent', 'vision', 'quick']

export default function LocalModelsPanel({ onToast }: { onToast: (m: string, kind?: 'ok' | 'err') => void }): JSX.Element {
  const [info, setInfo] = useState<LocalInfo | null>(null)
  const [install, setInstall] = useState<InstallProgress | null>(null)
  const [pulling, setPulling] = useState<Record<string, PullProgress>>({})
  const [bundle, setBundle] = useState<BundleProgress | null>(null)
  const [busy, setBusy] = useState(false)
  const [modelsDir, setModelsDir] = useState('')
  const [roles, setRoles] = useState<Record<string, string[]>>({ agent: [], vision: [], quick: [] })
  const [error, setError] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    const next = await api.local.info()
    setInfo(next)
    setModelsDir(next.modelsDir)
    // Spread first, defaults second, so a partial config still fills every role.
    setRoles({ ...{ agent: [], vision: [], quick: [] }, ...next.roles })
  }, [])

  useEffect(() => {
    void refresh()
    const offs = [
      api.local.onInstallProgress((p) => {
        setInstall(p)
        if (p.phase === 'done' || p.phase === 'error') setBusy(false)
        if (p.phase === 'done') void refresh()
      }),
      api.local.onPullProgress((p) => {
        setPulling((cur) => ({ ...cur, [p.model]: p }))
        if (p.done && !p.error) void refresh()
      }),
      api.local.onBundleProgress((p) => setBundle(p.state === 'done' || p.state === 'error' ? null : p))
    ]
    return () => offs.forEach((off) => off())
  }, [refresh])

  const installedIds = useMemo(() => new Set((info?.installedModels ?? []).map((m) => m.id)), [info])
  const has = (id: string): boolean =>
    installedIds.has(id) || installedIds.has(`${id}:latest`) || installedIds.has(id.replace(/:latest$/, ''))
  const needed = useMemo(() => [...new Set(Object.values(roles).flat())], [roles])
  const neededGb = needed.reduce((sum, id) => sum + (info?.models.find((m) => m.id === id)?.sizeGb ?? 0), 0)

  const setRoleModel = (role: string, modelId: string): void => {
    // One model may fill several roles: that is a supported choice, not a
    // mistake, and downloads are de-duplicated below.
    setRoles((cur) => ({ ...cur, [role]: [modelId] }))
  }

  if (!info) return <div className="hint">Checking for Ollama…</div>

  const status = !info.installed
    ? { text: 'Not installed', tone: 'red' as const }
    : !info.running
      ? { text: 'Installed, not running', tone: 'amber' as const }
      : !info.anthropicCompatible
        ? { text: 'Too old for the agent API', tone: 'red' as const }
        : { text: `Running${info.version ? ` · v${info.version}` : ''}`, tone: 'green' as const }

  return (
    <div className="local-panel">
      <div className="local-head">
        <div>
          <h4 style={{ margin: 0 }}>Local models (Ollama)</h4>
          <div className="hint" style={{ margin: '4px 0 0' }}>
            Runs on this machine: free, private, and offline once the models are downloaded.
          </div>
        </div>
        <span className={`badge ${status.tone}`}>{status.text}</span>
      </div>

      {error ? <div className="local-error">{error}</div> : null}

      {/* 1 — install ------------------------------------------------------- */}
      {!info.installed ? (
        <div className="local-step">
          <div className="local-step-title">
            <span className="step-num">1</span> Install Ollama
          </div>
          <div className="hint">
            {info.bundledInstaller
              ? 'The installer is already included in this app, so this works offline. It installs silently — you will not see a window.'
              : 'The installer is about a gigabyte and downloads from GitHub. It installs silently — you will not see a window. The models themselves come next and are much larger.'}
          </div>
          {install && install.phase !== 'done' ? (
            <div className="local-progress">
              <div className="bar">
                <i style={{ width: `${Math.round((install.progress ?? 0) * 100)}%` }} />
              </div>
              <div className="hint" style={{ margin: '5px 0 0' }}>{install.message}</div>
            </div>
          ) : (
            <button
              className="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                setError('')
                const res = await api.local.install({ modelsDir })
                setBusy(false)
                if (!res.ok) setError(res.error ?? 'Install failed')
                else {
                  onToast('Ollama installed')
                  await refresh()
                }
              }}
            >
              {busy ? 'Installing…' : info.bundledInstaller ? 'Install Ollama (included)' : 'Download and install Ollama'}
            </button>
          )}
        </div>
      ) : (
        <div className="local-step">
          <div className="local-step-row">
            <div>
              <div className="local-step-title">
                <span className="step-num">1</span> Ollama
              </div>
              <div className="hint mono" style={{ wordBreak: 'break-all' }}>{info.exe}</div>
            </div>
            <div className="row">
              {!info.running ? (
                <button
                  className="small"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true)
                    const res = await api.local.startDaemon()
                    setBusy(false)
                    if (!res.ok) setError(res.error ?? 'Could not start Ollama')
                    else onToast('Ollama started')
                    await refresh()
                  }}
                >
                  Start Ollama
                </button>
              ) : null}
              <button className="small ghost" onClick={() => void refresh()}>
                Re-check
              </button>
            </div>
          </div>
          {!info.anthropicCompatible && info.running ? (
            <div className="local-warn">
              This Ollama is older than 0.14, so it has no <code>/v1/messages</code> endpoint and the agent cannot use
              it. Update Ollama, then press Re-check.
            </div>
          ) : null}
        </div>
      )}

      {/* 2 — where the weights go ------------------------------------------- */}
      <div className="local-step">
        <div className="local-step-title">
          <span className="step-num">{info.installed ? 2 : 2}</span> Where to store the models
        </div>
        <div className="hint">
          Model weights are large — 5 GB for a small coder, 19 GB for a good one. Put them on the drive with room;
           nothing else in the app uses this folder.
        </div>
        <div className="row" style={{ marginTop: 6 }}>
          <input value={modelsDir} onChange={(e) => setModelsDir(e.target.value)} placeholder={info.defaultModelsDir} />
          <button
            className="small"
            onClick={async () => {
              const res = await api.local.setModelsDir(modelsDir)
              if (!res.ok) setError(res.error ?? 'Could not use that folder')
              else {
                setError('')
                onToast(res.restartNeeded ? 'Saved — restart Ollama for this to apply' : 'Model folder saved')
                await refresh()
              }
            }}
          >
            Save
          </button>
        </div>
        <div className="hint">
          {info.freeGb !== undefined ? `${Math.round(info.freeGb)} GB free on that drive.` : ''}{' '}
          {info.modelsDir !== info.defaultModelsDir ? `Custom location: ${info.modelsDir}` : 'Default Ollama location.'}
        </div>
      </div>

      {/* 3 — bundles -------------------------------------------------------- */}
      <div className="local-step">
        <div className="local-step-title">
          <span className="step-num">3</span> Download what you need
        </div>
        <div className="hint">
          A bundle is the set of models that covers every use case at a chosen quality, so you do not have to pick
          model by model. Models already installed are skipped.
        </div>
        <div className="bundle-grid">
          {info.bundles.map((b) => {
            const totalGb = b.models.reduce((s, id) => s + (info.models.find((m) => m.id === id)?.sizeGb ?? 0), 0)
            const missing = b.models.filter((id) => !has(id))
            const complete = missing.length === 0
            return (
              <div key={b.id} className={`bundle ${complete ? 'complete' : ''}`}>
                <div className="bundle-top">
                  <strong>{b.label}</strong>
                  <span className="badge">{Math.round(totalGb)} GB</span>
                </div>
                <div className="bundle-summary">{b.summary}</div>
                <div className="bundle-models">
                  {b.models.map((id) => (
                    <span key={id} className={`chip ${has(id) ? 'on' : ''}`}>
                      {has(id) ? '✓ ' : ''}
                      {info.models.find((m) => m.id === id)?.label ?? id}
                    </span>
                  ))}
                </div>
                <button
                  className={complete ? 'small ghost' : 'small primary'}
                  disabled={busy || !info.running}
                  onClick={async () => {
                    setBusy(true)
                    setError('')
                    const res = await api.local.pullBundle({ bundle: b.id })
                    setBusy(false)
                    setBundle(null)
                    if (!res.ok) setError(res.error ?? 'Download failed')
                    else onToast(`${b.label} downloaded`)
                    await refresh()
                  }}
                >
                  {complete ? 'Installed' : busy ? 'Downloading…' : `Download ${Math.round(totalGb)} GB`}
                </button>
              </div>
            )
          })}
        </div>
      </div>

      {/* 4 — single models -------------------------------------------------- */}
      <div className="local-step">
        <div className="local-step-title">
          <span className="step-num">4</span> Or download one at a time
        </div>
        <div className="model-list">
          {info.models.map((m) => (
            <ModelRow
              key={m.id}
              m={m}
              installed={has(m.id)}
              progress={pulling[m.id]}
              canPull={info.running && !busy}
              onPull={async () => {
                setError('')
                const res = await api.local.pull(m.id)
                if (!res.ok) setError(res.error ?? 'Download failed')
                else onToast(`${m.label} ready`)
              }}
              onCancel={() => void api.local.cancelPull()}
            />
          ))}
        </div>
      </div>

      {/* 5 — role mapping --------------------------------------------------- */}
      <div className="local-step">
        <div className="local-step-title">
          <span className="step-num">5</span> Use them for
        </div>
        <div className="hint">
          Pick which model handles each job. The same model can be chosen for several jobs — a large coder is usually
          good at both coding and reading screenshots — and it is only ever downloaded once.
        </div>
        <div className="role-list">
          {(info.roleDefs ?? []).map((role) => {
            const chosen = roles[role.id]?.[0] ?? ''
            return (
              <div key={role.id} className="role-row">
                <div className="role-label">
                  <strong>{role.label}</strong>
                  <div className="hint">{role.helps}</div>
                </div>
                <select value={chosen} onChange={(e) => setRoleModel(role.id, e.target.value)}>
                  <option value="">Not set</option>
                  {info.models
                    .filter((m) => (role.needs === 'vision' ? m.vision : m.tools))
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label} ({m.sizeGb} GB){has(m.id) ? ' — installed' : ''}
                      </option>
                    ))}
                </select>
              </div>
            )
          })}
        </div>

        <div className="role-summary">
          <div>
            {needed.length === 0
              ? 'No models assigned yet.'
              : `${needed.length} model${needed.length === 1 ? '' : 's'} cover all ${ROLE_ORDER.length} jobs · ${Math.round(neededGb)} GB total`}
          </div>
          {needed.some((id) => !has(id)) ? (
            <div className="hint">
              Missing: {needed.filter((id) => !has(id)).map((id) => info.models.find((m) => m.id === id)?.label ?? id).join(', ')}
            </div>
          ) : null}
        </div>

        <button
          className="primary"
          disabled={busy || needed.length === 0}
          onClick={async () => {
            const res = await api.local.setRoles(roles)
            if (!res.ok) setError(res.error ?? 'Could not save the mapping')
            else {
              setError('')
              onToast('Saved. The agent uses these when the provider is Ollama.')
              await refresh()
            }
          }}
        >
          Save model choices
        </button>
        {needed.some((id) => !has(id)) ? (
          <button
            className="small"
            style={{ marginLeft: 8 }}
            disabled={busy || !info.running}
            onClick={async () => {
              setBusy(true)
              setError('')
              const res = await api.local.pullBundle({ models: needed })
              setBusy(false)
              if (!res.ok) setError(res.error ?? 'Download failed')
              else onToast('All assigned models downloaded')
              await refresh()
            }}
          >
            Download the {Math.round(neededGb)} GB you have assigned
          </button>
        ) : null}
      </div>

      {bundle ? (
        <div className="local-progress sticky">
          <div className="hint" style={{ margin: 0 }}>
            Downloading {bundle.index + 1} of {bundle.of}: {bundle.model}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function ModelRow(props: {
  m: LocalModelDef
  installed: boolean
  progress?: PullProgress
  canPull: boolean
  onPull: () => Promise<void>
  onCancel: () => void
}): JSX.Element {
  const { m, installed, progress } = props
  const active = !!progress && !progress.done
  return (
    <div className={`model-row ${installed ? 'installed' : ''}`}>
      <div className="model-row-main">
        <div className="model-row-title">
          <strong>{m.label}</strong>
          <span className="badge">{m.sizeGb} GB</span>
          {m.tools ? <span className="badge green">tools</span> : <span className="badge red">no tools</span>}
          {m.vision ? <span className="badge green">vision</span> : null}
          {installed ? <span className="badge">installed</span> : null}
        </div>
        <div className="hint">{m.note}</div>
        {active ? (
          <div className="local-progress">
            <div className="bar">
              <i style={{ width: `${Math.round((progress?.progress ?? 0) * 100)}%` }} />
            </div>
            <div className="hint" style={{ margin: '4px 0 0' }}>
              {progress?.status}
              {progress?.progress !== undefined ? ` — ${Math.round(progress.progress * 100)}%` : ''}
            </div>
          </div>
        ) : null}
      </div>
      <div className="model-row-actions">
        {active ? (
          <button className="small ghost" onClick={props.onCancel}>
            Cancel
          </button>
        ) : (
          <button className="small" disabled={!props.canPull || installed} onClick={() => void props.onPull()}>
            {installed ? 'Installed' : 'Download'}
          </button>
        )}
      </div>
    </div>
  )
}

/** Re-exported so Settings can show bundle size without duplicating the rule. */
export function bundleTotalGb(b: BundleDef, models: LocalModelDef[]): number {
  return b.models.reduce((s, id) => s + (models.find((m) => m.id === id)?.sizeGb ?? 0), 0)
}
