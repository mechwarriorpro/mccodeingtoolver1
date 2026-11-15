/**
 * "Sometimes it says idle while the agent is still working."
 *
 * Two separate causes, and the tests below pin both because they fail in the
 * same visible way and neither is obvious from reading one file:
 *
 *   1. `handleMessage` announced idle on every `result` message. A result ends
 *      one *run*, not the turn — `runTurn` immediately starts another for a
 *      continuation, an automode retry, or a provider retry. The pill therefore
 *      read "idle" between two halves of the same job.
 *
 *   2. The renderer cleared `busy` on that idle and nothing re-set it until the
 *      next event, so the Stop button disappeared too — there was no way to
 *      interrupt a turn that was described as finished.
 *
 * These are source-level assertions. The behaviour is a React component talking
 * to an event emitter over IPC, and the honest way to test "does this emit idle
 * mid-turn" is to read the code that emits it: a mock of the SDK would be
 * testing the mock. The risk being guarded against is a future edit
 * reintroducing exactly the line this release removed.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')

const engine = read('src/main/agent/engine.ts')
const app = read('src/renderer/src/App.tsx')
const panel = read('src/renderer/src/components/ChatPanel.tsx')

/* --------------------------------------------------- main: who may say idle */

check('the result handler does not announce idle', () => {
  // Locate the real `case 'result':` label — the phrase also appears in the
  // comment that explains why idle is not emitted, so a plain indexOf finds the
  // comment first and the assertion then fails on the explanation itself.
  const label = /^\s*case 'result': \{/m.exec(engine)
  assert.ok(label, 'could not find the result handler')
  const start = label.index
  const rest = engine.slice(start + 10)
  const nextCase = rest.search(/^\s*case '/m)
  const block = nextCase > 0 ? rest.slice(0, nextCase) : rest
  // Strip comments: the docblock names the removed call on purpose.
  const code = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(
    code,
    /onStatus\(\s*'idle'\s*\)/,
    'the result handler ends a run, not the turn — runTurn may start another immediately'
  )
})

check('idle is announced from the turn’s own exit path', () => {
  // send()'s finally block is the one place that knows the turn is over.
  const sendIdx = app.length && engine.indexOf('async send(')
  assert.ok(sendIdx > 0)
  const finallyIdx = engine.indexOf('} finally {', sendIdx)
  const block = engine.slice(finallyIdx, finallyIdx + 400)
  assert.match(block, /onStatus\(\s*'idle'\s*\)/, 'the turn end must still say idle, or the pill never clears')
})

check('the turn-end idle is skipped when the user stopped it', () => {
  const sendIdx = engine.indexOf('async send(')
  const finallyIdx = engine.indexOf('} finally {', sendIdx)
  const block = engine.slice(finallyIdx, finallyIdx + 400)
  assert.match(block, /if \(!this\.stopped\)/, 'a stopped turn already said what happened; a second idle would be noise')
})

check('resumes and retries say what they are doing, not just "working"', () => {
  // Each onStatus('thinking') on a resume path carries a detail string.
  const resumePaths = [
    { name: 'continuation', re: /onStatus\('thinking',\s*`continuing/ },
    { name: 'automode resume', re: /onStatus\('thinking',\s*`\$\{verdict\.reason\}/ },
    { name: 'provider retry', re: /onStatus\('thinking',\s*`retrying/ }
  ]
  for (const p of resumePaths) {
    assert.match(engine, p.re, `${p.name} should carry a detail so the pill explains itself`)
  }
})

/* --------------------------------------------- renderer: busy must be honest */

check('a tool starting re-asserts busy', () => {
  // The registration, not the mention in a comment elsewhere in the file.
  const label = /api\.events\.onToolStart\(/g.exec(app)
  assert.ok(label, 'could not find the tool-start handler')
  const block = app.slice(label.index, label.index + 700)
  const code = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.match(code, /setBusy\(true\)/, 'a tool call is proof the turn is alive; a stray idle must not leave the pill wrong')
})

check('busy is cleared with the clock, not separately', () => {
  const idleIdx = app.indexOf("if (p.status === 'idle')")
  assert.ok(idleIdx > 0)
  const block = app.slice(idleIdx, idleIdx + 200)
  assert.match(block, /setBusy\(false\)/)
  assert.match(block, /setBusySince\(null\)/, 'the elapsed clock must stop with the turn, or it reads 40m on an idle agent')
})

check('the clock starts once per turn rather than resetting on every event', () => {
  // `t => t ?? Date.now()` keeps the first value; `Date.now()` would reset it.
  const occurrences = [...app.matchAll(/setBusySince\(\(t\) => t \?\? Date\.now\(\)\)/g)]
  assert.ok(occurrences.length >= 2, 'every event that starts a turn should preserve an existing start time')
  const resetting = [...app.matchAll(/setBusySince\(Date\.now\(\)\)/g)]
  assert.equal(resetting.length, 1, 'only the explicit "send a message" path may set a fresh value')
})

check('a failed send does not leave the clock running', () => {
  const start = app.indexOf('if (!res.ok)')
  const block = app.slice(start, start + 300)
  assert.match(block, /setBusySince\(null\)/, 'a turn that never started must not show elapsed time')
})

/* ------------------------------------------------------- the pill's honesty */

check('the pill distinguishes busy from idle and says why on hover', () => {
  assert.match(panel, /busy \? 'warn' : 'live'/)
  assert.match(panel, /title=\{busy \?/, 'hovering should explain the state, not just repeat the word')
})

check('the pill shows a moving elapsed time while busy', () => {
  assert.match(panel, /busySince\?: number \| null/)
  assert.match(panel, /status-elapsed/, 'a word that never changes is indistinguishable from a frozen window')
  assert.match(panel, /setInterval\(/, 'the elapsed text has to tick, or it is a static number')
})

check('the elapsed clock stops when idle', () => {
  assert.match(panel, /if \(!busy \|\| !busySince\) return/, 'otherwise a timer runs forever in the background')
})

check('elapsed minutes are formatted, not minutes-as-seconds', () => {
  assert.match(panel, /Math\.floor\(elapsed \/ 60\)/)
})

/* ---------------------------------------------------------------- the CSS */

check('the elapsed style exists, so it is not unstyled text', () => {
  const css = read('src/renderer/src/styles.css')
  assert.match(css, /\.status-elapsed\s*\{/)
  assert.match(css, /tabular-nums/, 'a proportional clock jitters as the digits change')
})

console.log(`\n${failures.length ? `${failures.length} check(s) failed` : `all ${passed} status-idle checks passed`}`)
if (failures.length) process.exit(1)
