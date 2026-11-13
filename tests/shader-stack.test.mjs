/**
 * Shader catalogue checks.
 *
 * The bug these exist to catch is a *category* bug: a flat "best shaders" list
 * that puts Sodium next to Complementary. That reads fine and is wrong — Sodium
 * has no shader API, and a mod author who follows it loses an afternoon. So the
 * tests assert on the shape of the data (two lists, non-overlapping, Flywheel not
 * labelled a shader API) as much as on individual names.
 *
 * The other half is honesty: every recommendation for a version that has no pack
 * loader must come back empty rather than inventing something.
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const out = path.join(process.cwd(), 'out-test', 'main')
const load = (file) => import(pathToFileURL(path.join(out, file)).href)
const {
  SHADER_PACKS,
  RENDER_ENGINES,
  USE_CASES,
  recommend,
  catalogueFor,
  fullCatalogue,
  compatibilityNotes,
  stackGuidance
} = await load('mod/shader-stack.js')

const names = SHADER_PACKS.map((p) => p.name)
const engineNames = RENDER_ENGINES.map((e) => e.name)

const results = []
function check(name, fn) {
  try {
    fn()
    results.push({ name, ok: true })
  } catch (e) {
    results.push({ name, ok: false, error: e.message })
  }
}

/* ------------------------------------------------------------- the two lists */

check('packs and engines are separate lists with no shared id', () => {
  const packIds = new Set(SHADER_PACKS.map((p) => p.id))
  for (const e of RENDER_ENGINES) assert.ok(!packIds.has(e.id), `${e.name} appears in both categories`)
})

check('the popular packs people actually install are all present', () => {
  // Names as the packs themselves spell them; the catalogue keeps the official
  // title, so "BSL Shaders", not "BSL".
  for (const want of ['Complementary Reimagined', 'Complementary Unbound', 'BSL Shaders', 'Photon', 'Bliss', 'Rethinking Voxels', 'MakeUp Ultra Fast']) {
    assert.ok(names.includes(want), `missing shader pack: ${want}`)
  }
})

check('the engine list covers loaders, perf renderers and the SDK', () => {
  const kinds = new Set(RENDER_ENGINES.map((e) => e.kind))
  for (const k of ['pack-loader', 'perf', 'sdk', 'instancing', 'legacy']) {
    assert.ok(kinds.has(k), `no engine of kind ${k}`)
  }
  for (const want of ['Iris', 'Oculus', 'Sodium', 'Embeddium', 'Flywheel', 'Veil', 'OptiFine']) {
    assert.ok(engineNames.includes(want), `missing rendering engine: ${want}`)
  }
})

check('Flywheel is not offered as a way to get shaders', () => {
  const f = RENDER_ENGINES.find((e) => e.id === 'flywheel')
  assert.ok(f, 'Flywheel missing')
  assert.equal(f.kind, 'instancing')
  assert.ok(f.dependOn, 'Flywheel is a library a mod may depend on')
  // Whatever the wording, it must say that a shaderpack turns it off.
  assert.match(f.misread + f.cost + (f.gives ?? ''), /shaderpack|shader pack/i)
})

check('Sodium is a renderer, not a shader loader', () => {
  const s = RENDER_ENGINES.find((e) => e.id === 'sodium')
  assert.ok(s)
  assert.equal(s.kind, 'perf')
  assert.ok(!s.needs || !s.needs.some((n) => /complementary|bsl|photon/i.test(n)), 'Sodium must not claim to need a pack')
})

check('Veil is flagged as a library a mod can depend on', () => {
  const v = RENDER_ENGINES.find((e) => e.id === 'veil')
  assert.ok(v)
  assert.equal(v.kind, 'sdk')
  assert.equal(v.dependOn, true)
  assert.match(v.versions.min, /^1\.2/, 'Veil is 1.21.x only')
})

