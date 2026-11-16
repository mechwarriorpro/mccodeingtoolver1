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
const transfer = await import(url('mod/transfer.js'))
const AdmZip = (await import('adm-zip')).default

/**
 * A real NeoForge installer, shaped like the one on the maven.
 *
 * Written as an actual zip rather than a placeholder because the code opens it:
 * `inspectLoaderJar` decides what `bin/modpack.jar` is by looking inside, and a
 * fake file would test the fake instead of the decision.
 */
function neoforgeInstaller(version) {
  const zip = new AdmZip()
  zip.addFile('META-INF/MANIFEST.MF', Buffer.from('Manifest-Version: 1.0\r\nMain-Class: cpw.mods.bootstraplauncher.BootstrapLauncher\r\n'))
  zip.addFile('install_profile.json', Buffer.from(JSON.stringify({ spec: 1, version: `${version}`, minecraft: '1.21.1' })))
  zip.addFile('META-INF/versions.list', Buffer.from(`installer\t${version}\tnet/neoforged/installer/${version}/installer-${version}.jar\n`))
  zip.addFile(`net/neoforged/installer/${version}/installer-${version}.jar`, Buffer.from('payload'))
  return zip.toBuffer()
}

/**
 * A 1.6/1.7-era Forge *universal* jar, which is what a legacy pack's
 * `bin/modpack.jar` really is: no install_profile.json, no net/minecraftforge/,
 * but cpw/mods/fml and an FMLCorePlugin in the manifest.
 */
function legacyForgeJar(version) {
  const zip = new AdmZip()
  zip.addFile(
    'META-INF/MANIFEST.MF',
    Buffer.from(`Manifest-Version: 1.0\r\nImplementation-Version: ${version}\r\nFMLCorePlugin: cpw.mods.fml.relauncher.FMLCorePlugin\r\n`)
  )
  zip.addFile('cpw/mods/fml/relauncher/FMLCorePlugin.class', Buffer.from('x'))
  return zip.toBuffer()
}

/** A mod jar, for the cases where a mod has ended up in bin/. */
function modJar(id, version) {
  const zip = new AdmZip()
  zip.addFile('META-INF/neoforge.mods.toml', Buffer.from(`modLoader="javafml"\n[[mods]]\nmodId="${id}"\nversion="${version}"\n`))
  zip.addFile('com/example/Example.class', Buffer.from('x'))
  return zip.toBuffer()
}

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
   * The single most important rule in the whole feature: the game itself must
   * never be written. Every spelling of it, wherever someone has put it.
   */
  for (const rel of [
    'bin/client.jar',
    'bin/server.jar',
    'bin/minecraft-1.21.1.jar',
    'bin/version.json',
    'bin/runData',
    'mods/client.jar',
    'mods/minecraft-1.21.1.jar',
    'jre/bin/java.exe',
    'runtime/lib/x.dll'
  ]) {
    const c = pack.classify(rel)
    assert.equal(c.protected, true, `${rel} must be protected`)
  }
})

await check('modpack.jar is the loader and MUST be replaceable', () => {
  /*
   * This was wrong in v0.5.13 and the user caught it: in every Technic pack
   * `bin/modpack.jar` is the NeoForge installer, and it is the file Technic
   * actually launches. Protecting all of `bin/` meant a pack could have every mod
   * on 1.21.1 and still start 1.20.1 — the update changed nothing that mattered.
   */
  for (const rel of ['bin/modpack.jar', 'bin/neoforge.jar', 'bin/forge.jar', 'bin/fabric.jar', 'bin/MODPACK.JAR']) {
    const c = pack.classify(rel)
    assert.equal(c.protected, false, `${rel} is the loader and must be updatable`)
    assert.equal(c.role, 'loader-installer', `${rel} must be recognised as the loader`)
  }
})

await check('other files in bin/ are still left alone', () => {
  for (const rel of ['bin/something.class', 'bin/whatever.bin']) {
    assert.equal(pack.classify(rel).protected, true, `${rel} is not the loader`)
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
    plan.summary.some((l) => /Minecraft jar/.test(l) && /left|never|not/i.test(l)),
    'the user asked for the jar to be left alone; the plan must say that it is'
  )
})

