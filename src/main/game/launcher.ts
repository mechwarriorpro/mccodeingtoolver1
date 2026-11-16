import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { findJava, run, javaHomeFor, sanitisedEnv } from '../util/exec'
import { logsDir } from '../config'
import type { GameStatus } from '../../shared/types'
import { emitGameLog, emitGameStatus, onGameLog, onGameStatus, setStatusProvider } from './events'

export { onGameLog, onGameStatus }
export { launchNeoForge, stopNeoForge } from './client'

const isWin = process.platform === 'win32'

/**
 * Dev-client runner: `gradlew runClient` from the mod project (ModDevGradle).
 * This is the fastest iteration loop because it recompiles the mod itself.
 */
export interface DevLaunchOptions {
  workspaceDir: string
  instanceId: string
  javaPath?: string
  jvmArgs?: string
  programArgs?: string
  windowWidth?: number
  windowHeight?: number
}

setStatusProvider(() => gameStatus())

/** Recent stdout/stderr per child, for explaining a failed start. */
const recentOutput = new WeakMap<ChildProcess, string[]>()

let current: {
  child: ChildProcess
  logPath: string
  startedAt: number
  instanceId: string
  exitCode: number | null
  titleScreen: boolean
  /** Set when the OS refused to start the process at all. */
  spawnError?: string
} | null = null

export function gameStatus(): GameStatus {
  if (!current) return { running: false }
  return {
    running: current.exitCode === null,
    pid: current.child.pid,
    instanceId: current.instanceId,
    titleScreen: current.titleScreen,
    logPath: current.logPath,
    startedAt: current.startedAt,
    exitCode: current.exitCode
  }
}

const TITLE_MARKERS = [
  /Backend library: LWJGL/i,
  /Created: .* minecraft:textures\/gui\/title\/minecraft\.png/i,
  /Narrator library for x64 successfully loaded/i,
  /Sound engine started/i,
  /OpenAL initialized/i
]

function scanLine(line: string): void {
  emitGameLog(line)
  if (current && !current.titleScreen && TITLE_MARKERS.some((re) => re.test(line))) {
    current.titleScreen = true
    emitGameStatus(gameStatus())
  }
}

function attach(child: ChildProcess, logPath: string): void {
  let buf = ''
  /**
   * Recent output, kept in memory *and* on disk.
   *
   * The log file is written asynchronously, so reading it back the instant the
   * process exits races the write and returns nothing — which is how a failed
   * launch ended up reporting "it exited immediately" with no cause. The cause
   * is nearly always in these last few lines.
   */
  const recent: string[] = []
  /**
   * `spawn` does not throw when the binary cannot be run — the failure arrives
   * later as an `error` event. Without a listener that event is an unhandled
   * exception, and with no listener at all the app reported "Dev client
   * starting" for a process that never existed. A launch that failed has to
   * look like a failed launch.
   */
  child.on('error', (err) => {
    const text = `[launcher] failed to start: ${err.message}\n`
    fs.appendFile(logPath, text, () => undefined)
    if (current && current.child === child) {
      current.exitCode = -1
      current.spawnError = err.message
      emitGameStatus(gameStatus())
    }
  })
  const handle = (chunk: Buffer): void => {
    const text = chunk.toString('utf8')
    fs.appendFile(logPath, text, () => undefined)
    buf += text
    const lines = buf.split(/\r?\n/)
    buf = lines.pop() ?? ''
    for (const line of lines) {
      scanLine(line)
      if (line.trim()) recent.push(line.trim())
      if (recent.length > 20) recent.shift()
    }
  }
  recentOutput.set(child, recent)
  child.stdout?.on('data', handle)
  child.stderr?.on('data', handle)
  child.on('exit', (code) => {
    if (buf) scanLine(buf)
    if (current && current.child === child) {
      current.exitCode = code
      emitGameStatus(gameStatus())
    }
  })
}

/**
 * The last few non-empty log lines.
 *
 * A launch failure's cause is nearly always one line of the process's own
 * output — "JAVA_HOME is not set", "Could not find or load main class" — and
 * returning that is worth more than any sentence this code could invent.
 */
function tailLog(logPath: string, lines = 6): string {
  try {
    return fs
      .readFileSync(logPath, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-lines)
      .join(' ')
  } catch {
    return ''
  }
}

/** Split a command-line-ish string into args, respecting simple quotes. */
export function splitArgs(input: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur)
        cur = ''
      }
    } else cur += ch
  }
  if (cur) out.push(cur)
  return out
}

