import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { resolveJava, run } from '../util/exec'

/**
 * NeoForge loader installation.
 *
 * The official installer supports a headless mode:
 *   java -jar neoforge-<ver>-installer.jar --install-client <minecraftDir>
 * It writes libraries/, versions/neoforge-<ver>/ and launcher_profiles.json, and
 * requires a launcher_profiles.json stub when the folder has never been used by the
 * vanilla launcher (otherwise it aborts with "you have not run the launcher").
 *
 * Technic's legacy bin/modpack.jar mechanism only applies to Forge on <= 1.12.2, so
 * for 1.21.1 the loader has to come from this installer (or be provided by the pack
 * platform), and the jar goes in mods/.
 */
export const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge'

export function installerFileName(neoVersion: string): string {
  return `neoforge-${neoVersion}-installer.jar`
}

export function installerUrl(neoVersion: string): string {
  return `${NEOFORGE_MAVEN}/${neoVersion}/${installerFileName(neoVersion)}`
}

export function cacheDir(): string {
  const dir = path.join(app.getPath('userData'), 'cache')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export async function downloadInstaller(neoVersion: string, onLine: (l: string) => void): Promise<{ ok: boolean; path?: string; error?: string }> {
  const target = path.join(cacheDir(), installerFileName(neoVersion))
  if (fs.existsSync(target) && fs.statSync(target).size > 100_000) {
    onLine(`[neoforge] using cached installer ${target}`)
    return { ok: true, path: target }
  }
  const url = installerUrl(neoVersion)
  onLine(`[neoforge] downloading ${url}`)
  // Node's fetch handles the maven redirects and TLS; PowerShell avoids proxy quirks.
  try {
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} from ${url}` }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 100_000) return { ok: false, error: 'Downloaded installer looks too small; the version may not exist.' }
    fs.writeFileSync(target, buf)
    onLine(`[neoforge] saved ${(buf.length / 1024 / 1024).toFixed(1)} MB to ${target}`)
    return { ok: true, path: target }
  } catch (e) {
    return { ok: false, error: `download failed: ${(e as Error).message}` }
  }
}

/** The installer refuses to run without this file. */
export function ensureLauncherProfiles(minecraftDir: string): void {
  const file = path.join(minecraftDir, 'launcher_profiles.json')
  if (fs.existsSync(file)) return
  fs.mkdirSync(minecraftDir, { recursive: true })
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        profiles: {},
        settings: { enableSnapshots: false, keepLauncherOpen: false, showMenu: false },
        version: 3
      },
      null,
      2
    )
  )
}

export interface InstallResult {
  ok: boolean
  minecraftDir: string
  versionId?: string
  log: string
  error?: string
}

export async function installNeoForge(opts: {
  neoVersion: string
  minecraftDir: string
  javaPath?: string
  onLine: (l: string) => void
}): Promise<InstallResult> {
  const log: string[] = []
  const push = (l: string): void => {
    log.push(l)
    opts.onLine(l)
  }

  const javaPick = resolveJava(opts.javaPath)
  if (!javaPick.path) {
    return { ok: false, minecraftDir: opts.minecraftDir, log: log.join('\n'), error: javaPick.error ?? 'Java 21 not found. Set it in Settings.' }
  }
  const java = javaPick.path
  push(`[neoforge] using Java ${javaPick.version} at ${java}`)

  const dl = await downloadInstaller(opts.neoVersion, push)
  if (!dl.ok || !dl.path) return { ok: false, minecraftDir: opts.minecraftDir, log: log.join('\n'), error: dl.error }

  fs.mkdirSync(opts.minecraftDir, { recursive: true })
  ensureLauncherProfiles(opts.minecraftDir)
  push(`[neoforge] installing ${opts.neoVersion} into ${opts.minecraftDir}`)

  const res = await run(java, ['-jar', dl.path, '--install-client', opts.minecraftDir], {
    cwd: path.dirname(dl.path),
    timeoutMs: 15 * 60 * 1000,
    onLine: (line) => push(`[installer] ${line}`)
  })

  const versionId = `neoforge-${opts.neoVersion}`
  const installed = fs.existsSync(path.join(opts.minecraftDir, 'versions', versionId, `${versionId}.json`))
  if (res.code !== 0 || !installed) {
    return {
      ok: false,
      minecraftDir: opts.minecraftDir,
      versionId: installed ? versionId : undefined,
      log: log.join('\n'),
      error: installed ? undefined : `Installer exited ${res.code}. ${res.stderr.split(/\r?\n/).slice(-4).join(' ')}`
    }
  }
  push(`[neoforge] loader ${versionId} ready`)
  return { ok: true, minecraftDir: opts.minecraftDir, versionId, log: log.join('\n') }
}

export function isNeoForgeInstalled(minecraftDir: string, neoVersion: string): boolean {
  return fs.existsSync(path.join(minecraftDir, 'versions', `neoforge-${neoVersion}`, `neoforge-${neoVersion}.json`))
}