await check('a pack whose loader jar must change says so, and plans the installer', () => {
  /*
   * The whole point. `bin/modpack.jar` holds an old NeoForge installer; the plan
   * has to propose replacing it with the target build, from the NeoForge maven,
   * and say why.
   */
  const dir = makePack({ 'mods/a.jar': 'PK', 'bin/version': '1.20.1-neoforge-20.4.1\n' })
  fs.writeFileSync(path.join(dir, 'bin/modpack.jar'), neoforgeInstaller('20.4.1'))
  const plan = planFor([], {
    dir,
    current: { mcVersion: '1.20.1', family: 'neoforge', loaderVersion: '20.4.1' },
    target: { mcVersion: '1.21.1', family: 'neoforge', loaderVersion: '21.1.80' }
  })
  assert.ok(plan.loaderJar, 'the loader jar is part of the plan')
  assert.equal(plan.loaderJar.rel, 'bin/modpack.jar')
  assert.equal(plan.loaderJar.download?.version, '21.1.80')
  assert.match(plan.loaderJar.download.url, /maven\.neoforged\.net.*21\.1\.80.*installer\.jar$/)
  assert.match(plan.loaderJar.why, /21\.1\.80/)
  assert.ok(plan.summary.some((l) => /bin\/modpack\.jar/.test(l) && /replaced/.test(l)))
})

await check('an installer already at the target version is not re-downloaded', () => {
  const dir = makePack({ 'mods/a.jar': 'PK', 'bin/version': '1.21.1-neoforge-21.1.80\n' })
  fs.writeFileSync(path.join(dir, 'bin/modpack.jar'), neoforgeInstaller('21.1.80'))
  const plan = planFor([], {
    dir,
    current: { mcVersion: '1.21.1', family: 'neoforge', loaderVersion: '21.1.80' },
    target: { mcVersion: '1.21.1', family: 'neoforge', loaderVersion: '21.1.80' }
  })
  assert.ok(!plan.loaderJar?.download, 'nothing to fetch when it is already right')
  assert.match(plan.loaderJar.why, /already/)
})

await check('a mod jar sitting in bin/ is described as what it is', () => {
  /*
   * Someone drops a mod into `bin/modpack.jar`, or a pack is assembled wrongly.
   * Technic cannot launch from a mod, and the message has to say so plainly
   * rather than calling it "not a recognised loader installer".
   */
  const dir = makePack({ 'bin/modpack.jar': modJar('create', '1.0.0') })
  const info = pack.inspectLoaderJar(path.join(dir, 'bin/modpack.jar'))
  assert.equal(info.kind, 'unknown-jar')
  assert.equal(info.looksLikeMod, true)
  assert.match(info.note, /mod jar, not a loader installer/)
})

