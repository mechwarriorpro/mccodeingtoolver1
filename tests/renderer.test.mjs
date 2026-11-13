import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Renderer capabilities per Minecraft version.
 *
 * The failure this prevents is expensive rather than noisy: an agent that writes
 * `coreShaders` assets for 1.12, or promises a deferred PBR pipeline to someone
 * on 1.16, wastes a session and then produces a black screen. These checks pin
 * the three boundaries that actually broke mods — 1.13, 1.17 and 1.20 — and the
 * honesty of the "photorealistic" answer at each of them.
 */

const out = path.join(process.cwd(), 'out-test', 'main')
const load = (file) => import(pathToFileURL(path.join(out, file)).href)
const { rendererSupport, rendererGuidance, realismVerdict } = await load('mod/renderer.js')

let passed = 0
function check(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (e) {
    console.log(`  FAIL ${name}`)
    console.log(`       ${e.message}`)
    process.exitCode = 1
  }
}

const CAN_TEXT = (r) => r.stage.can.join(' ').toLowerCase()
const CANNOT_TEXT = (r) => r.stage.cannot.join(' ').toLowerCase()

/* -------------------------------------------------------------- boundaries */

check('1.12.2 is the fixed-function era and has no shader loader', () => {
  const r = rendererSupport('1.12.2')
  assert.equal(r.api, 'gl11')
  assert.match(r.howShadersLoad, /Nothing in vanilla|no shader/i)
  // The decisive fact: there is no coreShaders path at all before 1.17.
  assert.match(CANNOT_TEXT(r), /blaze3d/)
})

check('1.13 crosses to LWJGL 3 but still has no shader resource path', () => {
  const r = rendererSupport('1.13.2')
  assert.equal(r.api, 'gl33', '1.13 has real GL 3.3 available, unlike 1.12')
  assert.match(r.howShadersLoad, /no shader resource path/i)
})

check('1.17 introduces Blaze3D and a real coreShaders folder', () => {
  const r = rendererSupport('1.17.1')
  assert.notEqual(r.api, 'gl33', '1.17 must not be described as the pre-Blaze3D era')
  assert.match(r.howShadersLoad, /shaders\/core/)
})

check('1.21.1 is the modern pipeline with PostChain available', () => {
  const r = rendererSupport('1.21.1')
  assert.ok(r.api === 'blaze3d' || r.api === 'pipeline')
  assert.match(CAN_TEXT(r), /postchain|post-process/)
  assert.match(r.apiLabel, /Blaze3D/)
})

check('an unknown version does not fall back to 1.12 rules', () => {
  // Worse than useless: the pre-1.13 advice tells the agent not to write a
  // shader at all, which is wrong for anything modern.
  const r = rendererSupport('')
  assert.notEqual(r.api, 'gl11')
})

check('1.21.2 is a different API from 1.21.1, not the same one', () => {
  // NeoForge's 1.21.2 primer: ShaderInstance -> CompiledShaderProgram, and
  // RenderPipeline moved to blaze3d.framegraph. An agent that treats 1.21.2 as
  // "1.21.1 with a patch number" writes code that does not compile.
  const a = rendererSupport('1.21.1')
  const b = rendererSupport('1.21.2')
  assert.notEqual(a.api, b.api, '1.21.2 must not report the same pipeline as 1.21.1')
  assert.equal(b.api, 'blaze3d-2')
  assert.match(b.apiLabel, /CompiledShaderProgram/)
  assert.ok(
    b.constraints.some((c) => /CompiledShaderProgram/.test(c)),
    'the rename must be stated in the constraints'
  )
})

