import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppConfig, ChatMessage, Conversation, GameStatus, PermissionPrompt, ScreenshotInfo } from '../../shared/types'
import type { ProjectSummary } from './lib/api'
import { api } from './lib/api'
import ChatPanel from './components/ChatPanel'
import GamePanel from './components/GamePanel'
import BuildPanel from './components/BuildPanel'
import LicenceReminder from './components/LicenceReminder'
import SetupModal from './components/SetupModal'
import SettingsModal from './components/SettingsModal'
import ReferencePanel from './components/ReferencePanel'
import ForkPanel from './components/ForkPanel'
import PackPanel from './components/PackPanel'
import PortPanel from './components/PortPanel'
import DiagPanel from './components/DiagPanel'
import ModesPanel from './components/ModesPanel'
import EvolvePanel from './components/EvolvePanel'
import ModelsPanel from './components/ModelsPanel'
import ShaderPanel from './components/ShaderPanel'
import ClipPanel from './components/ClipPanel'
import LearnPanel from './components/LearnPanel'

/**
 * Every panel, grouped by the question it answers.
 *
 * Flat tabs stopped working at ten: they ran off the edge of the window and the
 * overflow could not be scrolled to, because the strip was a single non-wrapping
 * flex row. Grouping keeps the count per row small, and wrapping means the strip
 * grows downwards instead of outwards, so no tab can ever be off-screen.
 */
const TAB_GROUPS: { label: string; tabs: { id: RailTab; label: string; hint: string }[] }[] = [
  {
    label: 'Make',
    tabs: [
      { id: 'game', label: 'Game', hint: 'Game window, launch, vision' },
      { id: 'project', label: 'Build', hint: 'Build, jar, install and project files' },
      { id: 'port', label: 'Update', hint: 'Port an existing mod to another version or loader' }
    ]
  },
  {
    // Two tabs that are both "make the thing look like something". Kept out of
    // Make so that group stays at four — the cap is what stops a group
    // overflowing its row, which is the bug the wrapping tab strip fixed.
    label: 'Render',
    tabs: [
      { id: 'models', label: 'Models', hint: '3D block, item and mob models, plus animations' },
      { id: 'shaders', label: 'Shaders', hint: 'Shader packs and rendering engines, picked by use case' }
    ]
  },
  {
    label: 'Know',
    tabs: [
      { id: 'refs', label: 'References', hint: 'Reference mods and editable forks' },
      { id: 'learn', label: 'Lessons', hint: 'Mistakes the app has learned from' },
      { id: 'modes', label: 'Modes', hint: 'AutoSwitch, learning mode and deep research' }
    ]
  },
  {
    label: 'See',
    tabs: [
      { id: 'files', label: 'Shots', hint: 'Screenshots of the running game' },
      { id: 'clips', label: 'Clips', hint: 'Record gameplay and analyse it with a vision model' },
      { id: 'diag', label: 'Log', hint: 'Diagnostics at three levels of detail' }
    ]
  },
  {
    label: 'Grow',
    tabs: [
      { id: 'pack', label: 'Pack', hint: 'Update the mods in a modpack, dependencies included' },
      { id: 'evolve', label: 'Evolve', hint: 'Let the agent evolve its own prompt' }
    ]
  }
]

type RailTab =
  | 'game'
  | 'project'
  | 'files'
  | 'refs'
  | 'port'
  | 'pack'
  | 'clips'
  | 'learn'
  | 'modes'
  | 'evolve'
  | 'models'
  | 'shaders'
  | 'diag'

