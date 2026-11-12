import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  commandLine: string
}

export interface RunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  /** Lines streamed as they arrive (useful for long gradle runs). */
  onLine?: (line: string, stream: 'out' | 'err') => void
  /** Optional signal from the renderer (build cancel). */
  signal?: AbortSignal
}

const isWin = process.platform === 'win32'

/**
 * Run a command and capture stdout/stderr. Works for gradle, git, gh and the game.
 * On Windows .bat/.cmd files cannot be spawned directly, so we route through cmd.exe.
 */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const commandLine = [cmd, ...args].map(quote).join(' ')
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams
    const spawnOpts = {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      windowsHide: true,
      windowsVerbatimArguments: false
    }
    try {
      const needsShell = isWin && /\.(bat|cmd)$/i.test(cmd)
      child = (needsShell ? spawn(`"${cmd}"`, args, { ...spawnOpts, shell: true }) : spawn(cmd, args, spawnOpts)) as ChildProcessWithoutNullStreams
    } catch (err) {
      reject(err)
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      fn()
    }

    const onAbort = (): void => {
      try {
        child.kill()
      } catch {
        /* already dead */
      }
      finish(() => resolve({ code: null, stdout, stderr, commandLine }))
    }

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          try {
            child.kill()
          } catch {
            /* ignore */
          }
          finish(() => resolve({ code: null, stdout: stdout + '\n[timeout]', stderr, commandLine }))
        }, opts.timeoutMs)
      : (undefined as unknown as NodeJS.Timeout)

    if (opts.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort)
    }

    let outBuf = ''
    let errBuf = ''
    const pump = (chunk: Buffer, stream: 'out' | 'err'): void => {
      const text = chunk.toString('utf8')
      if (stream === 'out') stdout += text
      else stderr += text
      if (!opts.onLine) return
      let buf = stream === 'out' ? outBuf + text : errBuf + text
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() ?? ''
      for (const line of lines) opts.onLine(line, stream)
      if (stream === 'out') outBuf = buf
      else errBuf = buf
    }

    child.stdout.on('data', (c: Buffer) => pump(c, 'out'))
    child.stderr.on('data', (c: Buffer) => pump(c, 'err'))
    child.on('error', (err) => finish(() => reject(err)))
    child.on('close', (code) => {
      if (outBuf && opts.onLine) opts.onLine(outBuf, 'out')
      if (errBuf && opts.onLine) opts.onLine(errBuf, 'err')
      finish(() => resolve({ code, stdout, stderr, commandLine }))
    })
  })
}

function quote(v: string): string {
  return /\s/.test(v) ? `"${v}"` : v
}

/**
 * Locate a JDK 21 installation. Minecraft 1.21.1 / NeoForge requires Java 21.
 * Checks configured path, JAVA_HOME, POSIX locations, then Windows JDK folders.
 */
export function findJava(configured?: string): string | null {
  const candidates: string[] = []
  if (configured) candidates.push(configured)
  for (const key of ['JDK21_HOME', 'JAVA_HOME', 'JDK_HOME']) {
    const v = process.env[key]
    if (v) candidates.push(isWin ? `${v}\\bin\\java.exe` : `${v}/bin/java`)
  }
  candidates.push(...scanJavaDirs())

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
    } catch {
      /* ignore */
    }
  }
  return null
}

function scanJavaDirs(): string[] {
  const out: string[] = []
  const roots = [
    'C\\Program Files\\Java',
    'C\\Program Files\\Eclipse Adoptium',
    'C\\Program Files\\Microsoft',
    'C\\Program Files\\Zulu',
    'C\\Program Files\\Amazon Corretto',
    '/usr/lib/jvm',
    '/Library/Java/JavaVirtualMachines'
  ]
  for (const root of roots) {
    const dir = isWin ? root.replace(/^C\\/, 'C:\\') : root
    let names: string[] = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names.sort().reverse()) {
      const exe = isWin ? `${dir}\\${name}\\bin\\java.exe` : name.endsWith('.jdk') || !name.includes('.') ? `${dir}/${name}/Contents/Home/bin/java` : `${dir}/${name}/bin/java`
      out.push(exe)
      if (!isWin) out.push(`${dir}/${name}/bin/java`)
    }
  }
  // Common Windows launcher-provided runtimes
  if (isWin) {
    const local = process.env.LOCALAPPDATA
    if (local) {
      for (const p of [
        `${local}\\Programs\\Eclipse Adoptium\\jdk-21\\bin\\java.exe`,
        `${local}\\Programs\\Microsoft\\jdk-21\\bin\\java.exe`
      ]) {
        out.push(p)
      }
    }
  }
  return out
}

export async function javaVersion(java: string): Promise<string | null> {
  try {
    const res = await run(java, ['-version'], { timeoutMs: 15000 })
    const text = `${res.stderr}${res.stdout}`
    const m = text.match(/version "([^"]+)"/)
    return m ? m[1] : null
  } catch {
    return null
  }
}

export function homeDir(): string {
  return os.homedir()
}
