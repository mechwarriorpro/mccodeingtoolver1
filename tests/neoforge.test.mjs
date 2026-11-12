/**
 * NeoForge loader + launch-argument tests. No network, no JDK: we feed synthetic
 * version JSONs and assert the command line is assembled the way the launcher does.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let failures = 0
function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`)
  }
}

const { installerUrl, installerFileName, ensureLauncherProfiles, isNeoForgeInstalled } = await import('../out-test/main/game/neoforge.js')
const { neoVirtualArgs } = await import('../out-test/main/game/client.js')
const { libraryAllowed, libraryTarget } = await import('../out-test/main/game/mojang.js')

console.log('installer naming')
check('installer url points at the neoforged maven', installerUrl('21.1.265') === 'https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.265/neoforge-21.1.265-installer.jar', installerUrl('21.1.265'))
check('installer filename', installerFileName('21.1.265') === 'neoforge-21.1.265-installer.jar')

console.log('launcher_profiles stub (installer refuses to run without it)')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcfa-nf-'))
const mcDir = path.join(tmp, 'mc')
ensureLauncherProfiles(mcDir)
const stub = JSON.parse(fs.readFileSync(path.join(mcDir, 'launcher_profiles.json'), 'utf8'))
check('stub has profiles object', stub && typeof stub.profiles === 'object')
check('stub has version 3', stub.version === 3)
const before = fs.readFileSync(path.join(mcDir, 'launcher_profiles.json'), 'utf8')
ensureLauncherProfiles(mcDir)
check('does not clobber an existing profile file', fs.readFileSync(path.join(mcDir, 'launcher_profiles.json'), 'utf8') === before)

console.log('loader detection')
check('reports not installed for empty dir', isNeoForgeInstalled(mcDir, '21.1.265') === false)
fs.mkdirSync(path.join(mcDir, 'versions', 'neoforge-21.1.265'), { recursive: true })
fs.writeFileSync(path.join(mcDir, 'versions', 'neoforge-21.1.265', 'neoforge-21.1.265.json'), '{}')
check('reports installed when version json exists', isNeoForgeInstalled(mcDir, '21.1.265') === true)

console.log('neoforge argument expansion')
const neoJson = {
  id: 'neoforge-21.1.265',
  mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher',
  arguments: {
    jvm: [
      '-p',
      '${library_directory}/cpw/mods/bootstraplauncher/2.1.2/bootstraplauncher-2.1.2.jar',
      { rules: [{ action: 'allow', os: { name: 'windows' } }], value: '-Dwin=true' },
      { rules: [{ action: 'allow', os: { name: 'linux' } }], value: '-Dlinux=true' },
      '--add-modules',
      'ALL-MODULE-PATH'
    ],
    game: ['--launchTarget', 'forgeclient', '--fml.neoForgeVersion', '21.1.265']
  }
}
const args = neoVirtualArgs(neoJson)
// Compare with forward slashes: the expansion embeds a native path, and the JSON
// adds '/cpw/mods/...' on top of it, so separators are mixed on Windows.
const slash = (v) => v.split(path.sep).join('/')
check(
  'expands ${library_directory}',
  args.jvm.some((a) => slash(a).includes('libraries/cpw/mods/bootstraplauncher')),
  (args.jvm || []).join(' ')
)
check('keeps plain jvm args', args.jvm.includes('--add-modules') && args.jvm.includes('ALL-MODULE-PATH'))
check('keeps game args', args.game.includes('--launchTarget') && args.game.includes('forgeclient'))
const osFiltered = args.jvm.filter((a) => a.startsWith('-Dwin=true') || a.startsWith('-Dlinux=true'))
check('applies exactly one os rule', osFiltered.length === 1, osFiltered.join(' '))
check('picks the host os rule', osFiltered[0] === (process.platform === 'win32' ? '-Dwin=true' : '-Dlinux=true'), process.platform)

console.log('vanilla library rules')
check('allow by default with no rules', libraryAllowed({ name: 'x' }) === true)
check('windows-only rule on non-windows', libraryAllowed({ name: 'x', rules: [{ action: 'allow', os: { name: 'windows' } }] }) === (process.platform === 'win32'))
const hostOs = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'
check(
  'disallow rule for the host os blocks the library',
  libraryAllowed({ name: 'x', rules: [{ action: 'disallow', os: { name: hostOs } }] }) === false
)
// Vanilla launcher semantics: when a library has rules, it is excluded unless a rule for this
// OS allows it. That is what keeps windows-only natives off linux/mac.
check(
  'rule for another os excludes the library',
  libraryAllowed({ name: 'x', rules: [{ action: 'allow', os: { name: hostOs === 'windows' ? 'linux' : 'windows' } }] }) === false
)
check('disallow anywhere in scope wins', libraryAllowed({ name: 'x', rules: [{ action: 'allow', os: { name: hostOs } }, { action: 'disallow', os: { name: hostOs } }] }) === false)
check(
  'library path is maven layout',
  slash(libraryTarget('com/example/a/1/a-1.jar')).endsWith('libraries/com/example/a/1/a-1.jar'),
  libraryTarget('com/example/a/1/a-1.jar')
)

fs.rmSync(tmp, { recursive: true, force: true })
console.log(failures ? `\n${failures} check(s) failed` : '\nall neoforge checks passed')
process.exit(failures ? 1 : 0)
