/**
 * Updating a mod inside a modpack's `mods/` folder.
 *
 * The rule under test, stated as the user did:
 *
 *   "i first want it to scan the provided mods folder since any mod updated will
 *    most likely have all needed dependancys in that folder"
 *
 * So the important assertion is not that the scanner works — it is that a pack
 * which already contains the dependency produces **no download**. If someone
 * reorders the logic so a download is offered first, these fail.
 *
 * The jars here are built in the test rather than checked in: a 30-byte zip with a
 * mods.toml in it is a real mod as far as every reader is concerned, and it keeps
 * the repository free of binaries.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import AdmZip from 'adm-zip'

const out = path.join(process.cwd(), 'out-test', 'main')
const load = (file) => import(pathToFileURL(path.join(out, file)).href)
const pack = await load('mod/modpack.js')

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
const section = (name) => console.log(name)

const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `mcf-pack-${label}-`))

/** A NeoForge jar whose toml declares dependencies. */
/** Write into <pack>/mods/, which is where a pack keeps its jars. */
function jarIn(dir, name, build) {
  const mods = path.join(dir, 'mods')
  fs.mkdirSync(mods, { recursive: true })
  build(path.join(mods, name))
  return dir
}

function neoJar(file, opts) {
  const zip = new AdmZip()
  const deps = (opts.depends ?? [])
    .map(
      (d) =>
        `[[dependencies.${opts.modId}]]\n` +
        `    modId="${d.id}"\n` +
        `    type="${d.type ?? 'required'}"\n` +
        (d.range ? `    versionRange="${d.range}"\n` : '') +
        `    ordering="NONE"\n    side="BOTH"\n`
    )
    .join('\n')
  zip.addFile(
    'META-INF/neoforge.mods.toml',
    Buffer.from(
      `modLoader="javafml"\nloaderVersion="[4,)"\nlicense="MIT"\n[[mods]]\nmodId="${opts.modId}"\nversion="${opts.version ?? '1.0.0'}"\ndisplayName="${opts.name ?? opts.modId}"\n\n${deps}`,
      'utf8'
    )
  )
  zip.addFile('META-INF/MANIFEST.MF', Buffer.from('Manifest-Version: 1.0\n', 'utf8'))
  zip.writeZip(file)
}

function fabricJar(file, opts) {
  const zip = new AdmZip()
  zip.addFile(
    'fabric.mod.json',
    Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        id: opts.modId,
        name: opts.name ?? opts.modId,
        version: opts.version ?? '1.0.0',
        depends: opts.depends ?? {}
      }),
      null,
      2
    )
  )
  zip.writeZip(file)
}

/* ------------------------------------------------------------------- version math */

section('version ranges decide "already provided" instead of guessing')
check('a maven range admits what is inside it', () => {
  // "1.20.1-47.2.0" is a Forge/mod version whose first two parts are the game
  // version, and 1.20.1 is the inclusive lower bound.
  assert.equal(pack.satisfiesRange('1.20.1-47.2.0', '[1.20.1,1.21)'), true)
  assert.equal(pack.satisfiesRange('47.2.0', '[47.0.0,48)'), true)
  assert.equal(pack.satisfiesRange('1.19.2-43.0.0', '[1.20.1,1.21)'), false)
})
check('the upper bound is exclusive when the bracket says so', () => {
  assert.equal(pack.satisfiesRange('1.21.0', '[1.20.1,1.21)'), false)
  assert.equal(pack.satisfiesRange('1.21.0', '[1.20.1,1.21]'), true)
})
check('an open-ended range has no ceiling', () => {
  assert.equal(pack.satisfiesRange('99.0.0', '[1.20.1,)'), true)
})
check('a prefix range matches its own subtree only', () => {
  assert.equal(pack.satisfiesRange('1.20.1', '1.20'), true)
  assert.equal(pack.satisfiesRange('1.21.1', '1.20'), false)
  assert.equal(pack.satisfiesRange('1.20.4', '1.20.x'), true)
})
check('an either/or range admits both sides', () => {
  assert.equal(pack.satisfiesRange('1.20.1', '[1.19,1.20] || [1.20.1,1.21)'), true)
})
check('comparison ranges are read as comparisons', () => {
  // Fabric metadata writes these constantly. Falling through to the prefix rule
  // would read "<1.22 >1.20" as the version 1.22.1.20 and answer wrongly.
  assert.equal(pack.satisfiesRange('1.21.1', '>=1.21 <1.22'), true)
  assert.equal(pack.satisfiesRange('1.22.0', '>=1.21 <1.22'), false)
  assert.equal(pack.satisfiesRange('1.20.9', '>=1.21'), false)
  assert.equal(pack.satisfiesRange('1.21.1', '>=1.21-'), true, 'a trailing dash is not a version')
  assert.equal(pack.satisfiesRange('1.21.4', '^1.20.1'), true)
  assert.equal(pack.satisfiesRange('2.0.0', '^1.20.1'), false)
  assert.equal(pack.satisfiesRange('1.20.9', '~1.20.1'), true)
  assert.equal(pack.satisfiesRange('1.21.0', '~1.20.1'), false)
})
check('an unparsable range never invents a mismatch', () => {
  // A pack that already runs is evidence enough; a false alarm here would send
  // the user chasing a dependency that is fine.
  assert.equal(pack.satisfiesRange(undefined, '[1,2)'), true)
  assert.equal(pack.satisfiesRange('1.0.0', undefined), true)
  assert.equal(pack.satisfiesRange('1.0.0', ''), true)
})
check('version parts compare numerically, not as strings', () => {
  assert.equal(pack.satisfiesRange('1.20.10', '[1.20.9,)'), true)
})

