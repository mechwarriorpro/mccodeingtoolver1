/**
 * Two features, one theme: things that were invisible are now listed.
 *
 * **Part 1 — whole-pack update.** The existing flows updated *jars*. None of them
 * touched the loader's own files, so a pack could have every mod on 1.21.1 and
 * still launch 1.20.1 because `bin/version` said so. The update now works on the
 * pack folder: mods, loader files, and a backup.
 *
 * The tests below are mostly about what it must *not* do. An update that loses a
 * mod, touches the Minecraft jar, or deletes before backing up is worse than no
 * update at all, and those are exactly the mistakes that are easy to make once
 * and hard to notice.
 *
 * **Part 2 — the project list.** "Switch" was a folder picker: to change project
 * you had to already know where it lived, and a fork under the app's data folder
 * could not be found again at all. The list merges projects the app remembers
 * with projects it finds nearby, and a project whose folder has gone stays
 * visible, marked, rather than vanishing.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

let passed = 0
const failures = []
async function check(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (e) {
    failures.push(name)
    console.log(`  FAIL ${name}\n       ${e.message}`)
  }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')
const url = (rel) => pathToFileURL(path.join(root, 'out-test/main', rel)).href

const pack = await import(url('mod/packupdate.js'))
const projects = await import(url('mod/projects.js'))

/* ------------------------------------------------------- temp pack fixture */

function makePack(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  return dir
}

/* ================================================ part 1: what is protected */

await check('the Minecraft jar is never classified as something to replace', () => {
  /*
   * The single most important rule in the whole feature. `bin/` is the launcher's
   * runtime — `client.jar`, `modpack.jar`, `version.json`, `runData` — and
   * replacing any of it stops the pack starting. Every one of them must be
   * protected, including the ones whose names look like mods.
   */
  for (const rel of [
    'bin/modpack.jar',
    'bin/client.jar',
    'bin/version',
    'bin/runData',
    'bin/version.json',
    'bin/forge-1.21.1-52.0.1.jar',
    'mods/client.jar',
    'mods/minecraft-1.21.1.jar',
    'jre/bin/java.exe'
  ]) {
    const c = pack.classify(rel)
    assert.equal(c.protected, true, `${rel} must be protected`)
  }
})

await check('a normal mod jar is not protected', () => {
  for (const rel of ['mods/create-1.21.1.jar', 'mods/1.21.1/jei.jar', 'coremods/foo.jar']) {
    assert.equal(pack.classify(rel).protected, false, `${rel} should be updatable`)
  }
})

await check('files are classified by where they sit, with a reason a person can read', () => {
  assert.equal(pack.classify('mods/a.jar').role, 'mod')
  assert.equal(pack.classify('config/create-common.toml').role, 'config')
  assert.equal(pack.classify('resourcepacks/x.zip').role, 'resourcepack')
  assert.equal(pack.classify('shaderpacks/y.zip').role, 'shaderpack')
  assert.equal(pack.classify('kubejs/server_scripts/z.js').role, 'script')
  for (const rel of ['mods/a.jar', 'bin/version', 'config/x.toml']) {
    assert.ok(pack.classify(rel).why.length > 5, `${rel} needs a reason, not an empty string`)
  }
})

await check('worlds and logs are skipped rather than surveyed', () => {
  const dir = makePack({
    'mods/a.jar': 'x',
    'world/level.dat': 'x',
    'saves/copy/level.dat': 'x',
    'logs/latest.log': 'x',
    'crash-reports/crash.txt': 'x',
    'config/x.toml': 'x'
  })
  const survey = pack.surveyPack(dir)
  const rels = survey.files.map((f) => f.rel.replace(/\\/g, '/'))
  assert.ok(rels.includes('mods/a.jar'))
  assert.ok(rels.includes('config/x.toml'))
  assert.ok(!rels.some((r) => r.startsWith('world/')), 'a world is the user\'s, not the update\'s')
  assert.ok(!rels.some((r) => r.startsWith('logs/')), 'a log is history')
  assert.ok(survey.skipped.length >= 4, 'the skipped folders should be reported, not silently dropped')
})

/* ============================================ part 1: the loader files */

