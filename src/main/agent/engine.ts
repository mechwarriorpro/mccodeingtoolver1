import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { query, type Options, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { effectiveApiKey, effectiveBaseUrl, loadConfig } from '../config'
import type { AutonomyMode, PermissionPrompt, ToolTrace } from '../../shared/types'
import { AsyncQueue } from '../util/async'
import { buildAgents, coordinatorPrompt } from './orchestrator'
import { buildSystemPrompt } from './prompt'
import { providerEnv, providerCaveats, providerById, type ProviderId } from '../providers'
import { createAgentTools, readProps } from './tools'
import { listReferences } from '../github/references'

export interface EngineEvents {
  onAssistantText: (text: string) => void
  /** A complete assistant text block (authoritative, replaces streaming scratch). */
  onAssistantBlock: (text: string) => void
  onToolStart: (trace: ToolTrace) => void
  onToolEnd: (id: string, status: ToolTrace['status'], detail?: string) => void
  onPermissionRequest: (req: PermissionPrompt) => void
  onPermissionResolved: (id: string) => void
  onStatus: (status: 'idle' | 'thinking' | 'waiting-permission' | 'error', detail?: string) => void
  onResult: (payload: { text: string; costUsd?: number; isError?: boolean; sessionId?: string }) => void
  onNotice: (text: string) => void
  onOutput: (line: string, source: 'build' | 'game') => void
  onGameStatus: (status: import('../../shared/types').GameStatus) => void
}

interface PendingPermission {
  id: string
  toolName: string
  input: Record<string, unknown>
  resolve: (allow: boolean, remember: boolean) => void
}

/** Read-only tools that are always safe to run. */
const SAFE_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'NotebookRead',
  'TodoWrite',
  'WebSearch',
  'WebFetch',
  'Task',
  'mcp__mcfrogeagent__project_info',
  'mcp__mcfrogeagent__env_report',
  'mcp__mcfrogeagent__game_status',
  'mcp__mcfrogeagent__read_log',
  'mcp__mcfrogeagent__list_screenshots',
  'mcp__mcfrogeagent__screenshot',
  'mcp__mcfrogeagent__list_reference_mods',
  'mcp__mcfrogeagent__search_reference',
  'mcp__mcfrogeagent__reference_status'
])

const SAFE_SHELL = [
  /^\s*(ls|dir|cat|type|head|tail|wc|pwd|git (status|log|diff|show|branch|rev-parse)|java -version|javac -version|gh (auth status|run list|run view|repo view))\b/i
]

export class AgentSession {
  private queue = new AsyncQueue<unknown>()
  private current: Query | null = null
  private pending = new Map<string, PendingPermission>()
  private permissionMode: AutonomyMode
  private sessionId: string | undefined
  private allowAllSession = new Set<string>()
  private busy = false
  private stopped = false
  private events: EngineEvents
  private getInstanceId: () => string

  constructor(events: EngineEvents, autonomy: AutonomyMode, sessionId: string | undefined, getInstanceId: () => string) {
    this.events = events
    this.permissionMode = autonomy
    this.sessionId = sessionId
    this.getInstanceId = getInstanceId
  }

  get active(): boolean {
    return this.busy
  }

  setAutonomy(mode: AutonomyMode): void {
    this.permissionMode = mode
    this.current?.setPermissionMode(this.mapMode(mode)).catch(() => undefined)
  }

  private mapMode(mode: AutonomyMode): 'default' | 'acceptEdits' | 'bypassPermissions' {
    if (mode === 'auto') return 'bypassPermissions'
    if (mode === 'review') return 'acceptEdits' // file edits auto; shell asks
    return 'default'
  }

  /** Send a user turn. Resolves when the result message arrives. */
  async send(prompt: string, images: { path: string; mediaType: string }[] = []): Promise<void> {
    if (this.busy) throw new Error('The agent is already running. Interrupt it first.')
    this.busy = true
    this.stopped = false
    this.events.onStatus('thinking')
    try {
      const content: unknown[] = []
      for (const img of images) {
        try {
          content.push({
            type: 'image',
            source: { type: 'base64', media_type: img.mediaType, data: fs.readFileSync(img.path).toString('base64') }
          })
        } catch {
          /* skip unreadable image */
        }
      }
      content.push({ type: 'text', text: prompt })

      this.queue.push({
        type: 'user',
        session_id: this.sessionId ?? '',
        message: { role: 'user', content },
        parent_tool_use_id: null
      })

      // Already streaming: the message rides the open input queue.
      if (this.current) return

      // Interrupting closes the backend session, so a new one is started for the next turn.
      const q = query({ prompt: this.queue as AsyncIterable<any>, options: this.buildOptions() })
      this.current = q
      try {
        for await (const msg of q) this.handleMessage(msg)
      } finally {
        this.current = null
      }
    } catch (e) {
      const message = (e as Error).message
      this.events.onStatus('error', message)
      this.events.onResult({ text: '', isError: true })
      throw e
    } finally {
      this.busy = false
      if (!this.stopped) this.events.onStatus('idle')
    }
  }