/* -------------------------------------------------------------------- reading jars */

section('a jar is read the way the loader reads it')
const work = tmp('one')
const createJar = path.join(work, 'create-1.21.1.jar')
neoJar(createJar, {
  modId: 'create',
  version: '6.0.0',
  name: 'Create',
  depends: [
    { id: 'minecraft', range: '[1.21.1,1.22)' },
    { id: 'neoforge', range: '[21.1,)' },
    { id: 'flywheel', range: '[1.0,2.0)' }
  ]
})
const read = pack.readModJar(createJar)
check('the mod id comes from the toml', () => {
  assert.equal(read.modId, 'create')
  assert.equal(read.version, '6.0.0')
  assert.equal(read.loader, 'neoforge')
})
check('every declared dependency is kept', () => {
  assert.equal(read.depends.length, 3)
})
check('the game and loader are marked as such', () => {
  const mc = read.depends.find((d) => d.modId === 'minecraft')
  assert.ok(mc.isLoaderOrGame, 'minecraft is not a download')
  assert.ok(read.depends.find((d) => d.modId === 'neoforge').isLoaderOrGame)
})
check('a real mod dependency is not marked as the game', () => {
  assert.equal(read.depends.find((d) => d.modId === 'flywheel').isLoaderOrGame, false)
})
check('the version range is captured', () => {
  assert.equal(read.depends.find((d) => d.modId === 'flywheel').versionRange, '[1.0,2.0)')
})

section('an optional dependency is not work')
const optionalJar = path.join(work, 'optional.jar')
neoJar(optionalJar, {
  modId: 'thing',
  depends: [{ id: 'jei', range: '[1,)', type: 'optional' }]
})
check('optional is recorded as optional, not required', () => {
  const m = pack.readModJar(optionalJar)
  assert.equal(m.depends[0].kind, 'optional')
})
check('a pack with only an optional dependency missing reports none', () => {
  const dir = tmp('opt')
  fs.copyFileSync(optionalJar, path.join(dir, 'thing.jar'))
  const scan = pack.scanModsFolder(dir)
  assert.deepEqual(scan.missing, [])
})

section('a fabric jar is read from its metadata')
const fabricDir = tmp('fabric')
fabricJar(path.join(fabricDir, 'sodium.jar'), { modId: 'sodium', version: '0.6.0', depends: { minecraft: '>=1.21', fabricloader: '>=0.15' } })
const fabricMod = pack.readModJar(path.join(fabricDir, 'sodium.jar'))
check('the id and version are read', () => {
  assert.equal(fabricMod.modId, 'sodium')
  assert.equal(fabricMod.version, '0.6.0')
  assert.equal(fabricMod.loader, 'fabric')
})
check('a fabric loader dependency is not a download', () => {
  assert.ok(fabricMod.depends.find((d) => d.modId === 'fabricloader').isLoaderOrGame)
})

section('a folder holds things that are not readable mods')
const messy = tmp('messy')
fs.writeFileSync(path.join(messy, 'notes.txt'), 'hello')
fs.writeFileSync(path.join(messy, 'not-a-mod.jar'), 'this is not a zip')
neoJar(path.join(messy, 'create.jar'), { modId: 'create', version: '6.0.0' })
const messyScan = pack.scanModsFolder(messy)
check('a text file is ignored, not treated as a mod', () => {
  assert.ok(messyScan.ignored.includes('notes.txt'))
})
check('a broken jar does not abort the scan', () => {
  assert.equal(messyScan.mods.length, 1)
  assert.equal(messyScan.mods[0].modId, 'create')
})
check('a broken jar is named as a jar, not written off as junk', () => {
  assert.deepEqual(messyScan.unreadableJars, ['not-a-mod.jar'])
  assert.doesNotMatch(messyScan.ignored.join(' '), /not-a-mod\.jar/, 'a jar must not be filed as a non-mod file')
})

/* ----------------------------------------------------------- THE RULE UNDER TEST */

