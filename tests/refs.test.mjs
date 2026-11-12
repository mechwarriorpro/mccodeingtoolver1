/**
 * Reference-mod (decompiler) and GitHub-sign-in logic tests.
 *
 * Everything here is offline: repo-reference parsing, jar-asset selection, the
 * credential record's redaction, and the source-tree helpers that the agent and
 * the UI both depend on. The decompiler itself needs Java, so the run path is
 * only checked for its "no Java" error rather than attempted.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { check, section, finish } from './helpers.mjs'

process.on('uncaughtException', (err) => {
  const msg = `${err && err.stack ? err.stack : err}`.replace(/%/g, '%25').replace(/\r?\n/g, ' | ').slice(0, 600)
  console.log(`::error title=refs.test.mjs crash::${msg}`)
  process.exit(1)
})

const refs = await import('../out-test/main/github/references.js')
const oauth = await import('../out-test/main/github/oauth.js')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcf-refs-'))

section('parseRepoRef accepts what people paste')
for (const [input, want] of [
  ['neoforged/NeoForge', 'neoforged/NeoForge'],
  ['https://github.com/Creators-of-Create/Create', 'Creators-of-Create/Create'],
  ['https://github.com/Creators-of-Create/Create.git', 'Creators-of-Create/Create'],
  ['https://github.com/VazkiiMods/Botania/tree/1.21.x', 'VazkiiMods/Botania'],
  ['git@github.com:owner/name.git', 'owner/name']
]) {
  const got = refs.parseRepoRef(input)
  check(`parse ${input}`, got && `${got.owner}/${got.repo}` === want, `got ${JSON.stringify(got)} want ${want}`)
}
check('parse rejects a bare word', refs.parseRepoRef('not a repo') === null)
check('parse rejects an empty string', refs.parseRepoRef('') === null)

section('mod jar selection skips sources/installers')
const assets = [
  { name: 'create-1.21.1-6.0.0.jar', size: 5_000_000, url: 'u', downloads: 10 },
  { name: 'create-1.21.1-6.0.0-sources.jar', size: 4_000_000, url: 'u', downloads: 1 },
  { name: 'create-1.21.1-6.0.0-javadoc.jar', size: 3_000_000, url: 'u', downloads: 1 },
  { name: 'create-installer-1.21.1.jar', size: 9_000_000, url: 'u', downloads: 1 }
]
const picked = refs.pickModJar(assets)
check('picks the plain mod jar', picked?.name === 'create-1.21.1-6.0.0.jar', `picked ${picked?.name}`)
check('never picks -sources', !/sources/.test(picked?.name ?? ''))
check('never picks -javadoc', !/javadoc/.test(picked?.name ?? ''))
check('never picks an installer', !/installer/.test(picked?.name ?? ''))
check('returns null when there are no jars', refs.pickModJar([{ name: 'readme.txt', size: 1, url: 'u', downloads: 0 }]) === null)

section('jar metadata is read from the mods toml')
// Build a minimal jar that looks like a NeoForge mod.
const AdmZip = (await import('adm-zip')).default
const jarPath = path.join(tmp, 'demo-mod-1.0.0.jar')
const zip = new AdmZip()
zip.addFile(
  'META-INF/neoforge.mods.toml',
  Buffer.from(
    [
      'modLoader="javafml"',
      'loaderVersion="[4,)"',
      'license="MIT"',
      '[[mods]]',
      'modId="demo"',
      'version="1.0.0"',
      'displayName="Demo Mod"',
      '[[dependencies.demo]]',
      'modId="neoforge"',
      'type="required"',
      'versionRange="[21.1.0,)"',
      'ordering="NONE"',
      'side="BOTH"',
      '[[dependencies.demo]]',
      'modId="minecraft"',
      'versionRange="[1.21.1,1.21.2)"'
    ].join('\n')
  )
)
zip.addFile('com/example/Demo.class', Buffer.from([0xca, 0xfe, 0xba, 0xbe]))
zip.writeZip(jarPath)

const meta = refs.describeJar(jarPath)
check('modId parsed', meta.modId === 'demo', JSON.stringify(meta))
check('displayName parsed', meta.displayName === 'Demo Mod')
check('loader is neoforge', meta.loader === 'neoforge', meta.loader)
check('minecraft range parsed', meta.mcVersion?.includes('1.21.1'), meta.mcVersion)
check('unreadable jar does not throw', refs.describeJar(path.join(tmp, 'missing.jar')) !== null)

// Older or hand-written tomls omit the neoforge dependency block. Forge never
// supported 1.20.2+, so a javafml jar for 1.21.1 is NeoForge regardless.
const bareJar = path.join(tmp, 'bare-1.0.0.jar')
const bareZip = new AdmZip()
bareZip.addFile(
  'META-INF/neoforge.mods.toml',
  Buffer.from(['modLoader="javafml"', '[[mods]]', 'modId="bare"', 'displayName="Bare"', 'version="1.0.0"', '[[dependencies.bare]]', 'modId="minecraft"', 'versionRange="[1.21.1,1.21.2)"'].join('\n'))
)
bareZip.writeZip(bareJar)
check('javafml + MC 1.21 is inferred as neoforge', refs.describeJar(bareJar).loader === 'neoforge', JSON.stringify(refs.describeJar(bareJar)))

section('slug helpers are path-safe')
check('repoSlug separates owner and repo', refs.repoSlug('Some Owner', 'A/Repo') === 'some-owner__a-repo', refs.repoSlug('Some Owner', 'A/Repo'))
const traversal = refs.slugify('../../etc/passwd')
check('slugify strips traversal', !traversal.includes('..') && !traversal.includes('/'), traversal)
check('slugify is a single path segment', !refs.slugify('a/../b').includes('/'), refs.slugify('a/../b'))
check('slugify never returns empty', refs.slugify('***') === 'mod')
// A crafted tag must not climb out of the cache folder.
const escapeAttempt = refs.modsCacheDir('demo', '../../../etc')
check('cache dir cannot escape userData', !escapeAttempt.split(/[\\/]/).includes('..'), escapeAttempt)

section('decompile reports a missing JDK instead of crashing')
const noJava = await refs.decompileJar(jarPath, path.join(tmp, 'out'), { javaPath: '/definitely/not/java' })
// The sandbox has no JDK at all; on a dev machine this may actually decompile.
if (!(await import('../out-test/main/util/exec.js')).findJava('/definitely/not/java')) {
  check('missing JDK is a clear error', noJava.ok === false && /Java|JDK/i.test(noJava.error ?? ''), noJava.error)
} else {
  check('JDK present: decompile attempted', typeof noJava.ok === 'boolean')
}

section('java file counting')
const tree = path.join(tmp, 'tree')
fs.mkdirSync(path.join(tree, 'a', 'b'), { recursive: true })
fs.writeFileSync(path.join(tree, 'a', 'One.java'), 'class One {}')
fs.writeFileSync(path.join(tree, 'a', 'b', 'Two.java'), 'class Two {}')
fs.writeFileSync(path.join(tree, 'a', 'b', 'notes.txt'), 'x')
check('counts nested .java files only', refs.countJava(tree) === 2, String(refs.countJava(tree)))

section('stored credentials never expose the token')
const auth = { token: 'ghp_secret', login: 'octocat', scopes: ['repo'], method: 'device', savedAt: 1 }
const redacted = oauth.redactAuth(auth)
check('token is removed', !('token' in redacted))
check('login is kept', redacted.login === 'octocat')
check('connected flag set', redacted.connected === true)
check('null auth is not connected', oauth.redactAuth(null).connected === false)

section('java for the decompiler is version-checked, not just "found"')
// The reported crash: PATH/JAVA_HOME held a Java 8, Vineflower needs 17+, and
// java died with UnsupportedClassVersionError (class file 61 vs 52).
const exec = await import('../out-test/main/util/exec.js')
const isWin = process.platform === 'win32'
const stubDir = path.join(tmp, 'javas')

/**
 * A fake java that answers -version. Windows cannot execute a shebang script, so
 * the stub is a .cmd there and a shell script elsewhere; both write the same
 * `openjdk version "..."` line to stderr, which is what the probe parses.
 */