check('the shader directory change at 1.21.2 is called out', () => {
  // Shaders moved out of core/ — a JSON that still says core/... fails to load
  // with "Failed to load required shader programs" and a black screen.
  const b = rendererSupport('1.21.2')
  assert.match(b.howShadersLoad, /shaders\/<name>\.vsh|no longer/i)
  assert.ok(
    b.constraints.some((c) => /shaders\/core/.test(c) && /not|no longer|wrong/i.test(c)),
    'the constraint list must warn about core/'
  )
  // And the older era must still say core/, or the two are indistinguishable.
  assert.match(rendererSupport('1.21.1').howShadersLoad, /shaders\/core/)
})

check('1.17 requires OpenGL 3.2 Core, which is a hardware gate', () => {
  const r = rendererSupport('1.17.1')
  assert.ok(
    r.constraints.some((c) => /3\.2 Core/.test(c) && /require/i.test(c)),
    '1.17 raising the GL requirement must be stated: a GL 2.1 machine cannot run it'
  )
})

check('nothing claims 1.21.1 shader code works on 1.21.2 unchanged', () => {
  const b = rendererSupport('1.21.2')
  assert.match(CANNOT_TEXT(b), /unchanged|not the same|moved/i)
})

/* ------------------------------------------------------------ honesty */

check('1.12 says photorealism is not reachable from mod code', () => {
  const v = realismVerdict('1.12.2')
  assert.equal(v.achievable, false)
  assert.match(v.how, /OptiFine|no shader loader/i)
  // It must not read as "impossible forever", just not from this mod.
  assert.match(v.how, /not/i)
})

check('modern versions say photorealism is reachable, and say how', () => {
  const v = realismVerdict('1.21.1')
  assert.equal(v.achievable, true)
  assert.match(v.how, /Iris|shader pack/i)
})

check('no version is described as able to ray trace', () => {
  // This is the claim that would be flatly false: Minecraft is rasterised.
  for (const v of ['1.12.2', '1.16.5', '1.18.2', '1.21.1']) {
    const r = rendererSupport(v)
    assert.ok(!/can\b[^.]*ray ?trac/i.test(CAN_TEXT(r)), `${v} claims ray tracing`)
  }
})

check('every version admits at least one real limitation', () => {
  for (const v of ['1.12.2', '1.16.5', '1.18.2', '1.21.1']) {
    const r = rendererSupport(v)
    assert.ok(r.stage.cannot.length >= 2, `${v} lists almost nothing it cannot do`)
    assert.ok(r.ceiling.length > 40, `${v} has no honest ceiling stated`)
  }
})

check('the shader mod each era needs is named correctly', () => {
  assert.equal(rendererSupport('1.12.2').needsShaderMod, 'optifine-shaders')
  assert.equal(rendererSupport('1.16.5').needsShaderMod, 'iris-sodium')
  assert.equal(rendererSupport('1.21.1').needsShaderMod, 'iris-sodium')
})

/* ---------------------------------------------------------------- guidance */

check('the guidance the agent gets is specific to the version', () => {
  const old = rendererGuidance('1.12.2')
  const modern = rendererGuidance('1.21.1')
  assert.notEqual(old, modern)
  assert.match(old, /GL11|LWJGL 2/i)
  assert.match(modern, /ShaderInstance|Blaze3D/)
})

check('the guidance names the API to write against in every era', () => {
  for (const v of ['1.12.2', '1.16.5', '1.21.1']) {
    const g = rendererGuidance(v)
    assert.match(g, /Rendering API/i, `${v} guidance has no API line`)
    assert.match(g, /Cannot/i, `${v} guidance does not say what is impossible`)
  }
})

check('the guidance warns about state leaks on every era', () => {
  // Unbalanced GL state is the single most common cause of "everything after my
  // render is broken", and it is version independent.
  for (const v of ['1.12.2', '1.16.5', '1.21.1']) {
    assert.match(rendererGuidance(v), /balanced|state/i, `${v} does not warn about GL state`)
  }
})

check('shader packs are separated from mod code in the guidance', () => {
  assert.match(rendererGuidance('1.21.1'), /shader \*?pack|shader pack/i)
})

console.log(`\n${passed} renderer checks passed`)
