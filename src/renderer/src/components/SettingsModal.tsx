import { useEffect, useState } from 'react'
import type { AppConfig, GameInstance } from '../../../shared/types'
import { api } from '../lib/api'
import GithubLogin from './GithubLogin'

interface Props {
  config: AppConfig & { apiKeySet: boolean }
  onClose: () => void
  onSaved: (cfg: AppConfig & { apiKeySet: boolean }) => void
  onToast: (text: string, kind?: 'ok' | 'err') => void
  /** Opens the reference-mod panel (decompiler) from the GitHub tab. */
  onOpenReferences?: () => void
}

const MODELS = [
  'claude-sonnet-4-5-20250929',
  'claude-opus-4-1-20250805',
  'claude-haiku-4-5-20251001',
  'claude-3-7-sonnet-latest'
]

export default function SettingsModal({ config, onClose, onSaved, onToast, onOpenReferences }: Props): JSX.Element {
  const [tab, setTab] = useState<'model' | 'github' | 'game'>('model')
  const [draft, setDraft] = useState(config)
  const [apiKey, setApiKey] = useState('')
  const [detected, setDetected] = useState<GameInstance[]>([])
  const [saving, setSaving] = useState(false)
  const [java, setJava] = useState<{ game: { path: string | null; version?: string; error?: string }; tools: { path: string | null; version?: string; error?: string }; split: boolean } | null>(null)
  const [javaCheck, setJavaCheck] = useState<{ ok: boolean; version?: string; major?: number; error?: string; cleared?: boolean } | null>(null)

  useEffect(() => {
    void api.instance.detect().then(setDetected)
    void api.java.status().then(setJava)
  }, [])

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
          <button className={tab === 'github' ? 'on' : ''} onClick={() => setTab('github')}>
            GitHub
          </button>
          <button className={tab === 'game' ? 'on' : ''} onClick={() => setTab('game')}>
            Game
          </button>
        </div>

        {tab === 'model' && (
          <>
            <div className="field">
              <label>Anthropic API key {config.apiKeySet ? <span className="badge green">set</span> : <span className="badge red">missing</span>}</label>
              <input type="password" value={apiKey} placeholder={config.apiKeySet ? '•••••••• (leave blank to keep)' : 'sk-ant-…'} onChange={(e) => setApiKey(e.target.value)} />
              <div className="hint">Used by the Claude Agent SDK. Env var ANTHROPIC_API_KEY also works.</div>
            </div>
            <div className="field">
              <label>Model</label>
              <select value={MODELS.includes(draft.model) ? draft.model : 'custom'} onChange={(e) => set('model', e.target.value === 'custom' ? '' : e.target.value)}>
                {MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                <option value="custom">custom…</option>
              </select>
              {!MODELS.includes(draft.model) && <input style={{ marginTop: 8 }} value={draft.model} onChange={(e) => set('model', e.target.value)} placeholder="model id" />}
            </div>
            <div className="two-col">
              <div className="field">
                <label>Per-run budget (USD, 0 = uncapped)</label>
                <input type="number" min={0} step={0.5} value={draft.maxBudgetUsd} onChange={(e) => set('maxBudgetUsd', Number(e.target.value))} />
              </div>
              <div className="field">
                <label>Base URL (optional, for proxies)</label>
                <input value={draft.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} placeholder="https://api.anthropic.com" />
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
