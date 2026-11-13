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

section('java version parsing (this is what decides which java is used)')
// The reported crash: JAVA_HOME/PATH held a Java 8, Vineflower needs 17+, and java
// died with UnsupportedClassVersionError (class file 61 vs 52). The decision is
// pure, so it is tested without spawning a JVM on either OS.
const exec = await import('../out-test/main/util/exec.js')
const isWin = process.platform === 'win32'

for (const [output, want, major] of [
  ['openjdk version "1.8.0_412" 2024-07-16', '1.8.0_412', 8],
  ['openjdk version "17.0.11" 2024-01-16', '17.0.11', 17],
  ['openjdk version "21.0.4" 2024-07-16 LTS', '21.0.4', 21],
  ['java version "1.7.0_80"', '1.7.0_80', 7],
  ['openjdk version "24-ea" 2025-03-18', '24-ea', 24]
]) {
  const parsed = exec.parseJavaVersionOutput(output)
  check(`parses ${want}`, parsed?.version === want && parsed?.major === major, JSON.stringify(parsed))
}
check('unparseable output yields null', exec.parseJavaVersionOutput('Error: could not find java.dll') === null)
check('empty output yields null', exec.parseJavaVersionOutput('') === null)

section('the selection rule rejects old runtimes')
const fakeMachine = (entries) => entries.map(([p, version], i) => ({ path: p, rank: i, configured: i === 0 }))
const probeMap = (map) => (path) => {
  const v = map[path]
  if (!v) return null
  if (v === 'broken') return null
  return { version: v, major: exec.majorOf(v) }
}

// The user's machine: a Java 8 wins the naive lookup, a JDK 21 is also present.
const machine = fakeMachine([
  ['C:\\Java\\jre1.8.0_51\\bin\\java.exe', '1.8.0_51'],
  ['C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.4.7-hotspot\\bin\\java.exe', '21.0.4']
])
const map = {
  'C:\\Java\\jre1.8.0_51\\bin\\java.exe': '1.8.0_51',
  'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.4.7-hotspot\\bin\\java.exe': '21.0.4'
}
const chosen = exec.selectJava(machine, probeMap(map), 17, 'the reference decompiler')
check('skips the Java 8 and picks the JDK 21', 'path' in chosen && /jdk-21/.test(chosen.path), JSON.stringify(chosen))

const onlyOld = fakeMachine([['C:\\Java\\jre1.8.0_51\\bin\\java.exe', '1.8.0_51']])
const noGood = exec.selectJava(onlyOld, probeMap(map), 17, 'the reference decompiler')
check('refuses a Java-8-only machine', 'error' in noGood, JSON.stringify(noGood))
check('the error names the requirement', /Java 17\+/.test(('error' in noGood && noGood.error) || ''), 'error' in noGood ? noGood.error : '')
check('the error lists every path tried', /Tried:/.test(('error' in noGood && noGood.error) || ''))
check('the error marks a configured path', /set in Settings/.test(('error' in noGood && noGood.error) || ''))

// 1.21.1 needs exactly 21: a Java 17 is fine for the decompiler, not for the game.
const j17Only = fakeMachine([['C:\\jdk-17\\bin\\java.exe', '17.0.11']])
check('17 is enough for the decompiler', 'path' in exec.selectJava(j17Only, probeMap({ 'C:\\jdk-17\\bin\\java.exe': '17.0.11' }), 17, 'tools'))
check('17 is not enough for the game', 'error' in exec.selectJava(j17Only, probeMap({ 'C:\\jdk-17\\bin\\java.exe': '17.0.11' }), 21, 'Minecraft 1.21.1'))

