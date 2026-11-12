import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { AgentSession } from '../agent/engine'
import { effectiveApiKey, loadConfig, redactConfig, saveConfig, screenshotsDir, attachmentsDir } from '../config'
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
import { scaffoldProject, validateModId, validatePackage, templateRoot } from '../mod/scaffold'
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
          if (payload.isError) last.error = payload.text || 'The run failed.'
        }
        conv.sessionId = payload.sessionId ?? conv.sessionId
        persist()
        send('agent:result', payload)
      },
      onNotice: () => undefined,
      onOutput: (line, source) => send('agent:output', { line, source }),
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
  ipcMain.handle('config:get', () => {
    const cfg = loadConfig()
    return { ...redactConfig(cfg), apiKeySet: !!effectiveApiKey() }
  })

  ipcMain.handle('config:set', (_e, patch: Partial<AppConfig>) => {
    // A masked key coming back from the UI must not overwrite the real one.
    if (patch.apiKey && patch.apiKey.startsWith('••')) delete patch.apiKey
    const next = saveConfig(patch)
    if (patch.autonomy) session?.setAutonomy(next.autonomy)
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
      {
        id: 'key',
        label: 'Anthropic API key',
        ok: !!effectiveApiKey(),
        detail: effectiveApiKey() ? 'Configured' : 'Missing',
        fix: 'Paste your key in Settings (it is stored only on this machine).'
      },
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
  ipcMain.handle('project:scaffold', async (_e, opts: { parentDir: string; modId: string; modName: string; group: string; modVersion: string; author?: string; license?: string; neoVersion?: string }) => {
    const dir = path.join(opts.parentDir, opts.modId)
    const res = scaffoldProject({
      targetDir: dir,
      modId: opts.modId,
      modName: opts.modName,
      group: opts.group,
      modVersion: opts.modVersion || '1.0.0',
      neoVersion: opts.neoVersion || '21.1.265',
      author: opts.author,
      license: opts.license
    })
    if (!res.ok) return res
    saveConfig({ workspaceDir: dir })
    resetSession()
    return { ok: true, dir }
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
    if (!effectiveApiKey()) return { ok: false, error: 'Set your Anthropic API key in Settings first.' }
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