export default function App(): JSX.Element {
  const [config, setConfig] = useState<(AppConfig & { apiKeySet: boolean }) | null>(null)
  const [project, setProject] = useState<ProjectSummary | null>(null)
  const [conversations, setConversations] = useState<{ id: string; title: string; updatedAt: number }[]>([])
  const [activeConv, setActiveConv] = useState<string>('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState('')
  /** Live model reasoning, cleared each turn. Shown under the bubble when on. */
  const [thinking, setThinking] = useState('')
  /** System remarks from main (retries, warnings) shown inline in the chat. */
  const [notices, setNotices] = useState<{ id: string; text: string }[]>([])
  const [status, setStatus] = useState<string>('idle')
  const [statusDetail, setStatusDetail] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [permission, setPermission] = useState<PermissionPrompt | null>(null)
  const [game, setGame] = useState<GameStatus>({ running: false })
  /**
   * Show the solo-project reminder, once per session, only when idle.
   *
   * Counting the launch is deferred until nothing is happening: a reminder that
   * interrupts a build to ask for money is the pattern this deliberately avoids.
   * A ref keeps it to one check per session even across re-renders.
   */
  const [showLicence, setShowLicence] = useState(false)
  const licenceChecked = useRef(false)
  const [consoleLines, setConsoleLines] = useState<{ line: string; source: 'build' | 'game' }[]>([])
  const [toasts, setToasts] = useState<{ id: number; text: string; kind: 'ok' | 'err' }[]>([])
  const [showSetup, setShowSetup] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [railTab, setRailTab] = useState<RailTab>('game')
  /**
   * Width of the right-hand rail, dragged by the handle beside it. Persisted,
   * because a user who widened it once should not have to do it every launch.
   */
  const [sideWidth, setSideWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem('sideWidth'))
    return Number.isFinite(saved) && saved >= 200 ? saved : 268
  })
  useEffect(() => {
    localStorage.setItem('sideWidth', String(sideWidth))
  }, [sideWidth])

  /** Drag the sidebar divider. Same clamp rule as the rail. */
  const startSideDrag = useCallback(() => {
    const onMove = (e: MouseEvent): void => {
      const max = Math.max(220, window.innerWidth - 420)
      setSideWidth(Math.min(Math.max(e.clientX, 190), max))
    }
    const onUp = (): void => {
      document.body.classList.remove('resizing')
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    document.body.classList.add('resizing')
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  const [railWidth, setRailWidth] = useState<number>(() => {
    // The rail track has to hold the divider (6px) as well as the rail, because
    // `.main` is `chat | divider | rail`. A stored value that only just fits
    // the rail leaves the divider outside its track and clips the rail edge.
    const saved = Number(localStorage.getItem('railWidth'))
    return Number.isFinite(saved) && saved >= 300 ? saved : 380
  })
  const dragging = useRef(false)
  const railRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    localStorage.setItem('railWidth', String(railWidth))
  }, [railWidth])

  /**
   * Drag the divider between the chat and the rail.
   *
   * Clamped to what the window can actually show: dragging past the window edge
   * is how a panel ends up somewhere the user cannot reach it, which is the bug
   * this whole change is about.
   */
  const startDrag = useCallback(() => {
    dragging.current = true
    const onMove = (e: MouseEvent): void => {
      if (!dragging.current) return
      const right = window.innerWidth - e.clientX
      const max = Math.max(320, window.innerWidth - 360)
      setRailWidth(Math.min(Math.max(right, 300), max))
    }
    const onUp = (): void => {
      dragging.current = false
      document.body.classList.remove('resizing')
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    document.body.classList.add('resizing')
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [shots, setShots] = useState<ScreenshotInfo[]>([])
  const autoShotDone = useRef(false)

  const toast = useCallback((text: string, kind: 'ok' | 'err' = 'ok') => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, text, kind }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200)
  }, [])

  // ---------------- bootstrap ----------------
  useEffect(() => {
    void (async () => {
      const cfg = await api.config.get()
      setConfig(cfg)
      const summary = await api.project.summary()
      setProject(summary)
      const list = await api.chat.list()
      setConversations(list)
      if (list.length) {
        await loadConversation(list[0].id)
      } else {
        const conv = await api.chat.new()
        setActiveConv(conv.id)
        setMessages([])
      }
      setGame(await api.game.status())
      setShots(await api.game.screenshots())
      if (!cfg.workspaceDir || !summary.open) setShowSetup(false)
    })()
  }, [])

  const loadConversation = useCallback(async (id: string) => {
    const conv = await api.chat.load(id)
    if (!conv) return
    setActiveConv(id)
    setMessages(conv.messages)
    setStreaming('')
  }, [])

  // ---------------- events ----------------
  useEffect(() => {
    const offs = [
      // The user's message is echoed by main *after* it is persisted. Without
      // this the turn only appeared after a reload, because the renderer never
      // added it locally.
      api.events.onUserMessage((p) => {
        const msg = p as { id: string; role: 'user'; text: string; createdAt: number; attachments?: unknown }
        setMessages((msgs) => (msgs.some((m) => m.id === msg.id) ? msgs : [...msgs, msg as never]))
        setBusy(true)
      }),
      api.events.onAgentText((p) => setStreaming((s) => s + p.text)),
      api.diag.onThinking((p) => setThinking((t) => (t + p.text).slice(-6000))),
      // Main's own remarks, e.g. "the provider is busy, retrying". Shown in the
      // chat so a pause never looks like a hang, but never merged into the
      // model's answer.
      api.events.onNotice((p) =>
        setNotices((n) => [...n.slice(-4), { id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, text: p.text }])
      ),
      api.events.onAgentBlock((p) => {
        // Authoritative complete block from the SDK: store it. The streaming
        // buffer is deliberately NOT cleared here — it is the live view of the
        // whole run, and clearing it mid-run made earlier blocks disappear from
        // the screen until the next delta arrived.
        setMessages((msgs) => {
          const copy = [...msgs]
          const lastIdx = [...copy].reverse().findIndex((m) => m.role === 'assistant')
          if (lastIdx === -1) return msgs
          const idx = copy.length - 1 - lastIdx
          const prev = copy[idx].text
          copy[idx] = { ...copy[idx], text: prev ? `${prev}\n\n${p.text}` : p.text }
          return copy
        })
      }),
      api.events.onAssistantStart((p) => {
        // Do NOT clear the stream buffer here: deltas for the first tokens can
        // arrive before this event, and clearing would swallow them mid-word.
        const msg = p as { id: string; role: 'assistant'; text: string; createdAt: number }
        setBusy(true)
        setMessages((msgs) => (msgs.some((m) => m.id === msg.id) ? msgs : [...msgs, { ...msg, tools: [] } as never]))
      }),
      api.events.onStatus((p) => {
        setStatus(p.status)
        setStatusDetail(p.detail)
        if (p.status === 'idle') setBusy(false)
        if (p.status !== 'waiting-permission') setPermission(null)
      }),
      api.events.onToolStart((trace) => {
        setMessages((msgs) => {
          const copy = [...msgs]
          const lastIdx = [...copy].reverse().findIndex((m) => m.role === 'assistant')
          if (lastIdx === -1) return msgs
          const idx = copy.length - 1 - lastIdx
          const msg = { ...copy[idx], tools: [...(copy[idx].tools ?? []), trace] }
          copy[idx] = msg
          return copy
        })
      }),
      api.events.onToolEnd((p) => {
        setMessages((msgs) =>
          msgs.map((m) => ({
            ...m,
            tools: m.tools?.map((t) => (t.id === p.id ? { ...t, status: p.status, detail: p.detail, endedAt: Date.now() } : t))
          }))
        )
      }),
      api.events.onPermission((p) => setPermission(p)),
      api.events.onPermissionResolved(() => setPermission(null)),
      api.events.onResult((p) => {
        // End of run: drop the live buffer and show what main persisted.
        setStreaming('')
        setThinking('')
        setBusy(false)
        setMessages((msgs) => {
          const copy = [...msgs]
          const lastIdx = [...copy].reverse().findIndex((m) => m.role === 'assistant')
          if (lastIdx !== -1) {
            const idx = copy.length - 1 - lastIdx
            const existing = copy[idx].text
            // The persisted message is authoritative (main appended every block).
            // Only fall back to the result text when nothing was stored, so an
            // error summary cannot overwrite the answer that is already on screen.
            const text = existing || p.text
            copy[idx] = { ...copy[idx], text, costUsd: p.costUsd, error: p.isError ? p.text : undefined }
          }
          return copy
        })
        void api.chat.list().then(setConversations)
        if (p.isError) toast('The agent run ended with an error', 'err')
      }),
      api.modes.onModelSwitch((p) => {
        // Announce it where the user is looking: the chat they were reading.
        setNotices((n) => [...n.slice(-4), { id: `sw-${Date.now()}`, text: `AutoSwitch: ${p.from} → ${p.to} (${p.kind})` }])
        toast(`Switched model — ${p.to.split('/').slice(1).join('/')}`)
      }),
      api.events.onOutput((p) => setConsoleLines((c) => [...c.slice(-900), p])),
      api.events.onGameLine((p) => setConsoleLines((c) => [...c.slice(-900), { line: p.line, source: 'game' }])),
      api.events.onGameStatus((st) => {
        setGame(st)
        if (st.running && st.titleScreen && config?.game.autoScreenshot && !autoShotDone.current) {
          autoShotDone.current = true
          void api.game.screenshot('title screen').then(async () => setShots(await api.game.screenshots()))
        }
        if (!st.running) autoShotDone.current = false
      }),
      api.events.onScreenshot(() => void api.game.screenshots().then(setShots)),
      api.events.onBuildLine((p) => setConsoleLines((c) => [...c.slice(-900), { line: p.line, source: 'build' }])),
      api.events.onBuildDone(() => void refreshProject())
    ]
    return () => offs.forEach((off) => off())
  }, [config?.game.autoScreenshot, toast])

  const refreshProject = useCallback(async () => {
    setProject(await api.project.summary())
  }, [])

  const refreshGame = useCallback(async () => {
    setGame(await api.game.status())
  }, [])

  // ---------------- actions ----------------
  async function send(text: string, attachments: { path: string; name: string; kind: string; mediaType?: string }[]): Promise<void> {
    // Clear here, where the turn genuinely starts, rather than on a stream event.
    setStreaming('')
    setThinking('')
    setNotices([])
    setBusy(true)
    setStatus('thinking')
    const res = await api.chat.send({ text, attachments })
    if (!res.ok) {
      setBusy(false)
      toast(res.error ?? 'could not start the agent', 'err')
    }
  }

  async function newConversation(): Promise<void> {
    const conv = await api.chat.new()
    setActiveConv(conv.id)
    setMessages([])
    setStreaming('')
    setNotices([])
    setConversations(await api.chat.list())
  }

  async function setAutonomy(mode: 'auto' | 'review' | 'ask'): Promise<void> {
    if (!config) return
    setConfig({ ...config, autonomy: mode })
    await api.chat.autonomy(mode)
  }

  /**
   * Point the app at a project.
   *
   * This used to set `workspaceDir`, which is the project the mod was scaffolded
   * *into*. Switching to a fork therefore forgot where the real project lived, and
   * any screen still reading `workspaceDir` — the build, the agent — acted on the
   * fork instead. `activeDir` says "what is open"; `workspaceDir` keeps saying
   * "where this mod was made", and builds prefer the former.
   */
  async function afterProjectChange(dir: string): Promise<void> {
    const saved = await api.config.set({ activeDir: dir })
    setConfig(saved)
    await refreshProject()
    setConsoleLines([])
  }

  const instance = config?.game.instances.find((i) => i.id === config.game.activeInstanceId)
  const needsSetup = !config?.workspaceDir || project?.open === false

  if (!config) {
    return <div className="empty">Loading…</div>
  }

  return (
    <div className="app">
      <div className="titlebar">
        <div className="brand">
          <span className="dot" />
          MC Forge Agent <small>1.21.1 · NeoForge</small>
        </div>
        <div className={`status-pill ${game.running ? 'live' : ''}`}>
          <i />
          {game.running ? (game.titleScreen ? 'In game' : 'Game starting') : 'Game stopped'}
        </div>
        <div style={{ flex: 1 }} />
        <button className="small ghost" onClick={() => setShowSettings(true)}>
          Settings
        </button>
      </div>

      <aside className="sidebar">
        <div className="side-section" style={{ display: 'flex', gap: 6 }}>
          <button className="small" style={{ flex: 1 }} onClick={() => void newConversation()}>
            + New chat
          </button>
          <button className="small" onClick={() => setShowSetup(true)} title="Create a new Fabric, Forge or NeoForge project">
            New mod
          </button>
        </div>
        <div className="side-section">
          <div className="side-title">Project</div>
          {project?.open ? (
            <>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>{project.props?.mod_name}</div>
              <div style={{ fontSize: 11.5, color: 'var(--dim)', wordBreak: 'break-all' }}>{project.dir}</div>
              {config?.activeDir && config.activeDir !== config.workspaceDir ? (
                <div className="badge amber" style={{ marginTop: 6 }} title="Builds and the agent act on this folder">
                  active: fork{config.workspaceDir ? ' · project is elsewhere' : ''}
                </div>
              ) : null}
              <div style={{ display: 'flex', gap: 5, marginTop: 7, flexWrap: 'wrap' }}>
                <span className="badge">{project.props?.mod_id}</span>
                <span className="badge">MC {project.props?.minecraft_version}</span>
                <span className="badge">{loaderBadge(project.props ?? {})}</span>
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 9 }}>
                <button
                  className="small ghost"
                  onClick={async () => {
                    const dir = await api.dialog.pickFolder({ title: 'Open an existing mod project' })
                    if (dir) await afterProjectChange(dir)
                  }}
                >
                  Switch
                </button>
                <button className="small ghost" onClick={() => void api.game.openFolder()}>
                  Folder
                </button>
                {config?.activeDir && config.activeDir !== config.workspaceDir ? (
                  <button
                    className="small ghost"
                    title="Go back to the project this mod was created in"
                    onClick={() => void afterProjectChange('')}
                  >
                    Original project
                  </button>
                ) : null}
              </div>
            </>
          ) : (
            <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
              No project open.
              <button className="small" style={{ marginTop: 8, width: '100%' }} onClick={() => setShowSetup(true)}>
                Create a mod project
              </button>
              <button
                className="small ghost"
                style={{ marginTop: 6, width: '100%' }}
                onClick={async () => {
                  const dir = await api.dialog.pickFolder({ title: 'Open an existing mod project' })
                  if (dir) await afterProjectChange(dir)
                }}
              >
                Open folder
              </button>
            </div>
          )}
        </div>

        <div className="side-section">
          <div className="side-title">
            Test instance
            <button className="small ghost" onClick={() => setShowSettings(true)}>
              edit
            </button>
          </div>
          {instance ? (
            <>
              <div style={{ fontSize: 12.5 }}>{instance.name}</div>
              <div style={{ fontSize: 11, color: 'var(--dim)', wordBreak: 'break-all' }}>{instance.path}</div>
              <div style={{ display: 'flex', gap: 5, marginTop: 6 }}>
                <span className="badge">{instance.kind}</span>
                {instance.technicExe ? <span className="badge green">Technic found</span> : null}
              </div>
            </>
          ) : (
            <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
              None. Scan Technic or add a folder in Settings → Game.
            </div>
          )}
        </div>

        <div className="side-section" style={{ borderBottom: 'none' }}>
          <div className="side-title">Chats</div>
        </div>
        <div className="sidebar-scroll" style={{ padding: '0 8px 12px' }}>
          {conversations.map((c) => (
            <div key={c.id} className={`conv-item ${c.id === activeConv ? 'on' : ''}`} onClick={() => void loadConversation(c.id)}>
              <span>{c.title}</span>
            </div>
          ))}
        </div>
      </aside>

      <div
        className="resizer"
        onMouseDown={startSideDrag}
        title="Drag to resize"
        role="separator"
        aria-orientation="vertical"
      />
      <main className="main" style={{ ['--rail-width' as string]: `${railWidth}px` }}>
        <ChatPanel
          messages={messages}
          streamingText={streaming}
          liveThinking={thinking}
          notices={notices}
          liveLines={consoleLines.slice(-4)}
          hasKey={config.apiKeySet || config.provider === 'ollama'}
          status={status}
          statusDetail={statusDetail}
          busy={busy}
          autonomy={config.autonomy}
          permission={permission}
          onAutonomy={(m) => void setAutonomy(m)}
          onSend={send}
          onStop={() => {
            // Stopping leaves the reasoning buffer mid-thought; clear it so the
            // next turn does not open with the previous one's thoughts.
            setThinking('')
            void api.chat.interrupt()
          }}
          onPermission={(id, allow, remember) => void api.chat.permission({ id, allow, remember })}
          onOpenImage={setLightbox}
        />

        <div className="resizer" onMouseDown={startDrag} title="Drag to resize" role="separator" aria-orientation="vertical" />
        <div className="rail" ref={railRef}>
          {/* Tabs wrap and are grouped by what they are for. Ten flat tabs used
              to run off the right edge of the window, which made the last ones
              unreachable — a window cannot be resized past the monitor. */}
          <nav className="rail-tabs" aria-label="Panels">
            {TAB_GROUPS.map((group) => (
              <div className="rail-group" key={group.label}>
                <span className="rail-group-label">{group.label}</span>
                <div className="rail-group-items">
                  {group.tabs.map((t) => (
                    <button
                      key={t.id}
                      className={railTab === t.id ? 'on' : ''}
                      onClick={() => setRailTab(t.id)}
                      title={t.hint}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </nav>
          <div className="rail-body">
            {railTab === 'game' && (
              <GamePanel
                status={game}
                instance={instance}
                consoleLines={consoleLines}
                onRefreshStatus={() => void refreshGame()}
                onOpenImage={setLightbox}
                onToast={toast}
              />
            )}
            {railTab === 'project' && (
              <BuildPanel project={project} config={config} onRefreshProject={() => void refreshProject()} onOpenImage={setLightbox} onToast={toast} />
            )}
            {railTab === 'refs' && (
              <>
                <div className="card">
                  <h4>Reference mods</h4>
                  <ReferencePanel project={project} onToast={toast} onOpenProject={(dir) => void afterProjectChange(dir)} />
                </div>
                <div className="card">
                  <h4>Editable forks</h4>
                  <ForkPanel onToast={toast} onEditProject={(dir) => void afterProjectChange(dir)} />
                </div>
              </>
            )}
            {railTab === 'port' && (
              <PortPanel
                onToast={toast}
                onEditProject={(dir) => void afterProjectChange(dir)}
                activeDir={project?.open ? project.dir : undefined}
              />
            )}
            {railTab === 'pack' && <PackPanel onToast={toast} />}
            {railTab === 'modes' && (
              <div className="card">
                <h4>Modes</h4>
                <ModesPanel onToast={toast} onSend={(text) => void send(text, [])} />
              </div>
            )}
            {railTab === 'models' && (
              <div className="card">
                <h4>3D models &amp; animations</h4>
                <ModelsPanel onToast={toast} onSend={(text) => void send(text, [])} />
              </div>
            )}
            {railTab === 'shaders' && (
              <div className="card">
                <h4>Shaders &amp; rendering</h4>
                <ShaderPanel
                  onToast={toast}
                  onSend={(text) => void send(text, [])}
                  onRecordLook={() => setRailTab('clips')}
                />
              </div>
            )}
            {railTab === 'evolve' && (
              <div className="card">
                <h4>Evolving agent</h4>
                <EvolvePanel onToast={toast} />
              </div>
            )}
            {railTab === 'diag' && (
              <div className="card">
                <h4>Diagnostics</h4>
                <DiagPanel onToast={toast} />
              </div>
            )}
            {railTab === 'learn' && (
              <div className="card">
                <h4>Lessons from past mistakes</h4>
                <LearnPanel onToast={toast} />
              </div>
            )}
            {railTab === 'clips' && (
              <div className="card">
                <h4>Gameplay clips</h4>
                <ClipPanel
                  onToast={toast}
                  onOpenImage={setLightbox}
                  onSendToAgent={(text) => void send(text, [])}
                />
              </div>
            )}
            {railTab === 'files' && (
              <div className="card">
                <h4>Screenshots</h4>
                {shots.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--dim)' }}>The agent captures the game window when it tests.</div>}
                {shots.map((s) => (
                  <div key={s.path} style={{ marginBottom: 10 }}>
                    <img className="shot" src={`file://${s.path}`} onClick={() => setLightbox(s.path)} alt={s.label ?? ''} />
                    <div style={{ fontSize: 11, color: 'var(--dim)' }}>
                      {s.label ?? 'capture'} · {new Date(s.createdAt).toLocaleTimeString()}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </main>

      {showLicence && <LicenceReminder onClose={() => setShowLicence(false)} />}
      {showSetup && <SetupModal onClose={() => setShowSetup(false)} onCreated={(dir) => void afterProjectChange(dir)} onToast={toast} />}
      {showSettings && (
        <SettingsModal
          config={config}
          onClose={() => setShowSettings(false)}
          onSaved={(cfg) => {
            setConfig(cfg)
            void refreshProject()
          }}
          onOpenReferences={() => {
            setShowSettings(false)
            setRailTab('refs')
          }}
          onToast={toast}
        />
      )}

      {needsSetup && !showSetup && messages.length === 0 && (
        <div style={{ position: 'fixed', bottom: 18, left: '50%', transform: 'translateX(-50%)', zIndex: 20 }}>
          <button className="primary" onClick={() => setShowSetup(true)}>
            Create your first NeoForge 1.21.1 mod
          </button>
        </div>
      )}

      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)}>
          <img src={`file://${lightbox}`} alt="screenshot" />
        </div>
      )}

      <div style={{ position: 'fixed', bottom: 16, right: 16, display: 'flex', flexDirection: 'column', gap: 8, zIndex: 70 }}>
        {toasts.map((t) => (
          <div
            key={t.id}
            style={{
              background: t.kind === 'err' ? '#2a1414' : '#13241b',
              border: `1px solid ${t.kind === 'err' ? '#4a2626' : '#24402f'}`,
              color: t.kind === 'err' ? '#ffb3b3' : '#a9f0c6',
              padding: '9px 13px',
              borderRadius: 9,
              fontSize: 12.5,
              maxWidth: 420,
              boxShadow: '0 8px 24px rgba(0,0,0,0.35)'
            }}
          >
            {t.text}
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * One short badge naming the loader and its version. Older projects (and the
 * vendored 1.21.1 template) only carry `neo_version`, so that is the fallback
 * rather than an assumption that every project is NeoForge.
 */
function loaderBadge(props: Record<string, string | undefined>): string {
  const explicit = (props.mod_loader ?? '').toLowerCase()
  const loader =
    explicit || (props.loader_version && !props.neo_version && !props.forge_version ? 'fabric' : props.forge_version ? 'forge' : 'neoforge')
  const version =
    loader === 'fabric' ? props.loader_version : loader === 'forge' ? props.forge_version : props.neo_version
  const label = loader === 'fabric' ? 'Fabric' : loader === 'forge' ? 'Forge' : 'NeoForge'
  return version ? `${label} ${version}` : label
}
