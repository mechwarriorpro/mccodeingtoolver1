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