await check('a NeoForge installer states its own version', () => {
  const dir = makePack({ 'bin/modpack.jar': neoforgeInstaller('21.1.80') })
  const info = pack.inspectLoaderJar(path.join(dir, 'bin/modpack.jar'))
  assert.equal(info.kind, 'neoforge-installer')
  assert.equal(info.version, '21.1.80')
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

/* ================================= part 2b: packs older than 1.8 */

await check('a 1.7.10 pack version is read, not reported as unknown', () => {
  /*
   * The legacy spelling is `1.7.10-Forge10.13.2.1230`: capital F and no separator.
   * The modern parser required a hyphen, so every pre-1.8 pack reported
   * `unknown` — which meant no version to compare, no loader to report, and an
   * update with nothing to work from. 1.7.10 packs are exactly the case this
   * feature exists for.
   */
  const cases = [
    ['1.7.10-Forge10.13.2.1230', '1.7.10', '10.13.2.1230'],
    ['1.7.10-Forge10.13.4.1566-1.7.10', '1.7.10', '10.13.4.1566'],
    ['1.6.4-Forge9.11.1.965', '1.6.4', '9.11.1.965'],
    ['1.6.4-forge9.11.1.964', '1.6.4', '9.11.1.964']
  ]
  for (const [line, mc, loader] of cases) {
    const dir = makePack({ 'bin/version': `${line}\n` })
    const v = pack.currentPackVersion(dir)
    assert.equal(v.mcVersion, mc, `${line} must report ${mc}`)
    assert.equal(v.family, 'forge', `${line} is Forge`)
    assert.equal(v.loaderVersion, loader, `${line} loader build`)
  }
})

await check('the modern spelling still parses, unchanged', () => {
  const modern = pack.currentPackVersion(makePack({ 'bin/version': '1.21.1-neoforge-21.1.80\n' }))
  assert.deepEqual(modern, { mcVersion: '1.21.1', family: 'neoforge', loaderVersion: '21.1.80' })
})

await check('a legacy pack with no bin/version still gives up its version', () => {
  /*
   * Old packs do not always have `bin/version`. They do ship the game's assets,
   * and the asset index is named for the version — a real answer where the file
   * is missing.
   */
  const fromAssets = makePack({ 'bin/assets/1.7.10/sounds.json': '{}', 'mods/a.jar': 'PK' })
  assert.equal(pack.currentPackVersion(fromAssets).mcVersion, '1.7.10')

  const fromVersionJson = makePack({ 'bin/version.json': JSON.stringify({ inheritsFrom: '1.6.4' }) })
  assert.equal(pack.currentPackVersion(fromVersionJson).mcVersion, '1.6.4')
})

await check('an unreadable legacy jar is reported as unknown, never guessed', () => {
  const dir = makePack({ 'mods/a.jar': 'PK' })
  const v = pack.currentPackVersion(dir)
  assert.equal(v.family, 'unknown')
  assert.equal(v.mcVersion, undefined)
})

await check('a 1.7.10 modpack.jar is recognised as the Forge loader it is', () => {
  /*
   * A legacy pack's modpack.jar is the Forge *universal* jar, not an installer.
   * It has no install_profile.json and no net/minecraftforge/; the markers are
   * cpw/mods/fml and an FMLCorePlugin in the manifest. Without recognising it,
   * the loader read as "not a recognised loader installer" with no version — and
   * it is the file Technic launches.
   */
  const dir = makePack({ 'bin/modpack.jar': legacyForgeJar('10.13.2.1230') })
  const info = pack.inspectLoaderJar(path.join(dir, 'bin/modpack.jar'))
  assert.equal(info.kind, 'forge-legacy')
  assert.equal(info.version, '10.13.2.1230', 'the manifest states it in Implementation-Version')
  assert.match(info.note, /universal jar/)
})

await check('a 1.7.10 pack copy knows its Minecraft version and loader together', () => {
  const dir = makePack({ 'bin/version': '1.7.10-Forge10.13.2.1230\n', 'mods/a.jar': 'PK' })
  const v = pack.currentPackVersion(dir)
  assert.deepEqual([v.mcVersion, v.family, v.loaderVersion], ['1.7.10', 'forge', '10.13.2.1230'])
})

await check('a 1.7.10 → 1.21.1 update is called a port, not an update', () => {
  /*
   * The jump is four loader generations. Calling it an "update" alongside the
   * plan would let someone start it expecting their world and configs to
   * survive, and they will not: the mods are different projects, the configs are
   * not compatible, and a 1.7.10 save will not load in 1.21.1.
   */
  const dir = makePack({ 'bin/version': '1.7.10-Forge10.13.2.1230\n', 'mods/a.jar': 'PK' })
  const plan = planFor([], {
    dir,
    current: { mcVersion: '1.7.10', family: 'forge', loaderVersion: '10.13.2.1230' },
    target: { mcVersion: '1.21.1', family: 'neoforge', loaderVersion: '21.1.80' }
  })
  const port = plan.summary.find((l) => /port, not an update/.test(l))
  assert.ok(port, 'the plan has to say what this really is')
  assert.match(port, /world will not open|configs do not carry over/i)
})

await check('a 1.20.1 → 1.21.1 update is NOT called a port', () => {
  // The opposite failure: crying "port" on an ordinary one-version update makes
  // the warning worthless.
  const plan = planFor([], {
    dir: makePack({ 'bin/version': '1.20.1-neoforge-20.4.1\n' }),
    current: { mcVersion: '1.20.1', family: 'neoforge', loaderVersion: '20.4.1' },
    target: { mcVersion: '1.21.1', family: 'neoforge', loaderVersion: '21.1.80' }
  })
  assert.ok(!plan.summary.some((l) => /port, not an update/.test(l)))
})

await check('a downgrade is named as one', () => {
  const plan = planFor([], {
    dir: makePack({ 'bin/version': '1.21.1-neoforge-21.1.80\n' }),
    current: { mcVersion: '1.21.1', family: 'neoforge', loaderVersion: '21.1.80' },
    target: { mcVersion: '1.20.1', family: 'neoforge', loaderVersion: '20.4.1' }
  })
  assert.ok(plan.summary.some((l) => /downgrade/i.test(l)))
})

await check('a legacy pack reports the old game files it carries, and does not delete them', () => {
  /*
   * A 1.7.10 pack ships the game itself: bin/libraries (LWJGL 2 and the old
   * Forge libs), bin/assets with a 1.7.10 index, bin/natives. A 1.21.1 launch
   * brings its own. They are dead weight at best and a conflicting classpath at
   * worst — but which of them a given launcher still needs differs, so they are
   * reported and left alone.
   */
  const dir = makePack({
    'bin/version': '1.7.10-Forge10.13.2.1230\n',
    'bin/libraries/org/lwjgl/lwjgl/lwjgl.jar': 'x'.repeat(1000),
    'bin/assets/1.7.10/sounds.json': '{}',
    'bin/natives/lwjgl.dll': 'x',
    'mods/a.jar': 'PK'
  })
  const plan = planFor([], {
    dir,
    current: { mcVersion: '1.7.10', family: 'forge', loaderVersion: '10.13.2.1230' }
  })
  const rels = plan.legacyLeftovers.map((l) => l.rel)
  assert.deepEqual(rels.sort(), ['bin/assets', 'bin/libraries', 'bin/natives'])
  assert.ok(plan.legacyLeftovers.every((l) => l.bytes > 0 || l.rel === 'bin/natives'))
  assert.ok(plan.summary.some((l) => /does not delete them/.test(l)), 'it must say they are not deleted')
})

await check('a modern pack has no leftovers to report', () => {
  // 1.20.1+ packs do not bundle the game; inventing leftovers would be noise.
  const plan = planFor([], {
    dir: makePack({ 'bin/version': '1.20.1-neoforge-20.4.1\n', 'mods/a.jar': 'PK' }),
    current: { mcVersion: '1.20.1', family: 'neoforge', loaderVersion: '20.4.1' }
  })
  assert.deepEqual(plan.legacyLeftovers, [])
})

await check('"nothing to do" and "nothing could be matched" are different sentences', () => {
  /*
   * Both used to render "Every mod ... already has a 1.21.1 build, or none could
   * be matched" — one sentence covering opposite situations. On a 1.7.10 pack the
   * user got the first reading, which says the pack is done, when in fact not one
   * mod was recognised. That is the difference between closing the window and
   * carrying on.
   */
  const allMissing = planFor(
    [
      { file: 'mods/bc.jar', path: '/p/mods/bc.jar', modId: 'buildcraft', version: '4.2.2', resolution: { found: false, incompatible: true } },
      { file: 'mods/ic2.jar', path: '/p/mods/ic2.jar', modId: 'ic2', version: '2.2.8', resolution: { found: false, incompatible: true } }
    ],
    { dir: makePack({ 'bin/version': '1.7.10-Forge10.13.2.1230\n' }) }
  )
  assert.ok(
    allMissing.summary.some((l) => /No mod could be matched/.test(l)),
    'a pack where nothing matched must say so plainly'
  )
  assert.ok(
    !allMissing.summary.some((l) => /Every mod that could be matched already has/.test(l)),
    'and must not claim they are already correct'
  )
})

await check('sizes are readable — a 200 kB folder is not "0 MB"', () => {
  assert.equal(pack.humanBytes(200000), '200 kB')
  assert.equal(pack.humanBytes(1536000), '1.5 MB')
  assert.equal(pack.humanBytes(999), '999 B')
  assert.equal(pack.humanBytes(2_400_000_000), '2.4 GB')
})

await check('a legacy pack is never given a NeoForge installer for a 1.7.10 target', () => {
  /*
   * There is no NeoForge for 1.7.10, and a Forge 1.7.10 universal jar is not
   * fetchable from the NeoForge maven. The plan must not invent a download — it
   * says the loader cannot be fetched automatically and lets the user handle it.
   */
  const dir = makePack({ 'bin/version': '1.7.10-Forge10.13.2.1230\n', 'bin/modpack.jar': legacyForgeJar('10.13.2.1230') })
  const plan = planFor([], {
    dir,
    current: { mcVersion: '1.20.1', family: 'forge', loaderVersion: '20.4.1' },
    target: { mcVersion: '1.7.10', family: 'forge', loaderVersion: '10.13.2.1230' }
  })
  assert.ok(plan.loaderJar, 'the jar is still part of the plan')
  assert.equal(plan.loaderJar.download, null, 'no automatic download for a legacy target')
})

await check('a legacy transfer compares the old loader to the new one', () => {
  // What the two-pack feature is for: a 1.7.10 Forge pack and a 1.21.1 NeoForge
  // pack differ in the loader jar, and that has to be stated rather than assumed.
  const plan = transfer.planPackTransfer({
    from: { dir: '/p/Old', label: 'Old', mcVersion: '1.7.10', family: 'forge', loaderVersion: '10.13.2.1230' },
    to: { dir: '/p/New', label: 'New', mcVersion: '1.21.1', family: 'neoforge', loaderVersion: '21.1.80' },
    sourceMods: [{ file: 'buildcraft.jar', path: '/p/Old/mods/buildcraft.jar', modId: 'buildcraft', version: '4.2.2', resolution: { found: false, incompatible: true } }],
    targetMods: [],
    loader: {
      from: { rel: 'bin/modpack.jar', present: 'a Forge 10.13.2.1230 (1.6/1.7-era) universal jar', version: '10.13.2.1230' },
      to: { rel: 'bin/modpack.jar', present: 'a NeoForge installer for 21.1.80', version: '21.1.80' }
    }
  })
  assert.equal(plan.loader.differs, true)
  assert.match(plan.loader.note, /10\.13\.2\.1230/)
  assert.match(plan.loader.note, /21\.1\.80/)
  assert.equal(plan.entries[0].status, 'incompatible', 'BuildCraft 1.7.10 cannot run on 1.21.1')
  assert.equal(plan.entries[0].selected, false)
})

/* ============================================ part 3: moving between packs */

const twoPacks = (opts = {}) => ({
  from: { dir: '/p/Source', label: 'Source', mcVersion: '1.20.1', family: 'neoforge', loaderVersion: '20.4.1' },
  to: { dir: '/p/Target', label: 'Target', mcVersion: '1.21.1', family: 'neoforge', loaderVersion: '21.1.80' },
  sourceMods: opts.sourceMods ?? [],
  targetMods: opts.targetMods ?? [],
  loader: opts.loader ?? {
    from: { rel: 'bin/modpack.jar', present: 'a NeoForge installer for 20.4.1', version: '20.4.1' },
    to: { rel: 'bin/modpack.jar', present: 'a NeoForge installer for 21.1.80', version: '21.1.80' }
  }
})

await check('a mod the target does not have is copied, and is selected', () => {
  const plan = transfer.planPackTransfer(twoPacks({
    sourceMods: [{ file: 'create-0.5.jar', path: '/p/Source/mods/create-0.5.jar', modId: 'create', name: 'Create', version: '0.5' }]
  }))
  const e = plan.entries[0]
  assert.equal(e.status, 'copy')
  assert.equal(e.selected, true)
  assert.equal(plan.counts.copy, 1)
})

await check('the same mod at the same version is not copied again', () => {
  /*
   * The failure this prevents: dragging a jar into a pack that already has it,
   * ending up with two copies, and the launcher refusing to start with a
   * duplicate-mod error that names neither file.
   */
  const plan = transfer.planPackTransfer(twoPacks({
    sourceMods: [{ file: 'create-0.5.jar', path: '/p/Source/mods/create-0.5.jar', modId: 'create', version: '0.5' }],
    targetMods: [{ file: 'create-0.5.jar', path: '/p/Target/mods/create-0.5.jar', modId: 'create', version: '0.5' }]
  }))
  const e = plan.entries[0]
  assert.equal(e.status, 'same')
  assert.equal(e.selected, false, 'there is nothing to gain from copying it')
})

await check('an older copy in the target is replaced, not duplicated', () => {
  const plan = transfer.planPackTransfer(twoPacks({
    sourceMods: [{ file: 'create-0.6.jar', path: '/p/Source/mods/create-0.6.jar', modId: 'create', version: '0.6' }],
    targetMods: [{ file: 'create-0.5.jar', path: '/p/Target/mods/create-0.5.jar', modId: 'create', version: '0.5' }]
  }))
  const e = plan.entries[0]
  assert.equal(e.status, 'upgrade')
  assert.equal(e.replaces, 'create-0.5.jar', 'the copy it displaces is named, so it can be removed, not left alongside')
  assert.equal(e.selected, true)
})

await check('a newer copy already in the target is kept', () => {
  /*
   * Carrying an old pack forward must not downgrade what is already there. This
   * is the mistake that makes "bring my mods across" quietly undo a previous
   * update.
   */
  const plan = transfer.planPackTransfer(twoPacks({
    sourceMods: [{ file: 'create-0.5.jar', path: '/p/Source/mods/create-0.5.jar', modId: 'create', version: '0.5' }],
    targetMods: [{ file: 'create-0.9.jar', path: '/p/Target/mods/create-0.9.jar', modId: 'create', version: '0.9' }]
  }))
  const e = plan.entries[0]
  assert.equal(e.status, 'newer-there')
  assert.equal(e.selected, false)
  assert.match(e.reason, /keeps the newer one/)
})

await check('version comparison is numeric, so 1.9 does not beat 1.10', () => {
  // A string compare would call 1.9 newer than 1.10 and skip a real upgrade.
  const plan = transfer.planPackTransfer(twoPacks({
    sourceMods: [{ file: 'm-1.10.jar', path: '/p/Source/mods/m-1.10.jar', modId: 'm', version: '1.10' }],
    targetMods: [{ file: 'm-1.9.jar', path: '/p/Target/mods/m-1.9.jar', modId: 'm', version: '1.9' }]
  }))
  assert.equal(plan.entries[0].status, 'upgrade')
})

await check('a mod with no build for the TARGET version is not moved', () => {
  /*
   * The check has to be against the target's Minecraft and loader version, not
   * the source's — the mod is going to run in the target. Using the source's
   * version would call everything fine and the target would not launch.
   */
  const plan = transfer.planPackTransfer(twoPacks({
    sourceMods: [{
      file: 'old-1.0.jar',
      path: '/p/Source/mods/old-1.0.jar',
      modId: 'oldmod',
      version: '1.0',
      resolution: { found: false, incompatible: true }
    }]
  }))
  const e = plan.entries[0]
  assert.equal(e.status, 'incompatible')
  assert.equal(e.selected, false, 'moving it would break the target pack')
  assert.match(e.reason, /1\.21\.1/, 'the reason names the version it cannot run on')
  assert.equal(plan.counts.incompatible, 1)
})

await check('an unidentifiable jar is listed but never moved', () => {
  const plan = transfer.planPackTransfer(twoPacks({
    sourceMods: [{ file: 'mystery.jar', path: '/p/Source/mods/mystery.jar' }]
  }))
  assert.equal(plan.entries[0].status, 'unidentified')
  assert.equal(plan.entries[0].selected, false)
})

await check('the two packs loader versions are compared, not just both shown', () => {
  /*
   * Both packs launch from bin/modpack.jar — normally a NeoForge installer — and
   * nothing in Windows tells you one is 20.4.1 and the other 21.1.80 until the
   * game starts. That comparison is the reason to look at two packs together.
   */
  const plan = transfer.planPackTransfer(twoPacks())
  assert.equal(plan.loader.differs, true)
  assert.match(plan.loader.note, /20\.4\.1/)
  assert.match(plan.loader.note, /21\.1\.80/)
  assert.match(plan.loader.note, /keeps its own loader/, 'the target is not silently moved to the source loader')
})

await check('two packs on the same loader say so rather than claiming a difference', () => {
  const plan = transfer.planPackTransfer(twoPacks({
    loader: {
      from: { rel: 'bin/modpack.jar', present: 'a NeoForge installer for 21.1.80', version: '21.1.80' },
      to: { rel: 'bin/modpack.jar', present: 'a NeoForge installer for 21.1.80', version: '21.1.80' }
    }
  }))
  assert.equal(plan.loader.differs, false)
  assert.match(plan.loader.note, /nothing has to change/)
})

await check('a loader version that cannot be read is not invented', () => {
  const plan = transfer.planPackTransfer(twoPacks({
    loader: {
      from: { rel: 'bin/modpack.jar', present: 'not a recognised loader installer', version: undefined },
      to: { rel: 'bin/modpack.jar', present: 'a NeoForge installer for 21.1.80', version: '21.1.80' }
    }
  }))
  assert.equal(plan.loader.differs, false, 'an unknown version must not be reported as a difference')
  assert.match(plan.loader.note, /cannot be compared/)
})

await check('every decision is made against the target version, not the source', () => {
  /*
   * This is the mistake the whole feature exists to prevent, so it is checked in
   * the source and not only in the pure function: resolving against the source's
   * version would approve every jar and then fail on launch in the target.
   */
  const main = read('src/main/ipc/index.ts')
  const block = main.slice(main.indexOf("'pack:compare'"), main.indexOf("'pack:transfer'"))
  assert.match(block, /const toVersion = currentPackVersion\(toDir\)/, 'the target is what mods are resolved against')
  assert.doesNotMatch(block, /const toVersion = currentPackVersion\(fromDir\)/, 'the source version would approve jars the target cannot run')
  assert.match(block, /newestVersionFor\(projectId, \{ mcVersion: toVersion\.mcVersion/, 'and the network lookup uses it too')
})

await check('the plan says the source pack is only read', () => {
  const plan = transfer.planPackTransfer(twoPacks())
  assert.ok(
    plan.summary.some((l) => /source pack is read/i.test(l)),
    'a feature that writes into one pack and reads another has to be explicit about which is which'
  )
})

await check('an installer version can be read from its file name when the jar cannot', () => {
  /*
   * Forge names two versions in one file name and the loader is the *second* —
   * reporting 1.20.1 as the loader build would call a pack up to date when it is
   * two loader generations behind.
   */
  assert.equal(transfer.versionFromInstallerName('neoforge-21.1.80-installer.jar'), '21.1.80')
  assert.equal(transfer.versionFromInstallerName('forge-1.20.1-47.2.0-installer.jar'), '47.2.0')
  assert.equal(transfer.versionFromInstallerName('neoforge-21.1.80-beta-installer.jar'), '21.1.80-beta')
  assert.equal(transfer.versionFromInstallerName('modpack.jar'), undefined)
  assert.equal(transfer.versionFromInstallerName('mystery.jar'), undefined)
})

await check('a download is not accepted as an installer unless it really is one', () => {
  /*
   * The maven returns an HTML page with a 200 often enough to matter. Putting that
   * into bin/modpack.jar is a pack that will not start, and the launcher's error
   * says nothing about why.
   */
  const html = Buffer.from('<!DOCTYPE html><html><body>404</body></html>')
  assert.equal(pack.verifyLoaderInstaller(html, { family: 'neoforge', loaderVersion: '21.1.80' }).ok, false)

  // A valid zip that is not a NeoForge installer — e.g. a mod — is refused too.
  const wrong = (() => {
    const zip = new AdmZip()
    zip.addFile('mods.toml', Buffer.from('x'))
    return zip.toBuffer()
  })()
  const res = pack.verifyLoaderInstaller(wrong, { family: 'neoforge', loaderVersion: '21.1.80' })
  assert.equal(res.ok, false)
  assert.match(res.error, /not a NeoForge installer/)

  // The real thing passes, and its version is confirmed.
  const good = pack.verifyLoaderInstaller(neoforgeInstaller('21.1.80'), { family: 'neoforge', loaderVersion: '21.1.80' })
  assert.equal(good.ok, true)
  assert.equal(good.version, '21.1.80')
})

await check('an installer for the wrong version is not silently accepted', () => {
  // Right shape, wrong build: it would start a different loader than the plan says.
  const res = pack.verifyLoaderInstaller(neoforgeInstaller('20.4.1'), { family: 'neoforge', loaderVersion: '21.1.80' })
  assert.equal(res.ok, true, 'the payload is a real installer')
  assert.notEqual(res.version, '21.1.80', 'and it must not claim to be the version asked for')
})

await check('the whole-pack update stages and verifies the loader before touching the pack', () => {
  /*
   * Order is the safety property: if the loader cannot be obtained, the mods must
   * not have been swapped yet. Mods on 1.21.1 with a 1.20.1 modpack.jar left in
   * bin/ is a pack that does not launch.
   */
  const main = read('src/main/ipc/index.ts')
  const block = main.slice(main.indexOf("'pack:applyWhole'"))
  const stage = block.indexOf('stagedLoader')
  const backup = block.indexOf('const backup = backUp(')
  const swap = block.indexOf('// 3. Swap the mods in.')
  assert.ok(stage > 0 && backup > 0 && swap > 0)
  assert.ok(stage < backup, 'the loader is fetched and verified before the backup is even made')
  assert.ok(backup < swap, 'and the backup is made before any jar is replaced')
  assert.match(block, /aborted: true/, 'a failed loader download must abort with the pack untouched')
})

await check('the transfer only ever writes into the target pack', () => {
  const main = read('src/main/ipc/index.ts')
  const block = main.slice(main.indexOf("'pack:transfer'"))
  const body = block.slice(0, block.indexOf("'pack:',") > 0 ? block.indexOf("'pack:',") : block.length)
  assert.ok(!/fs\.(writeFileSync|renameSync|copyFileSync)\([^)]*\bplan\.from\.dir/.test(body), 'the source must never be written to')
  assert.match(body, /const dest = path\.join\(toDir, 'mods'/, 'every write is rooted in the target')
})

await check('the transfer refuses a source file that is not a jar', () => {
  const main = read('src/main/ipc/index.ts')
  assert.match(main, /the source file is not a jar/, 'a truncated or HTML file must not be copied into mods/')
})

await check('both comparison and transfer are wired through preload and the api', () => {
  const preload = read('src/preload/index.ts')
  const api = read('src/renderer/src/lib/api.ts')
  const panel = read('src/renderer/src/components/PackPanel.tsx')
  assert.match(preload, /compare: \(opts: \{ from: string; to: string \}\) => ipcRenderer\.invoke\('pack:compare'/)
  assert.match(preload, /transfer: \(opts: \{ plan: unknown; selected: string\[\] \}\) => ipcRenderer\.invoke\('pack:transfer'/)
  assert.match(api, /compare: \(opts: \{ from: string; to: string \}\)/)
  assert.match(api, /export interface PackTransferPlan/)
  assert.match(panel, /<PackTransfer/, 'and the panel has to show it')
})

await check('the transfer panel states which pack is written to', () => {
  const comp = read('src/renderer/src/components/PackTransfer.tsx')
  assert.match(comp, /Only the target pack is written to/)
  assert.match(comp, /source pack is only read/i)
})

await check('the renderer and main agree on the transfer statuses', () => {
  const api = read('src/renderer/src/lib/api.ts')
  const mod = read('src/main/mod/transfer.ts')
  for (const status of ['copy', 'upgrade', 'same', 'newer-there', 'incompatible', 'unidentified']) {
    assert.ok(api.includes(`'${status}'`), `api.ts must know ${status}`)
    assert.ok(mod.includes(`'${status}'`), `transfer.ts must produce ${status}`)
  }
})

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
