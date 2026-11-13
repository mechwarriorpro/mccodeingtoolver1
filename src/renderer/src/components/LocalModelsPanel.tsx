import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  api,
  type BundleDef,
  type BundleProgress,
  type InstallProgress,
  type LocalInfo,
  type LocalModelDef,
  type LocalRoleDef,
  type ModelVerdict,
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

      {/* Detected hardware decides which bundle is suggested, how much context
          the daemon asks for, and whether a model can run at all. It is stated
          rather than assumed, and a hard limitation is said plainly. */}
      {info.hardware?.system ? (
        <div className={`local-hw ${info.hardware.noneRun ? 'blocked' : ''}`}>
          <div className="local-hw-main">
            {info.hardware.primary ? (
              <>
                <strong>{info.hardware.primary.name}</strong>
                {info.hardware.primary.vramGb ? <span className="badge">{info.hardware.primary.vramGb} GB VRAM</span> : null}
                {info.hardware.primary.needsVulkan ? <span className="badge amber">Vulkan, not ROCm</span> : null}
              </>
            ) : (
              <strong>CPU only</strong>
            )}
            <span className="badge">{Math.round(info.hardware.system.ramGb)} GB RAM</span>
            <span className="badge">{info.hardware.system.cpuCores} cores</span>
          </div>

          {info.hardware.noneRun ? (
            // Nothing in the catalogue fits. Saying "performance may vary" here
            // would be a lie, so it says it cannot run and offers the way out.
            <>
              <div className="local-blocked">
                <strong>Local models will not run on this machine.</strong> Every model here needs more memory
                than is available, so downloading one would waste the space and then fail to load.
              </div>
              <div className="hint">
                You are not stuck: <strong>Settings → Model</strong> has free cloud models (Z.ai, OpenRouter) that
                need no credit card. The agent, the tools and the build loop all work the same.
              </div>
            </>
          ) : (
            <>
              {info.hardware.system.cpuOnly ? (
                <div className="local-warn">
                  No supported graphics card: models run on the <strong>CPU</strong>. That works, but it is slow —
                  expect minutes rather than seconds for a small model, so start with the smallest one.
                </div>
              ) : null}
              {info.hardware.bestModel ? (
                <div className="hint">
                  Best that fits here: <strong>{info.models.find((m) => m.id === info.hardware.bestModel)?.label}</strong>
                  {' — '}
                  {info.bundles.find((b) => b.id === info.hardware.recommendedBundle)?.label} is suggested below.
                </div>
              ) : null}
            </>
          )}
          {info.hardware.primary?.note ? <div className="hint">{info.hardware.primary.note}</div> : null}
          {info.hardware.system.notes.filter(() => !info.hardware.system.cpuOnly).map((n, i) => (
            <div key={i} className="hint">{n}</div>
          ))}
        </div>
      ) : null}

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

      {/* Context length is a VRAM trade-off, not a preference: 32K on a 12B
          model costs ~4.5 GB of cache, which is most of an 8 GB card. */}
      <div className="local-step">
        <div className="local-step-title">
          <span className="step-num">2b</span> Conversation memory (context)
        </div>
        <div className="hint">
          How much of the conversation the model can hold. Bigger is better for long agent runs but costs video
          memory, and a model that no longer fits on the card runs in system RAM — several times slower.
          {info.hardware?.suggestedContext ? ` Suggested for your card: ${Math.round(info.hardware.suggestedContext / 1024)}K.` : ''}
        </div>
        <div className="row" style={{ marginTop: 6 }}>
          <select
            value={String(info.contextLength || info.hardware?.suggestedContext || 12288)}
            onChange={async (e) => {
              const res = await api.local.setContext(Number(e.target.value))
              if (!res.ok) setError(res.error ?? 'Could not save that')
              else {
                onToast(res.restartNeeded ? 'Saved — restart Ollama to apply' : 'Context updated')
                await refresh()
              }
            }}
          >
            {[8192, 12288, 16384, 32768, 65536].map((n) => (
              <option key={n} value={n}>
                {n / 1024}K tokens
                {n === info.hardware?.suggestedContext ? ' — suggested' : ''}
              </option>
            ))}
          </select>
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
            // A bundle containing a model this machine cannot run still offers
            // the rest of itself, with the exclusion stated.
            const blocked = b.models.filter((id) => info.hardware?.verdicts?.[id]?.verdict === 'impossible')
            const runnable = b.models.filter((id) => !blocked.includes(id))
            return (
              <div
                key={b.id}
                className={`bundle ${complete ? 'complete' : ''} ${b.id === info.hardware?.recommendedBundle ? 'suggested' : ''}`}
              >
                <div className="bundle-top">
                  <strong>{b.label}</strong>
                  <span className="badge">{Math.round(totalGb)} GB</span>
                </div>
                {b.id === info.hardware?.recommendedBundle ? <div className="bundle-flag">Suggested for your GPU</div> : null}
                <div className="bundle-summary">{b.summary}</div>
                <div className="bundle-models">
                  {b.models.map((id) => (
                    <span key={id} className={`chip ${has(id) ? 'on' : ''} ${blocked.includes(id) ? 'off' : ''}`}>
                      {has(id) ? '✓ ' : ''}
                      {info.models.find((m) => m.id === id)?.label ?? id}
                      {blocked.includes(id) ? ' — will not run here' : ''}
                    </span>
                  ))}
                </div>
                <button
                  className={complete ? 'small ghost' : 'small primary'}
                  disabled={busy || !info.running || runnable.length === 0}
                  onClick={async () => {
                    setBusy(true)
                    setError('')
                    const res = await api.local.pullBundle({ bundle: b.id })
                    setBusy(false)
                    setBundle(null)
                    if (!res.ok) setError(res.error ?? 'Download failed')
                    else if (res.skipped?.length) onToast(`${b.label}: installed what this machine can run`)
                    else onToast(`${b.label} downloaded`)
                    await refresh()
                  }}
                >
                  {complete
                    ? 'Installed'
                    : runnable.length === 0
                      ? 'Cannot run here'
                      : busy
                        ? 'Downloading…'
                        : blocked.length
                          ? `Download ${Math.round(runnable.reduce((t, id) => t + (info.models.find((m) => m.id === id)?.sizeGb ?? 0), 0))} GB`
                          : `Download ${Math.round(totalGb)} GB`}
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
              verdict={info.hardware?.verdicts?.[m.id]}
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
                    .filter((m) => info.hardware?.verdicts?.[m.id]?.verdict !== 'impossible')
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label} ({m.sizeGb} GB){has(m.id) ? ' — installed' : ''}
                        {info.hardware?.verdicts?.[m.id]?.verdict === 'slow' ? ' — slow here' : ''}
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
          {needed.some((id) => info.hardware?.verdicts?.[id]?.verdict === 'impossible') ? (
            <div className="fit-note impossible">
              One of your choices will not run on this machine. Pick a smaller model above, or use a cloud provider
              in Settings → Model.
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
  verdict?: ModelVerdict
  canPull: boolean
  onPull: () => Promise<void>
  onCancel: () => void
}): JSX.Element {
  const { m, installed, progress, verdict } = props
  const active = !!progress && !progress.done
  // Only a model that cannot load at all is blocked. 'slow' and 'tight' are
  // warnings, because refusing something that would have worked is worse.
  const blocked = verdict?.verdict === 'impossible'
  return (
    <div className={`model-row ${installed ? 'installed' : ''} ${blocked ? 'blocked' : ''}`}>
      <div className="model-row-main">
        <div className="model-row-title">
          <strong>{m.label}</strong>
          <span className="badge">{m.sizeGb} GB</span>
          {m.tools ? <span className="badge green">tools</span> : <span className="badge red">no tools</span>}
          {m.vision ? <span className="badge green">vision</span> : null}
          {installed ? <span className="badge">installed</span> : null}
          {verdict && !installed ? <VerdictBadge v={verdict} /> : null}
        </div>
        <div className="hint">{m.note}</div>
        {verdict && verdict.verdict !== 'good' ? (
          <div className={`fit-note ${verdict.verdict}`}>
            {verdict.reason}
            {verdict.fix ? <span className="fit-fix"> {verdict.fix}</span> : null}
            <span className="fit-math"> Needs ~{verdict.needGb} GB · available ~{Math.round(verdict.haveGb)} GB</span>
          </div>
        ) : null}
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
          <button
            className="small"
            disabled={!props.canPull || installed || blocked}
            title={blocked ? verdict?.reason : undefined}
            onClick={() => void props.onPull()}
          >
            {installed ? 'Installed' : blocked ? 'Cannot run here' : 'Download'}
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

function VerdictBadge({ v }: { v: ModelVerdict }): JSX.Element {
  if (v.verdict === 'impossible') return <span className="badge red">will not run</span>
  if (v.verdict === 'slow') return <span className="badge amber">slow here</span>
  if (v.verdict === 'tight') return <span className="badge amber">tight fit</span>
  return v.onCpu ? <span className="badge amber">CPU only</span> : <span className="badge green">runs well</span>
}
