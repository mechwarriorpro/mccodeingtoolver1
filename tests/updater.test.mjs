import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Self-update logic.
 *
 * The app shipped a bug where "Check for updates" found 0.4.11 and still
 * reported the pre-check state, so the panel said up to date. Nothing here
 * could have been tested before: `update.ts` imports electron-updater, which
 * imports electron. The decisions are now in their own module.
 */

const out = path.join(process.cwd(), 'out-test', 'main')
const { isNewer, updaterCachePath, friendlyUpdaterError } = await import(
  pathToFileURL(path.join(out, 'updater-logic.js')).href
)

let passed = 0
function check(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (e) {
    console.log(`  FAIL ${name}`)
    console.log(`       ${e.message}`)
    process.exitCode = 1
  }
}

/* ------------------------------------------------------------- isNewer */

check('a patch bump is newer', () => {
  assert.equal(isNewer('0.4.11', '0.4.9'), true)
})

check('0.4.10 beats 0.4.9, which string comparison gets backwards', () => {
  // "0.4.10" < "0.4.9" as text. This is the whole reason the function exists.
  assert.equal('0.4.10' < '0.4.9', true, 'sanity: the trap is real')
  assert.equal(isNewer('0.4.10', '0.4.9'), true)
})

check('the same version is not an update', () => {
  assert.equal(isNewer('0.4.11', '0.4.11'), false)
})

check('an older version is not offered as an update', () => {
  // A rolled-back release, or a user on a build from a newer branch.
  assert.equal(isNewer('0.4.9', '0.4.11'), false)
  assert.equal(isNewer('0.3.0', '0.4.11'), false)
})

check('a leading v and surrounding space are tolerated', () => {
  assert.equal(isNewer('v0.5.0', '0.4.11'), true)
  assert.equal(isNewer(' 0.5.0 ', '0.4.11'), true)
})

check('a missing segment is treated as zero', () => {
  assert.equal(isNewer('0.5', '0.4.11'), true)
  assert.equal(isNewer('0.5.0', '0.5'), false)
})

check('a major bump wins over any minor', () => {
  assert.equal(isNewer('1.0.0', '0.99.99'), true)
  assert.equal(isNewer('0.99.99', '1.0.0'), false)
})

check('garbage is not an update rather than an exception', () => {
  // A malformed latest.yml must not crash the updater into an error state that
  // looks like "update available".
  assert.equal(isNewer('nightly', '0.4.11'), false)
  assert.equal(isNewer('0.5.0', 'unknown'), false)
})

/* ---------------------------------------------------- updaterCachePath */

const join = (...p) => p.join('\\')

check('Windows uses LOCALAPPDATA, not Roaming', () => {
  const dir = updaterCachePath({
    platform: 'win32',
    appName: 'MC Forge Agent',
    env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' },
    home: 'C:\\Users\\u',
    join
  })
  assert.equal(dir, 'C:\\Users\\u\\AppData\\Local\\MC Forge Agent-updater')
  // The bug: the app used app.getPath('userData'), which is Roaming, so the
  // clear-cache button emptied a directory that was never written to.
  assert.ok(!/Roaming/.test(dir), 'the cache must not be under Roaming')
})

check('a missing LOCALAPPDATA falls back to AppData\\Local', () => {
  const dir = updaterCachePath({
    platform: 'win32',
    appName: 'X',
    env: {},
    home: 'C:\\Users\\u',
    join
  })
  assert.equal(dir, 'C:\\Users\\u\\AppData\\Local\\X-updater')
})

check('macOS uses ~/Library/Caches', () => {
  const dir = updaterCachePath({ platform: 'darwin', appName: 'X', env: {}, home: '/Users/u', join: (...p) => p.join('/') })
  assert.equal(dir, '/Users/u/Library/Caches/X-updater')
})

check('Linux honours XDG_CACHE_HOME and falls back to ~/.cache', () => {
  const withXdg = updaterCachePath({
    platform: 'linux',
    appName: 'X',
    env: { XDG_CACHE_HOME: '/tmp/cache' },
    home: '/home/u',
    join: (...p) => p.join('/')
  })
  assert.equal(withXdg, '/tmp/cache/X-updater')
  const without = updaterCachePath({ platform: 'linux', appName: 'X', env: {}, home: '/home/u', join: (...p) => p.join('/') })
  assert.equal(without, '/home/u/.cache/X-updater')
})

check('the cache folder is named after the app, as electron-updater expects', () => {
  const dir = updaterCachePath({
    platform: 'win32',
    appName: 'MC Forge Agent',
    env: { LOCALAPPDATA: 'L' },
    home: 'H',
    join
  })
  assert.match(dir, /MC Forge Agent-updater$/)
})

/* ---------------------------------------------- friendlyUpdaterError */

check('a missing release reads as "nothing published yet"', () => {
  assert.match(friendlyUpdaterError('404 Not Found'), /No published release/i)
  assert.match(friendlyUpdaterError('Cannot find latest.yml'), /No published release/i)
})

check('a network failure tells the user to check the connection', () => {
  assert.match(friendlyUpdaterError('net::ERR_INTERNET_DISCONNECTED'), /connection/i)
  assert.match(friendlyUpdaterError('getaddrinfo ENOTFOUND github.com'), /connection/i)
  // A TLS interception (common on corporate networks) reads the same way.
  assert.match(friendlyUpdaterError('unable to verify the first certificate'), /connection/i)
})

check('an integrity failure says so rather than dumping the hash', () => {
  assert.match(friendlyUpdaterError('sha512 checksum mismatch'), /integrity check/i)
})

check('a full disk is named', () => {
  assert.match(friendlyUpdaterError('ENOSPC: no space left on device'), /disk space/i)
})

check('an unknown error is passed through but truncated', () => {
  const long = 'x'.repeat(2000)
  assert.ok(friendlyUpdaterError(long).length <= 400)
  assert.equal(friendlyUpdaterError(''), 'unknown error')
})

console.log(`\n${passed} updater checks passed`)