section('a dependency already in the folder is never a download')
const complete = tmp('complete')
jarIn(complete, 'create.jar', (f) => neoJar(f, {
  modId: 'create',
  version: '6.0.0',
  depends: [
    { id: 'flywheel', range: '[1.0,2.0)' },
    { id: 'ponder', range: '[1.0,)' }
  ]
}))
jarIn(complete, 'flywheel.jar', (f) => neoJar(f, { modId: 'flywheel', version: '1.0.4', depends: [{ id: 'minecraft', range: '[1.21.1,1.22)' }] }))
jarIn(complete, 'ponder.jar', (f) => neoJar(f, { modId: 'ponder', version: '1.0.3' }))
const completeScan = pack.scanModsFolder(complete)
check('the scan finds the dependencies satisfied', () => {
  assert.deepEqual(completeScan.missing, [], 'a working pack has nothing missing')
})
check('no download is proposed for a complete folder', () => {
  const plan = pack.planUpdate(completeScan, { modId: 'create' })
  assert.equal(plan.toDownload.length, 0, `toDownload should be empty, got ${JSON.stringify(plan.toDownload.map((d) => d.modId))}`)
})
check('every dependency is reported as already present', () => {
  const plan = pack.planUpdate(completeScan, { modId: 'create' })
  assert.equal(plan.dependencies.length, 2)
  assert.ok(plan.dependencies.every((d) => d.outcome === 'already-present'))
})
check('the summary says nothing needs downloading', () => {
  const plan = pack.planUpdate(completeScan, { modId: 'create' })
  assert.match(plan.summary, /nothing to download/i)
})
check('it names the file that provides each one', () => {
  const plan = pack.planUpdate(completeScan, { modId: 'create' })
  const fw = plan.dependencies.find((d) => d.modId === 'flywheel')
  assert.equal(fw.providedBy, 'flywheel.jar')
  assert.equal(fw.haveVersion, '1.0.4')
})

section('a dependency that is genuinely absent is the only download')
const partial = tmp('partial')
jarIn(partial, 'create.jar', (f) => neoJar(f, {
  modId: 'create',
  version: '6.0.0',
  depends: [
    { id: 'flywheel', range: '[1.0,2.0)' },
    { id: 'ponder', range: '[1.0,)' }
  ]
}))
jarIn(partial, 'flywheel.jar', (f) => neoJar(f, { modId: 'flywheel', version: '1.0.4' }))
const partialScan = pack.scanModsFolder(partial)
check('only the absent one is listed as missing', () => {
  assert.equal(partialScan.missing.length, 1)
  assert.equal(partialScan.missing[0].modId, 'ponder')
})
check('it records which file needed it', () => {
  assert.deepEqual(partialScan.missing[0].requiredBy, ['create.jar'])
})
check('the plan offers exactly one download', () => {
  const plan = pack.planUpdate(partialScan, { modId: 'create' })
  assert.equal(plan.toDownload.length, 1)
  assert.equal(plan.toDownload[0].modId, 'ponder')
})
check('the summary separates "in the folder" from "not"', () => {
  const plan = pack.planUpdate(partialScan, { modId: 'create' })
  assert.match(plan.summary, /1 of 2/)
})

section('a present-but-old dependency is an upgrade, not a second copy')
const oldDep = tmp('olddep')
jarIn(oldDep, 'create.jar', (f) => neoJar(f, { modId: 'create', version: '6.0.0', depends: [{ id: 'flywheel', range: '[2.0,3.0)' }] }))
jarIn(oldDep, 'flywheel.jar', (f) => neoJar(f, { modId: 'flywheel', version: '1.0.4' }))
const oldScan = pack.scanModsFolder(oldDep)
check('the mismatch is reported with both versions', () => {
  assert.equal(oldScan.mismatched.length, 1)
  assert.equal(oldScan.mismatched[0].have, '1.0.4')
  assert.equal(oldScan.mismatched[0].versionRange, '[2.0,3.0)')
})
check('the plan marks it as the wrong version, not missing', () => {
  const plan = pack.planUpdate(oldScan, { modId: 'create' })
  const fw = plan.dependencies.find((d) => d.modId === 'flywheel')
  assert.equal(fw.outcome, 'present-wrong-version')
  assert.equal(fw.providedBy, 'flywheel.jar', 'replacing the existing file is the fix, not adding one')
})

section('an update that adds a requirement is judged against the folder')
check('a new dependency the folder lacks is the only offer', () => {
  // The copy in the folder needs flywheel only; the new build also wants ponder.
  const plan = pack.planUpdate(completeScan, {
    modId: 'create',
    incoming: [
      { modId: 'flywheel', versionRange: '[1.0,2.0)', kind: 'required', isLoaderOrGame: false },
      { modId: 'ponder', versionRange: '[1.0,)', kind: 'required', isLoaderOrGame: false },
      { modId: 'newlib', versionRange: '[1.0,)', kind: 'required', isLoaderOrGame: false }
    ]
  })
  assert.equal(plan.toDownload.length, 1)
  assert.equal(plan.toDownload[0].modId, 'newlib')
})
check('optional requirements in the new build are still not downloads', () => {
  const plan = pack.planUpdate(completeScan, {
    modId: 'create',
    incoming: [{ modId: 'newlib', versionRange: '[1.0,)', kind: 'optional', isLoaderOrGame: false }]
  })
  assert.equal(plan.toDownload.length, 0)
})
check('a mod with no dependencies says so plainly', () => {
  const solo = tmp('solo')
  neoJar(path.join(solo, 'solo.jar'), { modId: 'solo', version: '1.0.0' })
  const plan = pack.planUpdate(pack.scanModsFolder(solo), { modId: 'solo' })
  assert.equal(plan.dependencies.length, 0)
  assert.match(plan.summary, /no dependencies/i)
})