export async function launchDevClient(opts: DevLaunchOptions): Promise<{ ok: boolean; error?: string }> {
  if (current && current.exitCode === null) return { ok: false, error: 'The dev client is already running. Stop it first.' }
  const java = findJava(opts.javaPath)
  const logPath = path.join(logsDir(), `game-${new Date().toISOString().replace(/[:.]/g, '-')}.log`)
  fs.writeFileSync(logPath, '')

  const wrapper = path.join(opts.workspaceDir, isWin ? 'gradlew.bat' : 'gradlew')
  if (!fs.existsSync(wrapper)) return { ok: false, error: `gradlew not found in ${opts.workspaceDir}` }
  if (!isWin) {
    try {
      fs.chmodSync(wrapper, 0o755)
    } catch {
      /* ignore */
    }
  }

  const args = ['runClient', '--console=plain', '--no-daemon']
  const programArgs: string[] = []
  if (opts.windowWidth) programArgs.push('--width', String(opts.windowWidth))
  if (opts.windowHeight) programArgs.push('--height', String(opts.windowHeight))
  if (opts.programArgs?.trim()) programArgs.push(...splitArgs(opts.programArgs))
  if (programArgs.length) args.push(`--args=${programArgs.join(' ')}`)

  const env: NodeJS.ProcessEnv = sanitisedEnv({ TERM: 'dumb' })
  const home = java ? javaHomeFor(java) : null
  if (home) env.JAVA_HOME = home
  if (opts.jvmArgs?.trim()) env.JAVA_TOOL_OPTIONS = `${env.JAVA_TOOL_OPTIONS ?? ''} ${opts.jvmArgs}`.trim()

  try {
    // With shell:true on Windows the wrapper path is quoted by cmd.exe itself;
    // adding quotes here would double them and fail to launch.
    const cmd = wrapper
    const child = spawn(cmd, args, { cwd: opts.workspaceDir, env, shell: isWin, windowsHide: false, detached: false })
    current = { child, logPath, startedAt: Date.now(), instanceId: opts.instanceId, exitCode: null, titleScreen: false }
    attach(child, logPath)
    /**
     * Wait for the process to actually exist before saying it started.
     *
     * `spawned` fires once the OS has a pid; `error` fires instead when it does
     * not. A few milliseconds of waiting turns "Dev client starting" into a real
     * answer, and stops the agent from going on to screenshot a game that is
     * not running.
     */
    const outcome = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      let settled = false
      const finish = (r: { ok: boolean; error?: string }): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(r)
      }
      // A wrapper that starts and dies immediately is the common failure here —
      // no JAVA_HOME, a gradle wrapper that cannot download its distribution.
      // Waiting only for `spawn` reports success for a process that is already
      // dead, so a fast non-zero exit counts as a failed launch and carries the
      // log line that explains it.
      const timer = setTimeout(() => finish({ ok: true }), 2500)
      child.once('spawn', () => {
        // Do not resolve here: give the process a moment to prove it survives.
        setTimeout(() => finish({ ok: true }), 750)
      })
      child.once('error', (err) => finish({ ok: false, error: err.message }))
      child.once('exit', (code) => {
        // A clean immediate exit is still not a running client.
        const tail = (recentOutput.get(child) ?? []).slice(-4).join(' ')
        finish({ ok: false, error: tail || `it exited immediately with code ${code ?? 0}` })
      })
    })
    if (!outcome.ok) {
      current = null
      return { ok: false, error: `The dev client could not be started: ${outcome.error}` }
    }
    emitGameStatus(gameStatus())
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export async function stopDevClient(): Promise<{ ok: boolean; error?: string }> {
  if (!current || current.exitCode !== null) return { ok: true }
  const { child } = current
  try {
    if (isWin && child.pid) await run('taskkill', ['/pid', String(child.pid), '/T', '/F'], { timeoutMs: 20000 })
    else child.kill('SIGTERM')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export function readGameLog(tailLines = 200): { logPath?: string; text: string; crash?: string } {
  const logPath = current?.logPath
  if (!logPath || !fs.existsSync(logPath)) return { text: '' }
  const raw = fs.readFileSync(logPath, 'utf8')
  const lines = raw.split(/\r?\n/)
  let crash: string | undefined
  const crashDir = gameCrashDir()
  try {
    const files = fs
      .readdirSync(crashDir)
      .filter((f) => f.endsWith('.txt'))
      .map((f) => ({ f, t: fs.statSync(path.join(crashDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    if (files.length && Date.now() - files[0].t < 15 * 60 * 1000) {
      crash = fs.readFileSync(path.join(crashDir, files[0].f), 'utf8').slice(0, 12000)
    }
  } catch {
    /* none */
  }
  return { logPath, text: lines.slice(-tailLines).join('\n'), crash }
}

/** Crash reports land next to the game dir (bundled runClient uses ./run). */
function gameCrashDir(): string {
  return path.join(process.cwd(), 'run', 'crash-reports')
}

export function waitForTitleScreen(timeoutSec: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (!current) return resolve(false)
    if (current.titleScreen) return resolve(true)
    const started = Date.now()
    const timer = setInterval(() => {
      if (!current || current.exitCode !== null) {
        clearInterval(timer)
        resolve(false)
      } else if (current.titleScreen) {
        clearInterval(timer)
        resolve(true)
      } else if (Date.now() - started > timeoutSec * 1000) {
        clearInterval(timer)
        resolve(false)
      }
    }, 1000)
  })
}

/** Stop whichever game process is running (dev client or direct launch). */
export async function stopGame(): Promise<{ ok: boolean; error?: string }> {
  const { stopNeoForge, runningGame } = await import('./client')
  const direct = runningGame()
  if (direct && direct.exitCode === null) {
    stopNeoForge()
    return { ok: true }
  }
  return stopDevClient()
}
