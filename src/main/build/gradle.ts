import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { findJava, run } from '../util/exec'
import { indexErrors } from '../learn'

export type BuildMode = 'local' | 'actions'

export interface BuildOptions {
  workspaceDir: string
  mode: BuildMode
  javaPath?: string
  preferWrapper?: boolean
  /** 'build' (jar) or 'compileJava' (fast sanity check) */
  task?: 'build' | 'compileJava' | 'runData'
  onLine: (line: string) => void
  signal?: AbortSignal
}

export interface BuildResult {
  ok: boolean
  code: number | null
  logPath: string
  jarPath?: string
  errors: string[]
  durationMs: number
}

const isWin = process.platform === 'win32'

export function gradlewPath(dir: string, preferWrapper = true): { cmd: string; args: string[]; shell: boolean } {
  const wrapper = path.join(dir, isWin ? 'gradlew.bat' : 'gradlew')
  if (preferWrapper && fs.existsSync(wrapper)) {
    if (isWin) return { cmd: wrapper, args: [], shell: true }
    // ensure the script is executable (git checkouts on Linux/mac)
    try {
      fs.chmodSync(wrapper, 0o755)
    } catch {
      /* ignore */
    }
    return { cmd: wrapper, args: [], shell: false }
  }
  return { cmd: 'gradle', args: [], shell: isWin }
}

export function buildLogPath(): string {
  const dir = path.join(app.getPath('userData'), 'logs')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `build-${new Date().toISOString().replace(/[:.]/g, '-')}.log`)
}

/** Parse the interesting javac errors out of a gradle log. */
export function extractErrors(log: string): string[] {
  const lines = log.split(/\r?\n/)
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^.*\.java:\d+: error:/i.test(line) || /^error: /i.test(line) || /^.*\.java:\d+: warning: \[removal\]/i.test(line)) {
      out.push(line)
      // javac prints the source line, a caret line, then "symbol:"/"location:" details
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const ctx = lines[j]
        if (/^\s{2,}(symbol|location|required|found):/.test(ctx)) out.push(ctx.trim())
        else if (!ctx.trim() || /^.*\.java:\d+:/.test(ctx)) break
      }
    } else if (/Caused by:|> Task .* FAILED|Execution failed for task/.test(line)) {
      out.push(line)
    }
    if (out.length > 60) break
  }
  return [...new Set(out)]
}

export function findBuiltJar(dir: string): string | undefined {
  const libs = path.join(dir, 'build', 'libs')
  if (!fs.existsSync(libs)) return undefined
  const jars = fs
    .readdirSync(libs)
    .filter((f) => f.endsWith('.jar') && !/-sources|-javadoc|-dev|-all/.test(f))
    .map((f) => path.join(libs, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  return jars[0]
}

export async function runLocalBuild(opts: BuildOptions): Promise<BuildResult> {
  const started = Date.now()
  const logPath = buildLogPath()
  const logStream = fs.createWriteStream(logPath, { flags: 'a' })
  const push = (line: string): void => {
    logStream.write(line + '\n')
    opts.onLine(line)
  }

  const task = opts.task ?? 'build'
  const java = findJava(opts.javaPath)
  const gw = gradlewPath(opts.workspaceDir, opts.preferWrapper ?? true)

  push(`[build] mode=local task=${task}`)
  push(`[build] cwd=${opts.workspaceDir}`)
  push(`[build] java=${java ?? '(PATH)'}`)

  const env: NodeJS.ProcessEnv = { ...process.env }
  if (java) env.JAVA_HOME = path.dirname(path.dirname(java))
  env.GRADLE_OPTS = `${env.GRADLE_OPTS ?? ''} ${app.isPackaged ? '' : ''}`.trim()
  // Windows console cannot always render gradle's ANSI output.
  env.TERM = 'dumb'

  const args = [...gw.args, task, '--stacktrace', '--console=plain', '--no-daemon']
  if (opts.signal?.aborted) {
    logStream.end()
    return { ok: false, code: null, logPath, errors: ['cancelled'], durationMs: 0 }
  }

  const result = await new Promise<{ code: number | null }>((resolve) => {
    let child: ChildProcess
    const useShell = gw.shell
    // shell:true lets cmd.exe handle the .bat quoting and any spaces in the path.
    const cmd = gw.cmd
    child = spawn(cmd, args, {
      cwd: opts.workspaceDir,
      env,
      shell: useShell,
      windowsHide: true
    })
    let buf = ''
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString('utf8')
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() ?? ''
      for (const l of lines) push(l)
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (err) => {
      push(`[build] failed to start: ${err.message}`)
      resolve({ code: -1 })
    })
    child.on('close', (code) => {
      if (buf) push(buf)
      resolve({ code })
    })
    opts.signal?.addEventListener('abort', () => {
      push('[build] cancelled by user')
      try {
        child.kill()
      } catch {
        /* ignore */
      }
    })
  })

  const log = fs.readFileSync(logPath, 'utf8')
  const errors = result.code === 0 ? [] : extractErrors(log)
  if (errors.length) {
    // Learning happens on every failing build, not only when the agent asks:
    // by the time it reads the error the lesson is already recallable.
    try {
      indexErrors(errors, { logPath, source: 'local-build' })
    } catch {
      /* learning must never fail a build */
    }
  }
  const jarPath = result.code === 0 ? findBuiltJar(opts.workspaceDir) : undefined
  push(`[build] exit=${result.code} jar=${jarPath ?? 'none'}`)
  logStream.end()
  return { ok: result.code === 0, code: result.code, logPath, jarPath, errors, durationMs: Date.now() - started }
}

/** Quick `git status --porcelain` so the agent knows what is dirty. */
export async function gitSummary(dir: string): Promise<{ dirty: string[]; branch: string | null; remote: string | null }> {
  const dirty = await run('git', ['status', '--porcelain'], { cwd: dir }).catch(() => null)
  const branch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir }).catch(() => null)
  const remote = await run('git', ['remote', 'get-url', 'origin'], { cwd: dir }).catch(() => null)
  const lines = (dirty?.stdout ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  return {
    dirty: lines.slice(0, 200),
    branch: branch?.code === 0 ? branch.stdout.trim() : null,
    remote: remote?.code === 0 ? remote.stdout.trim() : null
  }
}

export function isGradleProject(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'build.gradle')) || fs.existsSync(path.join(dir, 'build.gradle.kts'))
}
