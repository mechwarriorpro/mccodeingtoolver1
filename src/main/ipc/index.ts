import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { AgentSession } from '../agent/engine'
import {
  attachDiagSink,
  clearDiagHistory,
  diagHistory,
  diagLogPath,
  getDiagLevel,
  levelName,
  log,
  parseLevel,
  safeJson,
  setDiagLevel,
  setDiagLogPath,
  type DiagLevel
} from '../diag'
import { effectiveApiKey, effectiveBaseUrl, loadConfig, redactConfig, saveConfig, screenshotsDir, attachmentsDir } from '../config'
import type {
  AppConfig,
  ChatMessage,
  Conversation,
  EnvReport,
  GameInstance,
  GameStatus,
  GithubStatus,
  PermissionPrompt,
  ReferenceModUi
} from '../../shared/types'
import {
  authFilePath,
  authToken,
  awaitDeviceApproval,
  beginDeviceFlow,
  beginWebFlow,
  fetchUser,
  loginWithToken,
  logout as githubLogout,
  openVerificationPage,
  readAuth,
  redactAuth
} from '../github/oauth'
import {
  addFromFile,
  addFromGithub,
  ensureReferenceIgnored,
  getReference,
  linkToProject,
  listReferences,
  listReleases,
  parseRepoRef,
  pickModJar,
  readReferenceFile,
  referenceTree,
  removeReference,
  searchReference
} from '../github/references'
import { deleteConversation, listConversations, loadConversation, newConversationId, saveConversation } from '../store'
import { validateModId, validatePackage, templateRoot } from '../mod/scaffold'
import { generateProject } from '../mod/generate'
import {
  type Loader,
  cachedCatalog,
  getCatalog,
  loadersFor,
  loaderVersionsFor,
  MIN_MC_VERSION,
  selectableVersions
} from '../versions/catalog'
import { resolveEra } from '../versions/eras'
import { resolveVisionModel } from '../game/vision'
import {
  BUNDLES,
  CONTEXT_CHOICES,
  LOCAL_MODELS,
  LOCAL_ROLES,
  bundleById,
  cancelPull,
  contextForVram,
  detectGpus,
  detectSystem,
  modelById,
  suitability,
  verdictFor,
  defaultModelsDir,
  findOllama,
  freeSpaceGb,
  hasBundledInstaller,
  installInProgress,
  installOllama,
  primaryGpu,
  probeOllama,
  pullModel,
  roleFit,
  startOllamaServe,
  type BundleId
} from '../local'
import { KNOWN_MODELS, PROVIDERS, DEFAULT_MODELS, discoverModels, requiresKey, type ProviderId } from '../providers'
import { clearLessons, confirmLesson, listLessons, recall, retireLesson } from '../learn'
import {
  MAX_CLIP_MS,
  analyseClip,
  attachAnalysis,
  clipDigest,
  deleteClip,
  getClip,
  isRecording,
  listClips,
  startClip,
  stopClip
} from '../game/clip'
import { captureFrameBuffer } from '../game/capture'
import {
  countForkSources,
  createFork,
  getFork,
  listForks,
  loadForks,
  removeFork,
  suggestedTarget,
  touchFork
} from '../mod/fork'
import { convertProject, detectProject, migrationReport, planPort } from '../mod/port'
import { detectLoader, detectMcVersion } from '../agent/engine'
import { readProps } from '../mod/props'
import { assetLayout, blockstateJson } from '../mod/assets'
import { QUADRUPED_BONES, animationJson, blockModelJson, entityModelJson, modelPaths, quadrupedWalk, writeModels } from '../mod/models'
import { textureFile, textureRef } from '../mod/texture-ref'
import { PATTERNS, PALETTES, texturePathFor, texturePng } from '../mod/textures'
import { rendererSupport, realismVerdict } from '../mod/renderer'
import { USE_CASES, catalogueFor, compatibilityNotes, fullCatalogue, recommend, type UseCase } from '../mod/shader-stack'
import { bestAvailable, describeRunTarget } from '../agent/autoswitch'
import { loadResearch, researchDir, saveResearch, runMode } from '../agent/modes'
import { knowledgeOn } from '../learn'
import { bestGeneration, evolveMany, ensureBaseline, loadStore, saveStore } from '../evolve/loop'
import { DEFAULT_RULES, rulesToInstructions } from '../evolve/metrics'
import { activeGeneration, promote } from '../evolve/genome'
import {
  checkForUpdates,
  clearUpdaterCache,
  currentUpdateState,
  initUpdater,
  downloadUpdate,
  installUpdate,
  setAutoUpdate,
  updatesSupported,
  versionLabel
} from '../update'
import { isGradleProject, runLocalBuild, buildLogPath, findBuiltJar, gitSummary } from '../build/gradle'
import { ghPreflight, initGithubRepo, runActionsBuild } from '../build/actions'
import { readJarInfo, installJar } from '../mod/jar'
import { detectTechnicInstances, buildTechnicPackZip, launchTechnic } from '../game/technic'
import { gameStatus, launchDevClient, onGameLog, onGameStatus, readGameLog, stopGame } from '../game/launcher'
import { captureGameWindow, listScreenshots } from '../game/capture'
import { clearJavaCache, probeJava, resolveJava, resolveToolJava, run } from '../util/exec'
import { installNeoForge, isNeoForgeInstalled } from '../game/neoforge'
import { launchNeoForge, runningGame, stopNeoForge } from '../game/client'
import { send } from './windows'

let session: AgentSession | null = null
let currentConversation: Conversation | null = null
let instanceOverride = ''

function conversation(): Conversation {
  if (!currentConversation) {
    currentConversation = {
      id: newConversationId(),
      title: 'New conversation',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: []
    }
  }
  return currentConversation
}

function persist(): void {
  if (!currentConversation) return
  currentConversation.updatedAt = Date.now()
  if (currentConversation.title === 'New conversation') {
    const firstUser = currentConversation.messages.find((m) => m.role === 'user')
    if (firstUser) currentConversation.title = firstUser.text.slice(0, 60) || 'New conversation'
  }
  saveConversation(currentConversation)
}

function ensureSession(): AgentSession {
  if (session) return session
  const cfg = loadConfig()
  session = new AgentSession(
    {
      onAssistantText: (text) => send('agent:text', { text }),
      onThinking: (text) => {
        // Kept out of the transcript unless the user asked to see it, but stored
        // so the diagnostic panel and a saved conversation can show it later.
        const conv = conversation()
        const last = [...conv.messages].reverse().find((m) => m.role === 'assistant')
        if (last) {
          last.thinking = (last.thinking ?? '') + text
          if (last.thinking.length > 20000) last.thinking = last.thinking.slice(-20000)
        }
        send('agent:thinking', { text })
      },
      onAssistantBlock: (text) => {
        // Complete block: write it onto the assistant message so a cancelled stream
        // or a missed delta never loses the answer.
        const conv = conversation()
        const last = [...conv.messages].reverse().find((m) => m.role === 'assistant')
        if (last) {
          last.text = last.text ? `${last.text}

${text}` : text
          send('agent:block', { text })
          persist()
        }
      },
      onToolStart: (trace) => {
        const conv = conversation()
        const last = [...conv.messages].reverse().find((m) => m.role === 'assistant')
        if (last) {
          last.tools = last.tools ?? []
          last.tools.push(trace)
        }
        send('agent:tool-start', trace)
      },
      onToolEnd: (id, status, detail) => {
        const conv = conversation()
        for (const m of conv.messages) {
          const tool = m.tools?.find((t) => t.id === id)
          if (tool) {
            tool.status = status
            tool.detail = detail
            tool.endedAt = Date.now()
          }
        }
        send('agent:tool-end', { id, status, detail })
      },
      onPermissionRequest: (req: PermissionPrompt) => send('agent:permission', req),
      onPermissionResolved: (id) => send('agent:permission-resolved', { id }),
      onStatus: (status, detail) => send('agent:status', { status, detail }),
      onResult: (payload) => {
        const conv = conversation()
        const last = [...conv.messages].reverse().find((m) => m.role === 'assistant')
        if (last) {
          if (!last.text && payload.text) last.text = payload.text
          last.costUsd = payload.costUsd
          // A run that wrote nothing still gets a sentence, so the conversation
          // does not reopen as an empty bubble.
          if (payload.empty && !last.text) last.text = payload.text
          // Prefer the classified sentence over the raw SDK text: the chat
          // should say what to do, not print a stack trace.
          if (payload.isError) last.error = payload.errorText || payload.text || 'The run failed.'
        }
        conv.sessionId = payload.sessionId ?? conv.sessionId
        persist()
        send('agent:result', payload)
      },
      // System remarks (retries, warnings) belong in the chat, but not as the
      // model's own words.
      onModelSwitch: (info) => {
        // Kept on the conversation: a turn that finished on a different model
        // than the user chose is something they need to be able to see later.
        const conv = conversation()
        conv.switches = [
          ...(conv.switches ?? []),
          {
            at: Date.now(),
            from: { provider: info.from.split('/')[0], model: info.from.split('/').slice(1).join('/') },
            to: { provider: info.provider, model: info.to.split('/').slice(1).join('/') },
            reason: info.reason,
            kind: info.kind
          }
        ].slice(-20)
        persist()
        send('agent:model-switch', info)
      },
      onNotice: (text) => send('agent:notice', { text }),
      onOutput: (line, source) => {
        // Build and game output is the first thing anyone asks about after "it
        // did nothing", so level 2 writes it down with the rest.
        log(source === 'build' ? 'build' : 'game', 'debug', line.trim(), undefined, 2)
        send('agent:output', { line, source })
      },
      onGameStatus: (status) => send('game:status', status)
    },
    cfg.autonomy,
    conversation().sessionId,
    () => instanceOverride || loadConfig().game.activeInstanceId
  )
  return session
}

function resetSession(): void {
  session = null
}

