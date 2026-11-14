/**
 * The licence reminder: when it appears, when it must not, and that it never
 * locks anything.
 *
 * These are the checks that matter, because the reminder is the one place the app
 * asks for money. Getting it wrong in either direction is expensive: too eager and
 * the tool is a nag, too passive and the licence is invisible.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

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
  assert.match(text.unlicensed.detail, /double the licence fee/i)
  assert.match(text.unlicensed.detail, /30 days/i, 'a demand must start a clock')
})

check('a licensed user is never told the unlicensed fee applies to them', () => {
  const res = lic.recordLaunch({ launchCount: 99, key: 'MCFAABCDEFGH1234', lastNagAt: 0 })
  assert.equal(res.showReminder, false)
})

/* --------------------------------------------------------------- the price */

check('the price is stated as a number, not a negotiation', () => {
  const text = lic.reminderText({ launchCount: 15, key: '', lastNagAt: 0 })
  const all = text.body.join(' ')
  assert.match(all, /\$50/, 'a reminder that does not say the price loses the people who would pay')
  assert.match(all, /12 months/i)
})

check('an unlicensed user is told the price too, not just referred to the licence', () => {
  const summary = lic.licenceSummary({ launchCount: 20, key: '', lastNagAt: 0 })
  assert.match(summary.detail, /\$50/)
})

check('the licence file and the app agree on the price', () => {
  // The one thing that must not drift: a price in the app and a different price
  // in LICENSE is a contract argument nobody wins.
  const text = fs.readFileSync(path.join(process.cwd(), 'LICENSE'), 'utf8')
  assert.match(text, /AUD \$50/, 'LICENSE must name the base fee')
  const base = lic.LICENCE_TERMS.commercial.baseAud
  assert.equal(base, 50)
  assert.ok(text.includes(`$${base}`), 'the same figure must appear in both')
  assert.equal(lic.LICENCE_TERMS.commercial.termMonths, 12)
  assert.match(text, /TWELVE MONTHS/i, 'the term must be in the licence, not just the app')
})

check('unlicensed commercial use costs double the fee, and says so', () => {
  const base = lic.LICENCE_TERMS.commercial.baseAud
  const multiple = lic.LICENCE_TERMS.commercial.unlicensedMultiple
  assert.equal(multiple, 2)
  assert.equal(base * multiple, lic.LICENCE_TERMS.commercial.unlicensedYearAud)
  const text = lic.reminderText({ launchCount: 15, key: '', lastNagAt: 0 })
  assert.match(text.unlicensed.detail, /\$100/)
})

check('a licensed user is never sold the licence again', () => {
  const summary = lic.licenceSummary({ launchCount: 40, key: 'MCFAABCDEFGH1234', lastNagAt: 0 })
  assert.equal(summary.licensed, true)
  assert.doesNotMatch(summary.detail, /\$50/)
})

/* --------------------------------------------------- combinations and tiers */

check('one licence costs the base price, with no discount invented', () => {
  const q = lic.licencePrice(1)
  assert.equal(q.totalAud, 50)
  assert.equal(q.discountPercent, 0)
  assert.equal(q.tier, undefined)
})

check('the ladder is the set of numbers asked for', () => {
  assert.deepEqual(
    lic.PRICE_TIERS.map((t) => [t.minSeats, t.discountPercent]),
    [
      [25, 5],
      [50, 10],
      [75, 25],
      [100, 34]
    ]
  )
})

check('each threshold gets a real reduction, and the top is 34%', () => {
  const at25 = lic.licencePrice(25)
  const at50 = lic.licencePrice(50)
  const at75 = lic.licencePrice(75)
  const at100 = lic.licencePrice(100)
  assert.equal(at25.discountPercent, 5)
  assert.equal(at50.discountPercent, 10)
  assert.equal(at75.discountPercent, 25)
  assert.equal(at100.discountPercent, 34, 'the top of the ladder is 34% off')
  assert.equal(at100.perSeatAud, 33)
})

check('the 50% ceiling stays above the ladder, so no tier can exceed half price', () => {
  assert.equal(lic.LICENCE_TERMS.commercial.maxDiscountPercent, 50)
  for (const tier of lic.PRICE_TIERS) assert.ok(tier.discountPercent <= 50)
})

check('the discount is applied to the whole purchase, not bolted on', () => {
  const q = lic.licencePrice(50)
  assert.equal(q.listAud, 2500)
  assert.equal(q.totalAud, 2250, '10% off $2500')
  assert.equal(q.perSeatAud, 45)
})

