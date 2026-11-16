import { app } from 'electron'
import { autoUpdater, type UpdateInfo } from 'electron-updater'
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig, saveConfig } from './config'
import { getMainWindow } from './ipc/windows'
import { friendlyUpdaterError as friendly, isNewer, updaterCachePath } from './updater-logic'

/**
 * Self-update.
 *
 * The packaged app points at its own GitHub releases via the `publish` block in
 * electron-builder.yml, so a new installer is picked up without the user
 * re-downloading anything by hand. That is what makes "select Minecraft 1.22
 * when it ships" practical: bumping the bundled era table ships as an ordinary
 * release, not a reinstall.
 *
 * Two things this deliberately does NOT do:
 *  - run in development (electron-updater throws without a real app bundle), or
 *  - install without the user's say so. It downloads in the background, then
 *    tells the UI an update is ready; installing restarts the app.
 */

export interface UpdateState {
  /** idle = nothing known, checking, available, downloading, ready, none, error */
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'none' | 'error'
  version?: string
  notes?: string
  /** 0-100 while downloading. */
  percent?: number
  error?: string
  /** True when the running build can actually update itself (packaged, Windows). */
  supported: boolean
  /** Last time a check completed, epoch ms. */
  checkedAt?: number
}

let state: UpdateState = { status: 'idle', supported: false }
let wired = false
/** Log of the last few updater messages, for the Settings panel's detail line. */
const log: string[] = []

function push(line: string): void {
  log.push(`${new Date().toISOString().slice(11, 19)} ${line}`)
  if (log.length > 60) log.shift()
}

function broadcast(next: Partial<UpdateState>): void {
  state = { ...state, ...next }
  const win = getMainWindow()
  if (win && !win.isDestroyed()) win.webContents.send('update:state', state)
}

/** The packaged app updates itself; a dev checkout has no installer to swap. */
export function updatesSupported(): boolean {
  return app.isPackaged && process.platform === 'win32'
}

export function currentUpdateState(): UpdateState {
  return { ...state, supported: updatesSupported(), log: log.slice(-12) } as UpdateState
}

/**
 * Wire electron-updater to the IPC channel. Safe to call more than once; the
 * listeners are only attached on the first call.
 */
export function initUpdater(): void {
  if (wired) return
  wired = true
  state = { ...state, supported: updatesSupported() }

  if (!updatesSupported()) {
    push('updates disabled: not a packaged Windows build')
    return
  }

  // Download only when the user asks. The installer is ~108 MB, and silently
  // pulling that down on someone's metered connection — before they have said
  // they want the update — is not a background nicety. `checkForUpdates` still
  // runs at startup and tells the UI an update exists; the download starts from
  // the button.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowPrerelease = false
  autoUpdater.logger = {
    info: (m?: unknown) => push(String(m)),
    warn: (m?: unknown) => push(`warn: ${String(m)}`),
    error: (m?: unknown) => push(`error: ${String(m)}`),
    debug: () => undefined
  }

  autoUpdater.on('checking-for-update', () => broadcast({ status: 'checking', error: undefined }))
  autoUpdater.on('update-available', (info: UpdateInfo) => {
    push(`update available: ${info.version}`)
    broadcast({ status: 'available', version: info.version, notes: noteText(info) })
  })
  autoUpdater.on('update-not-available', () => broadcast({ status: 'none', checkedAt: Date.now(), version: undefined }))
  autoUpdater.on('download-progress', (p) =>
    // Keep the version: the progress bar is shown next to "downloading 0.4.11",
    // and dropping it made the label flicker back to "unknown".
    broadcast({ status: 'downloading', percent: Math.round(p.percent) })
  )
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    push(`update downloaded: ${info.version}`)
    broadcast({ status: 'ready', version: info.version, percent: 100, notes: noteText(info) })
  })
  autoUpdater.on('error', (e: Error) => {
    push(`error: ${e.message}`)
    broadcast({ status: 'error', error: friendlyUpdaterError(e.message), checkedAt: Date.now() })
  })

  // A check at startup, then once a day while the app stays open.
  if (loadConfig().autoUpdate !== false) void checkForUpdates()
  setInterval(() => {
    if (loadConfig().autoUpdate !== false && state.status !== 'downloading') void checkForUpdates()
  }, 24 * 60 * 60 * 1000).unref?.()
}

function noteText(info: UpdateInfo): string | undefined {
  const raw = info.releaseNotes
  if (!raw) return undefined
  if (typeof raw === 'string') return raw.slice(0, 4000)
  return raw
    .map((n) => n.note ?? '')
    .join('\n')
    .slice(0, 4000)
}

