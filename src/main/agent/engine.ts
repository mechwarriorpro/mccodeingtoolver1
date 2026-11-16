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
import { effectiveRunTarget, isSwitchWorthy, nextModel, type SwitchTarget } from './autoswitch'
import { briefProject, learningPrompt, researchPrompt, runMode, saveResearch, loadResearch } from './modes'
import { candidatePrompt } from '../evolve/candidate'
import { checkUpdatedJar, completionVerdict, countRemainingBreakages } from '../mod/update-plan'
import { findBuiltJar } from '../build/gradle'
import { detectProject } from '../mod/port'

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
  /** The model changed mid-conversation, and why. */
  onModelSwitch: (info: { from: string; to: string; provider: string; reason: string; kind: string }) => void
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
  /**
   * When the current turn started, in epoch ms. Null when nothing is running.
   *
   * The renderer used to keep its own clock and start it on whichever event
   * happened to arrive first, which meant a window reloaded mid-turn showed no
   * time at all. Main is the only process that knows when the turn really
   * began, so it keeps the number and the UI asks for it.
   */
  private turnStartedAt: number | null = null
  /**
   * Set by `handleMessage` when a result message says the turn was cut short
   * rather than finished. `runTurn` reads it and resumes instead of ending.
   */
  private interruption: Interruption | null = null

  /**
   * Read the pending interruption through a method.
   *
   * A plain field read is narrowed by the compiler to `null` after the
   * assignment at the top of the loop, because it cannot see that
   * `handleMessage` writes it during iteration — the classic false narrowing on
   * a mutable field. A getter is opaque to that analysis.
   */
  private takeInterruption(): Interruption | null {
    return this.interruption
  }
  private stopped = false
  /** Did the last local build in this turn succeed? Null when none ran. */
  private lastBuildOk: boolean | null = null
  /** How many times this turn has been resumed to reach a finished jar. */
  private updateResumes = 0
  /** Breakages the update plan named that are still unresolved. */
  private unresolvedBreakages = 0
  /**
   * The version/loader the user asked to reach, from the last plan_update.
   *
   * Without this the automode stopping rule validates the jar against the
   * project's own property, which is exactly the value an unfinished update has
   * not changed yet — so a stale jar would be declared finished.
   */
  private updateTarget: { mcVersion: string; loader: 'neoforge' | 'forge' | 'fabric' } | null = null
  private events: EngineEvents
  private getInstanceId: () => string
  /** Reasoning accumulated since the last tool call or text block. */
  private thinking = ''
  /** Last subagent seen, so a tool call can be attributed to it. */
  private currentAgent = ''
  /**
   * The model this turn is running on. Normally the configured one; AutoSwitch
   * replaces it mid-turn, and the replacement sticks for the rest of the
   * conversation so a dead free tier does not have to be rediscovered each turn.
   */
  private override: SwitchTarget | null = null
  /** provider/model pairs tried this turn, so the chain walks forward. */
  private triedThisTurn = new Set<string>()

  constructor(events: EngineEvents, autonomy: AutonomyMode, sessionId: string | undefined, getInstanceId: () => string) {
    this.events = events
    this.permissionMode = autonomy
    this.sessionId = sessionId
    this.getInstanceId = getInstanceId
  }

  get active(): boolean {
    return this.busy
  }

  /**
   * What the UI needs to draw the pill honestly.
   *
   * A reloaded window has no event history, so without an explicit ask it draws
   * "idle" over a turn that is halfway through a build — and there is no Stop
   * button either, because that is gated on the same flag. `startedAt` is main's
   * own clock rather than the renderer's guess at when things began.
   */
  get state(): { busy: boolean; startedAt: number | null } {
    return { busy: this.busy, startedAt: this.turnStartedAt }
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
    /*
     * `busy` alone is not the whole story: `interrupt()` clears it the moment
     * the user presses Stop, while the run it interrupted is still unwinding
     * and `current` is still set. A message accepted in that window was pushed
     * onto a queue nobody would ever read again — the turn ended, the pill said
     * idle, and the user's follow-up silently never ran.
     */
    if (this.busy || this.current) throw new Error('The agent is already running. Interrupt it first.')
    this.busy = true
    this.turnStartedAt = Date.now()
    this.stopped = false
    // Per-turn, not per-session: a new request starts with a clean scoreboard.
    this.lastBuildOk = null
    this.updateResumes = 0
    this.unresolvedBreakages = 0
    this.updateTarget = null
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
      /*
       * The turn's one and only exit.
       *
       * `runTurn` deliberately does not announce idle — it can start another
       * run the instant it returns — so this is the only place that knows the
       * work is over. `turnStartedAt` is cleared with it: a stale start time
       * would make the next turn's clock begin hours ago.
       */
      this.busy = false
      this.turnStartedAt = null
      if (!this.stopped) this.events.onStatus('idle')
    }
  }

  /**
   * In automode, is the job actually finished?
   *
   * "Keep working until a stable jar meeting all criteria is met" is a
   * statement about the *state of the project*, not about how long the model
   * feels like talking. So the decision is made by reading the disk: did the
   * last build succeed, is there a jar, and does that jar pass its checks.
   *
   * Deliberately returns `done` in every case where there is no evidence of
   * unfinished work — no build ever attempted, no jar, nothing the plan flagged.
   * A chat turn in automode must not be trapped in a loop by a gate that only
   * knows how to say "not finished yet".
   */
  private automodeVerdict(cfg: ReturnType<typeof loadConfig>): { done: boolean; reason: string; resumePrompt?: string } {
    // Only automode keeps itself honest; review and ask exist to hand control back.
    if (this.permissionMode !== 'auto') return { done: true, reason: 'not automode' }

    let buildOk: boolean | null = null
    try {
      buildOk = this.lastBuildOk
    } catch {
      buildOk = null
    }
    // Nothing has been built in this turn: the user asked a question or the work
    // is not a build job, and looping would be wrong.
    if (buildOk === null) return { done: true, reason: 'no build attempted in this turn' }

    let jar = null
    let remaining = 0
    let target = { mcVersion: '1.21.1', loader: 'neoforge' as 'neoforge' | 'forge' | 'fabric' }
    try {
      const ws = cfg.workspaceDir
      if (ws) {
        const props = readProps(path.join(ws, 'gradle.properties'))
        // The version asked for outranks the one the property still says.
        target = this.updateTarget ?? { mcVersion: detectMcVersion(props), loader: detectLoader(props) }
        const detected = detectProject(ws)
        const built = findBuiltJar(ws)
        jar = checkUpdatedJar(built ?? null, target, { expectedModId: detected.modId })
        // Re-scan rather than trusting the plan's snapshot: a count that is
        // never recomputed either never reaches zero (resuming forever) or is
        // already zero because nothing updated it (finishing too early).
        remaining = this.unresolvedBreakages > 0 ? countRemainingBreakages(ws, detected.sourceRoot || 'src/main/java', { mcVersion: detected.mcVersion, loader: detected.loader }, target) : 0
      }
    } catch {
      // A check that cannot run must not invent a reason to keep going.
      return { done: true, reason: 'could not inspect the project' }
    }

    return completionVerdict({ buildOk, jar, remainingBreakages: remaining, resumes: this.updateResumes, maxResumes: MAX_UPDATE_RESUMES })
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
    const cfg = loadConfig()
    const target = this.override ?? effectiveRunTarget(cfg)
    this.triedThisTurn = new Set([`${target.provider}/${target.model}`])
    /**
     * How many times this turn has been picked back up after being cut short.
     * Separate from `attempt`, which counts provider retries — a run can exhaust
     * both, and conflating them would stop resuming after one busy provider.
     */
    let continuations = 0

    for (let attempt = 1; ; attempt++) {
      const q = query({ prompt: this.queue as AsyncIterable<any>, options: this.buildOptions() })
      this.current = q
      let failure: unknown = null
      this.interruption = null
      try {
        for await (const msg of q) this.handleMessage(msg)
      } catch (e) {
        failure = e
      } finally {
        this.current = null
      }

      /**
       * Cut short, not broken: queue the work back up and run again.
       *
       * The user is told what happened and the resume is announced, because a
       * silent second run looks like the agent ignored its own output. After
       * MAX_CONTINUATIONS the turn stops and says so — an agent that keeps
       * hitting the ceiling without converging is a real problem, not a hiccup.
       */
      // Read through a local: TypeScript cannot see that `handleMessage` mutates
      // this field, so it narrows `this.interruption` to `never` after the null
      // assignment above.
      const pending = this.takeInterruption()
      if (!failure && pending?.continuable) {
        const interruption = pending
        this.interruption = null
        if (this.stopped) return
        if (continuations >= MAX_CONTINUATIONS) {
          const notice = `Stopped after ${MAX_CONTINUATIONS} continuations — the task needs more turns than a single run allows. Split it into smaller requests, or ask it to finish the current file first.`
          log('agent', 'warn', 'continuation limit reached', { kind: interruption.kind, continuations }, 1)
          this.events.onNotice(notice)
          this.events.onResult({ text: notice, isError: false })
          this.events.onStatus('idle')
          this.busy = false
          this.turnStartedAt = null
          return
        }
        continuations++
        log('agent', 'info', 'continuing after interruption', { kind: interruption.kind, continuation: continuations }, 1)
        this.events.onNotice(interruption.notice)
        // Say what it is doing, not just that it is doing something: "working"
        // for four minutes with no reason is what makes the pill untrustworthy.
        this.events.onStatus('thinking', `continuing (${continuations}/${MAX_CONTINUATIONS})`)
        this.queue.push({
          type: 'user',
          session_id: this.sessionId ?? '',
          message: { role: 'user', content: [{ type: 'text', text: continuationPrompt(interruption, continuations) }] },
          parent_tool_use_id: null
        })
        // A fresh query, so the turn ceiling and budget restart — that is the
        // whole point of continuing rather than extending one run.
        attempt = 0
        continue
      }

      /**
       * Automode does not stop just because the model went quiet.
       *
       * The user's definition of finished is a stable jar meeting every
       * criterion, so that — not the model's closing sentence — decides whether
       * the turn is over. The verdict reads the project on disk: a failing
       * build, a jar that fails its checks, or breakages the plan named and
       * nobody fixed. If there is no evidence either way the turn ends normally,
       * because trapping an ordinary question in a loop would be worse.
       */
      if (!failure && !this.stopped) {
        const verdict = this.automodeVerdict(cfg)
        if (!verdict.done) {
          if (this.updateResumes >= MAX_UPDATE_RESUMES) {
            const notice = `Stopped after ${MAX_UPDATE_RESUMES} attempts to finish: ${verdict.reason}. Everything that was completed is saved — check the build log for the last error, or tell it what to do differently.`
            log('agent', 'warn', 'automode gave up short of a finished jar', { reason: verdict.reason }, 1)
            this.events.onNotice(notice)
            this.events.onResult({ text: notice, isError: false })
            this.events.onStatus('idle')
            this.busy = false
            this.turnStartedAt = null
            return
          }
          this.updateResumes++
          log('agent', 'info', 'automode continuing toward a finished jar', { reason: verdict.reason, resume: this.updateResumes }, 1)
          this.events.onNotice(`Not finished yet — ${verdict.reason}. Continuing (attempt ${this.updateResumes} of ${MAX_UPDATE_RESUMES}).`)
          this.events.onStatus('thinking', `${verdict.reason} — attempt ${this.updateResumes}/${MAX_UPDATE_RESUMES}`)
          this.queue.push({
            type: 'user',
            session_id: this.sessionId ?? '',
            message: { role: 'user', content: [{ type: 'text', text: verdict.resumePrompt ?? 'Keep going until the build is green and the jar passes its checks.' }] },
            parent_tool_use_id: null
          })
          attempt = 0
          continue
        }
      }

      if (!failure) return
      if (this.stopped) throw failure

      const info = classifyRunError(failure)
      log('provider', info.retryable ? 'warn' : 'error', `run failed: ${info.kind}`, { message: info.message }, 1)

      // A retry on the same model is right for a blip (529, dropped socket). It
      // is pointless when the account is empty or the model is gone: waiting
      // cannot put credit back. Those go straight to another model.
      if (info.retryable && attempt < MAX_ATTEMPTS) {
        // Say something: a silent pause looks like a hang, and the notice
        // channel keeps this out of the model's own words.
        this.events.onNotice(`The provider is busy. Retrying — attempt ${attempt + 1} of ${MAX_ATTEMPTS}…`)
        this.events.onStatus('thinking', `retrying (${attempt}/${MAX_ATTEMPTS})`)
        await new Promise((r) => setTimeout(r, 1500 * attempt))
        if (this.stopped) throw failure
        continue
      }

      // AutoSwitch: carry the turn on with a different model rather than ending
      // it. This is the difference between "your chat died because the free tier
      // ran out" and "the app finished the job on another free model".
      if (isSwitchWorthy(info.kind, failure)) {
        const next = nextModel(cfg, target, this.triedThisTurn)
        if (next) {
          const from = `${providerById(target.provider).label} ${target.model}`
          const to = `${providerById(next.provider).label} ${next.model}`
          log('provider', 'warn', `AutoSwitch ${from} → ${to}`, { reason: info.message, kind: info.kind, why: next.why }, 1)
          this.events.onNotice(`Switching model — ${next.why}. ${from} → ${next.model}.`)
          this.events.onModelSwitch({
            from: `${target.provider}/${target.model}`,
            to: `${next.provider}/${next.model}`,
            provider: next.provider,
            reason: info.message,
            kind: info.kind
          })
          this.override = next
          this.triedThisTurn.add(`${next.provider}/${next.model}`)
          attempt = 0
          continue
        }
        // Nothing left to try. Say why in terms of the chain, not the raw error.
        this.events.onNotice(
          cfg.autoSwitch
            ? 'AutoSwitch ran out of models to try. Add a key for another provider in Settings, or wait for the free tier to reset.'
            : 'AutoSwitch is off — turning it on would have carried this turn on another free model.'
        )
      }
      throw failure
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
    this.turnStartedAt = null
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
      // Both of these feed the automode stopping rule. They are the only way the
      // engine learns the difference between "the model says it is done" and
      // "the build is green and the jar passes".
      onBuildResult: (info) => {
        this.lastBuildOk = info.ok
      },
      onUpdatePlan: (info) => {
        this.unresolvedBreakages = info.breakages
        if (info.mcVersion && info.loader) this.updateTarget = { mcVersion: info.mcVersion, loader: info.loader }
      },
      onGameStatus: (status) => this.events.onGameStatus(status)
    })
    const agents = buildAgents({ modId: props.mod_id ?? '', workspaceDir: workspace, instancePath: instance?.path })

    // Which model this turn actually runs on. Deep research deliberately picks
    // the strongest available regardless of cost; AutoSwitch may have replaced
    // the model after a failure. Both are visible in the chat, never silent.
    const configured = effectiveRunTarget(cfg)
    const target = this.override ?? { provider: configured.provider, model: configured.model, label: '', free: false, why: '' }

    const baseUrl = this.override ? providerBaseUrlFor(this.override.provider) : effectiveBaseUrl()
    const provider = target.provider as ProviderId
    const apiKey = this.override ? keyForProvider(cfg, this.override.provider) : effectiveApiKey()
    // For local Ollama the role mapping wins over the single `model` field, so
    // the agent and its background alias can be different downloads.
    const localAgent = provider === 'ollama' ? cfg.local?.roles?.agent?.[0] ?? '' : ''
    const localQuick = provider === 'ollama' ? cfg.local?.roles?.quick?.[0] || localAgent : ''
    const model = target.model || localAgent || cfg.model || ''
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
          providerNote: providerCaveats(provider, model || providerById(provider).label).join(' '),
          // Learning and research change the job, not just the tone, so they are
          // appended as instructions rather than as a hint.
          modeBlock: this.modeBlock(cfg)
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
      // A ceiling exists so a runaway loop cannot spend without limit, but it is
      // high enough that ordinary multi-file work finishes in one run: the old
      // 120 was hit mid-build regularly, and each hit used to end the turn.
      maxTurns: MAX_TURNS_PER_RUN,
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

  /** The mode instructions for this turn, with the project filled in. */
  private modeBlock(cfg: ReturnType<typeof loadConfig>): string {
    const props = readProps(path.join(cfg.workspaceDir, 'gradle.properties'))
    return modePromptFor(cfg, {
      dir: cfg.workspaceDir,
      loader: detectLoader(props),
      mcVersion: detectMcVersion(props),
      modId: props.mod_id ?? ''
    })
  }

  /**
   * Run one prompt and return the text, with no tools and no transcript.
   *
   * This exists for the evolution harness: it needs to run a *mutated* prompt
   * and get back whatever the model wrote, without touching the user's chat, the
   * user's workspace, or the permission system. Tools are removed rather than
   * denied, so a prompt injected into a test task cannot run a command no matter
   * what it says.
   */
  async askOnce(prompt: string, opts: { genomeDir?: string } = {}): Promise<string> {
    const cfg = loadConfig()
    const provider = (cfg.provider || 'anthropic') as ProviderId
    const localAgent = provider === 'ollama' ? cfg.local?.roles?.agent?.[0] ?? '' : ''
    const model = localAgent || cfg.model || ''
    const isElectronRuntime = !!process.versions.electron
    const env: Record<string, string | undefined> = {
      ...process.env,
      CLAUDE_CODE_ENTRYPOINT: 'mcfrogeagent',
      ...(isElectronRuntime && !process.env.CLAUDE_CODE_PATH ? { ELECTRON_RUN_AS_NODE: '1' } : {})
    }
    Object.assign(env, providerEnv(provider, effectiveApiKey(), model))
    const baseUrl = effectiveBaseUrl()
    if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl

    // The candidate's own prompt is used verbatim, so the mutation is what is
    // being tested. A fallback keeps generation 0 evaluable before the genome
    // exists.
    const systemPrompt = opts.genomeDir ? await candidatePrompt(opts.genomeDir) : undefined

    const q = query({
      prompt,
      options: {
        cwd: cfg.workspaceDir || process.cwd(),
        model: model || undefined,
        ...(systemPrompt ? { systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt } } : {}),
        // No tools at all: the answer is the artifact, and the compiler is the judge.
        allowedTools: [],
        mcpServers: {},
        maxTurns: 1,
        permissionMode: 'default',
        persistSession: false,
        includePartialMessages: false,
        env,
        ...(isElectronRuntime
          ? {
              pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_PATH || resolveBundledCli(),
              executable: process.execPath as 'node',
              executableArgs: []
            }
          : {})
      }
    })
    let text = ''
    for await (const msg of q) {
      if (msg.type === 'result') {
        if (msg.subtype === 'success') text = msg.result
        else throw new Error((msg as { errors?: string[] }).errors?.join('\n') || 'the run failed')
        break
      }
    }
    return text
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
        /**
         * A turn can end without finishing and without failing.
         *
         * The SDK reports `error_max_turns` and `error_max_budget_usd` with
         * `is_error: false` and no error list. Treating those as failures is
         * what made the agent stop mid-build and say "Run failed." — nothing had
         * failed, it had run out of turns. They are recorded here and resumed by
         * `runTurn`; only a genuinely fatal result ends the turn.
         */
        const interruption = ok ? null : classifyInterruption(msg as { subtype?: string; is_error?: boolean; num_turns?: number; errors?: string[] })
        if (interruption?.continuable) {
          this.interruption = interruption
          this.sessionId = msg.session_id
          break
        }
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
        /*
         * Deliberately NOT `onStatus('idle')` here.
         *
         * A `result` message ends one *run*, and `runTurn` may immediately start
         * another — a continuation after a cut-short run, another attempt at
         * automode's unfinished jar, a retry after a busy provider. Announcing
         * idle at this point told the user the agent had stopped while it was
         * still working, which is exactly what makes it impossible to tell the
         * difference. The turn's own end announces idle, in `send()`'s `finally`
         * — one place, and only when it is true.
         */
        break
      }
      default:
        break
    }
  }
}