/* -------------------------------------------------------------------- folder paths */

section('the user can point at either the pack or its mods folder')
check('a pack folder resolves to its mods subfolder', () => {
  const r = pack.resolveModsDir(complete)
  assert.equal(path.basename(r.dir), 'mods')
  assert.equal(r.adjusted, true)
  assert.equal(r.dir, path.join(complete, 'mods'))
})
check('a mods folder is used as given', () => {
  assert.equal(pack.resolveModsDir(path.join(complete, 'mods')).adjusted, false)
})
check('a mods folder is recognised', () => {
  assert.ok(pack.looksLikeModsFolder(path.join(complete, 'mods')))
})
check('an empty folder is not one', () => {
  assert.equal(pack.looksLikeModsFolder(tmp('empty')), false)
})
check('scanning a pack folder finds the same mods as its mods folder', () => {
  const viaPack = pack.scanModsFolder(complete)
  const viaMods = pack.scanModsFolder(path.join(complete, 'mods'))
  assert.equal(viaPack.mods.length, viaMods.mods.length)
})

section('the loader names are read, so the UI can confirm the right folder')
check('a NeoForge pack reports NeoForge', () => {
  assert.ok(completeScan.loaders.includes('neoforge'))
})
check('a single jar can be adopted into a folder', () => {
  const dest = tmp('adopt')
  const src = path.join(work, 'create-1.21.1.jar')
  const r = pack.adoptJar(src, dest)
  assert.ok(r.ok)
  assert.ok(fs.existsSync(path.join(dest, 'create-1.21.1.jar')))
})
check('adopting a non-jar is refused', () => {
  const r = pack.adoptJar(path.join(messy, 'notes.txt'), complete)
  assert.equal(r.ok, false)
})

/* ------------------------------------------------ the sentence the UI shows */

check('a healthy pack is reported as healthy, with no work to do', () => {
  const v = pack.describeScan(pack.scanModsFolder(complete))
  assert.equal(v.healthy, true)
  assert.match(v.headline, /every dependency present/)
  assert.match(v.detail, /nothing downloaded/i)
  assert.doesNotMatch(v.headline, /not in this folder/)
})
check('a pack with a gap says which dependency, not just that something is wrong', () => {
  const v = pack.describeScan(pack.scanModsFolder(partial))
  assert.equal(v.healthy, false)
  assert.match(v.headline, /ponder/)
  assert.match(v.detail, /already covered/i)
})
check('a pack whose only problem is a version mismatch says so', () => {
  const v = pack.describeScan(pack.scanModsFolder(oldDep))
  assert.equal(v.healthy, false)
  assert.match(v.headline, /wrong version/)
  assert.doesNotMatch(v.headline, /not in this folder/)
  assert.doesNotMatch(v.headline, /\b1 are\b/, 'a count of one is singular')
})
check('one unreadable jar is said out loud and blocks the all-clear', () => {
  // The old answer here was "healthy", which is exactly how a folder full of
  // unread jars could be reported as complete.
  const v = pack.describeScan(pack.scanModsFolder(messy))
  assert.equal(v.healthy, false)
  assert.match(v.headline, /not-a-mod\.jar|could not be/)
})

/* -------------------------------------- checking an incoming jar, harmlessly */

check('the game version a pack is built for is read from the mods', () => {
  const v = pack.packVersions(pack.scanModsFolder(complete))
  assert.equal(v.mcVersion, '1.21.1')
  assert.equal(v.loader, 'neoforge')
})
check('a fabric pack identifies its game version and loader from jar metadata', () => {
  // `>=1.21` is a range with no upper bound, so the floor is the version to
  // look updates up against; guessing anything else would find no builds.
  const v = pack.packVersions(pack.scanModsFolder(fabricDir))
  assert.equal(v.mcVersion, '1.21')
  assert.equal(v.loader, 'fabric')
})

