import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChatMessage, PermissionPrompt, ToolTrace } from '../../../shared/types'
import { api } from '../lib/api'
import { renderMarkdown } from '../lib/markdown'

interface AttachmentDraft {
  path: string
  name: string
  kind: 'image' | 'file'
  mediaType?: string
  preview?: string
}

interface Props {
  messages: ChatMessage[]
  streamingText: string
  /** System remarks from main (retries, warnings), shown inline. */
  notices?: { id: string; text: string }[]
  /** Last few build/game output lines, shown under the streaming bubble. */
  liveLines?: { line: string; source: 'build' | 'game' }[]
  /** False when no provider key is configured, which unlocks the free-model hint. */
  hasKey?: boolean
  status: string
  statusDetail?: string
  busy: boolean
  autonomy: 'auto' | 'review' | 'ask'
  permission: PermissionPrompt | null
  onAutonomy: (m: 'auto' | 'review' | 'ask') => void
  onSend: (text: string, attachments: AttachmentDraft[]) => Promise<void>
  onStop: () => void
  onPermission: (id: string, allow: boolean, remember: boolean) => void
  onOpenImage: (path: string) => void
}

const TOOL_LABEL: Record<string, string> = {
  Read: 'Reading',
  Write: 'Writing',
  Edit: 'Editing',
  MultiEdit: 'Editing',
  Glob: 'Finding files',
  Grep: 'Searching',
  LS: 'Listing',
  Bash: 'Shell',
  Task: 'Delegating',
  WebSearch: 'Web search',
  WebFetch: 'Fetching',
  project_info: 'Inspecting project',
  env_report: 'Checking toolchain',
  build: 'Building',
  install: 'Installing jar',
  launch_game: 'Launching game',
  game_status: 'Checking game',
  screenshot: 'Taking screenshot',
  read_log: 'Reading game log',
  stop_game: 'Stopping game',
  export_technic_pack: 'Exporting pack',
  list_screenshots: 'Listing screenshots'
}

function summarizeInput(name: string, input: Record<string, unknown>): string {
  const pick = (k: string): string => (typeof input?.[k] === 'string' ? (input[k] as string) : '')
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return pick('file_path')
    case 'Bash':
      return pick('command').slice(0, 120)
    case 'Glob':
    case 'Grep':
      return [pick('pattern'), pick('path')].filter(Boolean).join('  in  ')
    case 'Task':
      return `${pick('subagent_type')} — ${pick('description')}`
    case 'build':
      return `${pick('mode') || 'local'} ${pick('task') || 'build'}`
    case 'install':
      return 'latest jar → instance mods'
    default: {
      const entries = Object.entries(input ?? {}).slice(0, 2)
      return entries.map(([k, v]) => `${k}=${String(v).slice(0, 60)}`).join(' ')
    }
  }
}