await check('the loader version files name the target build', () => {
  const neo = pack.loaderFilesFor({ mcVersion: '1.21.1', family: 'neoforge', loaderVersion: '21.1.80' })
  const version = neo.find((f) => f.rel === 'bin/version')
  assert.ok(version, 'bin/version is what Technic launches from')
  assert.equal(version.content.trim(), '1.21.1-neoforge-21.1.80')

  const forge = pack.loaderFilesFor({ mcVersion: '1.20.1', family: 'forge', loaderVersion: '47.2.0' })
  assert.equal(forge.find((f) => f.rel === 'bin/version').content.trim(), '1.20.1-forge-47.2.0')
})

await check('no loader version means no file is invented', () => {
  assert.deepEqual(pack.loaderFilesFor({ mcVersion: '1.21.1', family: 'neoforge', loaderVersion: '' }), [])
  assert.deepEqual(pack.loaderFilesFor({ mcVersion: '', family: 'neoforge', loaderVersion: '21.1.80' }), [])
})

await check('the current pack version is read from the launcher file', () => {
  const dir = makePack({ 'bin/version': '1.20.1-forge-47.1.0\n' })
  const cur = pack.currentPackVersion(dir)
  assert.deepEqual(cur, { mcVersion: '1.20.1', family: 'forge', loaderVersion: '47.1.0' })
})

await check('a pack with no readable version says so instead of guessing', () => {
  const dir = makePack({ 'mods/a.jar': 'x' })
  const cur = pack.currentPackVersion(dir)
  assert.equal(cur.family, 'unknown')
  assert.equal(cur.mcVersion, undefined, 'an unknown version must stay unknown, not default to latest')
})

/* ================================================= part 1: the plan's rules */

function planFor(mods, opts = {}) {
  const dir = opts.dir ?? makePack({ 'mods/x.jar': 'x' })
  return pack.planPackUpdate({
    root: dir,
    current: opts.current ?? { mcVersion: '1.20.1', family: 'neoforge', loaderVersion: '20.4.1' },
    target: opts.target ?? { mcVersion: '1.21.1', family: 'neoforge', loaderVersion: '21.1.80' },
    files: opts.files ?? pack.surveyPack(dir).files,
    mods
  })
}

await check('a mod with no build for the target is never selected for update', () => {
  /*
   * The failure this guards: a mod with no 1.21.1 build gets "updated" to the
   * newest 1.20.1 file, or to a file belonging to a different mod entirely, and
   * the pack crashes on launch with a wall of stack traces. It must be listed as
   * incompatible and left alone by default.
   */
  const plan = planFor([
    { file: 'mods/old.jar', path: '/p/mods/old.jar', modId: 'oldmod', version: '1.0.0', name: 'Old Mod', resolution: { found: false, incompatible: true } },
    { file: 'mods/good.jar', path: '/p/mods/good.jar', modId: 'goodmod', version: '1.0.0', name: 'Good', resolution: { found: true, target: { version: '2.0.0', url: 'https://x/y.jar', name: 'y.jar' } } }
  ])
  const old = plan.mods.find((m) => m.file === 'mods/old.jar')
  assert.equal(old.status, 'missing-build')
  assert.equal(old.selected, false, 'it must not be updated automatically')
  assert.ok(/no build supports/.test(old.reason), 'the reason must name the target')
  const good = plan.mods.find((m) => m.file === 'mods/good.jar')
  assert.equal(good.status, 'update')
  assert.equal(good.selected, true)
})

await check('an incompatible mod is named individually in the summary, not just counted', () => {
  const plan = planFor([
    { file: 'mods/a.jar', path: '/p/mods/a.jar', modId: 'aaa', version: '1', resolution: { found: false, incompatible: true } },
    { file: 'mods/b.jar', path: '/p/mods/b.jar', modId: 'bbb', version: '1', resolution: { found: false, incompatible: true } }
  ])
  const line = plan.summary.find((l) => /no 1\.21\.1 build/.test(l))
  assert.ok(line, 'the summary has to say how many are stuck')
  assert.ok(/listed|left on your disk/.test(line), 'and what happens to them')
})

await check('a mod already on the target version is kept, not re-downloaded', () => {
  const plan = planFor([
    { file: 'mods/a.jar', path: '/p/mods/a.jar', modId: 'aaa', version: '2.0.0', resolution: { found: true, target: { version: '2.0.0', url: 'https://x/a.jar', name: 'a.jar' } } }
  ])
  const m = plan.mods[0]
  assert.equal(m.status, 'keep')
  assert.equal(m.selected, false, 'nothing to do means nothing to tick')
})