const makeJava = (name, versionLine) => {
  const dir = path.join(stubDir, name)
  fs.mkdirSync(dir, { recursive: true })
  const line = `openjdk version "${versionLine}" 2024-01-01`
  if (isWin) {
    const file = path.join(dir, 'java.cmd')
    fs.writeFileSync(file, `@echo off\r\nif "%~1"=="-version" ( echo ${line} 1>&2 )\r\nexit /b 0\r\n`)
    return file
  }
  const file = path.join(dir, 'java')
  fs.writeFileSync(file, `#!/bin/sh\nif [ "$1" = "-version" ]; then echo '${line}' >&2; fi\nexit 0\n`)
  fs.chmodSync(file, 0o755)
  return file
}

const j8 = makeJava('jdk8', '1.8.0_412')
const j17 = makeJava('jdk17', '17.0.11')
const j21 = makeJava('jdk21', '21.0.4')
const jBadDir = path.join(stubDir, 'not-java')
fs.mkdirSync(jBadDir, { recursive: true })
const jBad = path.join(jBadDir, isWin ? 'java.exe' : 'java')
fs.writeFileSync(jBad, isWin ? 'not a real executable\r\n' : 'this is not a real java\n')
if (!isWin) fs.chmodSync(jBad, 0o755)

const probe8 = exec.probeJava(j8)
check('probe reads Java 8 as major 8', probe8?.major === 8, JSON.stringify(probe8))
check('probe reads Java 17 as major 17', exec.probeJava(j17)?.major === 17, JSON.stringify(exec.probeJava(j17)))
check('probe reads Java 21 as major 21', exec.probeJava(j21)?.major === 21, JSON.stringify(exec.probeJava(j21)))
check('probe returns null for a broken java', exec.probeJava(jBad) === null, JSON.stringify(exec.probeJava(jBad)))
check('probe returns null for a missing path', exec.probeJava(path.join(stubDir, 'nope', 'java')) === null)

