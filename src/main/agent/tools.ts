import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig, effectiveApiKey, effectiveBaseUrl } from '../config'
import { runLocalBuild } from '../build/gradle'
import { readProps } from '../mod/props'
import { resolveJava, resolveToolJava } from '../util/exec'
import { installJar, copyExtraMods, readJarInfo } from '../mod/jar'
import { buildTechnicPackZip, detectTechnicInstances, launchTechnic } from '../game/technic'
import { captureGameWindow, listScreenshots } from '../game/capture'
import { analyseClip, attachAnalysis, clipDigest, getClip, listClips, startClip, stopClip } from '../game/clip'
import { resolveVisionModel } from '../game/vision'
import { confirmLesson, listLessons, recall, recordFailure, saveKnowledge } from '../learn'
import { captureFrameBuffer } from '../game/capture'
import { gameStatus, launchDevClient, readGameLog, stopGame } from '../game/launcher'
import { installNeoForge, isNeoForgeInstalled } from '../game/neoforge'
import { launchNeoForge, runningGame, stopNeoForge } from '../game/client'
import { ghPreflight, runActionsBuild } from '../build/actions'
import { addFromGithub, ensureReferenceIgnored, getReference, linkToProject, listReferences, parseRepoRef, searchReference, getReference as getRef } from '../github/references'
import { authToken } from '../github/oauth'
import { gitSummary } from '../build/gradle'
import { assetLayout, blockstateJson } from '../mod/assets'
import { detectLoader, detectMcVersion } from './engine'
import { rendererGuidance, rendererSupport, realismVerdict } from '../mod/renderer'
import { PATTERNS, PALETTES, texturePathFor, texturePng } from '../mod/textures'
import {
  QUADRUPED_BONES,
  animationJson,
  blockModelJson,
  entityModelJson,
  modelPaths,
  quadrupedWalk,
  validateModel,
  writeModels,
  type ModelKind
} from '../mod/models'

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
      'recall_mistakes',
      'Before fixing a build/runtime error, check whether the same failure happened before in this app. Returns past lessons with the fix that worked, best match first.',
      {
        error: z.string().describe('The error text (a javac error, gradle failure, or crash line) to look up'),
        loader: z.enum(['neoforge', 'forge', 'fabric']).optional(),
        mcVersion: z.string().optional()
      },
      async ({ error, loader, mcVersion }) => {
        const res = recall(error, { loader, mcVersion, limit: 5 })
        if (!res.length) return text('No similar past mistake on record. Diagnose it from scratch and then record what fixed it with remember_fix.')
        return text(
          JSON.stringify(
            res.map((r) => ({
              score: Number(r.score.toFixed(2)),
              exact: r.exact,
              rule: r.lesson.rule,
              fix: r.lesson.fix,
              avoid: r.lesson.avoid,
              seen: r.lesson.seen,
              confirmed: r.lesson.confirmed,
              sample: r.lesson.sample.slice(0, 500)
            })),
            null,
            2
          )
        )
      }
    ),

    tool(
      'remember_fix',
      'Record a failure and the fix that worked, so the same mistake is recognised next time. Call this after you have actually fixed something that failed — not for every build error, since errors that are fixed immediately are learned automatically.',
      {
        error: z.string().describe('The original error text'),
        fix: z.string().describe('What fixed it, in one or two sentences (the API to use, the property to set, the file to add)'),
        rule: z.string().optional().describe('The general rule, if the fix applies more widely than this exact error'),
        avoid: z.string().optional().describe('What not to do again'),
        loader: z.enum(['neoforge', 'forge', 'fabric']).optional(),
        mcVersion: z.string().optional()
      },
      async ({ error, fix, rule, avoid, loader, mcVersion }) => {
        const rec = recordFailure({ error, fix, rule, source: 'manual', loader, mcVersion })
        if (!rec.lesson) return err(`Not recorded: ${rec.ignored ?? 'unusable error text'}`)
        if (avoid || rule) confirmLesson(rec.lesson.id, { rule, avoid, fix })
        return text(`${rec.added ? 'Learned a new' : 'Updated an existing'} lesson (seen ${rec.lesson.seen}×): ${rec.lesson.rule}`)
      }
    ),

    tool(
      'save_lesson',
      'Write a lesson into the app\'s permanent store, so every future run — including on a weaker model — starts knowing it. ' +
        'Use this in learning mode and deep research mode for each fact worth keeping, and any time you work out something the next model would otherwise have to rediscover. ' +
        'A lesson is a rule the reader can act on without rereading your sources.',
      {
        rule: z.string().min(8).describe('The fact, in one imperative sentence. E.g. "Register items with DeferredRegister.Items."'),
        fix: z.string().optional().describe('Exactly what to do instead — include the code shape or the API call.'),
        avoid: z.string().optional().describe('The mistake this prevents, so the reader recognises it.'),
        detail: z.string().optional().describe('Longer explanation or example. Stored, not shown in the prompt.'),
        topic: z.string().optional().describe('What this is about, e.g. "item registration", "datagen", "mixin".'),
        sources: z.array(z.string()).optional().describe('Reference mods or URLs that back it up.'),
        loader: z.string().optional().describe('Loader this applies to, if it is loader-specific.'),
        mcVersion: z.string().optional().describe('Minecraft version this applies to, if version-specific.')
      },
      async ({ rule, fix, avoid, detail, topic, sources, loader, mcVersion }) => {
        const cfg = loadConfig()
        const props = readProps(path.join(cfg.workspaceDir, 'gradle.properties'))
        try {
          const res = saveKnowledge({
            rule,
            fix,
            avoid,
            detail,
            topic,
            sources,
            sourceNote: 'written by the agent',
            // Deep research writes lessons the strong model has verified; study
            // is unconfirmed until it is used successfully, so they are marked
            // differently and ranked accordingly.
            kind: cfg.deepResearch ? 'research' : 'topic',
            confirmed: cfg.deepResearch,
            loader: loader ?? (props.loader ?? ''),
            mcVersion: mcVersion ?? (props.minecraft_version ?? '')
          })
          ctx.notify('lessons:changed', {})
          return text(
            res.duplicate
              ? `Already known — strengthened it instead (seen ${res.lesson.seen}×): "${res.lesson.rule}"`
              : `Saved lesson ${res.lesson.id}: "${res.lesson.rule}"`
          )
        } catch (e) {
          return err((e as Error).message)
        }
      }
    ),

    tool(
      'make_model',
      'Generate a 3D model or animation as valid Minecraft JSON and write it to the right folder. ' +
        'Use this instead of typing model JSON by hand: coordinates, namespaces and file locations are the three things that silently make a model invisible. ' +
        'Kinds: block (a block model), item (an item model), entity (Bedrock geometry, openable in Blockbench), animation (a Bedrock animation). ' +
        'For a quadruped mob, entity with skeleton="quadruped" gives a body, head and four legs already parented.',
      {
        modId: z.string().describe('The mod id, used for the asset path and texture references.'),
        name: z.string().describe('File name without extension, e.g. "ruby_block" or "ruby_golem".'),
        kind: z.enum(['block', 'item', 'entity', 'animation']).describe('What to generate.'),
        texture: z.string().optional().describe('For block/item: the texture path, e.g. "block/ruby_block". Defaults to the name.'),
        skeleton: z.enum(['none', 'quadruped']).optional().describe('For entity: "quadruped" gives a ready body/head/legs rig.'),
        animation: z.enum(['none', 'walk']).optional().describe('For entity: add a looping walk cycle for the quadruped rig.'),
        identifier: z.string().optional().describe('For entity/animation: the identifier. Defaults to geometry.<modId>.<name> / animation.<modId>.<name>.'),
        size: z.array(z.number()).length(3).optional().describe('For block: [width, height, depth] in pixels (16 = one block). Defaults to a full 16 cube.')
      },
      async ({ modId, name, kind, texture, skeleton, animation, identifier, size }) => {
        const cfg = loadConfig()
        const dir = cfg.workspaceDir
        // The folder layout is a property of the Minecraft version, not of the
        // app: writing a geo file into a 1.12 project makes a file nothing loads.
        const mcVersion = detectMcVersion(readProps(path.join(dir, 'gradle.properties')))
        const layout = assetLayout({ mcVersion, modId })
        if (layout.legacy && (kind === 'entity' || kind === 'animation')) {
          return err(
            `Minecraft ${mcVersion} has no JSON entity models or animation files. ` +
              'A 1.12 mob is a Java class extending ModelBase with ModelRenderer parts, registered in the client proxy — ' +
              'ask me to write that class instead, or migrate the project to 1.13+ first.'
          )
        }
        const writes: { path: string; text: string; kind: ModelKind | 'animation' | 'blockstate' }[] = []
        const summary: string[] = []

        if (kind === 'block' || kind === 'item') {
          const tex = `${modId}:${texture ?? `block/${name}`}`
          if (kind === 'block') {
            const elements = size
              ? [{ origin: [8 - size[0] / 2, 0, 8 - size[2] / 2] as [number, number, number], size: size as [number, number, number], uv: [0, 0] as [number, number] }]
              : undefined
            writes.push({
              kind,
              path: modelPaths({ modId, name, kind, mcVersion }),
              text: blockModelJson(
                elements
                  ? { textures: { all: tex }, elements }
                  : { parent: 'minecraft:block/cube_all', all: tex }
              )
            })
            summary.push(`block model → ${modelPaths({ modId, name, kind, mcVersion })}`)
            // A block without a blockstate pointing at this model is invisible in
            // the world even though the model file is perfect.
            const statePath = `${layout.blockstates}/${name}.json`
            writes.push({
              kind: 'blockstate',
              path: statePath,
              text: blockstateJson({ mcVersion, modelId: `${modId}:block/${name}` })
            })
            summary.push(`blockstate → ${statePath}`)
          } else {
            writes.push({
              kind,
              path: modelPaths({ modId, name, kind, mcVersion }),
              text: blockModelJson({ parent: 'minecraft:item/generated', all: tex })
            })
            summary.push(`item model → ${modelPaths({ modId, name, kind, mcVersion })}`)
          }
          // The texture path must exist or the model renders as the pink checker.
          summary.push(`texture expected at assets/${modId}/textures/${texture ?? `block/${name}`}.png (add one or it shows as missing)`)
        } else {
          const id = identifier ?? `geometry.${modId}.${name}`
          const bones = skeleton === 'quadruped' ? QUADRUPED_BONES(8, 6) : [{ name: 'root', pivot: [0, 0, 0] as [number, number, number], boxes: [{ origin: [-4, 0, -4] as [number, number, number], size: [8, 16, 8] as [number, number, number], uv: [0, 0] as [number, number] }] }]
          writes.push({
            kind: 'entity',
            path: modelPaths({ modId, name, kind: 'entity', mcVersion }),
            text: entityModelJson({ identifier: id, bones, textureWidth: 64, textureHeight: 64 })
          })
          summary.push(`entity geometry "${id}" → ${modelPaths({ modId, name, kind: 'entity', mcVersion })}`)
          summary.push('Open the .geo.json in Blockbench to sculpt it — the rig is structurally correct, the art is yours.')
          if (animation !== 'none' && skeleton === 'quadruped') {
            const anim = quadrupedWalk(identifier ?? `animation.${modId}.${name}.walk`)
            writes.push({ kind: 'animation', path: modelPaths({ modId, name: name + '.walk', kind: 'animation', mcVersion }), text: animationJson(anim) })
            summary.push(`walk animation → ${modelPaths({ modId, name: name + '.walk', kind: 'animation', mcVersion })} (reference it from the entity's animation controller)`)
          }
        }

        const res = writeModels(dir, writes)
        if (!res.ok) {
          return err(
            `Not written — ${res.issues.filter((i) => i.severity === 'error').map((i) => `${i.message}. ${i.fix}`).join(' ')}`
          )
        }
        ctx.notify('project:changed', {})
        return text(`Wrote ${res.written.length} file(s):\n${summary.map((l) => `- ${l}`).join('\n')}`)
      }
    ),

    tool(
      'make_texture',
      'Generate a 16x16 PNG texture in the style Minecraft uses: flat mid-tone, lit from the top-left, a little noise. ' +
        'Writes it to assets/<modId>/textures/block/ or /item/ so a generated model has something to point at. ' +
        'Use this instead of telling the user to go draw one — a model whose texture is missing renders as a black-and-pink checkerboard.',
      {
        modId: z.string().describe('The mod id, used for the folder.'),
        name: z.string().describe('Texture name, e.g. "ruby_block". Becomes block/<name>.png.'),
        kind: z.enum(['block', 'item']).optional().describe('Which texture folder. Item textures can have a cut-out silhouette.'),
        pattern: z
          .enum(['flat', 'noise', 'grain', 'brick', 'ore', 'metal', 'planks', 'frame'])
          .optional()
          .describe('How the surface looks. Defaults to noise, which reads as stone.'),
        palette: z.enum(['stone', 'wood', 'metal', 'gem', 'organic', 'dark']).optional().describe('Base colour family.'),
        size: z.number().optional().describe('Edge length in pixels. 16 is the Minecraft default; 32 or 64 for detail.'),
        silhouette: z.boolean().optional().describe('For items: clear the corners so it is not a square sprite.')
      },
      async ({ modId, name, kind, pattern, palette, size, silhouette }) => {
        const cfg = loadConfig()
        const dir = cfg.workspaceDir
        const k = kind ?? 'block'
        if (!/^[a-z0-9_]{2,48}$/.test(name)) return err('The texture name must be 2-48 lowercase letters, digits or underscores.')
        const rel = `src/main/resources/assets/${modId}/textures/${texturePathFor(k, name)}.png`
        try {
          const png = texturePng({ name, pattern: pattern ?? 'noise', palette: palette ?? 'stone', size: size ?? 16, transparentBackground: silhouette && k === 'item' })
          const full = path.join(dir, rel)
          fs.mkdirSync(path.dirname(full), { recursive: true })
          fs.writeFileSync(full, png)
          ctx.notify('project:changed', {})
          const ref = `${modId}:${texturePathFor(k, name)}`
          return text(
            `Wrote ${rel} (${png.length} bytes). Reference it as "${ref}" in a model.\n` +
              `Pattern: ${PATTERNS[(pattern ?? 'noise') as keyof typeof PATTERNS]}\n` +
              `Base colour: ${PALETTES[(palette ?? 'stone') as keyof typeof PALETTES].note}\n` +
              'This is serviceable, not art — it opens in any image editor if the user wants to paint over it.'
          )
        } catch (e) {
          return err(`Could not write the texture: ${(e as Error).message}`)
        }
      }
    ),

    tool(
      'renderer_capabilities',
      'What this project can actually render with, and what it cannot. Call this BEFORE promising a visual effect: ' +
        'the rendering API was replaced twice, so shader code that works on 1.21 does not exist on 1.12. ' +
        'It also answers "can we make this photorealistic" honestly.',
      { question: z.string().optional().describe('Optional: what the user wants to achieve, e.g. "reflective water".') },
      async ({ question }) => {
        const cfg = loadConfig()
        const dir = cfg.workspaceDir
        const props = readProps(path.join(dir, 'gradle.properties'))
        const mcVersion = detectMcVersion(props)
        const loader = detectLoader(props)
        const r = rendererSupport(mcVersion)
        const verdict = realismVerdict(mcVersion)
        return text(
          [
            `Minecraft ${mcVersion} (${loader})`,
            `API: ${r.apiLabel}`,
            `Shading language: ${r.shadingLanguage}`,
            `How shaders load: ${r.howShadersLoad}`,
            '',
            'CAN:',
            ...r.stage.can.map((c) => `  - ${c}`),
            'CANNOT:',
            ...r.stage.cannot.map((c) => `  - ${c}`),
            '',
            `Ceiling: ${r.ceiling}`,
            '',
            `Photorealistic: ${verdict.achievable ? 'possible' : 'not from mod code'}. ${verdict.how}`,
            question ? `\nFor "${question}": plan within the CAN list, and say plainly if it falls in CANNOT.` : ''
          ]
            .filter(Boolean)
            .join('\n')
        )
      }
    ),

    tool(
      'check_model',
      'Validate a model or animation JSON file before using it. Catches the failures that produce an invisible model with no error: bad identifier prefixes, missing namespaced textures, bones with parents that do not exist, unparseable JSON.',
      { file: z.string().describe('Path relative to the project root, e.g. src/main/resources/assets/mymod/geo/golem.geo.json') },
      async ({ file }) => {
        const cfg = loadConfig()
        const full = path.join(cfg.workspaceDir, file)
        try {
          // Not `text`: that name is the tool-result helper, and shadowing it
          // here made the return statements call a string.
          const body = fs.readFileSync(full, 'utf8')
          const kind = /animations/.test(file) ? 'animation' : /geo\.json/.test(file) ? 'entity' : 'block'
          const issues = validateModel(body, kind)
          if (!issues.length) return text(`OK — parsed as a ${kind} model and nothing looks wrong.`)
          return text(
            issues.map((i) => `${i.severity === 'error' ? 'ERROR' : 'warn '} ${i.message}\n      fix: ${i.fix}`).join('\n')
          )
        } catch (e) {
          return err(`Could not read ${file}: ${(e as Error).message}`)
        }
      }
    ),

    tool('list_mistakes', 'List the lessons this app has learned from past failures, most useful first.', {}, async () =>
      text(JSON.stringify(listLessons().slice(0, 40).map((l) => ({ id: l.id, rule: l.rule, fix: l.fix, avoid: l.avoid, seen: l.seen, source: l.source, confirmed: l.confirmed, loader: l.loader, mcVersion: l.mcVersion })), null, 2))
    ),

    tool(
      'capture_clip',
      'Record a short gameplay clip (frames, max 30 s) of the game window and analyse it with a vision model. Use this when the user reports something that only shows up over time — an animation, a mob behaviour, a crash after a few seconds, particles, a GUI transition — or when a single screenshot cannot show the problem. Frames are returned as images so you can see them yourself; the analysis is a second opinion.',
      {
        seconds: z.number().min(1).max(30).optional().describe('Clip length in seconds. Default 10, maximum 30.'),
        goal: z.string().optional().describe('What to look for, e.g. "does the ruby sword swing animation play"'),
        analyse: z.boolean().optional().describe('Also run the vision-model write-up. Default true.')
      },
      async ({ seconds, goal, analyse }) => {
        const clip = await startClip({
          durationMs: (seconds ?? 10) * 1000,
          fps: 2,
          note: goal,
          grab: captureFrameBuffer
        })
        if (!clip.frames.length) return err('No frames were captured. Is the game running and visible?')
        ctx.notify('clip:done', { clip })

        const parts: { type: string; text?: string; data?: string; mimeType?: string }[] = [
          {
            type: 'text' as const,
            text: `Captured ${(clip.durationMs / 1000).toFixed(1)}s (${clip.frames.length} frames) into ${clip.dir}.`
          }
        ]
        // A handful of frames, spread across the clip, so the model can see it.
        for (const f of clip.frames.filter((_, i) => clip.frames.length <= 6 || i % Math.ceil(clip.frames.length / 6) === 0).slice(0, 6)) {
          const png = fs.readFileSync(f.path)
          parts.push({ type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' })
        }

        if (analyse !== false) {
          // Share one resolution rule with the clips panel: local role mapping
          // first, then the vision provider, then the agent's own provider.
          const v = resolveVisionModel()
          const res = await analyseClip({
            clip,
            goal,
            apiKey: v.apiKey,
            baseUrl: v.baseUrl,
            auth: v.auth,
            providerLabel: v.providerLabel,
            model: v.model
          })
          if (res.ok && res.text) {
            attachAnalysis(clip.id, { model: res.model ?? 'vision', text: res.text, frames: res.frames ?? 0 })
            parts.push({ type: 'text' as const, text: `\nVision analysis:\n${res.text}` })
          } else if (res.error) {
            parts.push({ type: 'text' as const, text: `\n(Vision analysis unavailable: ${res.error})` })
          }
        }
        return { content: parts as never }
      }
    ),

    tool('stop_clip', 'Stop the clip that is currently recording, keeping the frames captured so far.', {}, async () =>
      stopClip().ok ? text('Stopping the clip; frames captured so far are kept.') : err('No clip is recording.')
    ),

    tool(
      'list_clips',
      'List gameplay clips recorded in this app, newest first, with their analyses.',
      {},
      async () => text(JSON.stringify(listClips().slice(0, 10).map((c) => ({ id: c.id, dir: c.dir, durationMs: c.durationMs, frames: c.frames.length, note: c.note, analysis: c.analysis?.text?.slice(0, 1200) })), null, 2))
    ),

    tool(
      'clip_report',
      'The full text digest (duration, note, vision analysis) of one clip by id, to reason about after the images are out of context.',
      { id: z.string().describe('Clip id from list_clips or capture_clip') },
      async ({ id }) => {
        const clip = getClip(id)
        return clip ? text(clipDigest(clip)) : err('Unknown clip id.')
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

export { readProps } from '../mod/props'

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
