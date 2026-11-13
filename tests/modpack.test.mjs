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
check('unreadable extras are mentioned but do not make a pack unhealthy', () => {
  const v = pack.describeScan(pack.scanModsFolder(messy))
  assert.equal(v.healthy, true)
  assert.match(v.detail, /not mods/)
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

for (const d of [work, fabricDir, messy, complete, partial, oldDep]) fs.rmSync(d, { recursive: true, force: true })

console.log(`\n${failures.length ? `${failures.length} check(s) failed` : `all ${passed} modpack checks passed`}`)
if (failures.length) process.exit(1)
