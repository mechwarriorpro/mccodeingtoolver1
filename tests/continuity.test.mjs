/**
 * A run that stops without finishing must not end the conversation.
 *
 * The bug these guard: Claude Code's SDK reports reaching its turn ceiling as a
 * `result` with `subtype: 'error_max_turns'`, `is_error: false` and an **empty**
 * `errors` array. The app read that as a failure, printed "Run failed." and went
 * idle — in the middle of a build, with the work half done. Nothing had failed.
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

const out = new URL('../out-test/main/agent/engine.js', import.meta.url).href
const eng = await import(out)

/* ------------------------------------------------------- what got cut short */

check('hitting the turn ceiling is continuable, not a failure', () => {
  const i = eng.classifyInterruption({ subtype: 'error_max_turns', is_error: false, num_turns: 120, errors: [] })
  assert.equal(i.kind, 'max-turns')
  assert.equal(i.continuable, true)
  assert.match(i.notice, /120/)
  assert.match(i.notice, /[Cc]ontinuing/)
})

check('hitting the turn ceiling does not say "failed"', () => {
  // The exact wording that made a half-finished build look like a crash.
  const i = eng.classifyInterruption({ subtype: 'error_max_turns', num_turns: 120 })
  assert.doesNotMatch(i.notice, /failed/i)
  assert.doesNotMatch(i.resumePrompt ?? '', /failed|error/i)
})

check('the spending cap is continuable and mentions the cap, not a fault', () => {
  const i = eng.classifyInterruption({ subtype: 'error_max_budget_usd' })
  assert.equal(i.kind, 'budget')
  assert.equal(i.continuable, true)
  assert.match(i.notice, /spending cap|budget/i)
  assert.match(i.notice, /Settings/)
})

check('a mid-execution stop with no cause is continuable', () => {
  const i = eng.classifyInterruption({ subtype: 'error_during_execution', errors: [] })
  assert.equal(i.kind, 'execution')
  assert.equal(i.continuable, true)
})

check('a mid-execution stop WITH a cause is not silently resumed', () => {
  // If the SDK names a reason, that reason is what the user needs to see; hiding
  // it behind "continuing..." would bury a real problem.
  const i = eng.classifyInterruption({ subtype: 'error_during_execution', errors: ['ENOSPC: no space left on device'] })
  assert.equal(i.kind, 'fatal')
  assert.equal(i.continuable, false)
  assert.match(i.notice, /no space left/)
})

check('a successful run is not an interruption', () => {
  const i = eng.classifyInterruption({ subtype: 'success' })
  assert.equal(i.continuable, false)
  assert.equal(i.notice, '')
})

check('an unknown result shape does not get resumed blindly', () => {
  const i = eng.classifyInterruption({ subtype: 'something_new' })
  assert.equal(i.continuable, false)
})

/* --------------------------------------------------------- the resume turn */

check('the resume prompt asks for continuation, never a restart', () => {
  const i = eng.classifyInterruption({ subtype: 'error_max_turns', num_turns: 120 })
  const prompt = eng.continuationPrompt(i, 1)
  assert.match(prompt, /carry on|continue/i)
  // The failure mode this prevents: re-reading every file it already read and
  // burning the whole ceiling again before touching a line of code.
  assert.match(prompt, /do not restart/i)
})

check('later continuations ask for economy, and say which one this is', () => {
  const i = eng.classifyInterruption({ subtype: 'error_max_turns', num_turns: 120 })
  const first = eng.continuationPrompt(i, 1)
  const third = eng.continuationPrompt(i, 3)
  assert.doesNotMatch(first, /continuation 3/)
  assert.match(third, /continuation 3 of/)
  assert.match(third, /economical/i)
})

check('there is a hard limit on resuming, so a loop cannot run forever', () => {
  assert.equal(eng.MAX_CONTINUATIONS, 3)
  assert.ok(eng.MAX_CONTINUATIONS >= 1)
})

check('every continuable kind has a resume prompt to send', () => {
  for (const subtype of ['error_max_turns', 'error_max_budget_usd', 'error_during_execution']) {
    const i = eng.classifyInterruption({ subtype })
    if (!i.continuable) continue
    assert.ok(i.resumePrompt && i.resumePrompt.length > 20, `${subtype} needs a prompt`)
  }
})

/* -------------------------------------------- the existing failure handling */

check('a provider failure is still classified as one, not as an interruption', () => {
  const i = eng.classifyRunError(new Error('529 overloaded_error'))
  assert.equal(i.kind, 'overloaded')
  assert.equal(i.retryable, true)
})

check('a bad key is still fatal and says what to do', () => {
  const i = eng.classifyRunError(new Error('401 authentication_error'))
  assert.equal(i.kind, 'auth')
  assert.equal(i.retryable, false)
  assert.match(i.message, /Settings/)
})

console.log(`\n${failures.length ? `${failures.length} check(s) failed` : `all ${passed} continuity checks passed`}`)
if (failures.length) process.exit(1)