export default function ChatPanel({
  messages,
  streamingText,
  notices = [],
  liveLines,
  hasKey = true,
  status,
  statusDetail,
  busy,
  autonomy,
  permission,
  onAutonomy,
  onSend,
  onStop,
  onPermission,
  onOpenImage
}: Props): JSX.Element {
  const [input, setInput] = useState('')
  const [drafts, setDrafts] = useState<AttachmentDraft[]>([])
  const bodyRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const lastAssistantId = useMemo(() => [...messages].reverse().find((m) => m.role === 'assistant')?.id, [messages])
  const lastAssistant = messages.find((m) => m.id === lastAssistantId)

  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 140
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [messages, streamingText, status])

  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      const items = e.clipboardData?.items
      if (!items) return
      for (const item of items) {
        if (!item.type.startsWith('image/')) continue
        const file = item.getAsFile()
        if (file) void addImageBlob(file)
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [])

  async function addImageBlob(blob: Blob): Promise<void> {
    const buf = await blob.arrayBuffer()
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)))
    const name = (blob as File).name || `pasted-${Date.now()}.png`
    const saved = await api.chat.attachImage({ base64, name })
    setDrafts((d) => [...d, { path: saved.path, name: saved.name, kind: 'image', mediaType: blob.type || 'image/png', preview: `data:${blob.type};base64,${base64}` }])
  }

  async function pickFiles(): Promise<void> {
    const files = await api.dialog.pickFiles({ title: 'Attach files or screenshots', multi: true })
    for (const f of files) {
      const saved = await api.chat.attachFile(f)
      const isImage = /\.(png|jpe?g|webp|gif)$/i.test(f)
      setDrafts((d) => [
        ...d,
        { path: saved.path, name: saved.name, kind: isImage ? 'image' : 'file', mediaType: isImage ? 'image/png' : undefined }
      ])
    }
  }

  async function submit(): Promise<void> {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    const toSend = drafts
    setDrafts([])
    await onSend(text, toSend)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <div className="chat">
      <div className="chat-head">
        <span className="title">Agent</span>
        <span className={`status-pill ${busy ? 'warn' : 'live'}`}>
          <i />
          {status === 'waiting-permission' ? 'waiting for approval' : busy ? (statusDetail || 'working') : 'idle'}
        </span>
        <div style={{ flex: 1 }} />
        <div className="autonomy" title="How much the agent may do without asking">
          <button className={autonomy === 'review' ? 'on' : ''} onClick={() => onAutonomy('review')}>
            Review
          </button>
          <button className={autonomy === 'ask' ? 'on blue' : ''} onClick={() => onAutonomy('ask')}>
            Ask
          </button>
          <button className={autonomy === 'auto' ? 'on amber' : ''} onClick={() => onAutonomy('auto')}>
            Auto
          </button>
        </div>
        {busy && (
          <button className="small danger" onClick={onStop}>
            Stop
          </button>
        )}
      </div>

      <div className="chat-body" ref={bodyRef}>
        <div className="chat-inner">
          {messages.length === 0 && (
            <div className="empty">
              <h2>Make a mod</h2>
              <div>Describe what you want in plain language. The agent inspects the project, writes the NeoForge code, builds the jar, launches the game and looks at it.</div>
              <div className="steps">
                <div>• “Add a ruby ore that spawns underground and drops a ruby gem”</div>
                <div>• “Make the ruby item edible and give it a glowing enchant glint”</div>
                <div>• “The game crashed on launch — read the log and fix it”</div>
                <div>• “Take a screenshot of the title screen and check the mod loaded”</div>
              </div>
              {!hasKey && (
                <div className="free-hint">
                  No API key yet? Settings → Model has free models from Z.ai and OpenRouter that need no credit
                  card, and the agent's tools and live output work exactly the same. Ollama is also an option if
                  you would rather run a model on your own machine — Settings → Local models checks your hardware
                  first and will tell you honestly if it will not fit.
                </div>
              )}
            </div>
          )}

          {messages.map((m) => {
            const isStreamingTarget = m.id === lastAssistantId && busy
            const text = isStreamingTarget && streamingText ? streamingText : m.text
            return (
              <div key={m.id} className={`msg ${m.role}`}>
                <div className="avatar">{m.role === 'user' ? 'YOU' : 'AI'}</div>
                <div className="bubble">
                  <div className="meta">
                    {m.role === 'user' ? 'You' : 'Agent'}
                    {m.costUsd ? ` · $${m.costUsd.toFixed(3)}` : ''}
                  </div>
                  {(text || m.tools?.length) && (
                    <div className="content">
                      {text ? <div dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} /> : null}
                      {m.tools?.map((t) => <ToolRow key={t.id} trace={t} />)}
                      {isStreamingTarget && !text && !m.tools?.length && status === 'thinking' && (
                        <span className="thinking-dots">
                          <i />
                          <i />
                          <i />
                        </span>
                      )}
                      {m.error && <div style={{ color: 'var(--red)', marginTop: 6 }}>{m.error}</div>}
                    </div>
                  )}
                  {m.attachments?.length ? (
                    <div className="attachments">
                      {m.attachments
                        .filter((a) => a.kind === 'image')
                        .map((a) => (
                          <img key={a.path} className="thumb" src={`file://${a.path}`} onClick={() => onOpenImage(a.path)} alt={a.name} />
                        ))}
                    </div>
                  ) : null}
                </div>
              </div>
            )
          })}

          {/* Main's own remarks: a retry, a warning. Kept visually distinct from
              the model's words so nothing here is mistaken for an answer. */}
          {notices.map((n) => (
            <div key={n.id} className="notice-row">
              <span className="notice-dot" />
              {n.text}
            </div>
          ))}

          {/* Live build/game output, inline: a build can take a minute and the
              chat should show it is doing something without a tab switch. */}
          {busy && (liveLines?.length ?? 0) > 0 && (
            <div className="live-lines">
              {liveLines!.map((l, i) => (
                <div key={i} className={`live-line ${l.source}`}>
                  <span className="src">{l.source === 'build' ? 'build' : 'game'}</span>
                  {l.line}
                </div>
              ))}
            </div>
          )}

          {lastAssistant && busy && streamingText && lastAssistant.id !== messages[messages.length - 1]?.id && (
            <div className="msg assistant">
              <div className="avatar">AI</div>
              <div className="bubble">
                <div className="content" dangerouslySetInnerHTML={{ __html: renderMarkdown(streamingText) }} />
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="composer">
        <div className="composer-inner">
          <div className="composer-box">
            {drafts.length > 0 && (
              <div className="attach-list">
                {drafts.map((d, i) => (
                  <div className="attach-chip" key={`${d.path}-${i}`}>
                    {d.preview ? <img src={d.preview} alt="" /> : <span>📎</span>}
                    <span>{d.name.slice(0, 24)}</span>
                    <button onClick={() => setDrafts((list) => list.filter((_, j) => j !== i))}>×</button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              value={input}
              placeholder={busy ? 'Agent is working…' : 'Describe the mod change, paste a crash log, or attach a screenshot'}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={busy}
            />
            <div className="composer-row">
              <button className="small ghost" onClick={() => void pickFiles()} title="Attach files or images">
                Attach
              </button>
              <button className="small ghost" onClick={() => fileRef.current?.click()} title="Attach an image">
                Image
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => {
                  for (const f of Array.from(e.target.files ?? [])) void addImageBlob(f)
                  e.target.value = ''
                }}
              />
              <div className="composer-hint">Enter to send · Shift+Enter for a new line</div>
              <button className="primary small" disabled={busy || !input.trim()} onClick={() => void submit()}>
                Send
              </button>
            </div>
          </div>
        </div>
      </div>

      {permission && <PermissionModal prompt={permission} onAnswer={onPermission} />}
    </div>
  )
}

function ToolRow({ trace }: { trace: ToolTrace }): JSX.Element {
  const label = TOOL_LABEL[trace.name] ?? trace.name
  return (
    <div className="tool-row">
      <span className="name">{label}</span>
      <span className="arg">{summarizeInput(trace.name, trace.input)}</span>
      <span className={`state ${trace.status}`}>
        {trace.status === 'running' ? '···' : trace.status === 'ok' ? 'done' : trace.status === 'error' ? 'failed' : 'denied'}
      </span>
    </div>
  )
}

function PermissionModal({ prompt, onAnswer }: { prompt: PermissionPrompt; onAnswer: (id: string, allow: boolean, remember: boolean) => void }): JSX.Element {
  const [remember, setRemember] = useState(false)
  const label = TOOL_LABEL[prompt.toolName] ?? prompt.toolName.replace('mcp__mcfrogeagent__', '')
  return (
    <div className="permission">
      <div className="box">
        <h3>Approve: {label}</h3>
        <p>{prompt.reason || 'The agent wants to run this. Approve only if it looks right.'}</p>
        <pre>{JSON.stringify(prompt.input, null, 2).slice(0, 4000)}</pre>
        <label style={{ display: 'flex', gap: 7, alignItems: 'center', fontSize: 12.5, color: 'var(--muted)', marginBottom: 14 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Always allow {label} for this conversation
        </label>
        <div className="actions">
          <button onClick={() => onAnswer(prompt.id, false, false)}>Deny</button>
          <button className="primary" onClick={() => onAnswer(prompt.id, true, remember)}>
            Allow
          </button>
        </div>
      </div>
    </div>
  )
}