  /** Stop the current run. The conversation continues on the next message. */
  async interrupt(): Promise<void> {
    this.stopped = true
    try {
      await this.current?.interrupt()
    } catch {
      /* ignore */
    }
    for (const [, p] of this.pending) p.resolve(false, false)
    this.pending.clear()
    this.busy = false
    this.events.onStatus('idle')
  }

  respondPermission(id: string, allow: boolean, remember: boolean): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    if (allow && remember) this.allowAllSession.add(p.toolName)
    p.resolve(allow, remember)
    this.events.onPermissionResolved(id)
    this.events.onStatus(allow ? 'thinking' : 'thinking')
  }

  private buildOptions(): Options {
    const cfg = loadConfig()
    const workspace = cfg.workspaceDir
    const props = readProps(path.join(workspace, 'gradle.properties'))
    const instance = cfg.game.instances.find((i) => i.id === this.getInstanceId())
    const server = createAgentTools({
      getWorkspace: () => cfg.workspaceDir,
      getInstanceId: () => this.getInstanceId(),
      notify: (channel, payload) => this.events.onNotice(JSON.stringify({ channel, payload })),
      onOutput: (line, source) => this.events.onOutput(line, source),
      onGameStatus: (status) => this.events.onGameStatus(status)
    })
    const agents = buildAgents({ modId: props.mod_id ?? '', workspaceDir: workspace, instancePath: instance?.path })

    const apiKey = effectiveApiKey()
    const baseUrl = effectiveBaseUrl()
    const provider = (cfg.provider || 'anthropic') as ProviderId
    const model = cfg.model || ''
    // The SDK spawns the Claude Code CLI with a JS runtime. In a packaged build there is
    // no system Node, but the Electron binary itself can run as Node when this is set.
    const isElectronRuntime = !!process.versions.electron
    const env: Record<string, string | undefined> = {
      ...process.env,
      CLAUDE_CODE_ENTRYPOINT: 'mcfrogeagent',
      ...(isElectronRuntime && !process.env.CLAUDE_CODE_PATH ? { ELECTRON_RUN_AS_NODE: '1' } : {})
    }
    // The provider decides auth and model aliases. `providerEnv` empties
    // ANTHROPIC_API_KEY for third parties so a paid Anthropic key is never sent
    // to another host, and forces the model alias so free models are not asked
    // for as "claude-sonnet-...".
    Object.assign(env, providerEnv(provider, apiKey, model))
    if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl

    return {
      cwd: workspace,
      model: cfg.model || undefined,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: `${buildSystemPrompt({
          references: listReferences()
            .filter((m) => m.decompiled)
            .map((m) => ({ title: m.title, slug: m.slug, version: m.version, licence: m.license })),
          githubSignedIn: !!(cfg.github.owner && cfg.github.repo),
          modId: props.mod_id ?? '',
          workspaceDir: workspace,
          autonomy: this.permissionMode,
          instancePath: instance?.path,
          instanceKind: instance?.kind,
          githubOwner: cfg.github.owner,
          githubRepo: cfg.github.repo,
          loader: detectLoader(props),
          mcVersion: detectMcVersion(props),
          providerNote: providerCaveats(provider, cfg.model || providerById(provider).label).join(' ')
        })}\n\n${coordinatorPrompt()}`
      },
      settingSources: ['user', 'project', 'local'],
      agents,
      mcpServers: { mcfrogeagent: { type: 'sdk', name: 'mcfrogeagent', instance: server.instance } },
      allowedTools: [
        'Read',
        'Write',
        'Edit',
        'MultiEdit',
        'Glob',
        'Grep',
        'LS',
        'TodoWrite',
        'Task',
        'WebFetch',
        'WebSearch',
        'mcp__mcfrogeagent'
      ],
      permissionMode: this.mapMode(this.permissionMode),
      ...(this.permissionMode === 'auto' ? { allowDangerouslySkipPermissions: true } : {}),
      canUseTool: this.buildCanUseTool(),
      includePartialMessages: true,
      maxTurns: 120,
      maxBudgetUsd: cfg.maxBudgetUsd > 0 ? cfg.maxBudgetUsd : undefined,
      persistSession: true,
      resume: this.sessionId && !this.sessionId.startsWith('local-') ? this.sessionId : undefined,
      env,
      ...(isElectronRuntime
        ? {
            pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_PATH || resolveBundledCli(),
            // Electron's binary is the "node" that runs the CLI.
            executable: process.execPath as 'node',
            executableArgs: []
          }
        : {})
    }
  }

  private buildCanUseTool() {
    return async (toolName: string, input: Record<string, unknown>): Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }> => {
      // Auto mode: allow everything the CLI asks about.
      if (this.permissionMode === 'auto') return { behavior: 'allow', updatedInput: input }

      // Safe read-only tools never prompt.
      if (SAFE_TOOLS.has(toolName)) return { behavior: 'allow', updatedInput: input }

      // Bash: review mode auto-allows read-only commands.
      if (toolName === 'Bash' && this.permissionMode === 'review') {
        const cmd = String(input.command ?? '')
        if (SAFE_SHELL.some((re) => re.test(cmd))) return { behavior: 'allow', updatedInput: input }
      }

      // Edits in review mode are auto-approved by the SDK's acceptEdits mode.
      if (this.permissionMode === 'review' && ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
        return { behavior: 'allow', updatedInput: input }
      }

      // App tools (build/install/launch) are allowed in review mode for local work.
      if (this.permissionMode === 'review' && toolName.startsWith('mcp__mcfrogeagent__')) {
        return { behavior: 'allow', updatedInput: input }
      }

      if (this.allowAllSession.has(toolName)) return { behavior: 'allow', updatedInput: input }

      const id = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      this.events.onStatus('waiting-permission', toolName)
      const allow = await new Promise<boolean>((resolve) => {
        this.pending.set(id, { id, toolName, input, resolve: (ok) => resolve(ok) })
        this.events.onPermissionRequest({ id, toolName, input, createdAt: Date.now() })
      })
      return allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'The user denied this action.' }
    }
  }

  private handleMessage(msg: SDKMessage): void {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init' && msg.session_id) this.sessionId = msg.session_id
        break
      case 'stream_event': {
        // incremental text deltas for a live typing effect
        const ev = msg.event as { type?: string; delta?: { type?: string; text?: string } }
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          this.events.onAssistantText(ev.delta.text)
        }
        break
      }
      case 'assistant': {
        const blocks = msg.message.content as { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[]
        // Without partial streaming, the full assistant text arrives here; use it as the floor
        // so the renderer shows the complete answer even if no deltas were delivered.
        const textContent = blocks
          .filter((b) => b.type === 'text' && b.text)
          .map((b) => b.text as string)
          .join('')
        if (textContent) this.events.onAssistantBlock(textContent)
        for (const block of blocks) {
          if (block.type === 'tool_use' && block.id && block.name) {
            this.events.onToolStart({
              id: block.id,
              name: block.name.replace('mcp__mcfrogeagent__', ''),
              input: block.input ?? {},
              status: 'running',
              startedAt: Date.now()
            })
          }
        }
        break
      }
      case 'user': {
        const blocks = (msg.message.content as { type: string; tool_use_id?: string; is_error?: boolean; content?: unknown }[]) ?? []
        for (const block of blocks) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            this.events.onToolEnd(block.tool_use_id, block.is_error ? 'error' : 'ok', typeof block.content === 'string' ? block.content.slice(0, 800) : undefined)
          }
        }
        break
      }
      case 'result': {
        const ok = msg.subtype === 'success'
        this.sessionId = msg.session_id
        this.events.onResult({
          text: ok ? msg.result : (msg as { errors?: string[] }).errors?.join('\n') ?? 'Run failed.',
          costUsd: msg.total_cost_usd,
          isError: !ok || msg.is_error,
          sessionId: msg.session_id
        })
        this.busy = false
        this.events.onStatus('idle')
        break
      }
      default:
        break
    }
  }
}

