import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { app } from 'electron'
import { findJava, run } from '../util/exec'
import { ensureAssets, ensureClientJar, ensureVersionJson, libraryAllowed, libraryTarget, mcDir, download, type VersionJson } from './mojang'
import { logsDir } from '../config'
import { currentStatus, emitGameLog, emitGameStatus, setStatusProvider } from './events'

/**
 * Launches a NeoForge 1.21.1 client directly with Java, the same way a launcher does:
 *   <java> <jvm args from neoforge json + vanilla jvm args> -cp <libs> <mainClass> <game args>
 *
 * This is what lets the agent install a jar into a Technic/custom instance and then
 * actually run the game and look at it, without depending on a third-party launcher CLI.
 */

const isWin = process.platform === 'win32'

export interface LaunchSpec {
  minecraftDir: string
  neoVersion: string
  gameDir: string
  javaPath?: string
  username?: string
  width?: number
  height?: number
  extraJvmArgs?: string[]
  extraProgramArgs?: string[]
  /** offline demo-ish profile; the client runs fine for testing without a session */
  onLine: (line: string) => void
}

export interface RunningGame {
  child: ChildProcess
  logPath: string
  startedAt: number
  gameDir: string
  titleScreen: boolean
  exitCode: number | null
}

let running: RunningGame | null = null

export function runningGame(): RunningGame | null {
  return running
}

export function clientStatus(): import('../../shared/types').GameStatus {
  if (!running) return { running: false }
  return {
    running: running.exitCode === null,
    pid: running.child.pid,
    instanceId: 'direct',
    titleScreen: running.titleScreen,
    logPath: running.logPath,
    startedAt: running.startedAt,
    exitCode: running.exitCode
  }
}

export function neoVirtualArgs(neoJson: VersionJson): { jvm: string[]; game: string[] } {
  // NeoForge 1.21 writes its module path args in the version json's arguments.
  const jvm: string[] = []
  const game: string[] = []
  const expand = (value: string, vars: Record<string, string>): string => value.replace(/\$\{([^}]+)\}/g, (_m, key) => vars[key] ?? '')
  const vars: Record<string, string> = {
    library_directory: path.join(mcDir(), 'libraries'),
    classpath_separator: isWin ? ';' : ':',
    launcher_name: 'mc-forge-agent',
    launcher_version: app.getVersion(),
    version_name: neoJson.id
  }
  for (const arg of neoJson.arguments?.jvm ?? []) {
    if (typeof arg === 'string') jvm.push(expand(arg, vars))
    else if (arg.rules === undefined || rulesAllow(arg.rules)) {
      for (const v of Array.isArray(arg.value) ? arg.value : [arg.value]) jvm.push(expand(v, vars))
    }
  }
  for (const arg of neoJson.arguments?.game ?? []) {
    if (typeof arg === 'string') game.push(expand(arg, vars))
    else if (arg.rules === undefined || rulesAllow(arg.rules as { action: string; os?: { name?: string } }[])) {
      for (const v of Array.isArray(arg.value) ? arg.value : [arg.value]) game.push(expand(v, vars))
    }
  }
  return { jvm, game }
}

function rulesAllow(rules: { action: string; os?: { name?: string } }[]): boolean {
  const osName = isWin ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'
  let allowed = false
  for (const rule of rules) {
    if (rule.os?.name && rule.os.name !== osName) continue
    allowed = rule.action === 'allow'
  }
  return allowed
}