// A broken executable must not be selected, and must not stop the search.
const mixed = fakeMachine([
  ['C:\\broken\\java.exe', 'broken'],
  ['C:\\jdk-21\\bin\\java.exe', '21.0.1']
])
const afterBroken = exec.selectJava(mixed, probeMap({ 'C:\\jdk-21\\bin\\java.exe': '21.0.1' }), 21, 'Minecraft 1.21.1')
check('a broken java is skipped, not selected', 'path' in afterBroken && afterBroken.path === 'C:\\jdk-21\\bin\\java.exe', JSON.stringify(afterBroken))

check('javaw is recognised', exec.isJavaw('C:\\Java\\bin\\javaw.exe') && !exec.isJavaw('C:\\Java\\bin\\java.exe'))

section('a failing decompile reports one readable line, not a stack trace')
// Whatever the machine has installed, the contract is the same: no raw stack
// frames in the message, and the log keeps the detail.
const run = await refs.decompileJar(jarPath, path.join(tmp, 'out-any'), { javaPath: path.join(tmp, 'no-java-here', 'java') })
check('a bad javaPath is never used as-is', !/no-java-here/.test(run.error ?? ''), run.error)
check('no stack frame leaks into the message', !/\tat |UnsupportedClassVersionError/.test(run.error ?? ''), run.error)
check('a failure is either a working decompile or an explained error', run.ok === true || !!run.error, JSON.stringify({ ok: run.ok }))
check('the message is short enough to read', (run.error ?? '').length < 400, `(${(run.error ?? '').length} chars)`)

// The summary itself, tested on the exact Vineflower output that reached CI.
const storm = [
  'Exception in thread "main" java.lang.RuntimeException: could not read entry',
  '\tat org.jetbrains.java.decompiler.struct.StructContext.addSpace(StructContext.java:238)',
  '\tat org.jetbrains.java.decompiler.struct.StructContext.addSpace(StructContext.java:220)',
  '\tat org.jetbrains.java.decompiler.main.Fernflower.addSource(Fernflower.java:133)'
].join('\n')
const summary = refs.summariseDecompilerFailure(storm)
check('the exception line is kept', /RuntimeException|RuntimeError/.test(summary), summary)
check('the "Exception in thread" prefix is dropped', !/^Exception in thread/.test(summary), summary)
check('the frame count is mentioned instead of the frames', /stack frame/.test(summary) && !/\tat /.test(summary), summary)
check('an empty output still yields a message', refs.summariseDecompilerFailure('').length > 0, refs.summariseDecompilerFailure(''))

section('an UnsupportedClassVersionError becomes advice, not a stack trace')
// The user saw 14 lines of JVM stack trace. This is the exact text, and the
// translation is pure so no JVM is needed to test it.
const crashText = [
  'Exception in thread "main" java.lang.UnsupportedClassVersionError: org/jetbrains/java/decompiler/main/decompiler/ConsoleDecompiler',
  'has been compiled by a more recent version of the Java Runtime (class file version 61.0), this version of the Java Runtime only',
  'recognizes class file versions up to 52.0',
  '\tat java.lang.ClassLoader.defineClass1(Native Method)',
  '\tat java.security.SecureClassLoader.defineClass(Unknown Source)'
].join('\n')
const translated = refs.translateDecompilerError(crashText, 'C:\\Program Files\\Java\\jre1.8.0_51\\bin\\java.exe')
check('the error is translated', !!translated && /needs a newer Java/.test(translated), translated ?? 'null')
check('it names the java that was used', /jre1\.8\.0_51|java\.exe/.test(translated ?? ''), translated ?? '')
check('it names the versions, not just class-file ids', /Java 8/.test(translated ?? '') && /Java 17/.test(translated ?? ''), translated ?? '')
check('it says what to do', /Settings/.test(translated ?? '') && /JDK 17\+/.test(translated ?? ''), translated ?? '')
check('no stack trace survives the translation', !/\tat |UnsupportedClassVersionError/.test(translated ?? ''), translated ?? '')
check('unrelated failures are not translated', refs.translateDecompilerError('error: could not open jar', 'java') === null)

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