/**
 * Ask GitHub whether there is a newer release.
 *
 * The returned state must not be read from the module's `state`: electron-updater
 * dispatches `update-available` on a *later tick* than the promise resolves, so
 * reading `state` here returned whatever it was before the check. That is the
 * "checking for updates does nothing" bug — a check that found 0.4.11 still
 * reported `idle`, and the Settings panel showed no update.
 *
 * So the authoritative answer is the value the API returns, and the events are
 * only used to report progress *during* a download.
 */
export async function checkForUpdates(): Promise<UpdateState> {
  if (!updatesSupported()) {
    broadcast({ status: 'idle', supported: false, error: undefined })
    return currentUpdateState()
  }
  try {
    const result = await autoUpdater.checkForUpdates()
    // null means the updater considered itself inactive (a dev build, or a
    // config with no feed) rather than "no update".
    if (result === null) {
      broadcast({ status: 'idle', supported: updatesSupported(), checkedAt: Date.now() })
      return currentUpdateState()
    }
    const info = result?.updateInfo
    if (info?.version) {
      // isUpdateAvailable is the API's own comparison, so a downgrade or an
      // equal version is not reported as an update.
      // Local numeric comparison rather than the semver instance: it is the
      // same decision, and it is the one covered by tests.
      const newer = isNewer(info.version, autoUpdater.currentVersion.version)
      if (newer) {
        push(`update available: ${info.version}`)
        broadcast({ status: 'available', version: info.version, notes: noteText(info), checkedAt: Date.now(), error: undefined })
      } else {
        broadcast({ status: 'none', version: undefined, checkedAt: Date.now(), error: undefined })
      }
    } else {
      broadcast({ status: 'none', version: undefined, checkedAt: Date.now(), error: undefined })
    }
  } catch (e) {
    broadcast({ status: 'error', error: friendlyUpdaterError((e as Error).message), checkedAt: Date.now() })
  }
  return currentUpdateState()
}

/**
 * Start downloading the update that `checkForUpdates` found.
 *
 * Separate from installing on purpose: downloading is 108 MB, installing
 * restarts the app. Both are the user's decision, and the UI shows progress in
 * between via the `download-progress` event.
 */
export async function downloadUpdate(): Promise<UpdateState> {
  if (!updatesSupported()) return currentUpdateState()
  try {
    broadcast({ status: 'downloading', percent: 0 })
    await autoUpdater.downloadUpdate()
  } catch (e) {
    broadcast({ status: 'error', error: friendlyUpdaterError((e as Error).message), checkedAt: Date.now() })
  }
  return currentUpdateState()
}

/** Quit and apply the downloaded update. No-op unless one is ready. */
export function installUpdate(): { ok: boolean; error?: string } {
  if (state.status !== 'ready') return { ok: false, error: 'No update has been downloaded yet.' }
  // isSilent=false, isForceRunAfter=true: normal installer, then relaunch.
  setImmediate(() => autoUpdater.quitAndInstall(false, true))
  return { ok: true }
}

/**
 * electron-updater's raw errors mention provider internals that mean nothing to
 * a mod developer. The mapping lives in updater-logic so it can be tested
 * without Electron; this re-exports it for the callers that already use it.
 */
export function friendlyUpdaterError(message: string): string {
  return friendly(message)
}

/** Toggle used by Settings; persisted so it survives restarts. */
export function setAutoUpdate(enabled: boolean): UpdateState {
  saveConfig({ autoUpdate: enabled })
  if (!enabled) {
    autoUpdater.removeAllListeners()
    wired = false
    broadcast({ status: 'idle', error: undefined })
    return currentUpdateState()
  }
  initUpdater()
  void checkForUpdates()
  return currentUpdateState()
}

/**
 * The version users are running, for the Settings header. Packaged builds get it
 * from app.getVersion(); a dev checkout should say so rather than imply 0.0.0.
 */
export function versionLabel(): string {
  return app.isPackaged ? app.getVersion() : `${app.getVersion()} (dev)`
}

/**
 * Where electron-updater caches downloads; exposed so Settings can show/clear it.
 *
 * Resolved the way electron-updater resolves it — `%LOCALAPPDATA%\<name>-updater`
 * on Windows, not `app.getPath('userData')` (which is Roaming, and was the reason
 * "Clear downloaded files" always freed nothing).
 */
export function updaterCacheDir(): string {
  return updaterCachePath({
    platform: process.platform,
    appName: app.getName(),
    env: process.env as Record<string, string | undefined>,
    home: app.getPath('home'),
    join: path.join
  })
}

export function clearUpdaterCache(): { ok: boolean; bytes?: number; error?: string } {
  const dir = updaterCacheDir()
  let freed = 0
  try {
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f)
        try {
          freed += fs.statSync(full).size
          fs.rmSync(full, { recursive: true, force: true })
        } catch {
          /* a locked file stays behind; the rest is still freed */
        }
      }
    }
    return { ok: true, bytes: freed }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
