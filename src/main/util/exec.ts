import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
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
 * Java discovery.
 *
 * Two different requirements share this code, so they get separate resolvers:
 *
 *   - Minecraft 1.21.1 / NeoForge needs **Java 21**.
 *   - The decompiler needs only **Java 17+** (Vineflower 1.11+ is class file 61).
 *
 * Picking the first file that exists is not enough: on Windows the `Path` entry
 * is often a Java 8 runtime, and a Java 8 `java.exe` cannot load Vineflower at
 * all (UnsupportedClassVersionError: class file version 61.0, this version only
 * recognizes up to 52.0). Every candidate is therefore version-checked, and
 * javaw.exe is never used because it writes no output.
 */

interface JavaCandidate {
  path: string
  /** Ordered preference; lower is better. */
  rank: number
  /** True for entries that came from the user's own configuration. */
  configured?: boolean
}

const LAUNCHER_DIRS = [
  // Runtimes shipped by launchers. Technic and the vanilla launcher between them
  // are the usual source of a stray Java 8 on a modding machine.
  'APPDATA\\.technic\\bin',
  'APPDATA\\.minecraft\\runtime',
  '.minecraft\\runtime',
  'APPDATA\\PrismLauncher\\java',
  'APPDATA\\MultiMC\\java',
  'APPDATA\\com.modrinth.theseus\\meta\\java',
  'APPDATA\\.gradle\\jdks'
]

function expandEnv(p: string): string {
  const appdata = process.env.APPDATA ?? ''
  const home = os.homedir()
  return p.replace(/^APPDATA\\/i, appdata).replace(/^~/, home)
}

/** Every place worth looking, best first. */
function javaCandidates(configured?: string): JavaCandidate[] {
  const out: JavaCandidate[] = []

  if (configured) out.push({ path: configured, rank: 0, configured: true })

  // JAVA_HOME first: a developer who set it means it.
  for (const key of ['JAVA_HOME', 'JDK_HOME', 'JDK21_HOME']) {
    const v = process.env[key]
    if (v) out.push({ path: isWin ? `${v}\bin\java.exe` : `${v}/bin/java`, rank: 1, configured: true })
  }

  // Named toolchain variables, when a build system set them.
  for (const key of ['ORG_GRADLE_JAVA_HOME', 'GRADLE_JAVA_HOME']) {
    const v = process.env[key]
    if (v) out.push({ path: isWin ? `${v}\bin\java.exe` : `${v}/bin/java`, rank: 2 })
  }

  out.push(...scanJavaDirs())

  // Last resort: whatever `java` is on PATH. Keep the bare name so the spawn
  // resolves through PATH, but the version check still applies.
  out.push({ path: 'java', rank: 99 })

  // Deduplicate on the normalised path, keeping the best rank.
  const seen = new Map<string, JavaCandidate>()
  for (const c of out) {
    const key = c.path.toLowerCase()
    const prev = seen.get(key)
    if (!prev || c.rank < prev.rank) seen.set(key, c)
  }
  return [...seen.values()].sort((a, b) => a.rank - b.rank)
}

/** Install roots plus per-launcher runtimes, in descending version order. */
function scanJavaDirs(): JavaCandidate[] {
  const out: JavaCandidate[] = []
  const rank = (name: string): number => {
    const m = name.match(/(?:jdk|jre|java|temurin|zulu|corretto|openjdk)[-_ ]?(?:1\.)?(\d+)/i) ?? name.match(/(?:^|[-_.])(\d{2})(?:[.\-_]|$)/)
    const major = m ? Number(m[1]) : 0
    // Prefer newer JDKs, but never above an explicitly configured one.
    return 10 + Math.max(0, 40 - major)
  }

  const roots = [
    'C:\Program Files\Java',
    'C:\Program Files\Eclipse Adoptium',
    'C:\Program Files\Eclipse Foundation',
    'C:\Program Files\Microsoft',
    'C:\Program Files\Zulu',
    'C:\Program Files\Amazon Corretto',
    'C:\Program Files\BellSoft',
    '/usr/lib/jvm',
    '/Library/Java/JavaVirtualMachines',
    '/opt/java'
  ]

  for (const raw of roots) {
    const dir = expandEnv(raw)
    let names: string[] = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      const base = isWin ? `${dir}\${name}\bin\java.exe` : `${dir}/${name}/bin/java`
      const mac = `${dir}/${name}/Contents/Home/bin/java`
      for (const exe of isWin ? [base] : [mac, base]) {
        out.push({ path: exe, rank: rank(name) })
      }
    }
  }

  // Launcher-managed runtimes, e.g. %APPDATA%\.technic\bin\jre-x64-java8\bin\java.exe
  for (const raw of LAUNCHER_DIRS) {
    const dir = expandEnv(raw)
    let names: string[] = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!/java|jdk|jre/i.test(name)) continue
      const exe = isWin ? `${dir}\${name}\bin\java.exe` : `${dir}/${name}/bin/java`
      out.push({ path: exe, rank: rank(name) })
    }
  }

  // Android Studio / IntelliJ bundled JetBrains Runtime, a common JDK 21 source.
  for (const raw of ['C:\Program Files\JetBrains', 'C:\Program Files\Android\Android Studio']) {
    const dir = expandEnv(raw)
    let names: string[] = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      for (const jbr of [
        `${dir}\${name}\jbr\bin\java.exe`,
        `${dir}\${name}\jre\bin\java.exe`
      ]) {
        out.push({ path: jbr, rank: rank(name) + 5 })
      }
    }
  }
  return out
}