check('a quantity break is flagged, because the invoice drops at one', () => {
  // 75 at $37.50 is $2812.50 while 74 at $45 is $3330. Ordinary volume pricing —
  // the buyer wanting 74 can order 75 and pay less — but the total falling
  // between two orders reads like an error, so it is labelled.
  assert.equal(lic.licencePrice(75).atQuantityBreak, true)
  assert.equal(lic.licencePrice(76).atQuantityBreak, false)
  assert.equal(lic.licencePrice(25).atQuantityBreak, true)
  assert.equal(lic.licencePrice(24).atQuantityBreak, false)
  assert.ok(lic.licencePrice(75).totalAud < lic.licencePrice(74).totalAud, 'the break is real')
  assert.ok(lic.licencePrice(100).totalAud < lic.licencePrice(99).totalAud)
})

check('per-licence price never rises as more are bought', () => {
  // The property that actually matters to a buyer comparing orders.
  let previous = Infinity
  for (let seats = 1; seats <= 260; seats++) {
    const per = lic.licencePrice(seats).perSeatAud
    assert.ok(per <= previous + 0.01, `${seats} licences cost $${per} each, more than ${seats - 1}`)
    previous = per
  }
})

check('the cap cannot be exceeded however many are bought', () => {
  for (const seats of [100, 500, 10000]) {
    const q = lic.licencePrice(seats)
    assert.ok(q.discountPercent <= 50, `${seats} seats got ${q.discountPercent}%`)
    assert.ok(q.perSeatAud >= 25, `${seats} seats fell to $${q.perSeatAud} each`)
  }
})

check('a quantity just below a threshold gets the lower rate, not the higher one', () => {
  // The boundary bug that costs someone a customer: 24 must not get the 25 price.
  assert.equal(lic.licencePrice(24).discountPercent, 0)
  assert.equal(lic.licencePrice(25).discountPercent, 5)
  assert.equal(lic.licencePrice(99).discountPercent, lic.PRICE_TIERS[2].discountPercent)
  assert.equal(lic.licencePrice(100).discountPercent, 34)
})

check('a nonsense quantity is treated as one licence, not as free', () => {
  for (const bad of [0, -5, Number.NaN, undefined]) {
    const q = lic.licencePrice(bad)
    assert.equal(q.seats, 1)
    assert.equal(q.totalAud, 50)
  }
})

check('money comes out to the cent, with no floating-point noise', () => {
  const q = lic.licencePrice(3)
  assert.equal(q.totalAud, 150)
  assert.match(q.summary, /\$150/)
  assert.doesNotMatch(q.summary, /\d\.\d{6,}/)
})

check('the quote reads as something a person can be sent', () => {
  const single = lic.licencePrice(1).summary
  assert.match(single, /AUD \$50/)
  assert.match(single, /12 months/)
  const team = lic.licencePrice(50).summary
  assert.match(team, /10%/)
  assert.match(team, /AUD \$2250/)
  assert.match(team, /per licence/i)
})

check('the licence file and the ladder agree at every threshold', () => {
  // A discount in the app that is absent from the terms is unenforceable.
  const text = fs.readFileSync(path.join(process.cwd(), 'LICENSE'), 'utf8')
  for (const q of [lic.licencePrice(25), lic.licencePrice(50), lic.licencePrice(75), lic.licencePrice(100)]) {
    assert.ok(text.includes(`${q.seats}`), `LICENSE must mention the ${q.seats} threshold`)
    assert.ok(text.includes(`$${q.perSeatAud}`), `LICENSE must state $${q.perSeatAud} per licence at ${q.seats}`)
  }
  assert.match(text, /maximum discount is 50%/i)
  assert.match(text, /one solo developer/i)
  assert.match(text, /one server/i)
})

check('unlicensed use is charged at the single-licence rate, never the combo rate', () => {
  // Otherwise a company could take the 50% discount by breaching the licence.
  const text = fs.readFileSync(path.join(process.cwd(), 'LICENSE'), 'utf8')
  assert.match(text, /NOT the discounted combination rate/i)
  const detail = lic.reminderText({ launchCount: 15, key: '', lastNagAt: 0 }).unlicensed.detail
  assert.match(detail, /\$100/)
})

console.log(`\n${failures.length ? `${failures.length} check(s) failed` : `all ${passed} licence checks passed`}`)
if (failures.length) process.exit(1)