export function registerIpc(): void {
  /* --------------------------------------------------------- diagnostics */

  // One rolling log per install, next to the config. Everything at level 1 and
  // above lands here, so a report of "it said 0" can be backed by evidence after
  // the window has closed.
  const diagLog = path.join(app.getPath('userData'), 'logs', 'agent.log')
  setDiagLogPath(diagLog)
  setDiagLevel(parseLevel(loadConfig().diagLevel))
  attachDiagSink({ onEntry: (entry) => send('diag:entry', entry), logPath: () => diagLog })

  ipcMain.handle('diag:level', () => ({ level: getDiagLevel(), name: levelName(getDiagLevel()), logPath: diagLog }))

  ipcMain.handle('diag:setLevel', (_e, value: unknown) => {
    const level = parseLevel(value)
    setDiagLevel(level)
    saveConfig({ diagLevel: level })
    return { level, name: levelName(level), logPath: diagLog }
  })

  ipcMain.handle('diag:history', () => diagHistory())

  ipcMain.handle('diag:clear', () => {
    clearDiagHistory()
    return true
  })

  /** Everything currently buffered, as one text blob, for copying into a report. */
  ipcMain.handle('diag:exportText', () => {
    const header = [
      `MC Forge Agent diagnostics — ${new Date().toISOString()}`,
      `level ${getDiagLevel()} (${levelName(getDiagLevel())})`,
      `app ${app.getVersion()} · electron ${process.versions.electron} · node ${process.versions.node} · ${process.platform} ${process.arch}`,
      `log file: ${diagLog}`
    ].join('\n')
    const body = diagHistory()
      .map((e) => {
        const head = `[${new Date(e.at).toISOString()}] ${e.source.padEnd(8)} ${e.label}${e.note ? ` (${e.note})` : ''}`
        return e.detail === undefined ? head : `${head}\n    ${safeJson(e.detail, 2000)}`
      })
      .join('\n')
    return `${header}\n\n${body}\n`
  })

  ipcMain.handle('diag:logPath', () => diagLog)

  ipcMain.handle('diag:openLog', async () => {
    try {
      fs.mkdirSync(path.dirname(diagLog), { recursive: true })
      if (!fs.existsSync(diagLog)) fs.writeFileSync(diagLog, '', 'utf8')
      return { ok: true, error: await shell.openPath(diagLog) }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  log('app', 'info', 'diagnostics ready', { logPath: diagLog, level: getDiagLevel() }, 2)

  ipcMain.handle('config:get', () => {
    const cfg = loadConfig()
    return { ...redactConfig(cfg), apiKeySet: !!effectiveApiKey() }
  })

  ipcMain.handle('config:set', (_e, patch: Partial<AppConfig>) => {
    // A masked key coming back from the UI must not overwrite the real one.
    if (patch.apiKey && patch.apiKey.startsWith('••')) delete patch.apiKey
    if (patch.visionProviderKey && patch.visionProviderKey.startsWith('••')) delete patch.visionProviderKey
    const next = saveConfig(patch)
    if (patch.autonomy) session?.setAutonomy(next.autonomy)
    // Turn the setting on the moment it is changed: waiting for a restart is how
    // a diagnostic setting ends up never being used.
    if (patch.diagLevel !== undefined) setDiagLevel(parseLevel(next.diagLevel))
    return { ...redactConfig(next), apiKeySet: !!effectiveApiKey() }
  })

  /**
   * Which java the app will actually use, and for what. Settings shows this so a
   * Java 8 on PATH is visible before it produces a JVM stack trace in a log.
   */
  ipcMain.handle('java:status', () => {
    const cfg = loadConfig()
    const game = resolveJava(cfg.javaPath)
    const tool = resolveToolJava(cfg.javaPath)
    return {
      game: { path: game.path, version: game.version, error: game.error },
      tools: { path: tool.path, version: tool.version, error: tool.error },
      /** True when the two disagree, which usually means a stale JAVA_HOME. */
      split: !!game.path && !!tool.path && game.path !== tool.path
    }
  })

  ipcMain.handle('java:check', (_e, javaPath: string) => {
    clearJavaCache()
    if (!javaPath) return { ok: true, cleared: true }
    const probe = probeJava(javaPath)
    if (!probe) return { ok: false, error: `${javaPath} did not respond to -version. Is it a real java.exe?` }
    const suitsGame = probe.major === 21
    const suitsTools = probe.major >= 17
    return {
      ok: suitsGame,
      version: probe.version,
      major: probe.major,
      suitsGame,
      suitsTools,
      error: suitsGame ? undefined : `That is Java ${probe.major}. Minecraft 1.21.1 needs Java 21${suitsTools ? ' (it can still run the decompiler)' : ' and the decompiler needs at least 17'}.`
    }
  })

  ipcMain.handle('java:clearCache', () => {
    clearJavaCache()
    return { ok: true }
  })

  ipcMain.handle('app:version', () => ({ version: app.getVersion(), electron: process.versions.electron, node: process.versions.node }))

  ipcMain.handle('env:report', async (): Promise<EnvReport> => {
    const cfg = loadConfig()
    const javaPick = resolveJava(cfg.javaPath)
    const java = javaPick.path
    const version = javaPick.version ?? null
    const gh = await ghPreflight(cfg.github, cfg.workspaceDir).catch(() => ({ ghFound: false, authed: false, repoOk: false, identity: undefined, messages: ['gh check failed'] }))
    const instance = cfg.game.instances.find((i) => i.id === cfg.game.activeInstanceId)
    const items: EnvReport['items'] = [
      (() => {
        const provider = (cfg.provider || 'anthropic') as ProviderId
        const def = PROVIDERS.find((p) => p.id === provider)
        const label = def?.label ?? 'AI provider'
        const keyed = !!effectiveApiKey()
        const needed = requiresKey(provider)
        return {
          id: 'key',
          label: provider === 'anthropic' ? 'Anthropic API key' : `API key (${label})`,
          ok: keyed || !needed,
          detail: keyed ? 'Configured' : needed ? 'Missing' : `${label} needs no key`,
          fix: needed
            ? `Paste your ${label} key in Settings, or switch to a free provider (it is stored only on this machine).`
            : ''
        }
      })(),
      {
        id: 'java',
        label: 'Java 21',
        ok: !!java && !!version?.startsWith('21'),
        detail: java ? `Java ${version} at ${java}` : 'Not found',
        fix: javaPick.error ?? 'Install Temurin/Microsoft OpenJDK 21, or set the java.exe path in Settings.'
      },
      {
        id: 'gh',
        label: 'GitHub account',
        ok: gh.authed,
        detail: gh.authed ? `Signed in${gh.identity ? ` as ${gh.identity.login}` : ''}` : gh.ghFound ? 'Not signed in' : 'Not signed in',
        fix: 'Sign in from Settings > GitHub. No GitHub CLI needed.'
      },
      {
        id: 'repo',
        label: 'GitHub repo',
        ok: gh.repoOk,
        detail: gh.repoOk ? `${cfg.github.owner}/${cfg.github.repo}` : 'Not reachable',
        fix: 'Create or select a repo in Settings > GitHub.'
      },
      {
        id: 'project',
        label: 'Mod project',
        ok: !!cfg.workspaceDir && isGradleProject(cfg.workspaceDir),
        detail: cfg.workspaceDir || 'No folder selected',
        fix: 'Create a new mod or open an existing folder.'
      },
      {
        id: 'instance',
        label: 'Test instance',
        ok: !!instance && fs.existsSync(instance.path),
        detail: instance ? `${instance.name} (${instance.kind})` : 'Not configured',
        fix: 'Scan for a Technic pack or pick a folder in Settings.'
      }
    ]
    return { ok: items.every((i) => i.ok), items }
  })

  // ---------------- GitHub sign-in ----------------
  /**
   * One place that answers "am I signed in, and can I actually push?".
   * Called by Settings on open, by the pre-build check and by env_report.
   */
  ipcMain.handle('github:status', async (): Promise<GithubStatus> => {
    const cfg = loadConfig()
    const auth = readAuth()
    const cliVer = await run('gh', ['--version'], { timeoutMs: 15000 }).catch(() => null)
    const ghCliFound = !!cliVer && cliVer.code === 0
    if (!auth) {
      return { connected: false, login: '', scopes: [], method: 'pat', savedAt: 0, ghCliFound, repoOk: false, repoMessage: 'Not signed in to GitHub.' }
    }
    try {
      const user = await fetchUser(auth.token)
      // The name can change; keep the stored copy in step with the account.
      const pre = await ghPreflight(cfg.github, cfg.workspaceDir).catch(() => null)
      return {
        connected: true,
        login: user.login,
        name: user.name,
        avatarUrl: user.avatarUrl,
        scopes: user.scopes.length ? user.scopes : auth.scopes,
        method: auth.method,
        savedAt: auth.savedAt,
        ghCliFound,
        repoOk: !!pre?.repoOk,
        repoMessage: pre?.messages.join(' · ')
      }
    } catch (e) {
      return {
        connected: false,
        login: auth.login,
        scopes: auth.scopes,
        method: auth.method,
        savedAt: auth.savedAt,
        ghCliFound,
        repoOk: false,
        repoMessage: 'The stored GitHub token is no longer valid.',
        error: (e as Error).message
      }
    }
  })

  /**
   * Device flow: returns a code for the UI, then resolves once the user approves.
   * The renderer shows the code and the "open github.com" button; this handler
   * stays pending so one round trip covers the whole sign-in.
   */
  ipcMain.handle('github:loginDevice', async (_e, opts: { openBrowser?: boolean } = {}) => {
    let grant
    try {
      grant = await beginDeviceFlow()
    } catch (e) {
      // Device flow refused (client id revoked / blocked). Fall back to the
      // loopback web flow, which needs no code entry.
      const err = e as Error
      if ((err as { code?: string }).code === 'device_unavailable') {
        try {
          const auth = await beginWebFlow()
          resetSession()
          return { ok: true, auth: redactAuth(auth) }
        } catch (inner) {
          return { ok: false, error: (inner as Error).message }
        }
      }
      return { ok: false, error: err.message }
    }
    send('github:device-code', {
      userCode: grant.userCode,
      verificationUri: grant.verificationUri,
      verificationUriComplete: grant.verificationUriComplete,
      expiresInSec: grant.expiresInSec
    })
    if (opts.openBrowser !== false) await openVerificationPage(grant)
    try {
      const auth = await awaitDeviceApproval(grant, undefined, (secondsLeft) => send('github:device-tick', { secondsLeft }))
      resetSession()
      return { ok: true, auth: redactAuth(auth) }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('github:loginToken', async (_e, token: string) => {
    try {
      const auth = await loginWithToken(token)
      resetSession()
      return { ok: true, auth: redactAuth(auth) }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('github:logout', () => {
    githubLogout()
    return { ok: true }
  })

  ipcMain.handle('github:authPath', () => authFilePath())

  ipcMain.handle('github:openDevicePage', () => shell.openExternal('https://github.com/login/device'))

  // ---------------- reference mods (decompiled) ----------------
  ipcMain.handle('ref:list', (): ReferenceModUi[] => listReferences().map(toRefUi))

  ipcMain.handle('ref:resolve', async (_e, input: string) => {
    const parsed = parseRepoRef(input)
    if (!parsed) return { ok: false, error: 'Enter a GitHub repo like owner/name or a github.com URL.' }
    if (!authToken()) return { ok: false, error: 'Sign in to GitHub first — release listings use the API.', needsAuth: true }
    try {
      const releases = await listReleases(parsed.owner, parsed.repo)
      return {
        ok: true,
        repo: `${parsed.owner}/${parsed.repo}`,
        releases: releases.map((r) => ({
          tag: r.tag,
          name: r.name,
          publishedAt: r.publishedAt,
          prerelease: r.prerelease,
          jars: r.assets.filter((a) => /\.jar$/i.test(a.name)).map((a) => ({ name: a.name, size: a.size, downloads: a.downloads })),
          recommended: pickModJar(r.assets)?.name
        }))
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('ref:addGithub', async (_e, opts: { repo: string; tag?: string; assetName?: string }) => {
    const parsed = parseRepoRef(opts.repo)
    if (!parsed) return { ok: false, error: 'Enter a GitHub repo like owner/name.' }
    const cfg = loadConfig()
    try {
      const res = await addFromGithub({
        owner: parsed.owner,
        repo: parsed.repo,
        releaseTag: opts.tag,
        assetName: opts.assetName,
        javaPath: cfg.javaPath,
        customJar: cfg.decompilerJar || undefined,
        onLine: (line) => send('ref:line', { line })
      })
      if (res.mod && cfg.workspaceDir) {
        ensureReferenceIgnored(cfg.workspaceDir)
        send('ref:list-changed')
      }
      return res.ok ? { ok: true, mod: toRefUi(res.mod!) } : { ok: false, error: res.error }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('ref:addFiles', async (_e, opts: { title?: string } = {}) => {
    const cfg = loadConfig()
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const picked = await dialog.showOpenDialog(win, {
      title: 'Pick a mod jar to decompile',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Mod jars', extensions: ['jar'] }]
    })
    if (picked.canceled || !picked.filePaths.length) return { ok: false, error: 'cancelled' }
    const added: ReferenceModUi[] = []
    const errors: string[] = []
    for (const file of picked.filePaths) {
      const res = await addFromFile({
        jarPath: file,
        title: opts.title,
        javaPath: cfg.javaPath,
        customJar: cfg.decompilerJar || undefined,
        onLine: (line) => send('ref:line', { line })
      })
      if (res.ok && res.mod) added.push(toRefUi(res.mod))
      else errors.push(`${path.basename(file)}: ${res.error ?? 'failed'}`)
    }
    if (added.length && cfg.workspaceDir) ensureReferenceIgnored(cfg.workspaceDir)
    return { ok: added.length > 0, mods: added, error: errors.join(' · ') || undefined }
  })

  ipcMain.handle('ref:remove', (_e, id: string) => {
    const mods = removeReference(id)
    return { ok: true, mods: mods.map(toRefUi) }
  })

  /** Copy decompiled sources into <project>/reference/<slug> so the agent can read them. */
  ipcMain.handle('ref:link', (_e, id: string) => {
    const cfg = loadConfig()
    if (!cfg.workspaceDir) return { ok: false, error: 'Open a mod project first.' }
    ensureReferenceIgnored(cfg.workspaceDir)
    const res = linkToProject(id, cfg.workspaceDir)
    if (res.ok) resetSession()
    return res
  })

  /* -------------------------------------------------------- past mistakes */

  ipcMain.handle('learn:list', () => listLessons())

  ipcMain.handle('learn:recall', (_e, opts: { error: string; loader?: Loader; mcVersion?: string }) =>
    recall(opts.error, { loader: opts.loader, mcVersion: opts.mcVersion })
  )

  ipcMain.handle('learn:update', (_e, opts: { id: string; rule?: string; fix?: string; avoid?: string }) =>
    confirmLesson(opts.id, { rule: opts.rule, fix: opts.fix, avoid: opts.avoid })
  )

  ipcMain.handle('learn:remove', (_e, id: string) => retireLesson(id))
  ipcMain.handle('learn:clear', () => {
    clearLessons()
    return []
  })

  /* -------------------------------------------------- gameplay clips / vision */

  ipcMain.handle('clip:start', async (_e, opts: { durationMs?: number; fps?: number; note?: string } = {}) => {
    if (isRecording()) return { ok: false, error: 'A clip is already being recorded.' }
    send('clip:started', { maxMs: MAX_CLIP_MS })
    // The recorder resolves only when the clip ends, so this handler is awaited
    // by the renderer for the whole capture. Progress arrives on clip:frame.
    const clip = await startClip({
      durationMs: opts.durationMs,
      fps: opts.fps,
      note: opts.note,
      grab: captureFrameBuffer,
      onFrame: (frame, index, total) => send('clip:frame', { t: frame.t, index, total, path: frame.path }),
      onDone: (done) => send('clip:done', { clip: done })
    })
    return { ok: true, clip }
  })

  ipcMain.handle('clip:stop', () => stopClip())
  ipcMain.handle('clip:list', () => listClips())
  ipcMain.handle('clip:get', (_e, id: string) => getClip(id))
  ipcMain.handle('clip:remove', (_e, id: string) => deleteClip(id))

  /** Send the clip's frames to a vision model and store the write-up. */
  ipcMain.handle('clip:analyse', async (_e, opts: { id: string; goal?: string; model?: string; mode?: 'bug' | 'look' }) => {
    const clip = getClip(opts.id)
    if (!clip) return { ok: false, error: 'Unknown clip.' }
    if (!clip.frames.length) return { ok: false, error: 'That clip has no frames.' }
    send('clip:analysing', { id: clip.id })
    // One rule shared with the agent's clip tool, so a clip analyses the same
    // way however it was triggered.
    const v = resolveVisionModel(opts.model)
    const res = await analyseClip({
      clip,
      goal: opts.goal,
      mode: opts.mode,
      model: v.model,
      apiKey: v.apiKey,
      baseUrl: v.baseUrl,
      auth: v.auth,
      providerLabel: v.providerLabel
    })
    if (res.ok && res.text) {
      attachAnalysis(clip.id, { model: res.model ?? 'vision', text: res.text, frames: res.frames ?? 0, mode: opts.mode })
    }
    return res
  })

  /** Text digest, injected into the agent conversation on request. */
  ipcMain.handle('clip:digest', (_e, id: string) => {
    const clip = getClip(id)
    return clip ? { ok: true, text: clipDigest(clip) } : { ok: false, error: 'Unknown clip.' }
  })

  /* ----------------------------------------------------------- evolution */

  const evolveLogPath = (): string => path.join(app.getPath('userData'), 'logs', 'evolution.log')

  /**
   * A classpath for compiling the evaluation task: the Minecraft and NeoForge
   * jars the user's own dev workspace already downloaded.
   *
   * Without them, `javac` cannot resolve `@Mod` or `DeferredRegister`, every
   * candidate would score zero on quality, and the loop would be measuring
   * nothing. Returning undefined is honest: evaluation then reports that it could
   * not verify, instead of silently rewarding compile failure.
   */
  const neoClasspath = (workspace: string): string | undefined => {
    const roots = [
      path.join(workspace, '.gradle', 'loom-cache'),
      path.join(workspace, 'build', 'moddev'),
      path.join(workspace, '.gradle', 'caches', 'modules-2', 'files-2.1')
    ]
    const jars: string[] = []
    const walk = (dir: string, depth: number): void => {
      if (depth > 6) return
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) walk(full, depth + 1)
        else if (e.name.endsWith('.jar') && /neoforge|minecraft|client-extra|mcp/i.test(e.name)) jars.push(full)
      }
    }
    for (const r of roots) walk(r, 0)
    if (!jars.length) return undefined
    return jars.slice(0, 40).join(path.delimiter)
  }
  /* ----------------------------------------------------------- evolution */

  /** The app's own sources, which is what a generation forks from. */
  const appSourcesDir = app.isPackaged ? path.join(process.resourcesPath, 'app-src') : app.getAppPath()

  let evolving = false
  let evolveAbort = new AbortController()

  ipcMain.handle('evolve:status', () => {
    try {
      ensureBaseline(appSourcesDir)
    } catch {
      /* a read-only install still gets to see the store it already has */
    }
    const store = loadStore()
    const active = activeGeneration(store)
    const cfg = loadConfig()
    return {
      ok: true,
      running: evolving,
      paused: store.paused,
      active: active ? { id: active.id, thesis: active.identity.thesis, score: active.score, status: active.status } : null,
      best: (() => {
        const b = bestGeneration(store)
        return b ? { id: b.id, score: b.score } : null
      })(),
      generations: store.generations.map((g) => ({
        id: g.id,
        createdAt: g.createdAt,
        thesis: g.identity.thesis,
        score: g.score,
        parts: g.parts,
        status: g.status,
        outcome: g.outcome,
        parent: g.parent,
        builds: g.metrics?.builds,
        classBytes: g.metrics?.classBytes,
        sourceBytes: g.metrics?.sourceBytes,
        buildMs: g.metrics?.buildMs,
        minHeapMb: g.metrics?.minHeapMb,
        note: g.metrics?.note
      })),
      rules: store.rules ?? DEFAULT_RULES,
      config: {
        evolving: cfg.evolving,
        evolveCount: cfg.evolveCount,
        evolveMaxGenerations: cfg.evolveMaxGenerations,
        evolveMaxHeapMb: cfg.evolveMaxHeapMb
      },
      /** What the current weights mean in words, so the numbers are not opaque. */
      instructions: rulesToInstructions(store.rules ?? DEFAULT_RULES, { maxHeapMb: cfg.evolveMaxHeapMb }),
      /** Which model would do the mutating — the same one the chat uses. */
      mutator: describeRunTarget(cfg),
      sourcesDir: appSourcesDir
    }
  })

  ipcMain.handle('evolve:rules', (_e, rules: { quality: number; speed: number; size: number; ram: number }) => {
    const store = loadStore()
    const clean = {
      quality: Math.max(0, Math.min(100, Math.round(rules.quality))),
      speed: Math.max(0, Math.min(100, Math.round(rules.speed))),
      size: Math.max(0, Math.min(100, Math.round(rules.size))),
      ram: Math.max(0, Math.min(100, Math.round(rules.ram)))
    }
    store.rules = clean
    saveStore(store)
    saveConfig({ evolveRules: clean })
    return { ok: true, rules: clean, instructions: rulesToInstructions(clean, { maxHeapMb: loadConfig().evolveMaxHeapMb }) }
  })

  ipcMain.handle('evolve:pause', (_e, paused: boolean) => {
    const store = loadStore()
    store.paused = !!paused
    saveStore(store)
    if (paused) evolveAbort.abort()
    return { ok: true, paused: store.paused }
  })

  ipcMain.handle('evolve:promote', (_e, id: number) => {
    const store = loadStore()
    const gen = store.generations.find((g) => g.id === id)
    if (!gen) return { ok: false, error: 'no such generation' }
    promote(store, id)
    // Promoting is only bookkeeping until the app restarts: the running process
    // still has the old prompt loaded. Saying so is better than pretending the
    // change is live.
    return { ok: true, needsRestart: id !== store.active || true }
  })

  /**
   * Run the loop.
   *
   * The mutator is a one-shot agent run with the *current* app prompt (so its own
   * behaviour is not affected by the mutation it is writing), and the candidate is
   * evaluated by compiling its prompt and asking it to solve a fixed task.
   */
  ipcMain.handle('evolve:run', async (_e, count?: number) => {
    if (evolving) return { ok: false, error: 'the loop is already running' }
    const cfg = loadConfig()
    const store = loadStore()
    if (!cfg.evolving) return { ok: false, error: 'evolution is off — enable it first' }

    evolving = true
    evolveAbort = new AbortController()
    // javac for the probe and the compile check. 17 rather than 21 because the
    // evaluation task only needs to compile against NeoForge's own level.
    const java = resolveToolJava(cfg.javaPath).path ?? undefined
    const classpath = neoClasspath(cfg.workspaceDir)
    try {
      const results = await evolveMany(count ?? cfg.evolveCount ?? 3, {
        appDir: appSourcesDir,
        askMutator: async (prompt) => {
          const s = ensureSession()
          return s.askOnce(prompt)
        },
        askCandidate: async (genomeDir, prompt) => {
          // A fresh session per candidate so one cannot reuse the other's state.
          const s = ensureSession()
          return s.askOnce(prompt, { genomeDir })
        },
        classpath,
        javaPath: java,
        signal: evolveAbort.signal,
        onStep: (step) => send('evolve:step', step)
      })
      const promoted = results.filter((r) => r.promoted).length
      send('evolve:done', { results: results.length, promoted })
      return {
        ok: true,
        results: results.map((r) => ({ ok: r.ok, verdict: r.verdict, error: r.error, id: r.generation?.id, promoted: r.promoted })),
        promoted,
        logPath: evolveLogPath()
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    } finally {
      evolving = false
    }
  })

  ipcMain.handle('evolve:log', () => {
    try {
      return { ok: true, text: fs.readFileSync(evolveLogPath(), 'utf8').slice(-40_000) }
    } catch {
      return { ok: true, text: '(no log yet — run one generation first)' }
    }
  })

  /** Hand the active generation's genome text to the diff view. */
  ipcMain.handle('evolve:genome', (_e, id: number) => {
    const store = loadStore()
    const gen = store.generations.find((g) => g.id === id)
    if (!gen) return { ok: false, error: 'no such generation' }
    const files: { path: string; text: string }[] = []
    for (const rel of ['src/main/agent/prompt.ts', 'src/main/agent/orchestrator.ts', 'src/main/agent/tools.ts']) {
      try {
        files.push({ path: rel, text: fs.readFileSync(path.join(gen.dir, rel), 'utf8') })
      } catch {
        /* missing in that generation */
      }
    }
    return { ok: true, files }
  })

  /* --------------------------------------------- modes and model switching */

  /**
   * What each mode would do right now, before the user commits to it.
   *
   * Deep research in particular needs to say *which* model it will spend on —
   * "the best available" is only honest if the user can see what that means on
   * their own keys, and that it will cost money.
   */
  /**
   * The 3D model panel's data. The paths are computed from the project's
   * Minecraft version rather than hardcoded, because a 1.12 project has no
   * geo/ folder and showing one would send the user looking for files that
   * nothing reads.
   */
  ipcMain.handle('models:info', () => {
    const cfg = loadConfig()
    const dir = cfg.workspaceDir
    const props = readProps(path.join(dir, 'gradle.properties'))
    const mcVersion = detectMcVersion(props)
    const modId = props.mod_id ?? props.modid ?? 'modid'
    const layout = assetLayout({ mcVersion, modId })
    return {
      ok: true,
      modId,
      mcVersion,
      legacy: layout.legacy,
      note: layout.note,
      folders: {
        blockModels: layout.blockModels,
        itemModels: layout.itemModels,
        blockstates: layout.blockstates,
        geo: layout.geo,
        animations: layout.animations
      }
    }
  })

  /**
   * Write a starting model immediately, without a model call.
   *
   * This exists because "generate a model" is deterministic: there is nothing
   * for an LLM to decide, and routing it through chat costs a turn and can add
   * the exact kind of invented coordinate that makes a model invisible. The
   * agent still gets the tool for cases that need judgement (a mob that matches
   * a described creature); this is the button for the common case.
   */
  /**
   * What this project can render, and the honest verdict on realism. Shown next
   * to the texture and shader controls so the user is not told to write a
   * coreShaders file for a version that has never loaded one.
   */
  ipcMain.handle('renderer:capabilities', () => {
    const cfg = loadConfig()
    const props = readProps(path.join(cfg.workspaceDir, 'gradle.properties'))
    const mcVersion = detectMcVersion(props)
    return {
      ok: true,
      mcVersion,
      loader: detectLoader(props),
      support: rendererSupport(mcVersion),
      verdict: realismVerdict(mcVersion)
    }
  })

  /**
   * The shader catalogue for this project, plus a recommendation per use case.
   *
   * `available` is what actually applies to this version and loader; `all` is
   * everything, so the UI can show what exists and grey out what does not —
   * "Photon, not for your version" is more useful than Photon silently vanishing.
   */
  ipcMain.handle('shaders:catalogue', () => {
    const cfg = loadConfig()
    const props = readProps(path.join(cfg.workspaceDir, 'gradle.properties'))
    const mcVersion = detectMcVersion(props)
    const loader = detectLoader(props)
    const available = catalogueFor(mcVersion, loader)
    const all = fullCatalogue()
    const recommendations = Object.fromEntries(
      (Object.keys(USE_CASES) as UseCase[]).map((useCase) => [useCase, recommend({ useCase, mcVersion, loader })])
    )
    return { ok: true, mcVersion, loader, useCases: USE_CASES, available, all, recommendations }
  })

  /** Conflict check for a set the user has assembled. */
  ipcMain.handle('shaders:check', (_e, ids: string[]) => {
    const cfg = loadConfig()
    const mcVersion = detectMcVersion(readProps(path.join(cfg.workspaceDir, 'gradle.properties')))
    return { ok: true, notes: compatibilityNotes(ids ?? [], mcVersion) }
  })

  /** Ask the agent about a specific use case, from the panel. */
  ipcMain.handle('shaders:explain', (_e, useCase: UseCase) => {
    const cfg = loadConfig()
    const props = readProps(path.join(cfg.workspaceDir, 'gradle.properties'))
    const mcVersion = detectMcVersion(props)
    const loader = detectLoader(props)
    const rec = recommend({ useCase, mcVersion, loader })
    return { ok: true, recommendation: rec }
  })

  /** Write one generated texture as a real PNG in the folder the game reads. */
  ipcMain.handle(
    'textures:create',
    (
      _e,
      req: { name: string; kind?: 'block' | 'item'; pattern?: keyof typeof PATTERNS; palette?: keyof typeof PALETTES; size?: number; silhouette?: boolean }
    ) => {
      const cfg = loadConfig()
      const props = readProps(path.join(cfg.workspaceDir, 'gradle.properties'))
      const modId = (props.mod_id ?? props.modid ?? 'modid').trim()
      const name = (req.name ?? '').trim().toLowerCase()
      if (!/^[a-z0-9_]{2,48}$/.test(name)) {
        return { ok: false, error: 'Use 2-48 lowercase letters, digits or underscores — this becomes the file name and the texture id.' }
      }
      if (!/^[a-z0-9_]{2,48}$/.test(modId)) {
        return { ok: false, error: `The project's mod id (${modId}) is not set in gradle.properties.` }
      }
      const kind = req.kind ?? 'block'
      const rel = `src/main/resources/assets/${modId}/textures/${texturePathFor(kind, name)}.png`
      try {
        const png = texturePng({
          name,
          pattern: req.pattern ?? 'noise',
          palette: req.palette ?? 'stone',
          size: req.size ?? 16,
          transparentBackground: Boolean(req.silhouette) && kind === 'item'
        })
        const full = path.join(cfg.workspaceDir, rel)
        fs.mkdirSync(path.dirname(full), { recursive: true })
        fs.writeFileSync(full, png)
        return { ok: true, path: rel, bytes: png.length, ref: `${modId}:${texturePathFor(kind, name)}` }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    }
  )

  ipcMain.handle(
    'models:create',
    (
      _e,
      req: { name: string; kind: 'block' | 'item' | 'entity' | 'animation'; texture?: string; skeleton?: 'none' | 'quadruped'; size?: [number, number, number] }
    ) => {
      const cfg = loadConfig()
      const dir = cfg.workspaceDir
      const props = readProps(path.join(dir, 'gradle.properties'))
      const mcVersion = detectMcVersion(props)
      const modId = (props.mod_id ?? props.modid ?? 'modid').trim()
      const name = (req.name ?? '').trim()
      if (!/^[a-z0-9_]{2,48}$/.test(name)) {
        return { ok: false, error: 'Use 2-48 lowercase letters, digits or underscores for the name (it becomes a file name and a registry id).' }
      }
      if (!/^[a-z0-9_]{2,48}$/.test(modId)) {
        return { ok: false, error: `The project's mod id (${modId}) is not set in gradle.properties, so asset paths cannot be built.` }
      }
      const layout = assetLayout({ mcVersion, modId })
      if (layout.legacy && (req.kind === 'entity' || req.kind === 'animation')) {
        return {
          ok: false,
          error: `Minecraft ${mcVersion} has no JSON entity models or animations. A 1.12 mob is a Java ModelBase class — ask the agent for one.`
        }
      }

      const writes: { path: string; text: string; kind: 'block' | 'item' | 'entity' | 'animation' | 'blockstate' }[] = []
      try {
        if (req.kind === 'block') {
          const tex = textureRef(modId, req.texture, `block/${name}`)
          const size = req.size ?? [16, 16, 16]
          const full = size[0] === 16 && size[1] === 16 && size[2] === 16
          writes.push({
            path: modelPaths({ modId, name, kind: 'block', mcVersion }),
            kind: 'block',
            text: blockModelJson(
              full
                ? { parent: 'minecraft:block/cube_all', all: tex }
                : { textures: { all: tex }, elements: [{ origin: [8 - size[0] / 2, 0, 8 - size[2] / 2], size, uv: [0, 0] }] }
            )
          })
          writes.push({ path: `${layout.blockstates}/${name}.json`, kind: 'blockstate', text: blockstateJson({ mcVersion, modelId: `${modId}:block/${name}` }) })
        } else if (req.kind === 'item') {
          writes.push({
            path: modelPaths({ modId, name, kind: 'item', mcVersion }),
            kind: 'item',
            text: blockModelJson({ parent: 'minecraft:item/generated', all: textureRef(modId, req.texture, `item/${name}`) })
          })
        } else {
          const bones = req.skeleton === 'quadruped' ? QUADRUPED_BONES(8, 6) : [{ name: 'root', pivot: [0, 8, 0] as [number, number, number], boxes: [{ origin: [-4, 0, -4] as [number, number, number], size: [8, 16, 8] as [number, number, number], uv: [0, 0] as [number, number] }] }]
          writes.push({
            path: modelPaths({ modId, name, kind: 'entity', mcVersion }),
            kind: 'entity',
            text: entityModelJson({ identifier: `geometry.${modId}.${name}`, bones })
          })
          if (req.kind === 'animation') {
            if (req.skeleton !== 'quadruped') {
              return { ok: false, error: 'A walk cycle needs the quadruped skeleton, because it animates named bones — pick "quadruped" to generate both.' }
            }
            writes.push({
              path: modelPaths({ modId, name: `${name}.walk`, kind: 'animation', mcVersion }),
              kind: 'animation',
              text: animationJson(quadrupedWalk(`animation.${modId}.${name}.walk`))
            })
          }
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }

      const res = writeModels(dir, writes)
      if (!res.ok) {
        return {
          ok: false,
          error: res.issues.filter((i) => i.severity === 'error').map((i) => i.message).join('\n'),
          issues: res.issues,
          written: res.written
        }
      }
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('project:changed', {})
      const texture = req.kind === 'block' || req.kind === 'item' ? textureRef(modId, req.texture, `${req.kind === 'block' ? 'block' : 'item'}/${name}`) : null
      return { ok: true, written: res.written, issues: res.issues, texture, textureFile: texture ? textureFile(modId, texture) : null }
    }
  )

  ipcMain.handle('modes:status', () => {
    const cfg = loadConfig()
    const best = bestAvailable(cfg)
    return {
      mode: runMode(cfg),
      learningMode: cfg.learningMode,
      deepResearch: cfg.deepResearch,
      autoSwitch: cfg.autoSwitch,
      autoSwitchLimit: cfg.autoSwitchLimit,
      autoSwitchIncludeLocal: cfg.autoSwitchIncludeLocal,
      researchTopic: cfg.researchTopic,
      runningOn: describeRunTarget(cfg),
      best: best
        ? { provider: best.provider, model: best.model, label: best.label, free: best.free, why: best.why }
        : null,
      lessons: listLessons().length,
      research: loadResearch()
    }
  })

  ipcMain.handle('modes:set', (_e, patch: { learningMode?: boolean; deepResearch?: boolean; researchTopic?: string }) => {
    const next = saveConfig(patch)
    log('app', 'info', 'mode changed', { mode: runMode(next), patch }, 2)
    // Turning deep research on without a topic would make the next run research
    // nothing in particular, which wastes the most expensive model available.
    return {
      ok: true,
      mode: runMode(next),
      needsTopic: next.deepResearch && !next.researchTopic.trim(),
      researchTopic: next.researchTopic
    }
  })

  /** Lessons written by study or research, so the panel can show the payoff. */
  ipcMain.handle('modes:knowledge', (_e, topic?: string) => {
    if (topic?.trim()) return knowledgeOn(topic)
    return listLessons().filter((l) => l.kind === 'topic' || l.kind === 'research')
  })

  ipcMain.handle('modes:startResearch', (_e, topic: string) => {
    const clean = topic.trim()
    if (!clean) return { ok: false, error: 'Give the research run a topic first.' }
    const cfg = loadConfig()
    const next = saveConfig({ deepResearch: true, researchTopic: clean })
    const dir = researchDir(cfg.workspaceDir)
    saveResearch({ topic: clean, startedAt: Date.now(), notes: [], model: describeRunTarget(next) })
    send('modes:changed', { mode: runMode(next) })
    return { ok: true, topic: clean, dir }
  })

  ipcMain.handle('modes:stopResearch', () => {
    const next = saveConfig({ deepResearch: false })
    saveResearch(null)
    send('modes:changed', { mode: runMode(next) })
    return { ok: true }
  })

  ipcMain.handle('modes:researchDir', () => researchDir(loadConfig().workspaceDir))

  /* ------------------------------------------------------- editable forks */

  ipcMain.handle('fork:list', () =>
    listForks().map((f) => ({ ...f, files: countForkSources(f.dir) }))
  )

  ipcMain.handle('fork:suggest', (_e, referenceId: string) => {
    const mod = listReferences().find((m) => m.id === referenceId)
    if (!mod) return { ok: false, error: 'Unknown reference mod.' }
    return { ok: true, ...suggestedTarget(mod), title: mod.title, license: mod.license, repo: mod.repo }
  })

  ipcMain.handle('fork:create', (_e, opts: { referenceId: string; loader?: Loader; mcVersion?: string; loaderVersion?: string; parentDir?: string }) => {
    const res = createFork(opts)
    if (res.ok) send('fork:list-changed')
    return res
  })

  ipcMain.handle('fork:remove', (_e, id: string) => {
    const rest = removeFork(id)
    send('fork:list-changed')
    return rest
  })

  ipcMain.handle('fork:open', (_e, id: string) => {
    const fork = getFork(id)
    if (!fork) return { ok: false, error: 'Unknown fork.' }
    return { ok: true, dir: fork.dir }
  })

  /** Read/write inside a fork, used by the reference panel's editor. */
  ipcMain.handle('fork:readFile', (_e, opts: { id: string; path: string }) => {
    const fork = getFork(opts.id)
    if (!fork) return { ok: false, error: 'Unknown fork.' }
    const full = safeJoin(fork.dir, opts.path)
    if (!full) return { ok: false, error: 'That path is outside the fork.' }
    try {
      return { ok: true, text: fs.readFileSync(full, 'utf8') }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('fork:writeFile', (_e, opts: { id: string; path: string; text: string }) => {
    const fork = getFork(opts.id)
    if (!fork) return { ok: false, error: 'Unknown fork.' }
    const full = safeJoin(fork.dir, opts.path)
    if (!full) return { ok: false, error: 'That path is outside the fork.' }
    try {
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, opts.text, 'utf8')
      touchFork(fork.dir)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('fork:tree', (_e, id: string) => {
    const fork = getFork(id)
    if (!fork) return []
    return listTree(fork.dir, 800)
  })

  /* ------------------------------------------------ updating / converting */

  /**
   * What is this project, really? Read from the files, not the folder name —
   * an old 1.12.2 Forge mod is usually called something like "my-mod-1.12.2"
   * and gets renamed the moment someone changes the target.
   */
  ipcMain.handle('port:detect', (_e, dir: string) => {
    try {
      return { ok: true, project: detectProject(dir) }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('port:plan', (_e, opts: { dir: string; loader: Loader; mcVersion: string }) => {
    try {
      const plan = planPort(opts.dir, { loader: opts.loader, mcVersion: opts.mcVersion })
      return { ok: true, plan }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('port:report', (_e, opts: { dir: string; loader: Loader; mcVersion: string }) => {
    try {
      return { ok: true, text: migrationReport(planPort(opts.dir, { loader: opts.loader, mcVersion: opts.mcVersion })) }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle(
    'port:convert',
    (
      _e,
      opts: {
        sourceDir: string
        targetDir: string
        loader: Loader
        mcVersion: string
        modVersion?: string
        author?: string
        license?: string
        backup?: boolean
      }
    ) => {
      const res = convertProject({
        sourceDir: opts.sourceDir,
        targetDir: opts.targetDir,
        target: { loader: opts.loader, mcVersion: opts.mcVersion },
        modVersion: opts.modVersion,
        author: opts.author,
        license: opts.license,
        backup: opts.backup
      })
      if (res.ok) send('fork:list-changed')
      return res
    }
  )

  ipcMain.handle('ref:search', (_e, opts: { query: string; id?: string; regex?: boolean }) => {
    if (!opts.query?.trim()) return { hits: [] }
    try {
      return { hits: searchReference(opts.query, { id: opts.id, regex: opts.regex }) }
    } catch (e) {
      return { hits: [], error: (e as Error).message }
    }
  })

  ipcMain.handle('ref:tree', (_e, id: string) => referenceTree(id))

  ipcMain.handle('ref:readFile', (_e, opts: { id: string; path: string }) => readReferenceFile(opts.id, opts.path))

  ipcMain.handle('ref:decompile', async (_e, id: string) => {
    const cfg = loadConfig()
    const mod = getReference(id)
    if (!mod) return { ok: false, error: 'Unknown reference mod.' }
    try {
      const { decompileJar } = await import('../github/references')
      if (!mod.jarPath || !fs.existsSync(mod.jarPath)) return { ok: false, error: 'The cached jar is missing; add the mod again.' }
      const dest = path.join(path.dirname(mod.jarPath), 'sources')
      const job = await decompileJar(mod.jarPath, dest, { javaPath: cfg.javaPath, decompilerJar: cfg.decompilerJar || undefined, onLine: (line) => send('ref:line', { line }) })
      // Re-register through the public adders so the index stays consistent.
      if (mod.source === 'github-release' && mod.repo) {
        const [owner, repo] = mod.repo.split('/')
        await addFromGithub({ owner, repo, releaseTag: mod.version, assetName: mod.jarName, javaPath: cfg.javaPath, customJar: cfg.decompilerJar || undefined, onLine: (line) => send('ref:line', { line }) })
      } else {
        await addFromFile({ jarPath: mod.jarPath, title: mod.title, licence: mod.license, javaPath: cfg.javaPath, customJar: cfg.decompilerJar || undefined, onLine: (line) => send('ref:line', { line }) })
      }
      const updated = getReference(id)
      return job.ok ? { ok: true, mod: updated ? toRefUi(updated) : undefined } : { ok: false, error: job.error, mod: updated ? toRefUi(updated) : undefined }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('ref:openFolder', async (_e, id: string) => {
    const mod = getReference(id)
    if (mod?.sourcesDir) await shell.openPath(mod.sourcesDir)
  })

  ipcMain.handle('ref:openHomepage', async (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url)
  })

  // ---------------- project ----------------
  ipcMain.handle('project:scaffold', async (_e, opts: {
    parentDir: string
    modId: string
    modName: string
    group: string
    modVersion: string
    author?: string
    license?: string
    loader: Loader
    mcVersion: string
    loaderVersion: string
  }) => {
    const dir = path.join(opts.parentDir, opts.modId)
    const res = generateProject({
      targetDir: dir,
      modId: opts.modId,
      modName: opts.modName,
      group: opts.group,
      modVersion: opts.modVersion || '1.0.0',
      author: opts.author,
      license: opts.license,
      loader: opts.loader,
      mcVersion: opts.mcVersion,
      loaderVersion: opts.loaderVersion,
      templateRoot: templateRoot()
    })
    if (!res.ok) return res
    saveConfig({ workspaceDir: dir })
    resetSession()
    return { ...res, dir }
  })

  /* --------------------------------------------------------------- local models */

  /** Catalog, bundles and role definitions, plus what is actually installed. */
  ipcMain.handle('local:info', async () => {
    const cfg = loadConfig()
    const exe = findOllama()
    const modelsDir = cfg.local?.modelsDir || defaultModelsDir()
    const probe = exe ? await probeOllama() : { running: false, anthropic: false }
    let installed: { id: string; sizeGb: number }[] = []
    // Read the manifest off disk as well as asking the daemon: the daemon may
    // not be running yet and Settings still needs to show what is downloaded.
    const manifests = path.join(modelsDir, 'manifests', 'registry.ollama.ai', 'library')
    try {
      for (const name of fs.readdirSync(manifests)) {
        for (const tag of fs.readdirSync(path.join(manifests, name))) {
          installed.push({ id: tag === 'latest' ? name : `${name}:${tag}`, sizeGb: 0 })
        }
      }
    } catch {
      installed = []
    }
    // Sizes come from the blobs the manifest points at; the daemon's own list is
    // the authoritative one when it is up.
    if (probe.running) {
      try {
        const text = await (await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(4000) })).text()
        const parsed = (JSON.parse(text) as { models?: { name?: string; size?: number }[] }).models ?? []
        const byName = new Map(parsed.filter((m) => m.name).map((m) => [m.name as string, (m.size ?? 0) / 1e9]))
        installed = [...byName.entries()].map(([id, gb]) => ({ id, sizeGb: Math.round(gb * 10) / 10 }))
      } catch {
        // Fall back to the manifest scan above.
      }
    }
    return {
      installed: !!exe,
      bundledInstaller: hasBundledInstaller(),
      exe,
      running: probe.running,
      anthropicCompatible: probe.anthropic,
      version: 'version' in probe ? probe.version : undefined,
      modelsDir,
      defaultModelsDir: defaultModelsDir(),
      freeGb: freeSpaceGb(modelsDir || defaultModelsDir()),
      installedModels: installed,
      roles: cfg.local?.roles ?? { agent: [], vision: [], quick: [] },
      models: LOCAL_MODELS,
      bundles: BUNDLES,
      roleDefs: LOCAL_ROLES,
      // Hardware drives three decisions: which bundle to suggest, how much
      // context the daemon asks for, and whether a model can run at all. All
      // three are reported so the UI can explain itself rather than guess.
      hardware: (() => {
        const system = detectSystem()
        const fit = suitability(system, cfg.local?.contextLength || undefined)
        return {
          gpus: system.gpus,
          primary: system.primary,
          recommendedBundle: recommendBundle(system.primary?.vramGb, fit),
          suggestedContext: contextForVram(system.primary?.vramGb),
          system,
          verdicts: fit.verdicts,
          bestModel: fit.best,
          noneRun: fit.none
        }
      })(),
      contextLength: cfg.local?.contextLength || 0
    }
  })

  /** Re-detect after the user installs Ollama outside the app. */
  ipcMain.handle('local:probe', async () => {
    const exe = findOllama()
    return { exe, ...(exe ? await probeOllama() : { running: false, anthropic: false as const }) }
  })

  /**
   * Download and run the official Ollama installer, streaming progress. The
   * download is ~1 GB, so every step reports back rather than freezing the UI.
   */
  ipcMain.handle('local:install', async (_e, opts: { installDir?: string; modelsDir?: string }) => {
    if (installInProgress()) return { ok: false, error: 'An install is already running.' }
    const cfg = loadConfig()
    if (opts.modelsDir !== undefined) saveConfig({ ...cfg, local: { ...cfg.local, modelsDir: opts.modelsDir } })
    const res = await installOllama({
      installDir: opts.installDir || cfg.local?.installDir || undefined,
      onEvent: (ev) => send('local:install-progress', ev)
    })
    if (res.ok) {
      // Point the daemon at the chosen weight location before it starts.
      const dir = loadConfig().local?.modelsDir
      if (dir) {
        const exe = res.path ?? findOllama()
        if (exe && !(await probeOllama()).running) {
          startOllamaServe(exe, dir, loadConfig().local?.contextLength || contextForVram(primaryGpu(detectGpus())?.vramGb))
          await delay(1500)
        }
      }
    }
    return res
  })

  /** Save the weights location. Restarts a daemon the app manages so the change applies. */
  ipcMain.handle('local:setModelsDir', async (_e, dir: string) => {
    const cfg = loadConfig()
    if (dir) {
      try {
        fs.mkdirSync(dir, { recursive: true })
      } catch (e) {
        return { ok: false, error: `Cannot create ${dir}: ${(e as Error).message}` }
      }
      const free = freeSpaceGb(dir)
      // Not a hard stop: the user may be about to free space, or may only want a
      // 6 GB vision model. Say the number and let them decide.
      if (free !== undefined && free < 6) {
        return {
          ok: false,
          error: `That drive has only ${Math.round(free)} GB free — not enough for any model here (the smallest is 6 GB). Pick another folder.`
        }
      }
    }
    saveConfig({ ...cfg, local: { ...cfg.local, modelsDir: dir } })
    const exe = findOllama()
    if (exe && cfg.local?.managed) {
      const running = await probeOllama()
      if (running.running) {
        // A process reads its environment at launch, so a live daemon has to be
        // restarted for OLLAMA_MODELS to take effect. The app only does this for
        // a daemon it started itself.
        try {
          execFileSync('taskkill', ['/F', '/IM', 'ollama.exe'], { stdio: 'ignore' })
        } catch {
          // Not running under that name; the serve call below handles it.
        }
        await delay(800)
        startOllamaServe(exe, dir || defaultModelsDir(), loadConfig().local?.contextLength || undefined)
      }
    }
    return { ok: true, modelsDir: dir || defaultModelsDir(), restartNeeded: !!exe && !cfg.local?.managed }
  })

  /** Choose how large a context the daemon asks for. Restarts a managed daemon. */
  ipcMain.handle('local:setContext', async (_e, tokens: number) => {
    const allowed = CONTEXT_CHOICES.map((c) => c.tokens) as number[]
    if (!allowed.includes(tokens)) return { ok: false, error: 'That context size is not offered.' }
    const cfg = loadConfig()
    saveConfig({ ...cfg, local: { ...cfg.local, contextLength: tokens } })
    const exe = findOllama()
    if (exe && cfg.local?.managed) {
      try {
        execFileSync('taskkill', ['/F', '/IM', 'ollama.exe'], { stdio: 'ignore' })
      } catch {
        // Nothing running to stop.
      }
      await delay(600)
      startOllamaServe(exe, cfg.local?.modelsDir || defaultModelsDir(), tokens)
    }
    return { ok: true, contextLength: tokens, restartNeeded: !!exe && !cfg.local?.managed }
  })

  /** Start the daemon ourselves so OLLAMA_MODELS is honoured. */
  ipcMain.handle('local:startDaemon', async () => {
    const cfg = loadConfig()
    const exe = findOllama()
    if (!exe) return { ok: false, error: 'Ollama is not installed.' }
    const probe = await probeOllama()
    if (probe.running) return { ok: true, alreadyRunning: true }
    const ctx = cfg.local?.contextLength || contextForVram(primaryGpu(detectGpus())?.vramGb)
    startOllamaServe(exe, cfg.local?.modelsDir || defaultModelsDir(), ctx)
    saveConfig({ ...cfg, local: { ...cfg.local, managed: true } })
    // The daemon takes a moment to bind the port; a single retry is enough and
    // avoids a spinner that never resolves.
    await delay(2000)
    const after = await probeOllama()
    return after.running ? { ok: true } : { ok: false, error: after.error ?? 'Ollama did not start.' }
  })

  /** Pull one model, streaming Ollama's progress lines to the renderer. */
  ipcMain.handle('local:pull', async (_e, modelId: string) => {
    if (!LOCAL_MODELS.some((m) => m.id === modelId)) return { ok: false, error: 'That model is not in the catalogue.' }
    // Downloading 8 GB that cannot load is the worst outcome, so it is refused
    // here with the reason. 'slow' and 'tight' still download: they work.
    const cfgNow = loadConfig()
    const system = detectSystem()
    const fit = verdictFor(modelId, system, cfgNow.local?.contextLength || undefined)
    if (fit.verdict === 'impossible') {
      return { ok: false, error: `${fit.reason} ${fit.fix ?? ''}`.trim(), hardware: fit }
    }
    const probe = await probeOllama()
    if (!probe.running) return { ok: false, error: 'Ollama is not running. Install or start it first.' }
    if (!probe.anthropic) {
      return { ok: false, error: 'This Ollama version has no Anthropic-compatible endpoint. Update to 0.14 or newer.' }
    }
    return pullModel(modelId, (p) => send('local:pull-progress', p))
  })

  ipcMain.handle('local:cancelPull', () => cancelPull())

  /** Download every model the current role mapping needs, de-duplicated. */
  ipcMain.handle('local:pullBundle', async (_e, opts: { bundle?: BundleId; models?: string[] }) => {
    const probe = await probeOllama()
    if (!probe.running) return { ok: false, error: 'Ollama is not running. Install or start it first.' }
    const wanted = opts.models ?? bundleById(opts.bundle ?? 'recommended')?.models ?? []
    const targets = [...new Set(wanted)].filter((id) => LOCAL_MODELS.some((m) => m.id === id))
    if (!targets.length) return { ok: false, error: 'Nothing to download.' }
    const failures: string[] = []
    const skipped: string[] = []
    const system = detectSystem()
    for (const [i, id] of targets.entries()) {
      const fit = verdictFor(id, system, loadConfig().local?.contextLength || undefined)
      if (fit.verdict === 'impossible') {
        // Do not download something that cannot load; keep going with the rest
        // so a bundle still gets the user a working setup.
        skipped.push(`${modelById(id)?.label ?? id} (${fit.needGb} GB needed, ${Math.round(fit.haveGb)} GB available)`)
        send('local:bundle-progress', { index: i, of: targets.length, model: id, state: 'skipped', error: fit.reason })
        continue
      }
      send('local:bundle-progress', { index: i, of: targets.length, model: id, state: 'start' })
      const res = await pullModel(id, (p) => send('local:pull-progress', p))
      send('local:bundle-progress', { index: i, of: targets.length, model: id, state: res.ok ? 'done' : 'error', error: res.error })
      if (!res.ok) {
        // A cancelled run must not carry on downloading the rest.
        if (/cancel/i.test(res.error ?? '')) return { ok: false, error: 'Download cancelled.', done: targets.slice(0, i) }
        failures.push(`${id}: ${res.error}`)
      }
    }
    if (failures.length) return { ok: false, error: failures.join('; '), done: targets, skipped }
    if (skipped.length) {
      // Partial success, and it must not read as a failure: everything that fits
      // was installed.
      return {
        ok: true,
        done: targets.filter((id) => !skipped.some((s) => s.startsWith(modelById(id)?.label ?? id))),
        skipped,
        error: `Skipped because this machine cannot run them: ${skipped.join(', ')}.`
      }
    }
    return { ok: true, done: targets }
  })

  /** Store which model ids fill each role. */
  ipcMain.handle('local:setRoles', async (_e, roles: { agent?: string[]; vision?: string[]; quick?: string[] }) => {
    const cfg = loadConfig()
    const clean: Record<string, string[]> = {}
    const problems: string[] = []
    for (const role of LOCAL_ROLES) {
      const list = [...new Set((roles[role.id] ?? []).filter((id) => LOCAL_MODELS.some((m) => m.id === id)))]
      for (const id of list) {
        const fit = roleFit(id, role.id)
        if (!fit.ok) problems.push(`${role.label}: ${fit.reason}`)
      }
      clean[role.id] = list
    }
    if (problems.length) return { ok: false, error: problems.join(' ') }
    saveConfig({ ...cfg, local: { ...cfg.local, roles: clean as AppConfig['local']['roles'] } })
    // The agent's model follows the agent role when on Ollama, so the single
    // `model` field stays truthful for the Settings picker.
    if ((cfg.provider || 'anthropic') === 'ollama' && clean.agent[0]) saveConfig({ ...loadConfig(), model: clean.agent[0] })
    return { ok: true, roles: clean }
  })

  /* ----------------------------------------------------------------- providers */

  /** The provider list and their bundled models, so Settings works offline. */
  ipcMain.handle('providers:list', () => ({
    providers: PROVIDERS,
    models: KNOWN_MODELS,
    defaults: DEFAULT_MODELS
  }))

  /** Open a provider's key page in the browser, so Settings can say "get a key". */
  ipcMain.handle('providers:openSignup', async (_e, url: string) => {
    if (!/^https:\/\//.test(url)) return { ok: false }
    await shell.openExternal(url)
    return { ok: true }
  })

  /** Live model list for one provider (OpenRouter's free roster, Ollama's local models). */
  ipcMain.handle('providers:models', async (_e, opts: { provider: ProviderId; apiKey?: string }) => {
    const cfg = loadConfig()
    const key = opts.apiKey && !opts.apiKey.startsWith('••') ? opts.apiKey : cfg.apiKey
    return discoverModels(opts.provider, key)
  })

  /**
   * A real round trip through the Anthropic protocol, so the user finds out a
   * key is wrong (or a free model is rate limited) in Settings rather than
   * halfway through a code change.
   */
  ipcMain.handle('providers:test', async (_e, opts: { provider: ProviderId; model: string; apiKey?: string }) => {
    const cfg = loadConfig()
    const key = opts.apiKey && !opts.apiKey.startsWith('••') ? opts.apiKey : cfg.apiKey
    if (requiresKey(opts.provider) && !key) return { ok: false, error: 'Paste an API key first.' }
    // Honour a base-URL override: testing the default endpoint when the user
    // pointed the agent at a proxy would report a false pass.
    const base =
      (opts.provider === (cfg.provider || 'anthropic') ? effectiveBaseUrl() : '') ||
      PROVIDERS.find((p) => p.id === opts.provider)?.baseUrl ||
      'https://api.anthropic.com'
    const url = `${base.replace(/\/+$/, '')}/v1/messages`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 45_000)
    const started = Date.now()
    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          ...(opts.provider === 'anthropic'
            ? { 'x-api-key': key }
            : { authorization: `Bearer ${key || opts.provider}` })
        },
        body: JSON.stringify({
          model: opts.model,
          max_tokens: 24,
          messages: [{ role: 'user', content: 'Reply with the single word: ready' }]
        })
      })
      const text = await res.text()
      if (!res.ok) return { ok: false, error: explainProviderError(res.status, text) }
      const json = JSON.parse(text) as { content?: { type: string; text?: string }[] }
      const reply = (json.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join(' ').trim()
      return { ok: true, reply: reply.slice(0, 120), ms: Date.now() - started }
    } catch (e) {
      const msg = (e as Error).message
      return {
        ok: false,
        error: /abort/i.test(msg)
          ? 'Timed out after 45 s. A free model may be busy; try again.'
          : /fetch failed|ENOTFOUND|ECONN/i.test(msg)
            ? 'Could not reach the provider. Check your connection' + (opts.provider === 'ollama' ? ' and that Ollama is running.' : '.')
            : msg
      }
    } finally {
      clearTimeout(timer)
    }
  })

  /* ------------------------------------------------------------------- update */

  initUpdater()
  ipcMain.handle('update:state', () => ({ ...currentUpdateState(), versionLabel: versionLabel() }))
  ipcMain.handle('update:check', async () => checkForUpdates())
  ipcMain.handle('update:download', () => downloadUpdate())
  ipcMain.handle('update:install', () => installUpdate())
  ipcMain.handle('update:setAuto', (_e, enabled: boolean) => setAutoUpdate(enabled))
  ipcMain.handle('update:clearCache', () => clearUpdaterCache())
  ipcMain.handle('update:supported', () => ({ supported: updatesSupported() }))

  /* ------------------------------------------------------------------ versions */

  /** The live catalog. `force` bypasses the 24 h cache (the Refresh button). */
  ipcMain.handle('versions:catalog', async (_e, opts: { force?: boolean; snapshots?: boolean } = {}) => {
    const catalog = await getCatalog({ force: opts.force })
    return {
      ok: true,
      fetchedAt: catalog.fetchedAt,
      errors: catalog.errors,
      minVersion: MIN_MC_VERSION,
      versions: selectableVersions(catalog, { snapshots: opts.snapshots }).map((v) => ({
        id: v.id,
        type: v.type,
        releasedAt: v.releasedAt,
        loaders: loadersFor(catalog, v.id)
      }))
    }
  })

  /** Loader builds that support one Minecraft version, newest first. */
  ipcMain.handle('versions:loaders', async (_e, opts: { mcVersion: string; loader: Loader }) => {
    const catalog = await getCatalog()
    return {
      ok: true,
      versions: loaderVersionsFor(catalog, opts.loader, opts.mcVersion).map((l) => l.version),
      loaders: loadersFor(catalog, opts.mcVersion)
    }
  })

  /** Everything the Setup dialog needs for one pick: era label, java, buildable. */
  ipcMain.handle('versions:era', (_e, opts: { loader: Loader; mcVersion: string }) => {
    const era = resolveEra(opts.loader, opts.mcVersion)
    if (!era) return { ok: false, error: 'No build toolchain for that combination.' }
    return { ok: true, era: { id: era.id, label: era.label, buildable: era.buildable, java: era.java, notes: era.notes } }
  })

  ipcMain.handle('project:validate', (_e, opts: { modId: string; group: string }) => ({
    modId: validateModId(opts.modId),
    group: validatePackage(opts.group)
  }))

  ipcMain.handle('dialog:pickFolder', async (_e, opts: { title?: string; defaultPath?: string } = {}) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const res = await dialog.showOpenDialog(win, {
      title: opts.title ?? 'Select folder',
      defaultPath: opts.defaultPath,
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle('dialog:pickFiles', async (_e, opts: { title?: string; filters?: { name: string; extensions: string[] }[]; multi?: boolean } = {}) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const res = await dialog.showOpenDialog(win, {
      title: opts.title ?? 'Select files',
      properties: opts.multi ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: opts.filters
    })
    return res.canceled ? [] : res.filePaths
  })

  ipcMain.handle('project:summary', async () => {
    const cfg = loadConfig()
    const ws = cfg.workspaceDir
    if (!ws || !fs.existsSync(ws)) return { open: false }
    const props = parseProps(path.join(ws, 'gradle.properties'))
    const git = await gitSummary(ws).catch(() => ({ dirty: [], branch: null, remote: null }))
    const files = listTree(ws, 400)
    const jar = findBuiltJar(ws)
    return {
      open: true,
      dir: ws,
      props,
      git,
      files,
      latestJar: jar ? readJarInfo(jar) : null,
      isGradle: isGradleProject(ws),
      template: templateRoot()
    }
  })

  ipcMain.handle('project:readFile', (_e, rel: string) => {
    const ws = loadConfig().workspaceDir
    const full = path.resolve(ws, rel)
    if (!full.startsWith(path.resolve(ws))) return { ok: false, error: 'outside project' }
    try {
      const stat = fs.statSync(full)
      if (stat.size > 512_000) return { ok: false, error: 'file too large' }
      return { ok: true, text: fs.readFileSync(full, 'utf8') }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('project:writeFile', (_e, rel: string, content: string) => {
    const ws = loadConfig().workspaceDir
    const full = path.resolve(ws, rel)
    if (!full.startsWith(path.resolve(ws))) return { ok: false, error: 'outside project' }
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content, 'utf8')
    return { ok: true }
  })

  // ---------------- build ----------------
  ipcMain.handle('build:local', async (_e, opts: { task?: 'build' | 'compileJava' } = {}) => {
    const cfg = loadConfig()
    if (!cfg.workspaceDir) return { ok: false, error: 'No project open.' }
    const res = await runLocalBuild({
      workspaceDir: cfg.workspaceDir,
      mode: 'local',
      javaPath: cfg.javaPath,
      preferWrapper: cfg.preferWrapper,
      task: opts.task ?? 'build',
      onLine: (line) => send('build:line', { line })
    })
    send('build:done', res)
    return res
  })

  ipcMain.handle('build:actions', async () => {
    const cfg = loadConfig()
    if (!cfg.workspaceDir) return { ok: false, error: 'No project open.' }
    const res = await runActionsBuild(cfg.github, cfg.workspaceDir, parseProps(path.join(cfg.workspaceDir, 'gradle.properties')).mod_id ?? 'mod', (line) =>
      send('build:line', { line })
    )
    send('build:done', res)
    return res
  })

  ipcMain.handle('build:preflight', async () => ghPreflight(loadConfig().github, loadConfig().workspaceDir))
  ipcMain.handle('build:logPath', () => buildLogPath())
  ipcMain.handle('build:openLog', async (_e, p: string) => {
    await shell.openPath(p)
  })
  ipcMain.handle('build:initRepo', async (_e, isPrivate: boolean) => {
    const cfg = loadConfig()
    if (!cfg.workspaceDir) return { ok: false, error: 'No project open.' }
    const res = await initGithubRepo(cfg.github, cfg.workspaceDir, isPrivate, (line) => send('build:line', { line }))
    return res
  })

  // ---------------- instances / game ----------------
  ipcMain.handle('instance:detect', () => detectTechnicInstances())

  ipcMain.handle('instance:list', () => {
    const cfg = loadConfig()
    return { instances: cfg.game.instances, activeId: cfg.game.activeInstanceId }
  })

  ipcMain.handle('instance:setActive', (_e, id: string) => {
    const cfg = saveConfig({ game: { ...loadConfig().game, activeInstanceId: id } })
    instanceOverride = ''
    resetSession()
    return cfg.game
  })

  ipcMain.handle('instance:add', (_e, instance: GameInstance) => {
    const cfg = loadConfig()
    const normalized: GameInstance = {
      ...instance,
      // Technic packs keep loader files inside <pack>/.minecraft
      minecraftDir: instance.minecraftDir || (instance.kind === 'technic' ? path.join(instance.path, '.minecraft') : instance.path)
    }
    const game = { ...cfg.game, instances: [...cfg.game.instances.filter((i) => i.id !== normalized.id), normalized], activeInstanceId: normalized.id }
    saveConfig({ game })
    return game
  })

  ipcMain.handle('instance:remove', (_e, id: string) => {
    const cfg = loadConfig()
    const instances = cfg.game.instances.filter((i) => i.id !== id)
    const activeInstanceId = cfg.game.activeInstanceId === id ? (instances[0]?.id ?? '') : cfg.game.activeInstanceId
    saveConfig({ game: { ...cfg.game, instances, activeInstanceId } })
    repairInstance(instances, activeInstanceId)
    return loadConfig().game
  })

  function repairInstance(_i: GameInstance[], _a: string): void {
    /* placeholder for future instance repair */
  }

  ipcMain.handle('game:status', () => gameStatus())
  ipcMain.handle('game:stop', () => stopGame())
  ipcMain.handle('game:log', (_e, lines = 400) => readGameLog(lines))
  ipcMain.handle('game:launch', async () => {
    const cfg = loadConfig()
    const instance = cfg.game.instances.find((i) => i.id === cfg.game.activeInstanceId)
    if (instance?.kind === 'technic') {
      const res = await launchTechnic()
      return res
    }
    return launchDevClient({
      workspaceDir: cfg.workspaceDir,
      instanceId: cfg.game.activeInstanceId,
      javaPath: cfg.javaPath,
      jvmArgs: cfg.game.clientJvmArgs,
      programArgs: cfg.game.clientProgramArgs,
      windowWidth: cfg.game.windowWidth,
      windowHeight: cfg.game.windowHeight
    })
  })

  ipcMain.handle('game:screenshot', async (_e, label?: string) => {
    const res = await captureGameWindow(label)
    send('screenshot:new', { path: res.path, label })
    return res
  })

  ipcMain.handle('game:screenshots', () => listScreenshots())
  ipcMain.handle('game:openFolder', async () => {
    const cfg = loadConfig()
    const instance = cfg.game.instances.find((i) => i.id === cfg.game.activeInstanceId)
    await shell.openPath(instance?.path ?? screenshotsDir())
  })

  ipcMain.handle('game:installJar', async (_e, jarPath?: string) => {
    const cfg = loadConfig()
    const instance = cfg.game.instances.find((i) => i.id === cfg.game.activeInstanceId)
    if (!instance) return { ok: false, error: 'No instance selected.' }
    const jar = jarPath ?? findBuiltJar(cfg.workspaceDir)
    if (!jar || !fs.existsSync(jar)) return { ok: false, error: 'No built jar found.' }
    const res = installJar(jar, instance.path)
    return { ok: true, ...res, jar: readJarInfo(jar) }
  })

  ipcMain.handle('game:exportTechnic', async () => {
    const cfg = loadConfig()
    const instance = cfg.game.instances.find((i) => i.id === cfg.game.activeInstanceId)
    if (!instance) return { ok: false, error: 'No instance selected.' }
    const props = parseProps(path.join(cfg.workspaceDir, 'gradle.properties'))
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const save = await dialog.showSaveDialog(win, {
      title: 'Export Technic pack zip',
      defaultPath: path.join(cfg.workspaceDir, `${props.mod_id ?? 'mod'}-technic-pack.zip`),
      filters: [{ name: 'Zip', extensions: ['zip'] }]
    })
    if (save.canceled || !save.filePath) return { ok: false, error: 'cancelled' }
    return buildTechnicPackZip(instance.path, save.filePath, {
      name: props.mod_name ?? 'Mod',
      version: props.mod_version ?? '1.0.0',
      loaderVersion: props.neo_version ?? '21.1.265'
    })
  })

  // ---------------- NeoForge loader (Technic-compatible instance) ----------------
  ipcMain.handle('neoforge:status', () => {
    const cfg = loadConfig()
    const instance = cfg.game.instances.find((i) => i.id === cfg.game.activeInstanceId)
    const props = parseProps(path.join(cfg.workspaceDir, 'gradle.properties'))
    const neoVersion = props.neo_version ?? '21.1.265'
    const mcDirPath = instance?.minecraftDir || instance?.path || ''
    return {
      instance: instance?.name ?? null,
      minecraftDir: mcDirPath,
      neoVersion,
      installed: !!mcDirPath && isNeoForgeInstalled(mcDirPath, neoVersion),
      javaFound: !!resolveJava(cfg.javaPath).path
    }
  })

  ipcMain.handle('neoforge:install', async () => {
    const cfg = loadConfig()
    const instance = cfg.game.instances.find((i) => i.id === cfg.game.activeInstanceId)
    if (!instance) return { ok: false, error: 'No test instance selected.' }
    const props = parseProps(path.join(cfg.workspaceDir, 'gradle.properties'))
    const neoVersion = props.neo_version ?? '21.1.265'
    const mcDirPath = instance.minecraftDir || (instance.kind === 'technic' ? path.join(instance.path, '.minecraft') : instance.path)
    const res = await installNeoForge({ neoVersion, minecraftDir: mcDirPath, javaPath: cfg.javaPath, onLine: (line) => send('build:line', { line }) })
    return res
  })

  // ---------------- direct client launch (no third-party launcher needed) ----------------
  ipcMain.handle('game:launchDirect', async () => {
    const cfg = loadConfig()
    const instance = cfg.game.instances.find((i) => i.id === cfg.game.activeInstanceId)
    if (!instance) return { ok: false, error: 'No test instance selected.' }
    const props = parseProps(path.join(cfg.workspaceDir, 'gradle.properties'))
    const mcDirPath = instance.minecraftDir || (instance.kind === 'technic' ? path.join(instance.path, '.minecraft') : instance.path)
    const jar = findBuiltJar(cfg.workspaceDir)
    if (jar && fs.existsSync(jar)) installJar(jar, instance.path)
    return launchNeoForge({
      minecraftDir: mcDirPath,
      neoVersion: props.neo_version ?? '21.1.265',
      gameDir: instance.path,
      javaPath: cfg.javaPath,
      width: cfg.game.windowWidth,
      height: cfg.game.windowHeight,
      extraJvmArgs: cfg.game.clientJvmArgs ? cfg.game.clientJvmArgs.split(/\s+/) : [],
      onLine: (line) => send('game:line', { line })
    })
  })

  ipcMain.handle('game:directStatus', () => {
    const direct = runningGame()
    return direct
      ? { running: direct.exitCode === null, pid: direct.child.pid, titleScreen: direct.titleScreen, logPath: direct.logPath, exitCode: direct.exitCode }
      : { running: false }
  })

  ipcMain.handle('game:stopAny', async () => {
    stopNeoForge()
    return stopGame()
  })

  // ---------------- chat ----------------
  ipcMain.handle('chat:list', () => listConversations())
  ipcMain.handle('chat:load', (_e, id: string) => {
    const conv = loadConversation(id)
    if (conv) {
      currentConversation = conv
      resetSession()
    }
    return conv
  })
  ipcMain.handle('chat:new', () => {
    currentConversation = { id: newConversationId(), title: 'New conversation', createdAt: Date.now(), updatedAt: Date.now(), messages: [] }
    persist()
    resetSession()
    return currentConversation
  })
  ipcMain.handle('chat:delete', (_e, id: string) => {
    deleteConversation(id)
    if (currentConversation?.id === id) currentConversation = null
    return listConversations()
  })

  ipcMain.handle('chat:send', async (_e, payload: { text: string; attachments?: { path: string; name: string; kind: string; mediaType?: string }[] }) => {
    const cfg = loadConfig()
    // Only providers that actually need a key are gated. Local Ollama runs
    // keyless, and blocking it here would make the free path unreachable.
    const provider = (cfg.provider || 'anthropic') as ProviderId
    if (requiresKey(provider) && !effectiveApiKey()) {
      return {
        ok: false,
        error:
          provider === 'anthropic'
            ? 'Set your Anthropic API key in Settings first, or pick a free provider.'
            : `Set a ${PROVIDERS.find((p) => p.id === provider)?.label ?? provider} API key in Settings first.`
      }
    }
    if (!cfg.workspaceDir || !fs.existsSync(cfg.workspaceDir)) return { ok: false, error: 'Create or open a mod project first.' }

    const conv = conversation()
    const msg: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      text: payload.text,
      createdAt: Date.now(),
      attachments: payload.attachments?.map((a) => ({ path: a.path, name: a.name, kind: a.kind }))
    }
    conv.messages.push(msg)
    const assistant: ChatMessage = { id: `msg-${Date.now()}-a`, role: 'assistant', text: '', createdAt: Date.now(), tools: [] }
    conv.messages.push(assistant)
    persist()
    send('chat:user-message', msg)
    send('chat:assistant-start', assistant)

    const s = ensureSession()
    s.setAutonomy(cfg.autonomy)
    const images = (payload.attachments ?? [])
      .filter((a) => a.kind === 'image')
      .map((a) => ({ path: a.path, mediaType: a.mediaType ?? 'image/png' }))
    try {
      await s.send(payload.text, images)
      return { ok: true }
    } catch (err) {
      assistant.error = (err as Error).message
      persist()
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('chat:interrupt', async () => {
    await session?.interrupt()
    persist()
    return { ok: true }
  })

  ipcMain.handle('chat:permission', (_e, payload: { id: string; allow: boolean; remember: boolean }) => {
    session?.respondPermission(payload.id, payload.allow, payload.remember)
    return { ok: true }
  })

  ipcMain.handle('chat:autonomy', (_e, mode: 'auto' | 'review' | 'ask') => {
    saveConfig({ autonomy: mode })
    session?.setAutonomy(mode)
    return { ok: true }
  })

  ipcMain.handle('chat:attachImage', (_e, args: { base64: string; name: string }) => {
    const dir = attachmentsDir()
    const file = path.join(dir, `${Date.now()}-${args.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`)
    fs.writeFileSync(file, Buffer.from(args.base64, 'base64'))
    return { path: file, name: path.basename(file), kind: 'image', size: fs.statSync(file).size }
  })

  ipcMain.handle('chat:attachFile', (_e, filePath: string) => {
    const dir = attachmentsDir()
    const target = path.join(dir, `${Date.now()}-${path.basename(filePath).replace(/[^a-zA-Z0-9._-]/g, '_')}`)
    fs.copyFileSync(filePath, target)
    return { path: target, name: path.basename(filePath), kind: 'file', size: fs.statSync(target).size }
  })

  // forward game log lines to the renderer console
  onGameLog((line) => send('game:line', { line }))
  onGameStatus((status: GameStatus) => send('game:status', status))
}

function parseProps(file: string): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*$/)
      if (m && !line.trim().startsWith('#')) out[m[1]] = m[2]
    }
  } catch {
    /* none */
  }
  return out
}

/** Join inside a folder without allowing `..` to escape it. */
function safeJoin(root: string, rel: string): string | null {
  const full = path.resolve(root, rel)
  const base = path.resolve(root)
  if (full !== base && !full.startsWith(base + path.sep)) return null
  return full
}

function listTree(root: string, limit: number): { path: string; dir: boolean }[] {
  const out: { path: string; dir: boolean }[] = []
  const walk = (dir: string, depth: number): void => {
    if (out.length >= limit || depth > 6) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
      if (['.git', 'build', '.gradle', 'run', 'node_modules', '.agent', 'logs'].includes(e.name)) continue
      const full = path.join(dir, e.name)
      const rel = path.relative(root, full).split(path.sep).join('/')
      out.push({ path: rel, dir: e.isDirectory() })
      if (e.isDirectory()) walk(full, depth + 1)
      if (out.length >= limit) return
    }
  }
  walk(root, 0)
  return out
}

/** Trim the stored record down to what the renderer needs. */
function toRefUi(mod: import('../github/references').ReferenceMod | ReferenceModUi): ReferenceModUi {
  const m = mod as import('../github/references').ReferenceMod
  return {
    id: m.id,
    slug: m.slug,
    title: m.title,
    version: m.version,
    source: m.source,
    repo: m.repo,
    homepage: m.homepage,
    license: m.license,
    jarName: m.jarName,
    jarSize: m.jarSize,
    modId: m.modId,
    loader: m.loader,
    mcVersion: m.mcVersion,
    decompiled: m.decompiled,
    decompiler: m.decompiler,
    sourcesDir: m.sourcesDir,
    linked: m.linked,
    createdAt: m.createdAt,
    error: m.error
  }
}

/**
 * Provider errors speak in status codes and JSON envelopes. Translate the ones a
 * user can act on; leave the rest readable but intact.
 */
function explainProviderError(status: number, body: string): string {
  const snippet = body.replace(/\s+/g, ' ').slice(0, 240)
  if (status === 401) return 'That API key was rejected. Check it was copied whole and belongs to this provider.'
  if (status === 402) return 'This account has no credit. Pick a free model, or add credit on the provider dashboard.'
  if (status === 403) return 'The key is valid but not allowed to use that model.'
  if (status === 404) return 'That model does not exist on this provider (or the base URL is wrong). Use Refresh to load the current list.'
  if (status === 429) return 'Rate limited by the provider. Free tiers are strict; wait a minute or pick another model.'
  if (status >= 500) return 'The provider had a server error. Try again in a moment.'
  return `Provider returned HTTP ${status}: ${snippet}`
}

/** Small sleep used between daemon restarts. */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Which bundle to put first for a given amount of video memory.
 *
 * This is a suggestion, not a restriction: the panel still lists every bundle.
 * The thresholds come from the weights themselves — a 12B model at Q4 is about
 * 8 GB before any context, so an 8 GB card is the boundary case.
 */
function recommendBundle(
  vramGb: number | undefined,
  fit?: { verdicts: Record<string, { verdict: string }>; best?: string }
): BundleId {
  // When the machine is known, trust the per-model verdicts: the largest model
  // that actually fits might be the compact bundle or something better.
  if (fit?.best) {
    if (fit.best === 'gemma4:12b') return 'compact'
    if (fit.best === 'qwen3-coder:30b') return 'recommended'
    if (fit.best === 'qwen3-coder:7b' || fit.best === 'gpt-oss:20b') return 'essential'
    // Only the small models fit, so the honest suggestion is the bundle built
    // from them rather than a 7B the machine cannot hold.
    if (['llama3.2:3b', 'qwen3:4b', 'gemma3:4b'].includes(fit.best)) return 'lowend'
  }
  if (vramGb === undefined) return 'essential'
  if (vramGb <= 8) return 'compact'
  if (vramGb <= 12) return 'essential'
  if (vramGb <= 20) return 'recommended'
  return 'max'
}