const isWinPath = (p: string): boolean => /^[A-Za-z]:[\\/]/.test(p) || p.includes('\\')

/** "21", "17", "1.8" -> major version. */
function majorOf(version: string): number {
  if (version.startsWith('1.')) return Number(version.split('.')[1])
  return Number(version.split(/[._-]/)[0])
}

interface VersionProbe {
  major: number
  version: string
  arch?: string
}

/** Cache probes: spawning java takes ~100 ms and this runs on every status check. */
const probeCache = new Map<string, VersionProbe | null>()

/**
 * Run `java -version` synchronously and parse it. Synchronous on purpose: this is
 * called from update handlers where an async round trip per candidate would make
 * the UI feel broken, and the result is cached.
 */
export function probeJava(path: string): VersionProbe | null {
  const key = path.toLowerCase()
  if (probeCache.has(key)) return probeCache.get(key) ?? null

  let result: VersionProbe | null = null
  try {
    // A .bat/.cmd wrapper (some launchers ship one) cannot be spawned directly on
    // Windows, and Node refuses to exec .bat without a shell. Route through cmd.exe
    // rather than shell:true, which would mangle an unquoted path with spaces.
    const attempts: (() => ReturnType<typeof spawnSync>)[] = /\.(bat|cmd)$/i.test(path)
      ? [
          () => spawnSync(process.env.COMSPEC || 'cmd.exe', ['/c', path, '-version'], { timeout: 8000, windowsHide: true, encoding: 'utf8' }),
          () => spawnSync(path, ['-version'], { timeout: 8000, windowsHide: true, encoding: 'utf8', shell: true })
        ]
      : [() => spawnSync(path, ['-version'], { timeout: 8000, windowsHide: true, encoding: 'utf8' })]

    for (const attempt of attempts) {
      const res = attempt()
      const text = `${res.stderr ?? ''}${res.stdout ?? ''}`
      const m = text.match(/version "([^"]+)"/)
      if (m) {
        result = {
          version: m[1],
          major: majorOf(m[1]),
          arch: text.match(/(64|32)-Bit/i)?.[0]
        }
        break
      }
    }
  } catch {
    result = null
  }
  probeCache.set(key, result)
  return result
}

function pick(configured: string | undefined, minMajor: number, purpose: string): { path: string; probe: VersionProbe } | { error: string } {
  const candidates = javaCandidates(configured)
  const seen: string[] = []
  for (const candidate of candidates) {
    if (!candidate.path) continue
    const exists = candidate.path === 'java' || (() => {
      try {
        return fs.existsSync(candidate.path) && fs.statSync(candidate.path).isFile()
      } catch {
        return false
      }
    })()
    if (!exists) continue
    const probe = probeJava(candidate.path)
    if (!probe) {
      seen.push(`${candidate.path} (not a working java)`)
      continue
    }
    if (probe.major >= minMajor) return { path: candidate.path, probe }
    seen.push(`${candidate.path} (Java ${probe.major}${candidate.configured ? ', set in Settings' : ''})`)
  }
  const want = minMajor === 21 ? 'Java 21' : `Java ${minMajor}+`
  return {
    error:
      `${want} is required for ${purpose}, but none was found.` +
      (seen.length ? ` Tried: ${seen.slice(0, 6).join('; ')}${seen.length > 6 ? `; and ${seen.length - 6} more` : ''}.` : '') +
      ' Install Temurin OpenJDK 21 (https://adoptium.net) and set java.exe in Settings → Model.'
  }
}

/**
 * Java for Minecraft 1.21.1 / NeoForge, which is exactly Java 21.
 * Returns null when nothing suitable exists; use resolveJava() for the reason.
 */
export function findJava(configured?: string): string | null {
  const res = pick(configured, 21, 'Minecraft 1.21.1')
  return 'path' in res ? res.path : null
}

/** Java 21+, verified by running it. Used for the game and the NeoForge installer. */
export function resolveJava(configured?: string): { path: string | null; version?: string; error?: string } {
  const res = pick(configured, 21, 'Minecraft 1.21.1')
  if ('path' in res) return { path: res.path, version: res.probe.version }
  return { path: null, error: res.error }
}

/**
 * Java 17+ for tools such as the decompiler. Deliberately separate from the game
 * JDK: Vineflower needs >= 17 (class file 61), the game needs exactly 21, and a
 * machine can have a working Java 17 without a 21.
 */
export function resolveToolJava(configured?: string): { path: string | null; version?: string; error?: string } {
  const res = pick(configured, 17, 'the reference decompiler')
  if ('path' in res) return { path: res.path, version: res.probe.version }
  return { path: null, error: res.error }
}

/** Version string of one specific executable, or null. */
export async function javaVersion(java: string): Promise<string | null> {
  const cached = probeJava(java)
  if (cached) return cached.version
  // Fall back to the async path for a path the sync probe could not parse.
  try {
    const res = await run(java, ['-version'], { timeoutMs: 15000 })
    const text = `${res.stderr}${res.stdout}`
    const m = text.match(/version "([^"]+)"/)
    return m ? m[1] : null
  } catch {
    return null
  }
}

/** Clear the probe cache (after the user changes the java path in Settings). */
export function clearJavaCache(): void {
  probeCache.clear()
}

/** True when the path looks like a javaw.exe, which prints nothing. */
export function isJavaw(path: string): boolean {
  return /javaw\.exe$/i.test(path)
}

export function homeDir(): string {
  return os.homedir()
}