check('a newer build of one mod is checked against the folder it would join', () => {
  const incoming = path.join(work, 'incoming-create.jar')
  neoJar(incoming, {
    modId: 'create',
    version: '6.1.0',
    depends: [
      { id: 'flywheel', range: '[1.0,2.0)' },
      { id: 'ponder', range: '[1.0,)' }
    ]
  })
  const res = pack.previewAdoption(pack.scanModsFolder(complete), incoming)
  assert.ok(res.ok)
  assert.equal(res.plan.toDownload.length, 0, 'a covered dependency must never become a download')
  assert.equal(res.plan.dependencies.every((d) => d.outcome === 'already-present'), true)
})
check('an update that needs something the folder lacks names exactly that one', () => {
  const incoming = path.join(work, 'incoming-create2.jar')
  neoJar(incoming, {
    modId: 'create',
    version: '6.1.0',
    depends: [
      { id: 'flywheel', range: '[1.0,2.0)' },
      { id: 'ponder', range: '[1.0,)' },
      { id: 'registrate', range: '[1.3,)' }
    ]
  })
  const res = pack.previewAdoption(pack.scanModsFolder(complete), incoming)
  assert.ok(res.ok)
  assert.deepEqual(
    res.plan.toDownload.map((d) => d.modId),
    ['registrate']
  )
  assert.equal(res.plan.dependencies.find((d) => d.modId === 'flywheel').outcome, 'already-present')
})
check('an update that tightens a range past the folder is caught before installing', () => {
  const incoming = path.join(work, 'incoming-create3.jar')
  neoJar(incoming, { modId: 'create', version: '7.0.0', depends: [{ id: 'flywheel', range: '[2.0,3.0)' }] })
  const res = pack.previewAdoption(pack.scanModsFolder(complete), incoming)
  assert.ok(res.ok)
  const fly = res.plan.dependencies.find((d) => d.modId === 'flywheel')
  assert.equal(fly.outcome, 'present-wrong-version')
  assert.equal(fly.providedBy, 'flywheel.jar')
  assert.match(res.plan.summary, /flywheel/)
})
check('previewing an updated copy names the old file it would replace, not add to', () => {
  const incoming = path.join(work, 'incoming-create4.jar')
  neoJar(incoming, { modId: 'create', version: '6.2.0' })
  const res = pack.previewAdoption(pack.scanModsFolder(complete), incoming)
  assert.equal(res.replaces, 'create.jar')
})
check('a jar that is not a mod is refused rather than copied in', () => {
  const junk = path.join(work, 'junk.jar')
  fs.writeFileSync(junk, Buffer.from('not a zip'))
  const res = pack.previewAdoption(pack.scanModsFolder(complete), junk)
  assert.equal(res.ok, false)
  assert.match(res.error, /not a readable mod jar/)
})
check('previewing writes nothing to the folder', () => {
  const before = fs.readdirSync(path.join(complete, 'mods')).length
  const incoming = path.join(work, 'incoming-create5.jar')
  neoJar(incoming, { modId: 'create', version: '6.3.0' })
  pack.previewAdoption(pack.scanModsFolder(complete), incoming)
  assert.equal(fs.readdirSync(path.join(complete, 'mods')).length, before)
})

/* ------------------------------------------- the scan that said "0 mods" */

section('an empty answer is never an all-clear')

check('a folder with no jars is reported as empty, not as healthy', () => {
  const empty = tmp('empty')
  const scan = pack.scanModsFolder(empty)
  const v = pack.describeScan(scan)
  assert.equal(scan.mods.length, 0)
  assert.equal(v.healthy, false)
  assert.match(v.headline, /No mods found/)
  assert.doesNotMatch(v.headline, /every dependency present/)
  fs.rmSync(empty, { recursive: true, force: true })
})
check('jars that cannot be parsed are a reading failure, not an empty pack', () => {
  const broken = tmp('broken')
  const mods = path.join(broken, 'mods')
  fs.mkdirSync(mods, { recursive: true })
  for (const n of ['a.jar', 'b.jar', 'c.jar']) fs.writeFileSync(path.join(mods, n), Buffer.from('not a zip at all'))
  const scan = pack.scanModsFolder(broken)
  assert.equal(scan.mods.length, 0)
  assert.equal(scan.unreadableJars.length, 3, 'every jar is accounted for, none are called junk')
  const v = pack.describeScan(scan)
  assert.equal(v.healthy, false)
  assert.match(v.headline, /No mod could be read/)
  assert.match(v.detail, /a\.jar/)
  fs.rmSync(broken, { recursive: true, force: true })
})
check('one unreadable jar downgrades the all-clear for the whole folder', () => {
  const mixed = tmp('mixed')
  jarIn(mixed, 'flywheel.jar', (f) => neoJar(f, { modId: 'flywheel', version: '1.0.4' }))
  fs.writeFileSync(path.join(mixed, 'mods', 'mystery.jar'), Buffer.from('nope'))
  const v = pack.describeScan(pack.scanModsFolder(mixed))
  assert.equal(v.healthy, false)
  assert.match(v.headline, /1 jar could not be/)
  fs.rmSync(mixed, { recursive: true, force: true })
})

section('packs that keep mods in subfolders')

check('jars in a version subfolder are read, not skipped', () => {
  const nested = tmp('nested')
  const inner = path.join(nested, 'mods', '1.21.1')
  fs.mkdirSync(inner, { recursive: true })
  neoJar(path.join(inner, 'create.jar'), { modId: 'create', version: '6.0.0' })
  const scan = pack.scanModsFolder(nested)
  assert.equal(scan.mods.length, 1)
  assert.equal(scan.mods[0].modId, 'create')
  assert.equal(scan.mods[0].file, path.join('1.21.1', 'create.jar'), 'the subfolder is kept in the name')
  fs.rmSync(nested, { recursive: true, force: true })
})
check('non-jar files are counted but never listed one by one', () => {
  const noisy = tmp('noisy')
  const mods = path.join(noisy, 'mods')
  fs.mkdirSync(mods, { recursive: true })
  for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(mods, `config-${i}.toml`), 'x')
  neoJar(path.join(mods, 'sodium.jar'), { modId: 'sodium', version: '0.6.0' })
  const scan = pack.scanModsFolder(noisy)
  assert.equal(scan.mods.length, 1)
  assert.equal(scan.ignored.length, 40)
  const v = pack.describeScan(scan)
  assert.equal(v.healthy, true)
  assert.match(v.detail, /40 other files/)
  fs.rmSync(noisy, { recursive: true, force: true })
})

