/**
 * The parts of self-update that are pure logic.
 *
 * `update.ts` imports `electron-updater`, which imports `electron` and cannot
 * load outside a packaged app — so none of that file was testable, which is why
 * the "check finds an update but the UI says up to date" bug shipped. The two
 * decisions worth testing are here, free of Electron:
 *
 *  - which of the latest release and the running version is newer, and
 *  - which directory electron-updater actually caches downloads in.
 */

export interface VersionLike {
  version: string
}

/**
 * Is `latest` newer than `current`?
 *
 * Deliberately not a string comparison: "0.4.10" < "0.4.9" as text, which is
 * exactly the shape of bug this avoids. Numeric, segment by segment, with a
 * missing segment treated as 0 so 0.5 and 0.5.0 agree.
 */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string): number[] => {
    const m = v.trim().replace(/^v/i, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
    if (!m) return []
    return [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3] ?? 0)]
  }
  const a = parse(latest)
  const b = parse(current)
  if (!a.length || !b.length) return false
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return false
}

/**
 * The directory electron-updater uses for downloaded installers.
 *
 * It resolves this from `getAppCacheDir()`, which is `%LOCALAPPDATA%` on
 * Windows, `~/Library/Caches` on macOS and `$XDG_CACHE_HOME` (or `~/.cache`)
 * elsewhere — *not* `app.getPath('userData')`, which is Roaming on Windows. The
 * app's "Clear downloaded files" button used userData and so emptied a
 * directory that never existed.
 *
 * Parameters rather than `app` calls, so the platform branches can be tested on
 * whichever platform is running the tests.
 */
export function updaterCachePath(opts: {
  platform: NodeJS.Platform
  appName: string
  env: Record<string, string | undefined>
  home: string
  join?: (...parts: string[]) => string
}): string {
  const join = opts.join ?? ((...parts: string[]) => parts.join('/'))
  const name = `${opts.appName}-updater`
  if (opts.platform === 'win32') {
    const local = opts.env.LOCALAPPDATA || join(opts.home, 'AppData', 'Local')
    return join(local, name)
  }
  if (opts.platform === 'darwin') return join(opts.home, 'Library', 'Caches', name)
  return join(opts.env.XDG_CACHE_HOME || join(opts.home, '.cache'), name)
}

/**
 * electron-updater's error messages mention provider internals that mean
 * nothing to a mod developer. Map the ones that actually happen.
 */
export function friendlyUpdaterError(message: string): string {
  const m = message || 'unknown error'
  if (/404|latest\.yml|Cannot find channel|No published versions/i.test(m)) {
    return 'No published release was found to update from yet.'
  }
  if (/net::|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|InternetException|certificate/i.test(m)) {
    return 'Could not reach GitHub. Check your connection and try again.'
  }
  if (/code signature|sha512|checksum|integrity/i.test(m)) {
    return 'The downloaded update failed its integrity check. Try again from the GitHub release page.'
  }
  if (/ENOSPC|no space/i.test(m)) return 'Not enough disk space to download the update.'
  return m.slice(0, 400)
}