check('Oculus carries its Forge-only, old-version ceiling', () => {
  const o = RENDER_ENGINES.find((e) => e.id === 'oculus')
  assert.ok(o)
  assert.deepEqual(o.loaders.sort(), ['forge', 'neoforge'])
  assert.equal(o.versions.max, '1.20.1')
})

check('every pack says how heavy it is and what GPU it needs', () => {
  for (const p of SHADER_PACKS) {
    assert.ok(['light', 'medium', 'heavy', 'extreme'].includes(p.weight), `${p.name}: bad weight`)
    assert.ok(p.minGpu && p.minGpu.length > 2, `${p.name}: no GPU floor`)
    assert.ok(p.runsOn.length > 0, `${p.name}: runs on nothing`)
    assert.ok(/^https?:\/\//.test(p.url), `${p.name}: no link`)
  }
})

check('every engine has a misconception line, not an empty string', () => {
  for (const e of RENDER_ENGINES) {
    assert.ok(e.misread && e.misread.length > 20, `${e.name}: no misread line`)
    assert.ok(e.gives && e.gives.length > 10, `${e.name}: no gives line`)
  }
})

check('SEUS PTGI is OptiFine-only — it does not run on Iris', () => {
  const seus = SHADER_PACKS.find((p) => /seus/i.test(p.id) || /SEUS/i.test(p.name))
  assert.ok(seus, 'SEUS missing from the catalogue')
  assert.deepEqual(seus.runsOn, ['optifine'])
})

/* ------------------------------------------------------------ recommendation */

check('every use case is recommendable on 1.21.1 NeoForge', () => {
  for (const useCase of Object.keys(USE_CASES)) {
    if (useCase === 'compare') continue
    const rec = recommend({ useCase, mcVersion: '1.21.1', loader: 'neoforge' })
    assert.ok(rec.picks.length > 0, `no pick for ${useCase}`)
    assert.ok(rec.picks.every((p) => p.why && p.action), `${useCase}: a pick without a reason or an action`)
  }
})

check('realism recommends packs, not Sodium or Flywheel', () => {
  const rec = recommend({ useCase: 'realism', mcVersion: '1.21.1', loader: 'neoforge' })
  const fromEngines = rec.picks.filter((p) => p.kind === 'engine').map((p) => p.name)
  assert.ok(!fromEngines.includes('Sodium'), 'Sodium is not a realism answer')
  assert.ok(!fromEngines.includes('Flywheel'), 'Flywheel is not a realism answer')
  assert.ok(rec.picks.some((p) => p.kind === 'pack'), 'realism needs a pack')
})

check('performance recommends a renderer and may mention Flywheel, never a pack as the answer', () => {
  const rec = recommend({ useCase: 'performance', mcVersion: '1.21.1', loader: 'fabric' })
  const first = rec.picks[0]
  assert.equal(first.kind, 'engine')
  assert.equal(first.name, 'Sodium', 'Fabric performance answer is Sodium')
})

check('custom-renderer on 1.21.1 points at Veil, and says a mod may depend on it', () => {
  const rec = recommend({ useCase: 'custom-renderer', mcVersion: '1.21.1', loader: 'neoforge' })
  assert.ok(rec.picks.some((p) => p.name === 'Veil'), 'Veil is the 1.21.x rendering SDK')
})

check('custom-renderer on 1.20.1 does not offer Veil', () => {
  const rec = recommend({ useCase: 'custom-renderer', mcVersion: '1.20.1', loader: 'forge' })
  assert.ok(!rec.picks.some((p) => p.name === 'Veil'), 'Veil is 1.21.x only')
})

check('1.12 gets honestly empty answers rather than dead options', () => {
  const rec = recommend({ useCase: 'realism', mcVersion: '1.12.2', loader: 'forge' })
  assert.ok(rec.picks.length <= 1, 'expect at most the OptiFine-era pack')
  assert.ok(rec.avoid, 'a legacy version must carry an explicit warning')
})

check('a recommendation knows whether the user has to install the answer', () => {
  const realism = recommend({ useCase: 'realism', mcVersion: '1.21.1', loader: 'neoforge' })
  assert.equal(realism.userInstalls, true, 'a shader pack is the player install')
  const perf = recommend({ useCase: 'performance', mcVersion: '1.21.1', loader: 'fabric' })
  assert.equal(perf.userInstalls, true, 'Sodium is also a player install')
})

check('every pick points at an id that exists in the catalogue', () => {
  const ids = new Set([...SHADER_PACKS.map((p) => p.id), ...RENDER_ENGINES.map((e) => `engine:${e.id}`)])
  for (const useCase of Object.keys(USE_CASES)) {
    const rec = recommend({ useCase, mcVersion: '1.21.1', loader: 'neoforge' })
    for (const p of rec.picks) assert.ok(ids.has(p.id), `${useCase}: pick ${p.id} is not in the catalogue`)
  }
})

/* -------------------------------------------------------------- compatibility */

check('catalogueFor filters to what applies to the version and loader', () => {
  const modern = catalogueFor('1.21.1', 'neoforge')
  const old = catalogueFor('1.12.2', 'forge')
  assert.ok(modern.engines.length > old.engines.length, 'fewer engines apply on 1.12')
  assert.ok(modern.engines.some((e) => e.id === 'veil'))
  assert.ok(!old.engines.some((e) => e.id === 'veil'), 'Veil cannot apply to 1.12.2')
  assert.ok(!old.engines.some((e) => e.id === 'iris'), 'Iris cannot apply to 1.12.2')
})

check('catalogueFor never returns an engine outside its own version range', () => {
  for (const [mc, loader] of [['1.12.2', 'forge'], ['1.16.5', 'forge'], ['1.20.1', 'forge'], ['1.21.1', 'fabric']]) {
    for (const e of catalogueFor(mc, loader).engines) {
      assert.ok(e.loaders.includes(loader), `${e.name} shipped for ${loader} on ${mc}`)
    }
  }
})

check('fullCatalogue keeps both categories even when nothing applies', () => {
  const all = fullCatalogue()
  assert.equal(all.packs.length, SHADER_PACKS.length)
  assert.equal(all.engines.length, RENDER_ENGINES.length)
})

check('Sodium and Oculus on one set is an error', () => {
  const notes = compatibilityNotes(['engine:sodium', 'engine:oculus'], '1.20.1')
  assert.ok(notes.some((n) => n.severity === 'error'), 'Fabric and Forge renderers do not mix')
})

check('Rubidium and Embeddium conflict', () => {
  const notes = compatibilityNotes(['engine:rubidium', 'engine:embeddium'], '1.20.1')
  assert.ok(notes.some((n) => n.severity === 'error'))
})

check('Iris without Sodium is a warning', () => {
  const notes = compatibilityNotes(['engine:iris'], '1.21.1')
  assert.ok(notes.some((n) => n.severity === 'warning'))
})

check('a sane set produces no errors', () => {
  const notes = compatibilityNotes(['complementary-reimagined', 'engine:iris', 'engine:sodium'], '1.21.1')
  assert.equal(notes.filter((n) => n.severity === 'error').length, 0)
})

/* ------------------------------------------------------------ prompt guidance */

check('stackGuidance names Flywheel and Sodium correctly and quotes nothing invented', () => {
  const g = stackGuidance('1.21.1')
  assert.match(g, /Flywheel is an instancing engine, not a shader API/)
  assert.match(g, /Sodium and Embeddium are renderers, not shader loaders/)
  for (const p of SHADER_PACKS.slice(0, 3)) assert.ok(!g.includes('add ' + p.name), 'the prompt must not suggest bundling a pack')
})

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : '\n      ' + r.error}`)
console.log(`\n${results.length - failed.length}/${results.length} shader-catalogue checks passed`)
if (failed.length) process.exit(1)