section('old Forge packs, which have no mods.toml')

check('a pre-1.13 jar is read from mcmod.info', () => {
  const old = tmp('old')
  const mods = path.join(old, 'mods')
  fs.mkdirSync(mods, { recursive: true })
  const zip = new AdmZip()
  zip.addFile(
    'mcmod.info',
    Buffer.from(
      JSON.stringify([{ modid: 'icbmclassic', name: 'ICBM Classic', version: '4.2.0', dependencies: ['icbmcore', 'forge'] }]),
      'utf8'
    )
  )
  zip.writeZip(path.join(mods, 'icbm-classic-1.12.2-4.2.0.jar'))
  const mod = pack.readModJar(path.join(mods, 'icbm-classic-1.12.2-4.2.0.jar'))
  assert.equal(mod.modId, 'icbmclassic')
  assert.equal(mod.name, 'ICBM Classic')
  assert.equal(mod.version, '4.2.0')
  assert.equal(mod.loader, 'forge')
  assert.deepEqual(
    mod.depends.map((d) => d.modId),
    ['icbmcore'],
    'a loader id in an old dependency list is not a mod you download'
  )
  fs.rmSync(old, { recursive: true, force: true })
})

/* ------------------------------------- one mod, and what has to come with it */

section('updating one mod brings its dependencies with it')

check('a jar with only a manifest is a read file, not an unreadable one', () => {
  const lib = tmp('lib')
  fs.mkdirSync(path.join(lib, 'mods'), { recursive: true })
  const zip = new AdmZip()
  zip.addFile('META-INF/MANIFEST.MF', Buffer.from('Manifest-Version: 1.0\nImplementation-Title: Registrate\nImplementation-Version: 1.3.1\n', 'utf8'))
  zip.writeZip(path.join(lib, 'mods', 'registrate.jar'))
  const scan = pack.scanModsFolder(lib)
  assert.equal(scan.unreadableJars.length, 0)
  assert.equal(scan.mods.length, 1)
  assert.equal(scan.mods[0].name, 'Registrate')
  fs.rmSync(lib, { recursive: true, force: true })
})

check('updating Create finds Flywheel and Ponder in the folder, not online', () => {
  const incoming = path.join(work, 'create-update.jar')
  neoJar(incoming, {
    modId: 'create',
    version: '6.1.0',
    depends: [
      { id: 'flywheel', range: '[1.0,2.0)' },
      { id: 'ponder', range: '[1.0,)' }
    ]
  })
  const res = pack.planModUpdate(pack.scanModsFolder(complete), incoming)
  assert.ok(res.ok)
  const p = res.preview
  assert.equal(p.modId, 'create')
  assert.equal(p.replaces, 'create.jar', 'the old Create jar is the file to replace')
  assert.deepEqual(p.dependencies.map((d) => d.modId).sort(), ['flywheel', 'ponder'])
  assert.equal(p.needNewer.length, 0, 'nothing has to be downloaded')
  assert.deepEqual(p.dependencies.map((d) => d.file).sort(), ['flywheel.jar', 'ponder.jar'])
  assert.match(p.summary, /provides them at compatible versions|provides all of them/)
})

check('a dependency that is too old is named, with the reason', () => {
  const incoming = path.join(work, 'create-strict.jar')
  neoJar(incoming, { modId: 'create', version: '7.0.0', depends: [{ id: 'flywheel', range: '[2.0,3.0)' }] })
  const res = pack.planModUpdate(pack.scanModsFolder(complete), incoming)
  assert.ok(res.ok)
  assert.equal(res.preview.needNewer.length, 1)
  const fly = res.preview.needNewer[0]
  assert.equal(fly.modId, 'flywheel')
  assert.equal(fly.path, path.join(complete, 'mods', 'flywheel.jar'), 'the jar to update is in the folder')
  assert.match(fly.problem, /needs \[2\.0,3\.0\)/)
  assert.match(res.preview.summary, /needs a newer build: flywheel/)
})

check('a dependency with no jar at all is the only kind that has to be downloaded', () => {
  const incoming = path.join(work, 'create-missing.jar')
  neoJar(incoming, {
    modId: 'create',
    version: '6.1.0',
    depends: [
      { id: 'flywheel', range: '[1.0,2.0)' },
      { id: 'ponder', range: '[1.0,)' },
      { id: 'registrate', range: '[1.3,)' }
    ]
  })
  const res = pack.planModUpdate(pack.scanModsFolder(complete), incoming)
  assert.deepEqual(res.preview.needNewer.map((d) => d.modId), ['registrate'])
  assert.equal(res.preview.needNewer[0].path, undefined)
  assert.match(res.preview.needNewer[0].problem, /not in this folder/)
  assert.match(res.preview.summary, /2 of 3 dependencies are already here/)
})

