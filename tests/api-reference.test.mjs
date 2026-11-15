/**
 * The base classes the agent writes against.
 *
 * These are the imports that break a build: `World` on 1.21, `getOrCreateTag()`
 * after 1.20.5, `RegistryEvent` after 1.19.3. The table exists so the agent looks
 * them up instead of recalling them, and these checks pin the answers that
 * matter and the honesty about the ones that cannot be answered.
 */
import assert from 'node:assert/strict'

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

const out = new URL('../out-test/main/mod/api-reference.js', import.meta.url).href
const api = await import(out)

/* ------------------------------------------------------------ era mapping */

check('the naming eras break where they actually broke', () => {
  assert.equal(api.eraOf('1.12.2'), 'legacy')
  assert.equal(api.eraOf('1.16.5'), 'mojmap')
  assert.equal(api.eraOf('1.16.4'), 'mcp')
  assert.equal(api.eraOf('1.20.1'), 'mojmap')
  assert.equal(api.eraOf('1.21.1'), 'mojmap')
})

/* --------------------------------------------------------- the big answers */

check('1.21 gives Level, not World', () => {
  const { text } = api.apiReference({ query: 'world', mcVersion: '1.21.1', loader: 'neoforge' })
  assert.match(text, /net\.minecraft\.world\.level\.Level/)
  assert.doesNotMatch(text, /net\.minecraft\.world\.World/, 'World is the 1.16 name')
})

check('1.12 gives World, not Level', () => {
  const { text } = api.apiReference({ query: 'world', mcVersion: '1.12.2', loader: 'forge' })
  assert.match(text, /net\.minecraft\.world\.World/)
  assert.doesNotMatch(text, /world\.level\.Level/)
})

check("Block's package moved, and the table knows it", () => {
  const neo = api.apiReference({ query: 'block', mcVersion: '1.21.1', loader: 'neoforge' }).text
  assert.match(neo, /net\.minecraft\.world\.level\.block\.Block/)
  const old = api.apiReference({ query: 'block', mcVersion: '1.12.2', loader: 'forge' }).text
  assert.match(old, /net\.minecraft\.block\.Block/)
})

check('the data-component change is stated, because it is the most common stale API', () => {
  const { text } = api.apiReference({ query: 'nbt', mcVersion: '1.21.1', loader: 'neoforge' })
  assert.match(text, /DataComponents|data components/i)
  assert.match(text, /getOrCreateTag\(\) is gone|does not exist/i)
})

check('on 1.16.4 the same question still answers getOrCreateTag, because it is still true', () => {
  const { text } = api.apiReference({ query: 'nbt', mcVersion: '1.16.4', loader: 'forge' })
  assert.match(text, /getOrCreateTag/)
})

check('pre-1.13 registration is not described with DeferredRegister', () => {
  const { text } = api.apiReference({ query: 'registration', mcVersion: '1.12.2', loader: 'forge' })
  assert.match(text, /Does not exist in this era|GameRegistry/)
})

/* ----------------------------------------------------- loader differences */

check('the entry class differs per loader, and all three are named', () => {
  const neo = api.apiReference({ query: 'entry class', mcVersion: '1.21.1', loader: 'neoforge' }).text
  const fabric = api.apiReference({ query: 'entry class', mcVersion: '1.21.1', loader: 'fabric' }).text
  assert.match(neo, /@Mod/)
  assert.match(fabric, /ModInitializer/)
  assert.match(fabric, /fabric\.mod\.json/)
})

check('fabric is told its metadata is fabric.mod.json, not mods.toml', () => {
  const { text } = api.apiReference({ query: 'metadata', mcVersion: '1.21.1', loader: 'fabric' })
  assert.match(text, /fabric\.mod\.json/)
})

check('a fabric project is answered with Registry.register, and named as such', () => {
  const { text } = api.apiReference({ query: 'registration', mcVersion: '1.21.1', loader: 'fabric' })
  assert.match(text, /Registry\.register/)
  // The only mention of DeferredRegister allowed is saying Fabric does not have one.
  const lines = text.split('\n').filter((l) => l.includes('DeferredRegister'))
  for (const l of lines) assert.match(l, /has no DeferredRegister/i, `unexpected: ${l}`)
})

check('a modern project is not lectured about 1.12 caveats', () => {
  const { text } = api.apiReference({ query: 'registration', mcVersion: '1.21.1', loader: 'fabric' })
  assert.doesNotMatch(text, /1\.12 and older/, 'the note applies to the legacy era only')
})

check('a fabric project is never answered with a registry event', () => {
  const { text } = api.apiReference({ query: 'registry event', mcVersion: '1.21.1', loader: 'fabric' })
  assert.match(text, /no registry event/i)
})

check('neoforge still gets DeferredRegister after the fabric branch was added', () => {
  const { text } = api.apiReference({ query: 'registration', mcVersion: '1.21.1', loader: 'neoforge' })
  assert.match(text, /DeferredRegister/)
})

/* ------------------------------------------------------------- honesty */

check('an unknown concept says "decompile it" instead of inventing an answer', () => {
  const { text, hits } = api.apiReference({ query: 'quantum flux capacitor', mcVersion: '1.21.1', loader: 'neoforge' })
  assert.equal(hits, 0)
  assert.match(text, /decompile_api/)
  assert.match(text, /Rather than guess/i)
})

check('the answer never presents itself as a signature guarantee', () => {
  const { text } = api.apiReference({ mcVersion: '1.21.1', loader: 'neoforge' })
  assert.match(text, /names, not a promise about signatures/i)
})

check('every concept can be listed, so the agent knows what to ask for', () => {
  const concepts = api.apiConcepts()
  assert.ok(concepts.length > 10)
  for (const needed of ['Block', 'World / Level', 'Tile entity', 'Deferred registration']) {
    assert.ok(concepts.includes(needed), `missing ${needed}`)
  }
})

check('a full lookup produces a substantial, readable answer', () => {
  const { text } = api.apiReference({ mcVersion: '1.21.1', loader: 'neoforge' })
  assert.ok(text.split('\n').length > 40)
})

console.log(`\n${failures.length ? `${failures.length} check(s) failed` : `all ${passed} api-reference checks passed`}`)
if (failures.length) process.exit(1)
