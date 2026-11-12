import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { resolveBuildJava, run, probeJava } from '../util/exec'
import { readProps } from '../mod/props'
import { resolveEra, javaForVersion } from '../versions/eras'
import { compareMcVersions } from '../versions/catalog'
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

/**
 * How to actually start Gradle.
 *
 * Three cases, and getting them wrong is what produced
 * `'C:\Users\Owner\AppData\Roaming\MC' is not recognized`:
 *
 *  - **Windows wrapper**: run `cmd.exe /d /s /c ""<path with spaces>" <args>"`.
 *    `shell: true` cannot be used because Node does not quote `cmd` for it.
 *  - **POSIX wrapper**: execute the script directly, no shell.
 *  - **Bare `gradle` on PATH**: needs a shell on Windows because it is a .bat.
 */
export function buildSpawnPlan(
  gw: { cmd: string; shell: boolean },
  args: string[],
  // Injectable so the Windows branch can be tested on any platform; getting this
  // wrong is invisible on macOS/Linux CI.
  platform: NodeJS.Platform = process.platform
): { cmd: string; args: string[]; shell: boolean; verbatim: boolean } {
  if (platform === 'win32' && /\.(bat|cmd)$/i.test(gw.cmd)) {
    // cmd.exe /s strips exactly the outer pair of quotes, which is why the whole
    // command line is wrapped in one more pair. This is the canonical pattern
    // Node documents for spawning a .bat whose path contains spaces.
    const inner = [`"${gw.cmd}"`, ...args.map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a))].join(' ')
    return {
      cmd: process.env.COMSPEC || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${inner}"`],
      shell: false,
      // Pass the command line through untouched so cmd.exe sees our quotes.
      verbatim: true
    }
  }
  if (gw.shell) {
    // A bare command resolved through PATH (e.g. `gradle`), which is a .bat on
    // Windows. There is no path with spaces to mangle here.
    return { cmd: gw.cmd, args, shell: true, verbatim: false }
  }
  return { cmd: gw.cmd, args, shell: false, verbatim: false }
}

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

/**
 * Work out which JDK this project needs — and flag the upgrade case.
 *
 * The app's own launcher is fixed on 1.21.1, so `findJava()` demands Java 21.
 * Building is different: a project declares its own target, and a 1.12.2 project
 * cannot run on Java 21 at all. Worse, during an in-place upgrade the *folder*
 * still says 1.12.2 while the *sources* are already 1.21.1, because those are
 * written by the agent before Gradle is touched.
 *
 * So: trust the declared version for the toolchain, but if the code has already
 * moved past it, build with the newer Java the code needs and say so in the log.
 * Failing the build with "Java 8 required" on 1.21.1 sources would be technically
 * consistent and practically useless.
 */
export function planBuildJava(
  workspaceDir: string,
  configured?: string
): {
  path: string | null
  version?: string
  targetJava: number
  mcVersion: string
  usingVersion?: string
  note?: string
  error?: string
} {
  const props = readProps(path.join(workspaceDir, 'gradle.properties'))
  const mcVersion = props.minecraft_version ?? props.mc_version ?? props.minecraftVersion ?? ''
  const loaderRaw = (props.loader ?? props.mod_loader ?? '').toLowerCase()
  const loader = loaderRaw.includes('neoforge') ? 'neoforge' : loaderRaw.includes('fabric') ? 'fabric' : 'forge'

  if (!mcVersion) {
    // A project without a declared version is most likely mid-upgrade. Java 17
    // is the safest middle: it runs old Gradle wrappers and can target 8 or 17.
    const fallback = resolveBuildJava(configured, 17, 'this project')
    return { ...fallback, targetJava: 17, mcVersion: '', note: 'no minecraft_version in gradle.properties' }
  }

  const era = resolveEra(loader, mcVersion)
  const declaredJava = era ? javaForVersion(loader, mcVersion, era) : 8

  // Has the source already been moved to a newer language level?
  const sources = sourceJavaLevel(workspaceDir)
  const codeNeeds = Math.max(declaredJava, sources ?? 0)
  if (codeNeeds > declaredJava) {
    const res = resolveBuildJava(configured, codeNeeds, `Minecraft ${mcVersion}`)
    return {
      ...res,
      targetJava: codeNeeds,
      mcVersion,
      note: `sources are already Java ${codeNeeds} but gradle.properties still says ${mcVersion} — finish the upgrade`
    }
  }

  const res = resolveBuildJava(configured, declaredJava, `Minecraft ${mcVersion}`)
  return { ...res, targetJava: declaredJava, mcVersion }
}

