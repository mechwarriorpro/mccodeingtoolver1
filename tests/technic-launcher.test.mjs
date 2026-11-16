/**
 * "Technic Launcher not found. Install it, or point Settings > Instance at the
 * pack folder."
 *
 * That sentence was wrong twice over, and the second mistake is the reason this
 * test exists:
 *
 *   - "Install it" was the whole advice for people who had it installed and open.
 *     The search checked three hard-coded Windows paths; the launcher ships as a
 *     single exe people run from Downloads, so it is usually nowhere near them.
 *   - "point Settings > Instance at the pack folder" named a fix that could not
 *     work. That control adds a *pack*, and no setting for the launcher path
 *     existed at all — so a user following the instruction would do it correctly
 *     and still get the same error.
 *
 * An error that names an impossible fix costs more than a vague one. The checks
 * below are mostly about that.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let passed = 0
const failures = []
function check(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (e) {
    failures.push(name)
    console.log(`  FAIL ${name}\n       ${e.message}`)
  }
}

const out = new URL('../out-test/main/game/technic.js', import.meta.url).href
const technic = await import(out)
const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

/* ------------------------------------------------- the error must be usable */

check('the message no longer points at a setting that does not exist', () => {
  const help = technic.launcherNotFoundHelp('')
  assert.doesNotMatch(help, /Settings > Instance/i, 'that control adds a pack; it has never set the launcher path')
  assert.doesNotMatch(help, /point Settings.*pack folder/i)
})

check('it names the setting that does exist', () => {
  const help = technic.launcherNotFoundHelp('')
  assert.match(help, /Settings → Game/)
  assert.match(help, /Technic Launcher/)
})

check('it says where it actually looked, rather than just "not found"', () => {
  const help = technic.launcherNotFoundHelp('')
  assert.match(help, /LOCALAPPDATA|APPDATA|Program Files/)
  assert.match(help, /Downloads/i, 'the download is a single exe; that is where it usually stays')
})

check('it offers a way forward that does not need the launcher at all', () => {
  // "Install it" is useless advice to someone who has it. A custom instance
  // starts Minecraft directly, which is what they wanted.
  const help = technic.launcherNotFoundHelp('')
  assert.match(help, /custom/i)
  assert.match(help, /directly|does not need the launcher|skip the launcher/i)
})

check('a configured path that does not resolve is quoted back', () => {
  const help = technic.launcherNotFoundHelp('D:\\Games\\nope\\TechnicLauncher.exe')
  assert.match(help, /D:\\Games\\nope\\TechnicLauncher\.exe/, 'the user needs to see what was tried, or they cannot spot a typo')
  assert.doesNotMatch(help, /Technic packs live in/, 'that is not the problem here')
})

check('it does not tell the user to install something they may already have', () => {
  const help = technic.launcherNotFoundHelp('')
  assert.doesNotMatch(help, /^Install it/i)
  assert.match(help, /Installing Technic is not required/i)
})

/* ------------------------------------------- what counts as a valid setting */

check('a folder is accepted, because people paste folders', () => {
  // The picker returns a file, but typing a folder is a reasonable thing to do.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tech-'))
  const exe = path.join(dir, 'TechnicLauncher.exe')
  fs.writeFileSync(exe, 'MZ')
  assert.equal(technic.resolveLauncherCandidate(dir), exe)
  assert.equal(technic.resolveLauncherCandidate(exe), exe)
  fs.rmSync(dir, { recursive: true, force: true })
})

check('a path to nothing is refused, not passed to spawn', () => {
  assert.equal(technic.resolveLauncherCandidate(path.join(os.tmpdir(), 'definitely-not-here.exe')), undefined)
  assert.equal(technic.resolveLauncherCandidate(''), undefined)
})

check('a folder that is not a launcher is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tech2-'))
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'hi')
  assert.equal(technic.resolveLauncherCandidate(path.join(dir, 'notes.txt')), undefined, 'spawning a text file is not a launch')
  fs.rmSync(dir, { recursive: true, force: true })
})

check('on this platform the search returns nothing rather than throwing', () => {
  // technicExe is Windows-only; elsewhere it must be a clean "no", which is what
  // the caller branches on. A throw here would take the Launch button with it.
  const res = technic.technicExe(undefined)
  if (process.platform === 'win32') assert.ok(res === undefined || typeof res === 'string')
  else assert.equal(res, undefined)
})

/* --------------------------------------------- the setting must actually wire */

check('the config carries a launcher path, or the fix is only cosmetic', () => {
  const types = read('src/shared/types.ts')
  assert.match(types, /technicLauncherPath: string/)
  const config = read('src/main/config.ts')
  assert.match(config, /technicLauncherPath: ''/, 'an empty default means auto-detect still works')
})

check('launching uses the configured path', () => {
  const technicSrc = read('src/main/game/technic.ts')
  assert.match(technicSrc, /launchTechnic\(configuredPath\?: string\)/)
  const tools = read('src/main/agent/tools.ts')
  assert.match(tools, /launchTechnic\(cfg\.game\.technicLauncherPath\)/)
  const ipc = read('src/main/ipc/index.ts')
  assert.match(ipc, /launchTechnic\(cfg\.game\.technicLauncherPath\)/, 'the Launch button must honour the setting too')
})

check('the agent can see whether the launcher was found', () => {
  // Without this, the agent's own diagnostics say "not found" and it cannot tell
  // a genuine miss from a path the user has already fixed.
  const tools = read('src/main/agent/tools.ts')
  assert.match(tools, /technicLauncher: \{ configured/)
})

check('Settings has a field for it, with a Browse button', () => {
  const settings = read('src/renderer/src/components/SettingsModal.tsx')
  assert.match(settings, /technicLauncherPath/)
  assert.match(settings, /Browse…/)
  assert.match(settings, /pickFiles/, 'typing an exact path is unreasonable; the picker is the actual fix for most people')
})

check('the sidebar tells the truth about the launcher instead of hiding it', () => {
  const app = read('src/renderer/src/App.tsx')
  assert.match(app, /Launcher found/)
  assert.match(app, /Launcher not found/, 'silence looked identical to "configured correctly"')
})

check('the search covers the 32-bit Program Files as well', () => {
  const technicSrc = read('src/main/game/technic.ts')
  assert.match(technicSrc, /ProgramFiles\(x86\)/, 'a 32-bit launcher on a 64-bit machine is the common case')
})

console.log(`\n${failures.length ? `${failures.length} check(s) failed` : `all ${passed} technic-launcher checks passed`}`)
if (failures.length) process.exit(1)