check('optional dependencies never come along for the ride', () => {
  const incoming = path.join(work, 'create-optional.jar')
  neoJar(incoming, {
    modId: 'create',
    version: '6.1.0',
    depends: [
      { id: 'flywheel', range: '[1.0,2.0)' },
      { id: 'jei', range: '[15,)', type: 'optional' }
    ]
  })
  const res = pack.planModUpdate(pack.scanModsFolder(complete), incoming)
  assert.deepEqual(res.preview.dependencies.map((d) => d.modId), ['flywheel'])
})

check('a mod with no dependencies outside the loader says so plainly', () => {
  const incoming = path.join(work, 'solo.jar')
  neoJar(incoming, { modId: 'solo', version: '1.0.0', depends: [{ id: 'minecraft', range: '[1.21.1,1.22)' }] })
  const res = pack.planModUpdate(pack.scanModsFolder(complete), incoming)
  assert.equal(res.preview.dependencies.length, 0)
  assert.match(res.preview.summary, /no dependencies outside the loader/)
})

check('an unreadable incoming jar is refused with a usable reason', () => {
  const junk = path.join(work, 'broken-update.jar')
  fs.writeFileSync(junk, Buffer.from('not a zip'))
  const res = pack.planModUpdate(pack.scanModsFolder(complete), junk)
  assert.equal(res.ok, false)
  assert.match(res.error, /could not be read as a mod/)
})

check('the display name a pack already uses is kept for the report', () => {
  const names = pack.displayNames(pack.scanModsFolder(complete))
  assert.equal(names.flywheel, 'flywheel')
})

/* ------------------------------------------- reading a jar by its file name */

section('a jar nobody can parse is still a jar')

check('the id and version are read out of a normal file name', () => {
  const v = pack.inferFromFileName('create-1.21.1-6.0.4.jar')
  assert.equal(v.modId, 'create')
  assert.equal(v.mcVersion, '1.21.1')
  assert.equal(v.version, '6.0.4')
  assert.equal(v.inferred, true)
})
check('the mod version after the minecraft version is the one kept', () => {
  // Reading `1.21.1` as the mod version left every guessed dependency with no
  // version at all, which made its range uncheckable.
  assert.equal(pack.inferFromFileName('flywheel-1.21.1-1.0.4.jar').version, '1.0.4')
  assert.equal(pack.inferFromFileName('flywheel-1.21.1-1.0.4.jar').mcVersion, '1.21.1')
})
check('a multi-word id keeps its shape, lowercased with dashes', () => {
  const v = pack.inferFromFileName('ICBM-Classic-1.12.2-4.2.0.jar')
  assert.equal(v.modId, 'icbm-classic')
  assert.equal(v.mcVersion, '1.12.2')
  assert.equal(v.version, '4.2.0')
})
check('loader words are not part of the id', () => {
  assert.equal(pack.inferFromFileName('jei-1.20.1-forge-15.2.0.27.jar').modId, 'jei')
  assert.equal(pack.inferFromFileName('sodium-fabric-mc1.20.1-0.5.0.jar').modId, 'sodium')
  assert.equal(pack.inferFromFileName('jei-1.20.1-forge-15.2.0.27.jar').version, '15.2.0.27')
})
check('a name with nothing id-like in it is refused, not invented', () => {
  assert.equal(pack.inferFromFileName('mod.jar'), null)
  assert.equal(pack.inferFromFileName('backup.jar'), null, 'no version, no minecraft version, no claim')
  assert.equal(pack.inferFromFileName('old.jar'), null)
})
check('sources and dev jars are not mistaken for the mod itself', () => {
  const v = pack.inferFromFileName('create-1.21.1-6.0.4-sources.jar')
  assert.equal(v.modId, 'create')
  assert.equal(v.version, '6.0.4')
})

check('matching demands the whole id, so a sibling mod is never mistaken for it', () => {
  assert.equal(pack.fileNameMatchesMod('create-1.21.1-6.0.4.jar', 'create'), true)
  assert.equal(pack.fileNameMatchesMod('create-1.21.1-6.0.4.jar', 'CREATE'), true, 'case does not matter')
  // The bug this prevents: satisfying "create" with "createaddition".
  assert.equal(pack.fileNameMatchesMod('createaddition-1.2.0.jar', 'create'), false)
  assert.equal(pack.fileNameMatchesMod('flywheel-1.0.4.jar', 'create'), false)
})

check('normalising ignores dashes and underscores', () => {
  assert.equal(pack.normalizeModId('ICBM-Classic'), pack.normalizeModId('icbm_classic'))
})

section('guesses are used, but never passed off as facts')

