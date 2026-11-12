import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig, effectiveApiKey } from '../config'
import { runLocalBuild } from '../build/gradle'
import { resolveJava, resolveToolJava } from '../util/exec'
import { installJar, copyExtraMods, readJarInfo } from '../mod/jar'
import { buildTechnicPackZip, detectTechnicInstances, launchTechnic } from '../game/technic'
import { captureGameWindow, listScreenshots } from '../game/capture'
import { gameStatus, launchDevClient, readGameLog, stopGame } from '../game/launcher'
import { installNeoForge, isNeoForgeInstalled } from '../game/neoforge'
import { launchNeoForge, runningGame, stopNeoForge } from '../game/client'
import { ghPreflight, runActionsBuild } from '../build/actions'
import { addFromGithub, ensureReferenceIgnored, getReference, linkToProject, listReferences, parseRepoRef, searchReference, getReference as getRef } from '../github/references'
import { authToken } from '../github/oauth'
import { gitSummary } from '../build/gradle'

type TextResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

function text(s: string): TextResult {
  return { content: [{ type: 'text', text: s }] }
}

function err(s: string): TextResult {
  return { content: [{ type: 'text', text: s }], isError: true }
}

/** Latest jar produced by the app (local build or Actions download). */
export function latestJar(workspace: string): string | undefined {
  const candidates: string[] = []
  const libs = path.join(workspace, 'build', 'libs')
  const stable = path.join(workspace, '.agent', 'latest')
  for (const dir of [libs, stable]) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.jar') && !/-sources|-javadoc|-dev/.test(f)) candidates.push(path.join(dir, f))
      }
    } catch {
      /* missing */
    }
  }
  return candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
}

export interface ToolContext {
  getWorkspace: () => string
  getInstanceId: () => string
  /** Called when a tool changes something the UI should refresh. */
  notify: (channel: string, payload?: unknown) => void
  /** Live output from builds and the game, streamed to the renderer console. */
  onOutput?: (line: string, source: 'build' | 'game') => void
  /** Game process status changes (started, exited, title screen reached). */
  onGameStatus?: (status: import('../../shared/types').GameStatus) => void
  /** Screenshot returned to the renderer for display. */
  onScreenshot?: (info: { path: string; width?: number; height?: number }) => void
}