/**
 * Locate Claude Code's CLI. The SDK is bundled into out/main (it is ESM-only, so it
 * cannot be require()d from a CJS bundle), but the CLI is a real file that must be
 * spawned, so electron-builder keeps the package outside the asar.
 */
function resolveBundledCli(): string {
  const candidates = [
    // packaged: asarUnpack puts the SDK on disk next to app.asar
    path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js'),
    // packaged without unpacking (works because cli.js ships inside the asar too)
    path.join(process.resourcesPath, 'app', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js'),
    path.join(process.resourcesPath, 'app.asar', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js'),
    // dev
    path.join(app.getAppPath(), 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js')
  ]
  const found = candidates.find((p) => fs.existsSync(p))
  if (!found) {
    // Fail with the search path, not a confusing ENOENT from spawn.
    throw new Error(`Claude Code CLI not found. Looked in:\n${candidates.join('\n')}`)
  }
  return found
}

/* ------------------------------------------------------------------ project */

/**
 * Which loader this project targets, from gradle.properties. Older projects (and
 * the vendored NeoForge template) only carry `neo_version`, so that is the
 * default rather than an assumption of "neoforge always".
 */
export function detectLoader(props: Record<string, string>): 'neoforge' | 'forge' | 'fabric' {
  const explicit = (props.mod_loader ?? props.loader ?? '').toLowerCase()
  if (explicit === 'fabric' || explicit === 'forge' || explicit === 'neoforge') return explicit
  if (props.loader_version && !props.neo_version && !props.forge_version) return 'fabric'
  if (props.forge_version) return 'forge'
  return 'neoforge'
}

export function detectMcVersion(props: Record<string, string>): string {
  return props.minecraft_version || props.mc_version || props.minecraftVersion || '1.21.1'
}