export async function prepareLaunch(spec: LaunchSpec): Promise<{ ok: boolean; command?: string[]; error?: string }> {
  const log = spec.onLine
  const java = findJava(spec.javaPath)
  if (!java) return { ok: false, error: 'Java 21 not found. Install a JDK 21 and select it in Settings.' }

  const versionId = `neoforge-${spec.neoVersion}`
  const neoJsonPath = path.join(spec.minecraftDir, 'versions', versionId, `${versionId}.json`)
  if (!fs.existsSync(neoJsonPath)) {
    return { ok: false, error: `NeoForge ${spec.neoVersion} is not installed in ${spec.minecraftDir}. Run "Install NeoForge" first.` }
  }
  const neoJson = JSON.parse(fs.readFileSync(neoJsonPath, 'utf8')) as VersionJson

  log('[launch] resolving Minecraft 1.21.1 assets and libraries (first run downloads ~400 MB)')
  const vanilla = await ensureVersionJson('1.21.1', log)
  const clientJar = await ensureClientJar(vanilla, log)
  await ensureAssets(vanilla, log)

  // download every library the vanilla json needs for this OS
  const classpath: string[] = []
  for (const lib of vanilla.libraries) {
    if (!libraryAllowed(lib)) continue
    const art = lib.downloads?.artifact
    if (!art) continue
    const target = libraryTarget(art.path)
    await download(art.url, target, art.sha1, log)
    classpath.push(target)
  }
  classpath.push(clientJar)

  const neoArgs = neoVirtualArgs(neoJson)
  const mainClass = neoJson.mainClass || 'cpw.mods.bootstraplauncher.BootstrapLauncher'

  const nativesDir = path.join(mcDir(), 'natives')
  fs.mkdirSync(nativesDir, { recursive: true })

  const jvmArgs: string[] = [
    '-Xmx4G',
    '-XX:+UseG1GC',
    `-Djava.library.path=${nativesDir}`,
    `-Dminecraft.launcher.brand=MC-Forge-Agent`,
    `-Dminecraft.launcher.version=${app.getVersion()}`,
    ...neoArgs.jvm,
    ...(spec.extraJvmArgs ?? [])
  ]

  const gameArgs: string[] = [
    ...neoArgs.game,
    '--username',
    spec.username || 'ModTester',
    '--version',
    versionId,
    '--gameDir',
    spec.gameDir,
    '--assetsDir',
    path.join(mcDir(), 'assets'),
    '--assetIndex',
    vanilla.assetIndex?.id ?? vanilla.assets ?? '17',
    '--uuid',
    '00000000000000000000000000000000',
    '--accessToken',
    'offline',
    '--userType',
    'legacy',
    '--versionType',
    'release',
    '--width',
    String(spec.width ?? 1280),
    '--height',
    String(spec.height ?? 720),
    ...(spec.extraProgramArgs ?? [])
  ]

  // The module path args NeoForge emits already contain the classpath via -DlegacyClassPath;
  // if they do not (non-modular setup), fall back to a plain -cp launch.
  const hasModulePath = jvmArgs.some((a) => a.startsWith('-p') || a.startsWith('--module-path'))
  if (!hasModulePath) jvmArgs.push('-cp', classpath.join(isWin ? ';' : ':'))

  return { ok: true, command: [java, ...jvmArgs, mainClass, ...gameArgs] }
}

export async function launchNeoForge(spec: LaunchSpec): Promise<{ ok: boolean; error?: string }> {
  if (running && running.exitCode === null) return { ok: false, error: 'A game process is already running.' }
  const prepared = await prepareLaunch(spec)
  if (!prepared.ok || !prepared.command) return { ok: false, error: prepared.error }

  const [java, ...args] = prepared.command
  const logPath = path.join(logsDir(), `client-${new Date().toISOString().replace(/[:.]/g, '-')}.log`)
  fs.writeFileSync(logPath, '')
  spec.onLine(`[launch] ${java} ${args.slice(0, 6).join(' ')} …`)

  const child = spawn(java, args, { cwd: spec.gameDir, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] })
  running = { child, logPath, startedAt: Date.now(), gameDir: spec.gameDir, titleScreen: false, exitCode: null }
  setStatusProvider(clientStatus)

  let buf = ''
  const handle = (chunk: Buffer): void => {
    const text = chunk.toString('utf8')
    fs.appendFile(logPath, text, () => undefined)
    buf += text
    const lines = buf.split(/\r?\n/)
    buf = lines.pop() ?? ''
    for (const line of lines) {
      emitGameLog(line)
      if (!running?.titleScreen && /(Sound engine started|Created: .*title\/minecraft\.png|Backend library: LWJGL)/i.test(line)) {
        if (running) running.titleScreen = true
      }
    }
    emitGameStatus()
  }
  child.stdout?.on('data', handle)
  child.stderr?.on('data', handle)
  child.on('exit', (code) => {
    if (running) running.exitCode = code
    emitGameStatus()
  })
  emitGameStatus()
  return { ok: true }
}

export function stopNeoForge(): void {
  if (!running || running.exitCode !== null) return
  try {
    if (isWin && running.child.pid) {
      void run('taskkill', ['/pid', String(running.child.pid), '/T', '/F'], { timeoutMs: 15000 })
    } else {
      running.child.kill('SIGTERM')
    }
  } catch {
    /* ignore */
  }
}

export function runningLog(): { logPath?: string; text: string } {
  if (!running) return { text: '' }
  try {
    const text = fs.readFileSync(running.logPath, 'utf8')
    return { logPath: running.logPath, text: text.split(/\r?\n/).slice(-400).join('\n') }
  } catch {
    return { logPath: running.logPath, text: '' }
  }
}
