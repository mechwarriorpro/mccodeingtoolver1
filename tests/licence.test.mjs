/**
 * The licence reminder: when it appears, when it must not, and that it never
 * locks anything.
 *
 * These are the checks that matter, because the reminder is the one place the app
 * asks for money. Getting it wrong in either direction is expensive: too eager and
 * the tool is a nag, too passive and the licence is invisible.
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

const out = new URL('../out-test/main/licence.js', import.meta.url).href
const lic = await import(out)

const fresh = () => ({ launchCount: 0, key: '', lastNagAt: 0 })

/* ------------------------------------------------------------- counting */

check('nothing is shown before the fifteenth launch', () => {
  let state = fresh()
  for (let i = 0; i < 14; i++) {
    const res = lic.recordLaunch(state)
    assert.equal(res.showReminder, false, `launch ${i + 1} should not remind`)
    state = res.state
  }
  assert.equal(state.launchCount, 14)
})

check('the fifteenth launch is the one that shows it', () => {
  let state = fresh()
  let showed = false
  for (let i = 0; i < 15; i++) {
    const res = lic.recordLaunch(state)
    state = res.state
    if (res.showReminder) showed = true
  }
  assert.equal(showed, true)
  assert.equal(state.launchCount, 15)
})

check('dismissing resets the count, so the next reminder is 15 launches away', () => {
  // Not "every launch after the fifteenth" — that is the nag that made WinRAR a joke.
  let state = { ...fresh(), launchCount: 15 }
  state = lic.dismissReminder(state)
  assert.equal(state.launchCount, 0)
  const afterOne = lic.recordLaunch(state)
  assert.equal(afterOne.showReminder, false, 'the very next launch must not remind again')
})

check('a licensed user is never reminded, whatever the count', () => {
  const res = lic.recordLaunch({ launchCount: 99, key: 'MCFAABCDEFGH1234', lastNagAt: 0 })
  assert.equal(res.showReminder, false)
})

check('the reminder is shown at most once per session', () => {
  const res = lic.recordLaunch({ launchCount: 40, key: '', lastNagAt: 0 }, { sessionAlreadyNagged: true })
  assert.equal(res.showReminder, false)
  assert.equal(res.state.launchCount, 41, 'the launch is still counted')
})

check('the counter survives a missing or corrupt config field', () => {
  const res = lic.recordLaunch(undefined)
  assert.equal(res.state.launchCount, 1)
  assert.equal(res.showReminder, false)
})

/* --------------------------------------------------------- never mid-work */

check('the reminder never interrupts a running agent, build or download', () => {
  assert.equal(lic.mayInterrupt({}), true)
  assert.equal(lic.mayInterrupt({ agentRunning: true }), false)
  assert.equal(lic.mayInterrupt({ buildRunning: true }), false)
  assert.equal(lic.mayInterrupt({ downloadRunning: true }), false)
  assert.equal(lic.mayInterrupt({ agentRunning: true, buildRunning: true }), false)
})

/* ------------------------------------------------------------- the key */

check('a commercial key is recognised by shape', () => {
  assert.equal(lic.looksLikeCommercialKey('MCFA-ABCD-EFGH-1234'), true)
  assert.equal(lic.looksLikeCommercialKey('mcfaabcdefgh1234'), true, 'case does not matter')
})

check('a key that is not the right shape is refused, and says nothing is locked', () => {
  assert.equal(lic.looksLikeCommercialKey('hunter2'), false)
  assert.equal(lic.looksLikeCommercialKey('MCFA123'), false, 'too short')
  const summary = lic.licenceSummary({ launchCount: 20, key: 'hunter2', lastNagAt: 0 })
  assert.equal(summary.licensed, false)
  assert.match(summary.detail, /nothing has been locked/i)
})

check('a recorded key is reported as recorded, not as unlocked features', () => {
  const summary = lic.licenceSummary({ launchCount: 20, key: 'MCFA-ABCD-EFGH-1234', lastNagAt: 0 })
  assert.equal(summary.licensed, true)
  assert.match(summary.detail, /record/i)
})

check('an unlicensed user is told the terms, not shown a locked door', () => {
  const summary = lic.licenceSummary(fresh())
  assert.equal(summary.licensed, false)
  assert.match(summary.title, /free for solo/i)
  assert.match(summary.detail, /commercial use needs a licence/i)
})

/* --------------------------------------------------------------- the words */

check('the reminder says what is free and what is not, in that order', () => {
  const text = lic.reminderText({ launchCount: 15, key: '', lastNagAt: 0 })
  assert.match(text.title, /solo project/i)
  assert.ok(text.free.length > 0, 'a free list is what stops it reading as a paywall')
  assert.ok(text.commercial.length > 0)
  assert.ok(
    text.free.some((f) => /solo/i.test(f)),
    'a solo developer must recognise themselves as free'
  )
  assert.ok(
    text.commercial.some((c) => /company|studio|client|selling/i.test(c)),
    'a commercial user must recognise themselves as needing a licence'
  )
  assert.match(text.action, /free unless you are making money/i)
})

check('the terms cover the cases that make a licence actionable', () => {
  // A licence that only says "commercial use" is hard to act on; these are the
  // concrete clauses a claim would rest on.
  const joined = lic.LICENCE_TERMS.commercialFor.join(' ').toLowerCase()
  for (const phrase of ['selling', 'client', 'company']) {
    assert.ok(joined.includes(phrase), `the terms must name "${phrase}"`)
  }
})

check('the app never claims to detect a company', () => {
  // Deliberately the whole point: enforcement is legal, not technical. Nothing
  // in this module inspects the machine, the user or the git author.
  const text = lic.reminderText({ launchCount: 15, key: '', lastNagAt: 0 })
  const all = [text.title, ...text.body, ...text.free, ...text.commercial, text.action].join(' ').toLowerCase()
  assert.doesNotMatch(all, /detect|verify your (company|employer)|machine id/)
})

/* ------------------------------------------- what unlicensed use costs */

check('the unlicensed fee is stated in the app, not only in the licence file', () => {
  const text = lic.reminderText({ launchCount: 15, key: '', lastNagAt: 0 })
  assert.match(text.unlicensed.headline, /15%/)
  assert.match(text.unlicensed.detail, /whichever is greater/i)
})

check('the fee says it is a cost, never a way to buy permission', () => {
  // The distinction that keeps the clause enforceable: paying afterwards does not
  // make the use lawful, or it would be a licence rather than a penalty.
  const text = lic.reminderText({ launchCount: 15, key: '', lastNagAt: 0 })
  assert.match(text.unlicensed.basis, /never permitted/i)
  assert.match(text.unlicensed.basis, /not a way to buy permission/i)
})

check('the fee has a calculable fallback, so invisible revenue is still chargeable', () => {
  // 15% of revenue nobody can see is worth nothing; doubling the list price is a
  // number that exists whether or not the seller ever discloses anything.
  const text = lic.reminderText({ launchCount: 15, key: '', lastNagAt: 0 })
  assert.match(text.unlicensed.detail, /double the commercial licence fee/i)
  assert.match(text.unlicensed.detail, /30 days/i, 'a demand must start a clock')
})

check('a licensed user is never told the unlicensed fee applies to them', () => {
  const res = lic.recordLaunch({ launchCount: 99, key: 'MCFAABCDEFGH1234', lastNagAt: 0 })
  assert.equal(res.showReminder, false)
})

console.log(`\n${failures.length ? `${failures.length} check(s) failed` : `all ${passed} licence checks passed`}`)
if (failures.length) process.exit(1)