check('tool java accepts 17', exec.resolveToolJava(j17).path === j17, JSON.stringify(exec.resolveToolJava(j17)))
check('tool java accepts 21', exec.resolveToolJava(j21).path === j21)
check('tool java rejects Java 8 with an explanation', exec.resolveToolJava(j8).path === null, JSON.stringify(exec.resolveToolJava(j8)))
check('the rejection names the requirement', /Java 17\+/.test(exec.resolveToolJava(j8).error ?? ''), exec.resolveToolJava(j8).error)
check('the rejection lists what was tried', /Tried:/.test(exec.resolveToolJava(j8).error ?? ''))
check('game java rejects 17 (1.21.1 needs 21)', exec.resolveJava(j17).path === null, JSON.stringify(exec.resolveJava(j17)))
check('game java accepts 21', exec.resolveJava(j21).path === j21)
check('javaw is recognised', exec.isJavaw('C:\\Java\\bin\\javaw.exe') && !exec.isJavaw('C:\\Java\\bin\\java.exe'))

section('decompile refuses to run a jar it cannot load')
// With a Java 8 the decompiler must stop before spawning, not print a JVM stack trace.
const j8Run = await refs.decompileJar(jarPath, path.join(tmp, 'out-j8'), { javaPath: j8 })
check('Java 8 is refused with a clear error', j8Run.ok === false && /Java 17\+/.test(j8Run.error ?? ''), j8Run.error)
check('no JVM crash text leaks through', !/UnsupportedClassVersionError/.test(j8Run.error ?? ''), j8Run.error)

section('an UnsupportedClassVersionError becomes advice, not a stack trace')
// If a stale java slips through, translate the JVM message instead of printing
// the 14-line stack trace the user saw. The stub claims to be Java 21 (so the
// version gate passes) but then throws the class-file error a Java 8 would.
const oldDir = path.join(tmp, 'javas', 'old')
fs.mkdirSync(oldDir, { recursive: true })
const msg =
  'Exception in thread "main" java.lang.UnsupportedClassVersionError: org/jetbrains/java/decompiler/main/decompiler/ConsoleDecompiler ' +
  'has been compiled by a more recent version of the Java Runtime (class file version 61.0), this version of the Java Runtime only ' +
  'recognizes class file versions up to 52.0'
let oldJava
if (isWin) {
  oldJava = path.join(oldDir, 'java.cmd')
  fs.writeFileSync(oldJava, `@echo off\r\nif "%~1"=="-version" ( echo openjdk version "21.0.1" 2024-01-01 1>&2 & exit /b 0 )\r\necho ${msg.replace(/[&|<>]/g, '')} 1>&2\r\nexit /b 1\r\n`)
} else {
  oldJava = path.join(oldDir, 'java')
  fs.writeFileSync(oldJava, `#!/bin/sh\nif [ "$1" = "-version" ]; then echo 'openjdk version "21.0.1" 2024-01-01' >&2; exit 0; fi\nprintf '%s\\n' '${msg}' >&2\nexit 1\n`)
  fs.chmodSync(oldJava, 0o755)
}
const fakeJar = path.join(tmp, 'decompiler.jar')
fs.writeFileSync(fakeJar, 'stub')
const oldRun = await refs.decompileJar(jarPath, path.join(tmp, 'out-old'), { javaPath: oldJava, customJar: fakeJar })
check('class-file error is translated', /needs a newer Java/.test(oldRun.error ?? ''), oldRun.error)
check('the translated error names both versions', /61/.test(oldRun.error ?? '') && /17\+/.test(oldRun.error ?? ''), oldRun.error)
check('no raw stack trace in the error', !/UnsupportedClassVersionError/.test(oldRun.error ?? ''), oldRun.error)

section('store lookup is tolerant of a missing index')
// The module keeps its index under userData; with the electron stub pointing at
// .test-tmp there is nothing there yet, and that must be an empty library, not a crash.
check('listReferences() on a fresh install', Array.isArray(refs.listReferences()) && refs.listReferences().length === 0, JSON.stringify(refs.listReferences()))
check('unknown id returns null', refs.getReference('does-not-exist') === null)
check('reading an unknown reference file fails cleanly', refs.readReferenceFile('does-not-exist', 'x.java').ok === false)
check('tree of an unknown reference is empty', refs.referenceTree('does-not-exist').length === 0)
check('search with no references finds nothing', refs.searchReference('Widget').hits.length === 0)

fs.rmSync(tmp, { recursive: true, force: true })
finish('reference mods')