/**
 * The key that belongs to a provider.
 *
 * Only the vision provider has a key of its own today; everything else uses the
 * main one, which is what Settings tells the user to set. Keeping this in one
 * place means AutoSwitch cannot accidentally send an Ollama request with an
 * Anthropic key attached.
 */
function keyForProvider(cfg: ReturnType<typeof loadConfig>, provider: ProviderId): string {
  if (providerById(provider).local) return ''
  if (provider === (cfg.visionProvider as ProviderId) && cfg.visionProviderKey) return cfg.visionProviderKey
  return cfg.apiKey
}

function providerBaseUrlFor(provider: ProviderId): string {
  return providerById(provider).baseUrl
}

/**
 * The instruction block for learning or deep research, or nothing in normal use.
 * Built from the project so the modes talk about *this* mod rather than modding
 * in general.
 */
function modePromptFor(cfg: ReturnType<typeof loadConfig>, ctx: { dir: string; loader: string; mcVersion: string; modId: string }): string {
  const mode = runMode(cfg)
  if (mode === 'code') return ''
  const brief = briefProject(ctx)
  if (mode === 'research') {
    const state = loadResearch()
    const topic = state?.topic || cfg.researchTopic || 'the area the user last asked about'
    return researchPrompt(topic, brief)
  }
  return learningPrompt(brief)
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

/* ------------------------------------------------------------------ continuity */

/**
 * A run that ended without finishing, but which was not the user's fault or a
 * provider failure: the agent hit its turn ceiling, its budget, or the SDK
 * stopped mid-execution.
 *
 * The distinction matters more than the error text. These are not errors to
 * report and stop on — the work is half done and the right move is to carry on.
 * A 401 or a bad key is the opposite: retrying cannot fix it, and hiding it
 * behind a "continuing…" message wastes the user's time.
 */
export type InterruptionKind = 'max-turns' | 'budget' | 'execution' | 'fatal'

export interface Interruption {
  kind: InterruptionKind
  /** True when resuming is worth doing without asking. */
  continuable: boolean
  /** What to tell the user, in a sentence they can act on. */
  notice: string
  /** The prompt used to pick the work back up. Never mentions failure. */
  resumePrompt?: string
}

/**
 * Read a `result` message and decide whether the turn was cut short.
 *
 * The SDK reports `error_max_turns` with `is_error: false` and an **empty**
 * `errors` array, which is why this app used to end the turn with the words "Run
 * failed." while the agent was in the middle of a build. Nothing had failed; it
 * had simply reached the 120-turn ceiling.
 */
export function classifyInterruption(msg: {
  subtype?: string
  is_error?: boolean
  num_turns?: number
  errors?: string[]
}): Interruption {
  switch (msg.subtype) {
    case 'error_max_turns':
      return {
        kind: 'max-turns',
        continuable: true,
        notice: `The agent reached its ${msg.num_turns ?? 120}-turn limit partway through. Continuing where it left off — say stop if you would rather it did not.`,
        resumePrompt:
          'You were cut off at the turn limit while still working. Look at what is actually on disk now and carry on from there — do not restart the task or repeat steps that already succeeded.'
      }
    case 'error_max_budget_usd':
      return {
        kind: 'budget',
        continuable: true,
        notice: 'The agent hit the spending cap for this run. It will carry on — raise the cap in Settings if you would rather it ran uninterrupted.',
        resumePrompt:
          'You were stopped by the per-run spending cap, not by a problem with the work. Continue from where you stopped; keep tool calls lean and avoid repeating reads you have already done.'
      }
    case 'error_during_execution':
      // The SDK's own wrapper: it means "the loop threw", so the cause is in
      // `errors`. If there is a cause worth retrying, the caller sees it as a
      // normal failure instead.
      return {
        kind: msg.errors?.length ? 'fatal' : 'execution',
        continuable: !msg.errors?.length,
        notice: msg.errors?.length
          ? (msg.errors[0] ?? 'The run failed.')
          : 'The agent stopped mid-step without saying why. Continuing.',
        resumePrompt: msg.errors?.length
          ? undefined
          : 'The previous step ended without a result. Check the state of the files and continue the task.'
      }
    case 'success':
      return { kind: 'fatal', continuable: false, notice: '' }
    default:
      return {
        kind: msg.is_error ? 'fatal' : 'execution',
        continuable: false,
        notice: (msg.errors ?? []).join('\n') || 'The run stopped.'
      }
  }
}

/**
 * How many times one turn may be resumed before giving up.
 *
 * Three is enough to get through a long refactor split across turn ceilings, and
 * few enough that a genuine loop — an agent that keeps hitting the ceiling
 * without converging — is reported rather than burning the user's credit
 * indefinitely. Each resume is announced, so it is never silent.
 */
export const MAX_CONTINUATIONS = 3

/**
 * Turns allowed in a single run.
 *
 * This is a *safety valve*, not a work limit — `runTurn` resumes when it is hit
 * (`MAX_CONTINUATIONS` times, with the user told each time). 400 is roughly a
 * long refactor: the old 120 was reached mid-build often enough that it read as
 * the agent giving up.
 */
export const MAX_TURNS_PER_RUN = 400

/**
 * How many times automode may resume to reach a finished jar.
 *
 * Separate from `MAX_CONTINUATIONS` because it is a different promise. Those
 * three resumes exist so a long refactor is not cut in half by a turn ceiling.
 * These exist so "keep working until the jar is stable" cannot be satisfied by
 * the model *saying* it is stable. When they run out the user is told what is
 * still wrong, in the words of the failed check — not just "it stopped".
 */
export const MAX_UPDATE_RESUMES = 6

/**
 * The synthetic turn that resumes work.
 *
 * Deliberately terse and non-alarming: the model has already seen its own tool
 * results, and a long explanation of the interruption invites it to re-read
 * everything it just read.
 */
export function continuationPrompt(interruption: Interruption, attempt: number): string {
  const base = interruption.resumePrompt ?? 'Continue the task from where you stopped.'
  return attempt === 1 ? base : `${base}\n\n(This is continuation ${attempt} of ${MAX_CONTINUATIONS} in this turn. Be economical: fewer, larger tool calls.)`
}
