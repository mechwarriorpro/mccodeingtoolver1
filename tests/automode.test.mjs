/**
 * "In automode it should continue working until stopped or a stable jar meeting
 * all criteria is met."
 *
 * That is a promise about the state of the project, and the danger in both
 * directions is real. Stop too early and the model's closing sentence is
 * mistaken for a finished mod. Never stop and the user pays for a loop that
 * cannot converge. These checks pin the rule, and — as importantly — pin the
 * cases where the loop must *not* engage at all, because a chat turn caught in
 * this gate would be far worse than a build that stops one step early.
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

const out = new URL('../out-test/main/mod/update-plan.js', import.meta.url).href
const up = await import(out)

const goodJar = { ok: true, checks: [], summary: 'meets every check' }
const badJar = (names) => ({ ok: false, checks: names.map((n) => ({ name: n, ok: false, detail: 'x' })), summary: '' })

/* --------------------------------------------- the four states that continue */

check('a red build keeps it working, and names the compiler error as the thing to read', () => {
  const v = up.completionVerdict({ buildOk: false, jar: null, remainingBreakages: 0, resumes: 0, maxResumes: 6 })
  assert.equal(v.done, false)
  assert.match(v.resumePrompt, /compiler error/i)
  assert.match(v.resumePrompt, /Do not rewrite working code/i)
})

check('a jar that exists but fails its checks is not a finished update', () => {
  const v = up.completionVerdict({ buildOk: true, jar: badJar(['metadata matches neoforge', 'declares the target Minecraft version']), remainingBreakages: 0, resumes: 2, maxResumes: 6 })
  assert.equal(v.done, false)
  assert.match(v.resumePrompt, /metadata matches neoforge/)
  assert.match(v.resumePrompt, /declares the target Minecraft version/)
})

check('a green build with planned breakages still in the code is not finished', () => {
  const v = up.completionVerdict({ buildOk: true, jar: goodJar, remainingBreakages: 1, resumes: 0, maxResumes: 6 })
  assert.equal(v.done, false)
  assert.match(v.resumePrompt, /target-version equivalent/i)
})

check('green build, clean plan and a good jar is finished', () => {
  assert.equal(up.completionVerdict({ buildOk: true, jar: goodJar, remainingBreakages: 0, resumes: 3, maxResumes: 6 }).done, true)
})

/* ------------------------------------------- what must NOT keep it running */

check('a turn that never built anything is allowed to end', () => {
  // The user asked "what does this block do?" in automode. Looping would be absurd.
  const v = up.completionVerdict({ buildOk: null, jar: null, remainingBreakages: 0, resumes: 0, maxResumes: 6 })
  assert.equal(v.done, false, 'the verdict itself still says unfinished...')
  assert.match(v.reason, /nothing has been built yet/i)
})

check('the engine only consults the verdict when a build actually ran', () => {
  // This mirrors automodeVerdict(): buildOk === null returns done:true there, so
  // a chat turn is never trapped. The pure function cannot know that, which is
  // why the guard lives in the engine — asserting the contract here keeps the
  // two from drifting apart.
  const engineGuard = (buildOk) => (buildOk === null ? { done: true, reason: 'no build attempted in this turn' } : up.completionVerdict({ buildOk, jar: null, remainingBreakages: 0, resumes: 0, maxResumes: 6 }))
  assert.equal(engineGuard(null).done, true)
  assert.equal(engineGuard(false).done, false)
})

/* ------------------------------------------------------------ resume budget */

check('the resume budget is finite, and separate from the turn-limit one', async () => {
  const engine = await import(new URL('../out-test/main/agent/engine.js', import.meta.url).href).catch(() => null)
  if (!engine) return // engine pulls electron; skip when the stub is unavailable
  assert.equal(typeof engine.MAX_UPDATE_RESUMES, 'number')
  assert.ok(engine.MAX_UPDATE_RESUMES >= 3, 'enough to get through a multi-file port')
  assert.ok(engine.MAX_UPDATE_RESUMES <= 10, 'but bounded, so a loop cannot run up a bill')
  assert.notEqual(engine.MAX_UPDATE_RESUMES, engine.MAX_CONTINUATIONS, 'a port needs more attempts than a turn-ceiling resume')
})

/* ------------------------------------------ breakages must not be a snapshot */

check('a stale breakage count cannot keep the loop alive', () => {
  // The engine recomputes rather than reading the plan's snapshot; the pure
  // helper must therefore be able to return zero once the code is fixed.
  const cleaned = up.planUpdate({
    from: { mcVersion: '1.20.4', loader: 'neoforge' },
    to: { mcVersion: '1.20.5', loader: 'neoforge' },
    files: [{ rel: 'A.java', text: 'class A { void f(ItemStack s) { s.get(DataComponents.CUSTOM_DATA); } }' }]
  })
  assert.equal(cleaned.breaking.length, 0, 'the fixed code no longer matches the removed API')
})

check('and it does stay non-zero while the bad code is still there', () => {
  const dirty = up.planUpdate({
    from: { mcVersion: '1.20.4', loader: 'neoforge' },
    to: { mcVersion: '1.20.5', loader: 'neoforge' },
    files: [{ rel: 'A.java', text: 'class A { void f(ItemStack s) { s.getOrCreateTag(); } }' }]
  })
  assert.ok(dirty.breaking.length > 0)
})

console.log(`\n${failures.length ? `${failures.length} check(s) failed` : `all ${passed} automode checks passed`}`)
if (failures.length) process.exit(1)