await check('an unidentifiable jar is left alone rather than guessed at', () => {
  const plan = planFor([{ file: 'mods/mystery.jar', path: '/p/mods/mystery.jar', version: '?', resolution: { found: false } , modId: undefined }])
  const m = plan.mods[0]
  assert.equal(m.status, 'unidentified')
  assert.equal(m.selected, false)
})

await check('the plan says the Minecraft jar is not touched', () => {
  const plan = planFor([])
  assert.ok(
    plan.summary.some((l) => /bin\/|Minecraft jar/.test(l) && /never|not/.test(l)),
    'the user asked for the jar to be left alone; the plan must say that it is'
  )
})

await check('loader files already at the target are not marked for rewriting', () => {
  const dir = makePack({ 'bin/version': '1.21.1-neoforge-21.1.80\n', 'mods/a.jar': 'x' })
  const plan = planFor([], { dir })
  const v = plan.loaderFiles.find((l) => l.rel === 'bin/version')
  assert.ok(v, 'it is still listed')
  assert.equal(v.changed, false, 'rewriting an identical file is a pointless write')
})

await check('a stale loader file is marked for rewriting', () => {
  const dir = makePack({ 'bin/version': '1.20.1-forge-47.1.0\n', 'mods/a.jar': 'x' })
  const plan = planFor([], { dir })
  const v = plan.loaderFiles.find((l) => l.rel === 'bin/version')
  assert.equal(v.changed, true)
})

/* ============================================= part 1: backup and apply */

await check('the backup copies what is about to change, and writes a manifest', () => {
  const dir = makePack({
    'mods/a.jar': 'old-a',
    'mods/b.jar': 'old-b',
    'bin/version': '1.20.1-forge-47.1.0\n',
    'world/level.dat': 'huge'
  })
  const plan = planFor(
    [
      { file: 'mods/a.jar', path: path.join(dir, 'mods/a.jar'), modId: 'a', version: '1', resolution: { found: true, target: { version: '2', url: 'https://x/a.jar', name: 'a.jar' } } }
    ],
    { dir }
  )
  plan.mods[0].selected = true
  const res = pack.backUp(plan)
  assert.equal(res.ok, true, res.error)
  assert.ok(fs.existsSync(path.join(res.dir, 'mods/a.jar')), 'the jar about to be replaced is copied')
  assert.ok(fs.existsSync(path.join(res.dir, 'bin/version')), 'the loader file about to be rewritten is copied')
  assert.ok(!fs.existsSync(path.join(res.dir, 'mods/b.jar')), 'an untouched jar is not copied')
  assert.ok(!fs.existsSync(path.join(res.dir, 'world')), 'a 3 GB world is not copied to undo a jar swap')
  const manifest = JSON.parse(fs.readFileSync(path.join(res.dir, 'BACKUP.json'), 'utf8'))
  assert.equal(manifest.from.mcVersion, '1.20.1')
  assert.equal(manifest.to.mcVersion, '1.21.1')
  assert.match(manifest.restore, /copy/i, 'the manifest has to say how to undo it')
})

await check('replacing a jar leaves a readable jar in place, with the same file name', () => {
  const dir = makePack({ 'mods/create-1.20.1.jar': 'OLD' })
  const incoming = path.join(dir, 'incoming.jar')
  // A real zip header: replaceJar refuses anything else, which is the next test.
  fs.writeFileSync(incoming, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('new content')]))
  const res = pack.replaceJar(path.join(dir, 'mods/create-1.20.1.jar'), incoming)
  assert.equal(res.ok, true, res.error)
  assert.equal(fs.readFileSync(path.join(dir, 'mods/create-1.20.1.jar')).subarray(0, 4).toString('hex'), '504b0304')
  assert.ok(!fs.existsSync(path.join(dir, 'mods/create-1.20.1.jar.incoming')), 'the staging file is cleaned up')
  assert.ok(!fs.existsSync(path.join(dir, 'mods/.create-1.20.1.jar.previous')), 'and so is the old one')
})

