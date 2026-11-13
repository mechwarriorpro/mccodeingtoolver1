import { useEffect, useState } from 'react'
import type { AppConfig, GameInstance } from '../../../shared/types'
import { api, type ProviderDef, type ProviderModel, type UpdateState } from '../lib/api'
import LocalModelsPanel from './LocalModelsPanel'
import GithubLogin from './GithubLogin'

interface Props {
  config: AppConfig & { apiKeySet: boolean }
  onClose: () => void
  onSaved: (cfg: AppConfig & { apiKeySet: boolean }) => void
  onToast: (text: string, kind?: 'ok' | 'err') => void
  /** Opens the reference-mod panel (decompiler) from the GitHub tab. */
  onOpenReferences?: () => void
}

export default function SettingsModal({ config, onClose, onSaved, onToast, onOpenReferences }: Props): JSX.Element {
  const [tab, setTab] = useState<'model' | 'local' | 'github' | 'game' | 'updates'>('model')
  const [draft, setDraft] = useState(config)
  const [apiKey, setApiKey] = useState('')
  const [detected, setDetected] = useState<GameInstance[]>([])
  const [saving, setSaving] = useState(false)
  const [java, setJava] = useState<{ game: { path: string | null; version?: string; error?: string }; tools: { path: string | null; version?: string; error?: string }; split: boolean } | null>(null)
  const [javaCheck, setJavaCheck] = useState<{ ok: boolean; version?: string; major?: number; error?: string; cleared?: boolean } | null>(null)
  const [providers, setProviders] = useState<ProviderDef[]>([])
  const [models, setModels] = useState<Record<string, ProviderModel[]>>({})
  const [defaults, setDefaults] = useState<Record<string, string>>({})
  const [modelSource, setModelSource] = useState<string>('')
  const [loadingModels, setLoadingModels] = useState(false)
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null)
  const [localFit, setLocalFit] = useState<{ none: boolean; cpuOnly: boolean; best?: string; installed: boolean; running: boolean } | null>(null)
  const [update, setUpdate] = useState<(UpdateState & { versionLabel?: string }) | null>(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    void api.providers.list().then((r) => {
      setProviders(r.providers)
      setModels(r.models)
      setDefaults(r.defaults)
    })
  }, [])

  useEffect(() => {
    void api.update.state().then(setUpdate)
    return api.events.onUpdateState((st) => setUpdate((prev) => ({ ...st, versionLabel: prev?.versionLabel })))
  }, [])

  useEffect(() => {
    void api.instance.detect().then(setDetected)
    void api.java.status().then(setJava)
  }, [])

  const providerId = draft.provider || 'anthropic'
  const currentProvider = providers.find((p) => p.id === providerId)
  const selectedModel = (models[providerId] ?? []).find((m) => m.id === draft.model)

  async function checkJava(path: string): Promise<void> {
    setJavaCheck(null)
    const res = await api.java.check(path)
    setJavaCheck(res)
    setJava(await api.java.status())
  }

  function set<K extends keyof AppConfig>(key: K, value: AppConfig[K]): void {
    setDraft((d) => ({ ...d, [key]: value }))
  }

  async function save(): Promise<void> {
    setSaving(true)
    try {
      const patch: Partial<AppConfig> = { ...draft }
      if (apiKey) patch.apiKey = apiKey
      const next = await api.config.set(patch)
      onSaved(next)
      onToast('Settings saved')
      onClose()
    } catch (e) {
      onToast((e as Error).message, 'err')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal">
      <div className="box">
        <h2>Settings</h2>
        <div className="sub">Stored locally in this app's user data folder. The API key never leaves the main process.</div>

        <div className="autonomy" style={{ marginBottom: 16, width: 'fit-content' }}>
          <button className={tab === 'model' ? 'on' : ''} onClick={() => setTab('model')}>
            Model
          </button>
          <button className={tab === 'local' ? 'on' : ''} onClick={() => setTab('local')}>
            Local models
          </button>
          <button className={tab === 'github' ? 'on' : ''} onClick={() => setTab('github')}>
            GitHub
          </button>
          <button className={tab === 'game' ? 'on' : ''} onClick={() => setTab('game')}>
            Game
          </button>
          <button className={tab === 'updates' ? 'on' : ''} onClick={() => setTab('updates')}>
            Updates
          </button>
        </div>

        {tab === 'model' && (
          <>
            <div className="field">
              <label>Provider</label>
              <select
                value={draft.provider || 'anthropic'}
                onChange={(e) => {
                  // Switching provider must switch the model with it, or the SDK
                  // asks a free provider for "claude-sonnet-..." and gets a 404.
                  const next = e.target.value
                  set('provider', next)
                  set('model', defaults[next] ?? '')
                  setApiKey('')
                  setTest(null)
                  setModelSource('')
                  // Choosing Ollama with no role mapping yet would leave the
                  // agent with no model, so seed a sensible one from Local models.
                  if (next === 'ollama') {
                    void api.local.info().then((info) => {
                      const agent = info.roles.agent[0]
                      if (agent) set('model', agent)
                      // Hardware is checked before the provider is saved, so a
                      // machine that cannot run any local model is told now
                      // rather than after a failed first message.
                      setLocalFit({
                        none: info.hardware?.noneRun ?? false,
                        cpuOnly: info.hardware?.system?.cpuOnly ?? false,
                        best: info.models.find((m) => m.id === info.hardware?.bestModel)?.label,
                        installed: info.installed,
                        running: info.running
                      })
                    })
                  } else {
                    setLocalFit(null)
                  }
                }}
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                    {p.local ? ' (free, local)' : ''}
                  </option>
                ))}
              </select>
              {localFit ? (
                <div className={`local-blocked`} style={{ marginTop: 8 }}>
                  {localFit.none ? (
                    <>
                      <strong>Local models will not run on this machine.</strong> Every model needs more memory
                      than is available. Switch to a free cloud provider above (Z.ai or OpenRouter) — no card
                      needed — or open <strong>Local models</strong> to see the numbers.
                    </>
                  ) : !localFit.installed ? (
                    <>
                      Ollama is not installed yet. Open <strong>Local models</strong> to install it and download a
                      model{localFit.best ? ` — ${localFit.best} is the best fit for this machine.` : '.'}
                    </>
                  ) : !localFit.running ? (
                    <>Ollama is installed but not running. Open <strong>Local models</strong> and press Start Ollama.</>
                  ) : localFit.cpuOnly ? (
                    <>
                      No supported graphics card: models will run on the <strong>CPU</strong>. That works, but it is
                      slow — pick the smallest model in <strong>Local models</strong>.
                    </>
                  ) : null}
                </div>
              ) : null}
              {currentProvider ? (
                <div className="hint">
                  {currentProvider.note}
                  {currentProvider.id === 'ollama' ? (
                    <>
                      {' '}
                      <button className="link" onClick={() => setTab('local')}>
                        Install it and choose models →
                      </button>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="field">
              <label>
                {currentProvider?.label ?? 'Provider'} API key{' '}
                {config.apiKeySet ? <span className="badge green">set</span> : currentProvider?.keyOptional ? <span className="badge">not needed</span> : <span className="badge red">missing</span>}
              </label>
              <div className="row">
                <input
                  type="password"
                  value={apiKey}
                  placeholder={config.apiKeySet ? '•••••••• (leave blank to keep)' : currentProvider?.id === 'anthropic' ? 'sk-ant-…' : 'paste the key from the provider'}
                  onChange={(e) => setApiKey(e.target.value)}
                />
                {currentProvider ? (
                  <button className="small" onClick={() => void api.providers.openSignup(currentProvider.signupUrl)}>
                    Get a key
                  </button>
                ) : null}
              </div>
              <div className="hint">
                Stored locally; it never leaves the main process. Switching provider keeps the old key until you save a new one.
              </div>
            </div>

            <div className="field">
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 5 }}>
                <label style={{ margin: 0 }}>Model</label>
                <div className="row" style={{ gap: 8 }}>
                  <button
                    className="small ghost"
                    disabled={loadingModels}
                    onClick={async () => {
                      setLoadingModels(true)
                      setTest(null)
                      try {
                        const res = await api.providers.models({ provider: draft.provider || 'anthropic', apiKey })
                        setModels((m) => ({ ...m, [draft.provider || 'anthropic']: res.models }))
                        setModelSource(res.error ?? (res.source === 'live' ? `Live list: ${res.models.length} free models.` : 'Bundled list.'))
                      } finally {
                        setLoadingModels(false)
                      }
                    }}
                  >
                    {loadingModels ? 'Refreshing…' : 'Refresh free models'}
                  </button>
                </div>
              </div>
              <select value={draft.model} onChange={(e) => set('model', e.target.value)}>
                {(models[draft.provider || 'anthropic'] ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                    {m.free ? ' — free' : ''}
                    {m.vision ? ' · vision' : ''}
                    {m.tools ? '' : ' · no tools'}
                  </option>
                ))}
                {!(models[draft.provider || 'anthropic'] ?? []).some((m) => m.id === draft.model) ? (
                  <option value={draft.model}>{draft.model || '(no model selected)'}</option>
                ) : null}
              </select>
              <input
                style={{ marginTop: 6 }}
                value={draft.model}
                onChange={(e) => set('model', e.target.value)}
                placeholder="or type any model id"
              />
              {selectedModel ? (
                <div className="hint">
                  {selectedModel.limits ? `${selectedModel.limits} · ` : ''}
                  {selectedModel.context ? `context ${selectedModel.context} · ` : ''}
                  {selectedModel.tools ? 'tool calling' : 'no tool calling — cannot edit files'}
                  {selectedModel.vision ? ', vision' : ', no vision (screenshots will not be read)'}
                </div>
              ) : null}
              {modelSource ? <div className="hint">{modelSource}</div> : null}
            </div>

            <div className="row" style={{ marginBottom: 12 }}>
              <button
                className="small"
                disabled={testing}
                onClick={async () => {
                  setTesting(true)
                  setTest(null)
                  try {
                    const res = await api.providers.test({ provider: draft.provider || 'anthropic', model: draft.model, apiKey })
                    setTest(
                      res.ok
                        ? { ok: true, message: `Connected — “${res.reply}” in ${((res.ms ?? 0) / 1000).toFixed(1)}s` }
                        : { ok: false, message: res.error ?? 'Test failed' }
                    )
                  } finally {
                    setTesting(false)
                  }
                }}
              >
                {testing ? 'Testing…' : 'Test connection'}
              </button>
              {test ? (
                <span className="hint" style={{ margin: 0, color: test.ok ? 'var(--accent)' : 'var(--red)' }}>
                  {test.message}
                </span>
              ) : null}
            </div>

            <div className="two-col">
              <div className="field">
                <label>Vision model for screenshots and clips</label>
                <select
                  value={draft.visionProvider || ''}
                  onChange={(e) => {
                    const next = e.target.value
                    set('visionProvider', next)
                    const [pid] = next.split(':')
                    if (pid && pid !== providerId) set('visionModel', (models[pid] ?? []).find((m) => m.vision)?.id ?? '')
                  }}
                >
                  <option value="">Same as the agent's provider and model</option>
                  {providers
                    .filter((p) => p.id !== providerId)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                </select>
                {draft.visionProvider ? (
                  <>
                    <input
                      style={{ marginTop: 6 }}
                      value={draft.visionModel}
                      onChange={(e) => set('visionModel', e.target.value)}
                      placeholder={(models[draft.visionProvider.split(':')[0]] ?? []).find((m) => m.vision)?.id ?? 'vision-capable model id'}
                    />
                    <input
                      style={{ marginTop: 6 }}
                      type="password"
                      value={draft.visionProviderKey === '••••••••' ? '' : draft.visionProviderKey}
                      onChange={(e) => set('visionProviderKey', e.target.value)}
                      placeholder="key for that provider"
                    />
                  </>
                ) : null}
                <div className="hint">
                  Clips and screenshots need a model that accepts images. A free vision model here keeps the agent's
                  coding model free of image costs.
                </div>
              </div>
              <div className="field">
                <label>Per-run budget (USD, 0 = uncapped)</label>
                <input type="number" min={0} step={0.5} value={draft.maxBudgetUsd} onChange={(e) => set('maxBudgetUsd', Number(e.target.value))} />
                <div className="hint">Only applies to paid models; a free tier cannot overspend.</div>
              </div>

              <div className="field">
                <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={draft.evolving}
                    onChange={(e) => set('evolving', e.target.checked)}
                  />
                  Let the agent evolve its own prompt
                </label>
                <div className="hint">
                  Adds the <b>Evolve</b> tab. It rewrites the agent's own prompt, tool descriptions and subagent
                  instructions, then proves each change by compiling real NeoForge code. Off by default; nothing runs
                  until you press the button, and every generation is reversible.
                </div>
                {draft.evolving && (
                  <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                    <label className="inline" style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 11.5 }}>
                      generations per run
                      <input
                        type="number"
                        min={1}
                        max={20}
                        value={draft.evolveCount}
                        onChange={(e) => set('evolveCount', Number(e.target.value))}
                        style={{ width: 56 }}
                      />
                    </label>
                    <label className="inline" style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 11.5 }}>
                      RAM ceiling (MB)
                      <input
                        type="number"
                        min={0}
                        step={128}
                        value={draft.evolveMaxHeapMb}
                        onChange={(e) => set('evolveMaxHeapMb', Number(e.target.value))}
                        style={{ width: 80 }}
                      />
                    </label>
                  </div>
                )}
              </div>

              <div className="field">
                <label>Diagnostics</label>
                <select
                  value={draft.diagLevel}
                  onChange={(e) => set('diagLevel', Number(e.target.value) as 0 | 1 | 2 | 3)}
                >
                  <option value={0}>Off — record nothing</option>
                  <option value={1}>Errors — only what went wrong</option>
                  <option value={2}>Every step — each tool call and its result</option>
                  <option value={3}>Everything — plus raw provider traffic</option>
                </select>
                <div className="hint">
                  Lives in the Diagnostics tab. Higher levels are slower and write more to the log; level 1 already
                  writes each run's outcome to <code>logs/agent.log</code>, so a bug can be explained after the fact.
                </div>
              </div>

              <div className="field">
                <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={draft.showThinking}
                    onChange={(e) => set('showThinking', e.target.checked)}
                  />
                  Show how the agent thinks
                </label>
                <div className="hint">
                  Lets the model reason before it acts and shows that reasoning with the action it produced. Useful on a
                  stubborn bug, slower and dearer on a paid model.
                </div>
                {draft.showThinking && (
                  <input
                    type="number"
                    min={0}
                    step={1024}
                    value={draft.thinkingTokens}
                    onChange={(e) => set('thinkingTokens', Number(e.target.value))}
                    placeholder="thinking budget in tokens, e.g. 4096"
                    style={{ marginTop: 6 }}
                  />
                )}
                {draft.showThinking && draft.thinkingTokens <= 0 && (
                  <div className="hint warn">
                    A model only thinks when it is given a token budget. Set one above 0 or nothing will happen.
                  </div>
                )}
                {draft.showThinking && draft.provider !== 'anthropic' && (
                  <div className="hint warn">
                    {providers.find((p) => p.id === draft.provider)?.label ?? draft.provider} does not accept the thinking parameter, so it
                    is not sent. The Diagnostics tab still records every tool call and its arguments — that is how the
                    agent works on a non-Claude model.
                  </div>
                )}
              </div>
            </div>
            <div className="field">
              <label>Base URL override (optional)</label>
              <input
                value={draft.baseUrl}
                onChange={(e) => set('baseUrl', e.target.value)}
                placeholder={currentProvider?.baseUrl || 'https://api.anthropic.com'}
              />
              <div className="hint">
                Leave blank to use the provider's own endpoint. Set this only for a proxy or a self-hosted gateway.
              </div>
            </div>
            <div className="field">
              <label>Decompiler jar (empty = download Vineflower automatically)</label>
              <div className="row">
                <input value={draft.decompilerJar} onChange={(e) => set('decompilerJar', e.target.value)} placeholder="C:\\Tools\\cfr-0.152.jar" />
                <button
                  onClick={async () => {
                    const files = await api.dialog.pickFiles({ title: 'Pick a decompiler jar', filters: [{ name: 'Jar', extensions: ['jar'] }] })
                    if (files[0]) set('decompilerJar', files[0])
                  }}
                >
                  Browse
                </button>
              </div>
              <div className="hint">Used for reference mods. Vineflower, CFR or another jar with a command-line interface all work.</div>
            </div>
            <div className="field">
              <label>Java 21 executable (empty = auto-detect)</label>
              <div className="row">
                <input value={draft.javaPath} onChange={(e) => set('javaPath', e.target.value)} placeholder="C:\\Program Files\\Eclipse Adoptium\\jdk-21\\bin\\java.exe" />
                <button
                  onClick={async () => {
                    const files = await api.dialog.pickFiles({ title: 'Pick java.exe', filters: [{ name: 'java', extensions: ['exe', ''] }] })
                    if (files[0]) {
                      set('javaPath', files[0])
                      await checkJava(files[0])
                    }
                  }}
                >
                  Browse
                </button>
                <button onClick={() => void checkJava(draft.javaPath)}>Check</button>
              </div>
              {java && (
                <div className="hint">
                  {java.game.path ? (
                    <>
                      Game / NeoForge: <b>Java {java.game.version}</b> at <code>{java.game.path}</code>
                    </>
                  ) : (
                    <span className="warn">No Java 21 found. {java.game.error}</span>
                  )}
                  {java.tools.path && java.tools.path !== java.game.path && (
                    <>
                      <br />
                      Decompiler: Java {java.tools.version} at <code>{java.tools.path}</code>
                    </>
                  )}
                  {!java.tools.path && <><br /><span className="warn">{java.tools.error}</span></>}
                </div>
              )}
              {javaCheck && (
                <div className={javaCheck.ok ? 'hint' : 'hint warn'}>
                  {javaCheck.cleared
                    ? 'Cleared the cached Java lookup; auto-detection will run again.'
                    : javaCheck.ok
                      ? `Java ${javaCheck.version} — good for Minecraft 1.21.1.`
                      : javaCheck.error}
                </div>
              )}
              <div className="hint">
                Detected by running <code>java -version</code> and checking the major version — a Java 8 left on PATH or in JAVA_HOME
                is skipped, because Vineflower needs 17+ and 1.21.1 needs 21.
              </div>
            </div>
          </>
        )}

        {tab === 'local' && <LocalModelsPanel onToast={onToast} />}

        {tab === 'github' && (
          <>
            <GithubLogin onToast={onToast} />
            <div className="two-col">
              <div className="field">
                <label>Owner</label>
                <input value={draft.github.owner} onChange={(e) => set('github', { ...draft.github, owner: e.target.value })} placeholder="ShadowClanGaming" />
              </div>
              <div className="field">
                <label>Repository</label>
                <input value={draft.github.repo} onChange={(e) => set('github', { ...draft.github, repo: e.target.value })} placeholder="ruby-tools" />
              </div>
            </div>
            <div className="field">
              <label>Branch</label>
              <input value={draft.github.branch} onChange={(e) => set('github', { ...draft.github, branch: e.target.value })} placeholder="main" />
            </div>
            <div className="hint" style={{ marginBottom: 12 }}>
              The app commits your source, pushes, runs the build workflow and downloads the jar with the account above.
              Git itself still needs to be installed; the GitHub CLI does not.
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                className="small"
                onClick={() =>
                  void api.build.preflight().then((r) => onToast(r.messages.length ? r.messages.join(' · ') : 'GitHub ready', r.ghFound && r.authed && r.repoOk ? 'ok' : 'err'))
                }
              >
                Test connection
              </button>
              <button
                className="small"
                onClick={() =>
                  void api.build.initRepo(false).then((r) => onToast(r.ok ? `Pushed to ${r.url}` : r.error ?? 'failed', r.ok ? 'ok' : 'err'))
                }
              >
                Create repo & push
              </button>
              {onOpenReferences && (
                <button className="small ghost" onClick={onOpenReferences}>
                  Reference mods (decompiler)…
                </button>
              )}
            </div>
            <div className="hint" style={{ marginTop: 10 }}>
              Reference mods: download another mod's release jar, decompile it and let the agent read it for API examples.
            </div>
          </>
        )}

        {tab === 'game' && (
          <>
            <div className="field">
              <label>Test instances</label>
              <div style={{ border: '1px solid var(--line)', borderRadius: 8, maxHeight: 190, overflowY: 'auto' }}>
                {draft.game.instances.length === 0 && <div style={{ padding: 10, color: 'var(--dim)', fontSize: 12.5 }}>No instances yet.</div>}
                {draft.game.instances.map((i) => (
                  <div
                    key={i.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '7px 9px',
                      borderBottom: '1px solid var(--line)',
                      fontSize: 12.5,
                      background: i.id === draft.game.activeInstanceId ? '#16241d' : undefined
                    }}
                  >
                    <input
                      type="radio"
                      style={{ width: 'auto' }}
                      checked={i.id === draft.game.activeInstanceId}
                      onChange={() => set('game', { ...draft.game, activeInstanceId: i.id })}
                    />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.name}</div>
                      <div style={{ color: 'var(--dim)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.path}</div>
                    </div>
                    <span className="badge" style={{ marginLeft: 'auto' }}>
                      {i.kind}
                    </span>
                    <button className="small ghost" onClick={() => set('game', { ...draft.game, instances: draft.game.instances.filter((x) => x.id !== i.id) })}>
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
              <button
                className="small"
                onClick={() =>
                  void api.instance.detect().then((found) => {
                    setDetected(found)
                    const ids = new Set(draft.game.instances.map((i) => i.id))
                    const merged = [...draft.game.instances, ...found.filter((f) => !ids.has(f.id))]
                    set('game', { ...draft.game, instances: merged, activeInstanceId: draft.game.activeInstanceId || merged[0]?.id || '' })
                    onToast(`Found ${found.length} Technic pack(s)`)
                  })
                }
              >
                Scan Technic
              </button>
              <button
                className="small"
                onClick={async () => {
                  const dir = await api.dialog.pickFolder({ title: 'Pick a game folder (contains mods/)' })
                  if (!dir) return
                  const inst: GameInstance = {
                    id: `custom:${dir}`,
                    name: dir.split(/[\\/]/).pop() ?? 'instance',
                    kind: 'custom',
                    path: dir,
                    minecraftDir: dir
                  }
                  setDetected([])
                  set('game', { ...draft.game, instances: [...draft.game.instances, inst], activeInstanceId: inst.id })
                }}
              >
                Add folder
              </button>
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--dim)', marginBottom: 14 }}>
              Technic packs live in %APPDATA%\.technic\modpacks\&lt;pack&gt;. A custom folder must contain a mods folder; using your NeoForge launcher instance works too.
            </div>

            <div className="two-col">
              <div className="field">
                <label>Window width</label>
                <input type="number" value={draft.game.windowWidth} onChange={(e) => set('game', { ...draft.game, windowWidth: Number(e.target.value) })} />
              </div>
              <div className="field">
                <label>Window height</label>
                <input type="number" value={draft.game.windowHeight} onChange={(e) => set('game', { ...draft.game, windowHeight: Number(e.target.value) })} />
              </div>
            </div>
            <div className="field">
              <label>Extra JVM args for runClient</label>
              <input value={draft.game.clientJvmArgs} onChange={(e) => set('game', { ...draft.game, clientJvmArgs: e.target.value })} placeholder="-Xmx4G -XX:+UseG1GC" />
            </div>
            <div className="field">
              <label>Extra program args</label>
              <input value={draft.game.clientProgramArgs} onChange={(e) => set('game', { ...draft.game, clientProgramArgs: e.target.value })} placeholder="--fullscreen" />
            </div>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, color: 'var(--muted)' }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={draft.game.autoScreenshot} onChange={(e) => set('game', { ...draft.game, autoScreenshot: e.target.checked })} />
              Screenshot automatically once the title screen appears
            </label>
          </>
        )}

        {tab === 'updates' && (
          <>
            <div className="field">
              <label>Installed version</label>
              <div style={{ fontSize: 13, color: 'var(--text)' }}>{update?.versionLabel ?? '…'}</div>
            </div>

            <div className="field">
              <label>Status</label>
              <div className="hint" style={{ marginTop: 0, fontSize: 12 }}>
                {updateStatusLine(update, checking)}
              </div>
              {update?.error ? (
                <div className="hint" style={{ color: 'var(--red)' }}>
                  {update.error}
                </div>
              ) : null}
              {update?.percent !== undefined && update.status === 'downloading' ? (
                <div className="progress" style={{ marginTop: 8 }}>
                  <div className="bar" style={{ width: `${update.percent}%` }} />
                </div>
              ) : null}
            </div>

            <div className="row" style={{ marginBottom: 14 }}>
              <button
                className="small"
                disabled={checking || !update?.supported}
                onClick={async () => {
                  setChecking(true)
                  try {
                    setUpdate({ ...(await api.update.check()), versionLabel: update?.versionLabel })
                  } finally {
                    setChecking(false)
                  }
                }}
              >
                {checking ? 'Checking…' : 'Check for updates'}
              </button>
              {update?.status === 'available' ? (
                <button
                  className="small primary"
                  disabled={checking}
                  onClick={async () => {
                    const next = await api.update.download()
                    setUpdate({ ...next, versionLabel: update?.versionLabel })
                  }}
                >
                  Download {update.version}
                </button>
              ) : null}
              {update?.status === 'downloading' ? (
                <button className="small" disabled>
                  Downloading… {update.percent ?? 0}%
                </button>
              ) : null}
              {update?.status === 'ready' ? (
                <button className="small primary" onClick={() => void api.update.install()}>
                  Restart and install {update.version}
                </button>
              ) : null}
              <button
                className="small"
                onClick={async () => {
                  const res = await api.update.clearCache()
                  onToast(res.ok ? `Cleared ${Math.round((res.bytes ?? 0) / 1024 / 1024)} MB of downloaded updates` : res.error ?? 'Could not clear', res.ok ? 'ok' : 'err')
                }}
              >
                Clear downloaded files
              </button>
            </div>

            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, color: 'var(--muted)' }}>
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={draft.autoUpdate}
                onChange={(e) => {
                  set('autoUpdate', e.target.checked)
                  void api.update.setAuto(e.target.checked).then(setUpdate)
                }}
              />
              Check for new versions automatically (recommended)
            </label>
            <div className="hint">
              Updates are downloaded in the background from this project's GitHub releases and applied on the next restart.
              The Minecraft version list updates on its own every 24 h without an app update, so new game versions appear
              even when you skip an update.
            </div>

            {update?.notes ? (
              <div className="field" style={{ marginTop: 14 }}>
                <label>What's new in {update.version}</label>
                <pre className="code-view" style={{ maxHeight: 200 }}>{update.notes}</pre>
              </div>
            ) : null}
          </>
        )}

        <div className="actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** One plain-English line per updater state. */
function updateStatusLine(st: (UpdateState & { versionLabel?: string }) | null, checking: boolean): string {
  if (!st) return 'Checking…'
  if (!st.supported) return 'This build cannot update itself (development build). Install a released version to get automatic updates.'
  if (checking) return 'Checking GitHub releases…'
  switch (st.status) {
    case 'checking':
      return 'Checking GitHub releases…'
    case 'available':
      return `Version ${st.version} is available — downloading in the background.`
    case 'downloading':
      return `Downloading version ${st.version}… ${st.percent ?? 0}%`
    case 'ready':
      return `Version ${st.version} is downloaded and ready. It will install when you restart the app.`
    case 'none':
      return st.checkedAt
        ? `You are up to date (checked ${new Date(st.checkedAt).toLocaleString()}).`
        : 'You are up to date.'
    case 'error':
      return 'The last check failed.'
    default:
      return 'Updates are checked at startup.'
  }
}