check('an unreadable jar still counts toward what the folder provides', () => {
  const guessed = tmp('guessed')
  const mods = path.join(guessed, 'mods')
  fs.mkdirSync(mods, { recursive: true })
  neoJar(path.join(mods, 'create-1.21.1-6.0.4.jar'), { modId: 'create', version: '6.0.4', depends: [{ id: 'flywheel', range: '[1.0,2.0)' }] })
  // An old, unparseable Flywheel: only its file name identifies it.
  fs.writeFileSync(path.join(mods, 'flywheel-1.0.4.jar'), Buffer.from('not a zip'))
  const scan = pack.scanModsFolder(guessed)
  assert.equal(scan.unreadableJars.length, 1)
  assert.deepEqual(scan.inferred.map((i) => i.modId), ['flywheel'])
  assert.equal(scan.mods.length, 1, 'a guess is not counted as a read mod')
  assert.equal(scan.missing.length, 0, 'a name match counts, so Create is not reported as broken')

  const incoming = path.join(guessed, 'create-new.jar')
  neoJar(incoming, { modId: 'create', version: '6.1.0', depends: [{ id: 'flywheel', range: '[1.0,2.0)' }] })
  const plan = pack.planModUpdate(scan, incoming)
  const dep = plan.preview.dependencies.find((d) => d.modId === 'flywheel')
  assert.equal(dep.inferred, true, 'the caller is told this one is a guess')
  assert.equal(dep.needsNewer, false, 'a guess is not silently upgraded over an installed jar')
  assert.match(dep.problem, /could not be read/)
  assert.match(dep.problem, /file name/)
  fs.rmSync(guessed, { recursive: true, force: true })
})

check('a readable jar wins over a name guess for the same id', () => {
  const both = tmp('both')
  const mods = path.join(both, 'mods')
  fs.mkdirSync(mods, { recursive: true })
  // Same id, two files: one readable, one not. The readable one must answer.
  fs.writeFileSync(path.join(mods, 'flywheel-1.0.0.jar'), Buffer.from('nope'))
  neoJar(path.join(mods, 'flywheel-2.0.1.jar'), { modId: 'flywheel', version: '2.0.1' })
  const scan = pack.scanModsFolder(both)
  const incoming = path.join(both, 'create.jar')
  neoJar(incoming, { modId: 'create', version: '6.1.0', depends: [{ id: 'flywheel', range: '[2.0,3.0)' }] })
  const dep = pack.planModUpdate(scan, incoming).preview.dependencies.find((d) => d.modId === 'flywheel')
  assert.equal(dep.inferred, undefined, 'the readable jar is the one reported')
  assert.equal(dep.version, '2.0.1')
  assert.equal(dep.needsNewer, false)
  fs.rmSync(both, { recursive: true, force: true })
})

check('a name match does not make an empty folder look complete', () => {
  const onlyGuesses = tmp('guessonly')
  const mods = path.join(onlyGuesses, 'mods')
  fs.mkdirSync(mods, { recursive: true })
  fs.writeFileSync(path.join(mods, 'some-mod-1.0.0.jar'), Buffer.from('nope'))
  const v = pack.describeScan(pack.scanModsFolder(onlyGuesses))
  assert.equal(v.healthy, false, 'nothing here could actually be read')
  assert.match(v.detail, /file name/)
  fs.rmSync(onlyGuesses, { recursive: true, force: true })
})

section('the decompiled code is the judge of the guess')

check('an @Mod id that matches confirms the file name', () => {
  const src = tmp('src-confirm')
  fs.mkdirSync(path.join(src, 'com', 'example'), { recursive: true })
  fs.writeFileSync(path.join(src, 'com', 'example', 'CreateMod.java'), '@Mod("create")\npublic class CreateMod {}\n')
  const res = pack.verifyInferredId(src, 'create')
  assert.equal(res.verdict, 'confirmed')
  assert.equal(res.found, 'create')
  fs.rmSync(src, { recursive: true, force: true })
})
check('an @Mod id that differs disproves it, and says which id it really is', () => {
  const src = tmp('src-wrong')
  fs.mkdirSync(src, { recursive: true })
  fs.writeFileSync(path.join(src, 'Thing.java'), '@Mod(modid = "actuallysomethingelse")\npublic class Thing {}\n')
  const res = pack.verifyInferredId(src, 'create')
  assert.equal(res.verdict, 'contradicted')
  assert.equal(res.found, 'actuallysomethingelse')
  fs.rmSync(src, { recursive: true, force: true })
})
check('code with no @Mod anywhere is unknown, not a pass', () => {
  const src = tmp('src-unknown')
  fs.mkdirSync(src, { recursive: true })
  fs.writeFileSync(path.join(src, 'Lib.java'), 'package com.example;\npublic class Lib {}\n')
  const res = pack.verifyInferredId(src, 'flywheel')
  assert.equal(res.verdict, 'unknown')
  fs.rmSync(src, { recursive: true, force: true })
})

for (const d of [work, fabricDir, messy, complete, partial, oldDep]) fs.rmSync(d, { recursive: true, force: true })

console.log(`\n${failures.length ? `${failures.length} check(s) failed` : `all ${passed} modpack checks passed`}`)
if (failures.length) process.exit(1)