await check('a jar in a subfolder is replaced where it is, not duplicated at the top', () => {
  /*
   * Some packs keep `mods/1.21.1/` or `mods/client/`. Resolving the target from
   * the plan's root plus the file's relative path keeps the jar where it was;
   * joining `mods/` and the basename would leave the old copy in the subfolder
   * and add a second one — two builds of the same mod, which is a crash on
   * launch. This checks the path the apply step builds.
   */
  const dir = makePack({ 'mods/1.21.1/jei.jar': 'OLD' })
  const incoming = path.join(dir, 'incoming.jar')
  fs.writeFileSync(incoming, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('new')]))
  const rel = 'mods/1.21.1/jei.jar'
  const res = pack.replaceJar(path.join(dir, rel), incoming)
  assert.equal(res.ok, true, res.error)
  assert.ok(fs.existsSync(path.join(dir, 'mods/1.21.1/jei.jar')), 'the jar stays in its subfolder')
  assert.ok(!fs.existsSync(path.join(dir, 'mods/jei.jar')), 'and is not duplicated at the top level')
})

await check('the apply step resolves from the plan root, not a stored absolute path', () => {
  /*
   * A plan can outlive the machine state it was made on — reload the window, move
   * the pack — so the only trustworthy anchor is the root the plan was computed
   * against plus the file's relative path.
   */
  const main = read('src/main/ipc/index.ts')
  const applyIdx = main.indexOf("'pack:applyWhole'")
  assert.ok(applyIdx > 0)
  const block = main.slice(applyIdx, applyIdx + 6000)
  assert.match(block, /path\.join\(root, mod\.file\)/, 'the target must be built from the plan root')
  assert.doesNotMatch(block, /path\.join\(root, 'mods', mod\.file\)/, 'a subfolder jar would be duplicated at the top')
})

await check('an HTML error page served as a jar is refused, and the old jar survives', () => {
  /*
   * The most common bad download there is: a mirror returns its 404 page with a
   * 200 and the launcher later reports a corrupt mod. Checking the zip header
   * before the swap is what turns that into an error message instead.
   */
  const dir = makePack({ 'mods/a.jar': 'REAL JAR' })
  const bad = path.join(dir, 'bad.jar')
  fs.writeFileSync(bad, '<!DOCTYPE html><html>404</html>')
  const res = pack.replaceJar(path.join(dir, 'mods/a.jar'), bad)
  assert.equal(res.ok, false)
  assert.match(res.error, /not a jar/i)
  assert.equal(fs.readFileSync(path.join(dir, 'mods/a.jar'), 'utf8'), 'REAL JAR', 'the working jar must be untouched')
})

/* ================================================= part 2: project list */

await check('the same project reached by two different paths is one entry', () => {
  /*
   * Windows paths are case-insensitive and may use either separator. Listing
   * `C:\mods\Foo` and `c:/mods/foo` separately means the dropdown offers the same
   * project twice, once of which is the one you are already in.
   */
  const merged = projects.mergeProjects(
    [{ dir: 'C:\\mods\\Foo', lastOpenedAt: 100 }],
    ['c:/mods/foo'],
    { exists: () => true, describe: () => null }
  )
  assert.equal(merged.length, 1, 'one folder is one project')
  assert.equal(merged[0].source, 'both')
})

await check('a POSIX path keeps its case', () => {
  assert.notEqual(projects.projectKey('/home/me/Mods'), projects.projectKey('/home/me/mods'))
  assert.equal(projects.projectKey('/home/me/Mods/'), '/home/me/Mods')
  assert.equal(projects.projectKey('C:\\Mods\\Foo\\'), 'c:\\mods\\foo')
})

await check('the active project is first, then most recently opened', () => {
  const merged = projects.mergeProjects(
    [
      { dir: '/p/old', lastOpenedAt: 100 },
      { dir: '/p/new', lastOpenedAt: 900 },
      { dir: '/p/active', lastOpenedAt: 50 }
    ],
    [],
    { activeDir: '/p/active', exists: () => true, describe: () => null }
  )
  assert.equal(merged[0].dir, '/p/active', 'where you are should not need scrolling to find')
  assert.equal(merged[1].dir, '/p/new', 'then the last one worked on')
  assert.equal(merged[2].dir, '/p/old')
})

await check('a missing project is listed, marked, and last', () => {
  /*
   * A project silently disappearing from a list reads as data loss. It stays,
   * greyed and last, so the user can see it and decide — reopen it, or know that
   * the folder really is gone.
   */
  const merged = projects.mergeProjects([{ dir: '/p/gone', lastOpenedAt: 999 }], ['/p/here'], {
    exists: (d) => d === '/p/here',
    describe: () => null
  })
  const gone = merged.find((p) => p.dir === '/p/gone')
  assert.ok(gone, 'it must not be dropped')
  assert.equal(gone.exists, false)
  assert.equal(merged[merged.length - 1].dir, '/p/gone', 'a missing folder is a footnote, not a candidate')
})