export function createAgentTools(ctx: ToolContext) {
  let activeBuild: AbortController | null = null

  const tools = [
    tool(
      'project_info',
      'Report the mod project state: mod id/name/version from gradle.properties, NeoForge and Minecraft versions, source file count, git branch/dirty files, and the latest built jar.',
      {},
      async () => {
        const ws = ctx.getWorkspace()
        const props = readProps(path.join(ws, 'gradle.properties'))
        const git = await gitSummary(ws).catch(() => ({ dirty: [], branch: null, remote: null }))
        const jar = latestJar(ws)
        const files = countFiles(path.join(ws, 'src'))
        return text(
          JSON.stringify(
            {
              workspace: ws,
              modId: props.mod_id,
              modName: props.mod_name,
              modVersion: props.mod_version,
              group: props.mod_group_id,
              minecraft: props.minecraft_version,
              neoForge: props.neo_version,
              sourceFiles: files,
              git,
              latestJar: jar ? { ...readJarInfo(jar) } : null
            },
            null,
            2
          )
        )
      }
    ),

    tool(
      'env_report',
      'Check the toolchain: Java 21, GitHub CLI login, GitHub repo access, configured test instance, and whether the project is a valid gradle build.',
      {},
      async () => {
        const cfg = loadConfig()
        const javaPick = resolveJava(cfg.javaPath)
        const toolPick = resolveToolJava(cfg.javaPath)
        const gh = await ghPreflight(cfg.github, cfg.workspaceDir).catch(() => ({ ghFound: false, authed: false, repoOk: false, messages: ['gh check failed'] }))
        const instance = cfg.game.instances.find((i) => i.id === cfg.game.activeInstanceId)
        return text(
          JSON.stringify(
            {
              java: {
                path: javaPick.path,
                version: javaPick.version,
                ok: !!javaPick.version?.startsWith('21'),
                error: javaPick.error
              },
              decompilerJava: { path: toolPick.path, version: toolPick.version, error: toolPick.error },
              github: gh,
              apiKeyPresent: !!effectiveApiKey(),
              instance: instance ? { name: instance.name, kind: instance.kind, path: instance.path, exists: fs.existsSync(instance.path) } : null,
              isGradleProject: fs.existsSync(path.join(cfg.workspaceDir, 'build.gradle')),
              detectedTechnic: detectTechnicInstances().map((i) => i.path)
            },
            null,
            2
          )
        )
      }
    ),

    tool(
      'build',
      'Build the mod. mode "local" runs ./gradlew build on this machine (fast, full javac errors). mode "actions" commits, pushes and builds on GitHub Actions, then downloads the jar. Returns exit code, errors and jar path.',
      {
        mode: z.enum(['local', 'actions']).default('local'),
        task: z.enum(['build', 'compileJava']).default('build').describe('compileJava is a faster syntax/type check')
      },
      async ({ mode, task }) => {
        if (activeBuild) return err('A build is already running. Wait for it to finish.')
        const ws = ctx.getWorkspace()
        const cfg = loadConfig()
        activeBuild = new AbortController()
        const lines: string[] = []
        try {
          if (mode === 'local') {
            const res = await runLocalBuild({
              workspaceDir: ws,
              mode: 'local',
              javaPath: cfg.javaPath,
              preferWrapper: cfg.preferWrapper,
              task,
              onLine: (l) => {
                lines.push(l)
                if (lines.length > 400) lines.shift()
                ctx.onOutput?.(l, 'build')
              },
              signal: activeBuild.signal
            })
            ctx.notify('build:done', { ok: res.ok, jarPath: res.jarPath, logPath: res.logPath, source: 'local' })
            return res.ok
              ? text(JSON.stringify({ ok: true, jar: res.jarPath, durationMs: res.durationMs, logPath: res.logPath }, null, 2))
              : err(
                  JSON.stringify(
                    { ok: false, exitCode: res.code, errors: res.errors.length ? res.errors : lines.slice(-40), logPath: res.logPath },
                    null,
                    2
                  )
                )
          }
          const res = await runActionsBuild(cfg.github, ws, readProps(path.join(ws, 'gradle.properties')).mod_id ?? 'mod', (l) => {
            lines.push(l)
            if (lines.length > 400) lines.shift()
            ctx.onOutput?.(l, 'build')
          }, activeBuild.signal)
          ctx.notify('build:done', { ok: res.ok, jarPath: res.jarPath, logPath: res.logPath, source: 'actions' })
          return res.ok
            ? text(JSON.stringify({ ok: true, jar: res.jarPath, mode: 'actions', durationMs: res.durationMs }, null, 2))
            : err(JSON.stringify({ ok: false, errors: res.errors, logPath: res.logPath }, null, 2))
        } catch (e) {
          return err(`Build failed to start: ${(e as Error).message}`)
        } finally {
          activeBuild = null
        }
      }
    ),

    tool(
      'install',
      'Copy the latest built jar into the active test instance mods folder (replacing previous builds of the same mod). Optionally also copy extra jars first.',
      {},
      async () => {
        const cfg = loadConfig()
        const instance = cfg.game.instances.find((i) => i.id === ctx.getInstanceId()) ?? cfg.game.instances[0]
        if (!instance) return err('No test instance configured. Add one in Settings > Test instance.')
        const ws = ctx.getWorkspace()
        const jar = latestJar(ws)
        if (!jar) return err('No jar found. Build first.')
        if (!fs.existsSync(instance.path)) return err(`Instance folder does not exist: ${instance.path}`)
        const extra = copyExtraMods(cfg.game.extraMods, instance.path)
        const res = installJar(jar, instance.path, undefined, false)
        ctx.notify('install:done', { installed: res.installed })
        return text(
          JSON.stringify(
            {
              ok: true,
              jar: readJarInfo(jar),
              installedTo: res.installed,
              replaced: res.removed,
              extraModsCopied: extra.copied,
              extraModsMissing: extra.missing
            },
            null,
            2
          )
        )
      }
    ),

    tool(
      'install_neoforge',
      'Install the NeoForge loader for the configured 1.21.1 instance with the official installer (headless --install-client). Writes libraries/ and versions/ next to the instance so launch_game mode "instance" can run it.',
      {},
      async () => {
        const cfg = loadConfig()
        const instance = cfg.game.instances.find((i) => i.id === ctx.getInstanceId())
        if (!instance) return err('No instance configured. Ask the user to add one in Settings > Game.')
        const neoVersion = readProps(path.join(ctx.getWorkspace(), 'gradle.properties')).neo_version ?? '21.1.265'
        const minecraftDir = instance.minecraftDir || path.join(instance.path, '.minecraft')
        const res = await installNeoForge({
          neoVersion,
          minecraftDir,
          javaPath: cfg.javaPath,
          onLine: (line) => ctx.onOutput?.(line, 'build')
        })
        return res.ok
          ? text(`NeoForge ${neoVersion} installed into ${minecraftDir}`)
          : err(`${res.error ?? 'installer failed'}\n${res.log.split('\n').slice(-12).join('\n')}`)
      }
    ),

    tool(
      'launch_game',
      'Start the game for testing. mode "dev" runs the gradle dev client (runClient, fastest iteration). mode "instance" launches the configured instance directly with NeoForge and the installed jar (works for Technic packs). mode "launcher" opens the Technic launcher so the user presses Play.',
      { mode: z.enum(['dev', 'instance', 'launcher']).default('dev') },
      async ({ mode }) => {
        const cfg = loadConfig()
        const instance = cfg.game.instances.find((i) => i.id === ctx.getInstanceId())
        const ws = ctx.getWorkspace()
        const neoVersion = readProps(path.join(ws, 'gradle.properties')).neo_version ?? '21.1.265'

        if (mode === 'instance') {
          if (!instance) return err('No instance configured.')
          const minecraftDir = instance.minecraftDir || path.join(instance.path, '.minecraft')
          if (!isNeoForgeInstalled(minecraftDir, neoVersion)) {
            return err(`NeoForge ${neoVersion} is not installed in ${minecraftDir}. Call install_neoforge first.`)
          }
          const jar = latestJar(ws)
          if (!jar) return err('No jar built yet. Call build first.')
          installJar(jar, instance.path)
          const res = await launchNeoForge({
            minecraftDir,
            neoVersion,
            gameDir: instance.path,
            javaPath: cfg.javaPath,
            width: cfg.game.windowWidth,
            height: cfg.game.windowHeight,
            extraJvmArgs: cfg.game.clientJvmArgs ? cfg.game.clientJvmArgs.split(/\s+/).filter(Boolean) : [],
            onLine: (line) => ctx.onOutput?.(line, 'game')
          })
          ctx.onGameStatus?.(gameStatus())
          return res.ok
            ? text(`NeoForge client launching from ${instance.path}. First run downloads Minecraft assets (~400 MB), so expect several minutes.`)
            : err(res.error ?? 'launch failed')
        }

        if (mode === 'launcher') {
          if (!instance) return err('No instance configured.')
          const res = await launchTechnic()
          ctx.notify('game:status', gameStatus())
          ctx.onGameStatus?.(gameStatus())
          return res.ok ? text('Technic Launcher started. The user must press Play on the pack.') : err(res.error ?? 'Could not start launcher')
        }

        const res = await launchDevClient({
          workspaceDir: ws,
          instanceId: instance?.id ?? '',
          javaPath: cfg.javaPath,
          jvmArgs: cfg.game.clientJvmArgs,
          programArgs: cfg.game.clientProgramArgs,
          windowWidth: cfg.game.windowWidth,
          windowHeight: cfg.game.windowHeight
        })
        ctx.notify('game:status', gameStatus())
        if (!res.ok) return err(res.error ?? 'launch failed')
        ctx.onGameStatus?.(gameStatus())
        return text('Dev client starting. First launch compiles and downloads assets, which can take several minutes.')
      }
    ),

    tool(
      'game_status',
      'Current game state: running, pid, whether the title screen was reached, exit code, and the last 60 log lines.',
      {},
      async () => {
        const direct = runningGame()
        const status = direct
          ? { running: direct.exitCode === null, pid: direct.child.pid, titleScreen: direct.titleScreen, logPath: direct.logPath, exitCode: direct.exitCode }
          : gameStatus()
        const log = readGameLog(60)
        return text(JSON.stringify({ ...status, recentLog: log.text, crashReport: log.crash ? log.crash.slice(0, 4000) : undefined }, null, 2))
      }
    ),

    tool(
      'read_log',
      'Read the running game log, or a crash report. Use lines to control how much tail you get (default 300).',
      { lines: z.number().int().min(20).max(4000).default(300) },
      async ({ lines }) => {
        const log = readGameLog(lines)
        if (!log.text) return err('No game log yet. Launch the game first.')
        return text(
          JSON.stringify({ logPath: log.logPath, tail: log.text, crashReport: log.crash ? log.crash.slice(0, 8000) : undefined }, null, 2)
        )
      }
    ),

    tool(
      'screenshot',
      'Capture the Minecraft window and return the PNG as an image you can look at. Use this to verify the game state, menus, and whether a feature renders correctly.',
      { label: z.string().optional().describe('Short note stored with the screenshot, e.g. "title screen" or "after opening creative inventory"') },
      async ({ label }) => {
        const res = await captureGameWindow(label)
        if (!res.ok || !res.base64) return err(res.error ?? 'capture failed')
        ctx.onScreenshot?.({ path: res.path!, width: res.width, height: res.height })
        ctx.notify('screenshot:new', { path: res.path, label })
        return {
          content: [
            { type: 'text' as const, text: `Screenshot saved to ${res.path} (${res.width}x${res.height}).` },
            { type: 'image' as const, data: res.base64, mimeType: 'image/png' }
          ]
        }
      }
    ),

    tool('stop_game', 'Close the running game/launcher process.', {}, async () => {
      stopNeoForge()
      const res = await stopGame()
      ctx.notify('game:status', gameStatus())
      ctx.onGameStatus?.(gameStatus())
      return res.ok ? text('Game stopped.') : err(res.error ?? 'failed')
    }),

    tool(
      'export_technic_pack',
      'Export the active instance as a Technic-compatible pack zip (mods/ + config/ at top level, plus a README-plan.txt explaining the NeoForge loader install).',
      { outPath: z.string().optional().describe('Where to write the zip. Defaults to the workspace .agent folder.') },
      async ({ outPath }) => {
        const cfg = loadConfig()
        const instance = cfg.game.instances.find((i) => i.id === ctx.getInstanceId())
        if (!instance) return err('No instance configured.')
        const props = readProps(path.join(ctx.getWorkspace(), 'gradle.properties'))
        const zipPath = outPath || path.join(ctx.getWorkspace(), '.agent', `${props.mod_id ?? 'mod'}-technic-pack.zip`)
        const res = await buildTechnicPackZip(instance.path, zipPath, {
          name: props.mod_name ?? 'Mod',
          version: props.mod_version ?? '1.0.0',
          loaderVersion: props.neo_version ?? '21.1.265'
        })
        return res.ok ? text(`Wrote ${res.zip}`) : err(res.error ?? 'export failed')
      }
    ),

    tool(
      'list_screenshots',
      'List screenshots captured during this session, newest first.',
      {},
      async () => {
        const shots = listScreenshots().slice(0, 30)
        return text(JSON.stringify(shots, null, 2))
      }
    ),

    tool(
      'add_reference_mod',
      'Add another mod as read-only reference material: download the jar from a GitHub release (or the user\'s Downloads folder via jarPath), decompile it with Vineflower, and put the sources under <project>/reference/. Use it when the user asks "how does mod X do Y" or when you need a working example of an API. Reference sources are never compiled into the project.',
      {
        repo: z.string().optional().describe('GitHub repo, e.g. "owner/name" or a github.com URL'),
        tag: z.string().optional().describe('Release tag; omit for the latest stable release'),
        assetName: z.string().optional().describe('Exact jar asset name; omit to pick the mod jar automatically'),
        jarPath: z.string().optional().describe('Absolute path to a local jar, instead of a GitHub release')
      },
      async (args) => {
        const cfg = loadConfig()
        if (args.jarPath) {
          const { addFromFile } = await import('../github/references')
          const res = await addFromFile({ jarPath: args.jarPath, javaPath: cfg.javaPath, onLine: (l) => ctx.onOutput?.(l, 'build') })
          if (!res.ok || !res.mod) return err(res.error ?? 'could not add that jar')
          if (cfg.workspaceDir) {
            ensureReferenceIgnored(cfg.workspaceDir)
            linkToProject(res.mod.id, cfg.workspaceDir)
          }
          return text(`${res.mod.title} ${res.mod.version}: ${res.mod.decompiled ? 'decompiled and linked into reference/' : `downloaded, decompile failed (${res.mod.error})`}`)
        }
        const parsed = args.repo ? parseRepoRef(args.repo) : null
        if (!parsed) return err('Pass repo (owner/name) or jarPath.')
        if (!authToken()) {
          // Public release jars still download without a token; only the release
          // listing needs auth, and addFromGithub handles a missing token for
          // public repos via the unauthenticated API.
        }
        const res = await addFromGithub({
          owner: parsed.owner,
          repo: parsed.repo,
          releaseTag: args.tag,
          assetName: args.assetName,
          javaPath: cfg.javaPath,
          onLine: (l) => ctx.onOutput?.(l, 'build')
        })
        if (!res.ok || !res.mod) return err(res.error ?? 'could not add that mod')
        let linked = ''
        if (cfg.workspaceDir && res.mod.decompiled) {
          ensureReferenceIgnored(cfg.workspaceDir)
          const link = linkToProject(res.mod.id, cfg.workspaceDir)
          if (link.ok) linked = ` Sources copied to reference/${res.mod.slug} (${link.files} files).`
        }
        return text(
          `${res.mod.title} ${res.mod.version} (${res.mod.jarName}).${
            res.mod.decompiled ? ` Decompiled.${linked}` : ` Decompilation failed: ${res.mod.error}`
          }`
        )
      }
    ),

    tool(
      'list_reference_mods',
      'List the reference mods added so far: title, version, whether sources are decompiled, and their licence.',
      {},
      async () => {
        const mods = listReferences().map((m) => ({
          id: m.id,
          slug: m.slug,
          title: m.title,
          version: m.version,
          licence: m.license,
          decompiled: m.decompiled,
          linkedIntoProject: !!m.linked,
          modId: m.modId,
          mcVersion: m.mcVersion,
          repo: m.repo
        }))
        return text(mods.length ? JSON.stringify(mods, null, 2) : 'No reference mods yet.')
      }
    ),

    tool(
      'search_reference',
      'Search the decompiled reference sources for a symbol, class or string, e.g. "RegisterPayloadHandlersEvent". Returns file:line hits you can then Read from <project>/reference/.',
      {
        query: z.string().describe('Text to look for (case-insensitive)'),
        regex: z.boolean().optional().describe('Treat query as a regular expression'),
        id: z.string().optional().describe('Limit to one reference mod id')
      },
      async (args) => {
        const { hits } = searchReference(args.query, { regex: args.regex, id: args.id })
        if (!hits.length) return text(`No matches for "${args.query}".`)
        return text(
          JSON.stringify(
            hits.map((h) => ({ ...h, read: `reference/${getRef(h.id)?.slug ?? h.id}/${h.file}` })),
            null,
            2
          )
        )
      }
    ),

    tool(
      'reference_status',
      'Check whether a reference mod is available and where its sources live.',
      { id: z.string().describe('Reference mod id') },
      async (args) => {
        const mod = getReference(args.id)
        if (!mod) return err(`No reference mod with id ${args.id}.`)
        return text(
          JSON.stringify(
            {
              title: mod.title,
              version: mod.version,
              decompiled: mod.decompiled,
              linked: !!mod.linked,
              sourcesDir: mod.sourcesDir,
              projectCopy: mod.linked ? `reference/${mod.slug}` : null,
              licence: mod.license,
              error: mod.error
            },
            null,
            2
          )
        )
      }
    )
  ]

  return createSdkMcpServer({ name: 'mcfrogeagent', version: '1.0.0', tools })
}

export function readProps(file: string): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*)\s*$/)
      if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch {
    /* ignore */
  }
  return out
}

function countFiles(dir: string): number {
  let n = 0
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) n += countFiles(path.join(dir, e.name))
      else n++
    }
  } catch {
    /* ignore */
  }
  return n
}
