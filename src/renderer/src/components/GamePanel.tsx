import { useEffect, useRef, useState } from 'react'
import type { GameInstance, GameStatus, ScreenshotInfo } from '../../../shared/types'
import { api } from '../lib/api'

interface Props {
  status: GameStatus
  instance?: GameInstance
  consoleLines: { line: string; source: 'build' | 'game' }[]
  onRefreshStatus: () => void
  onOpenImage: (path: string) => void
  onToast: (text: string, kind?: 'ok' | 'err') => void
}

export default function GamePanel({ status, instance, consoleLines, onRefreshStatus, onOpenImage, onToast }: Props): JSX.Element {
  const [shots, setShots] = useState<ScreenshotInfo[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [showCrash, setShowCrash] = useState<string | null>(null)
  const [loader, setLoader] = useState<{ installed: boolean; neoVersion: string; minecraftDir: string; javaFound: boolean } | null>(null)
  const consoleRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void refreshShots()
    void api.neoforge.status().then(setLoader)
  }, [])

  useEffect(() => {
    const el = consoleRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [consoleLines.length])

  async function refreshShots(): Promise<void> {
    setShots(await api.game.screenshots())
  }

  async function act(name: string, fn: () => Promise<void>): Promise<void> {
    setBusy(name)
    try {
      await fn()
    } catch (e) {
      onToast((e as Error).message, 'err')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div>
      <div className="card">
        <h4>
          Game
          <span className={`status-pill ${status.running ? 'live' : ''}`} style={{ marginLeft: 'auto' }}>
            <i />
            {status.running ? (status.titleScreen ? 'title screen' : 'starting') : status.exitCode != null ? `exited (${status.exitCode})` : 'not running'}
          </span>
        </h4>
        <div className="kv" style={{ marginBottom: 10 }}>
          <div className="k">Instance</div>
          <div className="v">{instance ? `${instance.name} · ${instance.kind}` : 'not set'}</div>
          {status.pid ? (
            <>
              <div className="k">PID</div>
              <div className="v">{status.pid}</div>
            </>
          ) : null}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button
            className="small primary"
            disabled={!!busy || status.running}
            onClick={() =>
              act('launch', async () => {
                const res = await api.game.launch()
                if (!res.ok) onToast(res.error ?? 'launch failed', 'err')
                else onToast(instance?.kind === 'technic' ? 'Launcher started — press Play in Technic' : 'Dev client starting…')
                onRefreshStatus()
              })
            }
          >
            {instance?.kind === 'technic' ? 'Open Technic' : 'Launch game'}
          </button>
          <button
            className="small"
            disabled={!status.running || !!busy}
            onClick={() =>
              act('stop', async () => {
                await api.game.stopAny()
                onRefreshStatus()
              })
            }
          >
            Stop
          </button>
          <button
            className="small"
            disabled={!!busy || status.running || !loader?.installed}
            title={loader?.installed ? 'Launch the NeoForge client directly with this instance' : 'Install the NeoForge loader first'}
            onClick={() =>
              act('direct', async () => {
                const res = await api.game.launchDirect()
                if (!res.ok) onToast(res.error ?? 'launch failed', 'err')
                else onToast('NeoForge client starting — first run downloads assets')
                onRefreshStatus()
              })
            }
          >
            {busy === 'direct' ? 'Starting…' : 'Launch instance'}
          </button>
          <button
            className="small"
            disabled={!!busy}
            onClick={() =>
              act('shot', async () => {
                const res = await api.game.screenshot('manual')
                if (!res.ok) onToast(res.error ?? 'screenshot failed', 'err')
                await refreshShots()
              })
            }
          >
            {busy === 'shot' ? 'Capturing…' : 'Screenshot'}
          </button>
          <button
            className="small ghost"
            disabled={!!busy}
            onClick={() =>
              act('install', async () => {
                const res = await api.game.installJar()
                if (!res.ok) onToast(res.error ?? 'install failed', 'err')
                else onToast(`Installed ${res.installed?.split(/[\\/]/).pop()}`)
              })
            }
          >
            Install jar
          </button>
        </div>
      </div>

      <div className="card">
        <h4>
          NeoForge loader
          <span className={`badge ${loader?.installed ? 'green' : 'amber'}`} style={{ marginLeft: 'auto' }}>
            {loader?.installed ? loader.neoVersion : 'not installed'}
          </span>
        </h4>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8, wordBreak: 'break-all' }}>
          {loader?.minecraftDir || 'No instance selected'}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--dim)', marginBottom: 9 }}>
          Technic's <code>bin/modpack.jar</code> only loads Forge up to 1.12.2. For 1.21.1 the official NeoForge installer writes the
          loader next to the instance; the mod jar itself goes in <code>mods/</code>.
        </div>
        <button
          className="small"
          disabled={!!busy || !loader?.minecraftDir || !loader?.javaFound}
          onClick={() =>
            act('neoforge', async () => {
              const res = await api.neoforge.install()
              setLoader(await api.neoforge.status())
              if (!res.ok) onToast(res.error ?? 'installer failed', 'err')
              else onToast(`NeoForge ${loader?.neoVersion} installed`)
            })
          }
        >
          {busy === 'neoforge' ? 'Installing loader…' : loader?.installed ? 'Reinstall NeoForge' : 'Install NeoForge'}
        </button>
        {!loader?.javaFound && <span style={{ fontSize: 11.5, color: 'var(--red)', marginLeft: 8 }}>Java 21 missing</span>}
      </div>

      <div className="card">
        <h4>Screenshots</h4>
        {shots.length === 0 ? (
          <div style={{ color: 'var(--dim)', fontSize: 12.5 }}>No screenshots yet. The agent captures these when it tests the game.</div>
        ) : (
          shots.slice(0, 4).map((s) => (
            <div key={s.path} style={{ marginBottom: 8 }}>
              <img className="shot" src={`file://${s.path}`} onClick={() => onOpenImage(s.path)} alt={s.label ?? 'screenshot'} />
              <div style={{ display: 'flex', gap: 6, fontSize: 11, color: 'var(--dim)' }}>
                <span>{s.label ?? 'capture'}</span>
                <span style={{ marginLeft: 'auto' }}>{new Date(s.createdAt).toLocaleTimeString()}</span>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="card">
        <div className="console-bar">
          <h4 style={{ margin: 0 }}>Console</h4>
          <div className="spacer" />
          <button
            className="small ghost"
            onClick={() =>
              act('log', async () => {
                const res = await api.game.log(3000)
                if (res.crash) setShowCrash(res.crash)
                else onToast(res.text ? 'Log is in the console below' : 'No log yet', res.text ? 'ok' : 'err')
              })
            }
          >
            Crash report
          </button>
          <button
            className="small ghost"
            onClick={() =>
              act('folder', async () => {
                await api.game.openFolder()
              })
            }
          >
            Open folder
          </button>
        </div>
        <div className="console" ref={consoleRef}>
          {consoleLines.length === 0 ? (
            <div className="sys">Build and game output appears here.</div>
          ) : (
            consoleLines.slice(-500).map((l, i) => (
              <div key={i} className={/error|exception|failed|caused by/i.test(l.line) ? 'err' : /BUILD SUCCESS|done/i.test(l.line) ? 'ok' : ''}>
                {l.line}
              </div>
            ))
          )}
        </div>
      </div>

      {showCrash && (
        <div className="modal" onClick={() => setShowCrash(null)}>
          <div className="box" onClick={(e) => e.stopPropagation()}>
            <h2>Crash report</h2>
            <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, fontFamily: 'var(--mono)', maxHeight: '60vh', overflow: 'auto' }}>{showCrash}</pre>
            <div className="actions">
              <button onClick={() => setShowCrash(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
