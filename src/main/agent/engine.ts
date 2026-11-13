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
import { log, safeJson } from '../diag'

export interface EngineEvents {
  onAssistantText: (text: string) => void
  /** Model reasoning. Only emitted when the user has enabled thinking. */
  onThinking: (text: string) => void
  /** A complete assistant text block (authoritative, replaces streaming scratch). */
  onAssistantBlock: (text: string) => void
  onToolStart: (trace: ToolTrace) => void
  onToolEnd: (id: string, status: ToolTrace['status'], detail?: string) => void
  onPermissionRequest: (req: PermissionPrompt) => void
  onPermissionResolved: (id: string) => void
  onStatus: (status: 'idle' | 'thinking' | 'waiting-permission' | 'error', detail?: string) => void
  onResult: (payload: {
    text: string
    costUsd?: number
    isError?: boolean
    sessionId?: string
    errorText?: string
    /** Succeeded but the model wrote nothing. */
    empty?: boolean
  }) => void
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
  /** Reasoning accumulated since the last tool call or text block. */
  private thinking = ''
  /** Last subagent seen, so a tool call can be attributed to it. */
  private currentAgent = ''

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
      await this.runTurn()
    } catch (e) {
      // A real failure: surface a sentence the user can act on, not the SDK's
      // stack trace. The retry loop has already given up by the time we get here.
      const info = classifyRunError(e)
      this.events.onStatus('error', 'Failed')
      this.events.onResult({ text: '', isError: true, errorText: info.message })
      throw e
    } finally {
      this.busy = false
      if (!this.stopped) this.events.onStatus('idle')
    }
  }

  /**
   * Run one turn, retrying only failures worth retrying.
   *
   * An overloaded provider (HTTP 529) or a dropped connection is temporary, and
   * a couple of retries with backoff turn a dead run into a blip — the log this
   * came from showed a 529 ending the turn outright. A bad key or a missing
   * model is not temporary: retrying wastes the user's time and buries the real
   * message, so those fail immediately and verbatim.
   */
  private async runTurn(): Promise<void> {
    const MAX_ATTEMPTS = 3
    for (let attempt = 1; ; attempt++) {
      const q = query({ prompt: this.queue as AsyncIterable<any>, options: this.buildOptions() })
      this.current = q
      let failure: unknown = null
      try {
        for await (const msg of q) this.handleMessage(msg)
      } catch (e) {
        failure = e
      } finally {
        this.current = null
      }
      if (!failure) return
      if (this.stopped) throw failure

      const info = classifyRunError(failure)
      if (!info.retryable || attempt >= MAX_ATTEMPTS) throw failure

      // Say something: a silent pause looks like a hang, and the notice channel
      // keeps this out of the model's own words.
      this.events.onNotice(`The provider is busy. Retrying — attempt ${attempt + 1} of ${MAX_ATTEMPTS}…`)
      this.events.onStatus('thinking')
      await new Promise((r) => setTimeout(r, 1500 * attempt))
      if (this.stopped) throw failure
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
    // For local Ollama the role mapping wins over the single `model` field, so
    // the agent and its background alias can be different downloads.
    const localAgent = provider === 'ollama' ? cfg.local?.roles?.agent?.[0] ?? '' : ''
    const localQuick = provider === 'ollama' ? cfg.local?.roles?.quick?.[0] || localAgent : ''
    const model = localAgent || cfg.model || ''
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
    // providerEnv points every alias at the agent model; give the cheap alias its
    // own model when the user mapped one, or the SDK would load a second copy.
    if (provider === 'ollama' && localQuick && localQuick !== model) {
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = localQuick
    }
    if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl

    // Reasoning is off unless asked for: it costs tokens, and a model that is
    // told to think on every turn is slower with no gain for simple edits.
    //
    // Only Anthropic-shaped endpoints accept the thinking parameter. Sending it
    // to Ollama or a free gateway risks a hard 400 that would end every turn, so
    // the switch is honoured where it works and reported where it does not
    // rather than silently doing nothing.
    const thinkingSupported = provider === 'anthropic'
    const thinkingOn = thinkingSupported && !!cfg.showThinking && cfg.thinkingTokens > 0
    if (cfg.showThinking && !thinkingSupported) {
      log(
        'provider',
        'warn',
        `thinking requested but ${providerById(provider).label} does not accept the thinking parameter`,
        { provider, model },
        1
      )
    }

    return {
      cwd: workspace,
      model: model || undefined,
      ...(thinkingOn ? { maxThinkingTokens: cfg.thinkingTokens } : {}),
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
          providerNote: providerCaveats(provider, model || providerById(provider).label).join(' ')
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
    // Level 3: the raw SDK traffic. This is what turns "it said 0" into a
    // readable transcript, so it is logged before any interpretation below.
    log('sdk', msg.type === 'result' ? 'info' : 'raw', `${msg.type}${'subtype' in msg ? `:${(msg as { subtype?: string }).subtype ?? ''}` : ''}`, msg, 3)

    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init' && msg.session_id) this.sessionId = msg.session_id
        if (msg.subtype === 'init') {
          log('agent', 'info', 'session started', { sessionId: msg.session_id, model: (msg as { model?: string }).model }, 2)
        }
        break
      case 'stream_event': {
        // incremental text deltas for a live typing effect
        const ev = msg.event as {
          type?: string
          delta?: { type?: string; text?: string; thinking?: string }
        }
        if (ev.type === 'content_block_delta') {
          if (ev.delta?.type === 'text_delta' && ev.delta.text) {
            this.events.onAssistantText(ev.delta.text)
          } else if (ev.delta?.type === 'thinking_delta' && ev.delta.thinking) {
            this.thinking += ev.delta.thinking
            this.events.onThinking(ev.delta.thinking)
            log('stream', 'raw', 'thinking delta', { chars: ev.delta.thinking.length }, 3)
          }
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
        // Reasoning that arrived as a complete block rather than as deltas.
        const thinkingBlocks = blocks
          .filter((b) => b.type === 'thinking' && b.text)
          .map((b) => b.text as string)
          .join('')
        if (thinkingBlocks && !this.thinking) this.thinking = thinkingBlocks

        if (textContent) this.events.onAssistantBlock(textContent)
        for (const block of blocks) {
          if (block.type === 'tool_use' && block.id && block.name) {
            const name = block.name.replace('mcp__mcfrogeagent__', '')
            const trace = {
              id: block.id,
              name,
              input: block.input ?? {},
              status: 'running' as const,
              startedAt: Date.now(),
              ...(this.thinking ? { thinking: this.thinking.trim() } : {}),
              ...(this.currentAgent ? { agent: this.currentAgent } : {})
            }
            // Every tool call, with its arguments — level 2.
            log('tool', 'info', `→ ${name}`, trace.input, 2, trace.agent ? `agent=${trace.agent}` : undefined)
            this.events.onToolStart(trace)
            // Reasoning belongs to the call it produced, not to the next one.
            this.thinking = ''
          }
        }
        break
      }
      case 'user': {
        const blocks = (msg.message.content as { type: string; tool_use_id?: string; is_error?: boolean; content?: unknown }[]) ?? []
        for (const block of blocks) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            const detail = typeof block.content === 'string' ? block.content.slice(0, 800) : undefined
            log('tool', block.is_error ? 'error' : 'debug', `← ${block.tool_use_id} ${block.is_error ? 'failed' : 'ok'}`, block.content, block.is_error ? 1 : 2)
            this.events.onToolEnd(block.tool_use_id, block.is_error ? 'error' : 'ok', detail)
          }
        }
        break
      }
      case 'result': {
        const ok = msg.subtype === 'success'
        this.sessionId = msg.session_id
        const durationMs = (msg as { duration_ms?: number }).duration_ms
        const turns = (msg as { num_turns?: number }).num_turns
        const raw = ok ? msg.result : (msg as { errors?: string[] }).errors?.join('\n') ?? ''
        // A run that succeeded with nothing to say is a real state — the model
        // called tools and stopped without prose. Saying so beats an empty bubble
        // that looks like a crash, and at level 1+ it is written down.
        const empty = ok && !String(raw ?? '').trim()
        log(
          'agent',
          'info',
          `run ${ok ? 'finished' : 'failed'}`,
          { subtype: msg.subtype, durationMs, turns, costUsd: msg.total_cost_usd, empty, isError: msg.is_error },
          1
        )
        if (empty) {
          log(
            'agent',
            'warn',
            'the run produced no text — the model stopped after its tool calls',
            { sessionId: msg.session_id, turns, costUsd: msg.total_cost_usd },
            1
          )
        }
        this.events.onResult({
          text: empty ? 'The agent finished without writing a reply. Its tool calls above are the whole result.' : raw || 'Run failed.',
          costUsd: msg.total_cost_usd,
          isError: !ok || msg.is_error,
          sessionId: msg.session_id,
          empty
        })
        this.thinking = ''
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
 * Work out what a failed run actually was.
 *
 * The SDK surfaces provider errors as plain strings inside thrown errors, so
 * this is pattern-based by necessity — but it answers the two questions a user
 * has: *will waiting help?* and *what do I actually do?*
 */
export function classifyRunError(error: unknown): {
  kind: 'overloaded' | 'rate-limit' | 'auth' | 'network' | 'model' | 'context' | 'symlink' | 'unknown'
  retryable: boolean
  message: string
} {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const text = raw.replace(/\s+/g, ' ').trim()
  const has = (re: RegExp): boolean => re.test(text)

  // A symlink failure on Windows means Developer Mode is off. It appears in the
  // log while the SDK spawns a subagent, but the SDK *catches* it and falls back
  // to a plain file, so a run carrying this message has usually succeeded. Saying
  // so is the difference between "your app is broken" and "this is cosmetic".
  if (has(/EPERM.*symlink|symlink.*EPERM/i)) {
    return {
      kind: 'symlink',
      retryable: false,
      message:
        'Windows blocked a link the agent tried to create, which needs Developer Mode. The run itself is not ' +
        'affected. To silence the warnings: Windows Settings → Privacy & security → For developers → Developer Mode.'
    }
  }
  if (has(/\b529\b|overloaded_error|temporarily overloaded/i)) {
    return {
      kind: 'overloaded',
      retryable: true,
      message: 'The model provider is overloaded right now. Tried several times — wait a moment and send again.'
    }
  }
  if (has(/\b429\b|rate.?limit/i)) {
    return {
      kind: 'rate-limit',
      retryable: true,
      message: 'Rate limited by the provider. Free tiers are strict — wait a minute, or switch model in Settings.'
    }
  }
  if (has(/\b401\b|invalid x-api-key|authentication_error|api key was rejected/i)) {
    return { kind: 'auth', retryable: false, message: 'The API key was rejected. Check it in Settings → Model.' }
  }
  if (has(/\b402\b|credit balance|insufficient (credit|quota)/i)) {
    return {
      kind: 'auth',
      retryable: false,
      message: 'This account has no credit. Pick a free model in Settings → Model, or add credit with the provider.'
    }
  }
  if (has(/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up/i)) {
    return {
      kind: 'network',
      retryable: true,
      message: 'Could not reach the provider. Check your connection — and if you are on Ollama, that it is running.'
    }
  }
  if (has(/model.*(not found|does not exist)|\b404\b/i)) {
    return {
      kind: 'model',
      retryable: false,
      message: 'That model is not available from this provider. Use Refresh in Settings → Model for the current list.'
    }
  }
  if (has(/context (window|length)|too many tokens|prompt is too long/i)) {
    return {
      kind: 'context',
      retryable: false,
      message: 'The conversation is longer than the model can hold. Start a new chat, or use a larger-context model.'
    }
  }
  return { kind: 'unknown', retryable: false, message: text.slice(0, 600) || 'The run failed.' }
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