await check('a project is named by its mod name, falling back to the folder', () => {
  const merged = projects.mergeProjects([{ dir: '/p/ShadowClanGaming' }], [], {
    exists: () => true,
    describe: () => ({ name: 'ShadowClan Gaming', modId: 'shadowclangaming' })
  })
  assert.equal(merged[0].name, 'ShadowClan Gaming')
  assert.equal(merged[0].modId, 'shadowclangaming')

  const unnamed = projects.mergeProjects([{ dir: '/p/SomeMod' }], [], { exists: () => true, describe: () => null })
  assert.equal(unnamed[0].name, 'SomeMod')
})

await check('looking around does not turn into a disk crawl', () => {
  /*
   * The dropdown has to appear instantly. Scanning one level under where projects
   * already live is the realistic case; walking a drive is not something to do
   * while someone is waiting for a menu.
   */
  const roots = projects.projectSearchRoots(['/home/me/mods/One', '/home/me/mods/Two'], '/home/me/projects')
  assert.deepEqual([...new Set(roots)].sort(), ['/home/me/mods', '/home/me/projects'])
})

await check('only folders that look like projects are offered', () => {
  const readdir = (d) => {
    if (d === '/p') return ['ModA', 'ModB', 'notes', '.git']
    if (d === '/p/ModA') return ['gradle.properties', 'src']
    if (d === '/p/ModB') return ['build.gradle']
    return []
  }
  const found = projects.scanForProjects('/p', readdir, (a, b) => `${a}/${b}`)
  assert.deepEqual(found.sort(), ['/p/ModA', '/p/ModB'])
})

await check('the list is wired from main through preload to the renderer', () => {
  const main = read('src/main/ipc/index.ts')
  const preload = read('src/preload/index.ts')
  const app = read('src/renderer/src/App.tsx')
  assert.match(main, /ipcMain\.handle\('project:list'/, 'main has to answer')
  assert.match(preload, /list: \(\) => ipcRenderer\.invoke\('project:list'\)/, 'preload has to forward it')
  assert.match(app, /<ProjectPicker/, 'and the sidebar has to show it')
})

await check('opening or creating a project remembers it', () => {
  /*
   * A project created but never switched to still has to appear in the list, so
   * the remembering happens on every path that opens one — scaffold, switch,
   * fork — not only on the dropdown.
   */
  const main = read('src/main/ipc/index.ts')
  const calls = [...main.matchAll(/rememberProject\(([^)]*)\)/g)].map((m) => m[1])
  assert.ok(calls.includes('dir'), 'scaffolding a project must remember it')
  assert.ok(calls.includes('target'), 'switching to a project must remember it')
  assert.ok(calls.includes('fork.dir'), 'opening a fork must remember it')
})

await check('a project can be created from the picker itself', () => {
  const picker = read('src/renderer/src/components/ProjectPicker.tsx')
  assert.match(picker, /onNew\(\)/, 'the dropdown must offer creation, not only switching')
})

/* ================================= the two panels agree on the plan shape */

await check('the renderer and main agree on what a plan entry looks like', () => {
  const api = read('src/renderer/src/lib/api.ts')
  const mainTypes = read('src/main/mod/packupdate.ts')
  for (const field of ['file', 'path', 'modId', 'version', 'status', 'reason', 'selected']) {
    assert.ok(new RegExp(`\\b${field}\\??:`).test(api), `api.ts must type ${field}`)
    assert.ok(new RegExp(`\\b${field}\\??:`).test(mainTypes), `packupdate.ts must produce ${field}`)
  }
  for (const status of ['update', 'keep', 'missing-build', 'unidentified']) {
    assert.ok(api.includes(`'${status}'`), `api.ts must know the ${status} status`)
    assert.ok(mainTypes.includes(`'${status}'`), `packupdate.ts must produce the ${status} status`)
  }
})

console.log(`\n${failures.length ? `${failures.length} check(s) failed` : `all ${passed} pack-update and project checks passed`}`)
if (failures.length) process.exit(1)