/**
 * The highest Java level the sources appear to use, from `sourceCompatibility`
 * or `JavaVersion.VERSION_xx` in the build files. Null when nothing declares it.
 */
export function sourceJavaLevel(workspaceDir: string): number | null {
  for (const file of ['build.gradle', 'build.gradle.kts']) {
    let text = ''
    try {
      text = fs.readFileSync(path.join(workspaceDir, file), 'utf8')
    } catch {
      continue
    }
    const found = [
      ...text.matchAll(/JavaVersion\.VERSION_(\d+)/g),
      ...text.matchAll(/sourceCompatibility\s*=?\s*(?:JavaVersion\.VERSION_)?[\"']?(?:1\.)?(\d+)/g),
      ...text.matchAll(/languageVersion\s*=?\s*JavaLanguageVersion\.of\((\d+)\)/g)
    ].map((m) => Number(m[1]))
    if (found.length) return Math.max(...found)
  }
  return null
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
  const plan = planBuildJava(opts.workspaceDir, opts.javaPath)
  const java = plan.path
  const gw = gradlewPath(opts.workspaceDir, opts.preferWrapper ?? true)

  push(`[build] mode=local task=${task}`)
  push(`[build] cwd=${opts.workspaceDir}`)
  push(`[build] project=${plan.mcVersion || '?'} → needs Java ${plan.targetJava}${plan.note ? ` (${plan.note})` : ''}`)
  push(`[build] java=${java ?? '(PATH)'}${plan.usingVersion ? ` (Java ${plan.usingVersion})` : ''}`)

  const env: NodeJS.ProcessEnv = { ...process.env }
  if (java) env.JAVA_HOME = path.dirname(path.dirname(java))
  env.GRADLE_OPTS = `${env.GRADLE_OPTS ?? ''} ${app.isPackaged ? '' : ''}`.trim()
  // Windows console cannot always render gradle's ANSI output.
  env.TERM = 'dumb'

  if (!java) {
    const message = plan.error ?? 'No suitable Java was found for this project.'
    push(`[build] ${message}`)
    logStream.end()
    return { ok: false, code: null, logPath, errors: [message], durationMs: 0 }
  }

  const args = [...gw.args, task, '--stacktrace', '--console=plain', '--no-daemon']
  if (opts.signal?.aborted) {
    logStream.end()
    return { ok: false, code: null, logPath, errors: ['cancelled'], durationMs: 0 }
  }

  const result = await new Promise<{ code: number | null }>((resolve) => {
    let child: ChildProcess
    // On Windows a .bat cannot be spawned directly, so it goes through cmd.exe.
    // The path MUST be quoted by us: `shell: true` does not quote the command,
    // so a project living in "…\MC Forge Agent\forks\…" was split at the space
    // and cmd.exe tried to run "C:\Users\Owner\AppData\Roaming\MC".
    const spawnPlan = buildSpawnPlan(gw, args)
    child = spawn(spawnPlan.cmd, spawnPlan.args, {
      cwd: opts.workspaceDir,
      env,
      shell: spawnPlan.shell,
      windowsHide: true,
      windowsVerbatimArguments: spawnPlan.verbatim
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
