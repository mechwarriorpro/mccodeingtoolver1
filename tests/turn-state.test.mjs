/**
 * "Agent still sometimes shows idle when it's still working" — the second report.
 *
 * v0.5.9 fixed the first cause: `handleMessage` announced idle on every `result`
 * message, though a result ends one *run*, not the turn. That was real and it is
 * still fixed. It was not the whole story, and these are the remaining ways the
 * pill could go quiet over live work:
 *
 *   1. The renderer cleared `busy` on `agent:result` and only re-set it on a tool
 *      call or a text delta. Between two runs of one turn — automode resuming
 *      toward a finished jar, a continuation, a provider retry — there is a
 *      stretch with no tool call and no text, because the model is thinking. The
 *      pill read "idle" for all of it, and the Stop button was gone with it.
 *
 *   2. `onStatus` only ever *cleared* busy. `thinking` updated the label and
 *      nothing else, so once busy had been dropped by anything at all, main
 *      saying "thinking" could not put it back.
 *
 *   3. A window reloaded mid-turn had no event history and no way to ask, so it
 *      drew "idle" over a running build until the next tool call happened to
 *      arrive — and a run that is thinking produces no tool calls.
 *
 * The first two are tested against the real compiled engine, because they are
 * statements about a state machine and a mock of it would be testing the mock.
 * The third is tested against the source, since it is wiring between processes.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
async function checkAsync(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (e) {
    failures.push(name)
    console.log(`  FAIL ${name}\n       ${e.message}`)
  }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')

/*
 * `pathToFileURL`, not `path.join`.
 *
 * On Linux a bare absolute path happens to work in `import()`. On Windows it
 * does not: `C:\...` parses as a URL with scheme "c", and Node rejects it with
 * ERR_UNSUPPORTED_ESM_URL_SCHEME. That is exactly how this test passed locally
 * and failed in CI, where the runner is Windows. A path is not a URL.
 */
const { AgentSession } = await import(pathToFileURL(path.join(root, 'out-test/main/agent/engine.js')).href)

/**
 * An event sink that records what main told the UI.
 *
 * `idle` is the only status that may be announced while a turn is running, so
 * the record is checked as a sequence rather than a set: order is the whole
 * point. A stray idle followed by more work is exactly the reported bug.
 */
function recorder() {
  const seen = []
  const events = {}
  for (const name of [
    'onAssistantText',
    'onThinking',
    'onAssistantBlock',
    'onToolStart',
    'onToolEnd',
    'onPermissionRequest',
    'onPermissionResolved',
    'onResult',
    'onNotice',
    'onModelSwitch',
    'onOutput',
    'onGameStatus'
  ]) {
    events[name] = () => {}
  }
  events.onStatus = (status, detail) => seen.push({ status, detail })
  return { events, seen }
}

/* ------------------------------------------------ engine: the turn's clock */

check('a fresh engine is idle, with no turn running', () => {
  const { events } = recorder()
  const s = new AgentSession(events, 'auto', undefined, () => '')
  assert.deepEqual(s.state, { busy: false, startedAt: null })
  assert.equal(s.active, false)
})

/* -------------------------------- engine: only the turn may end the turn */

check('the result handler still does not announce idle', () => {
  // The v0.5.9 fix. Kept here as well as in status-idle.test.mjs because this
  // file is about the same symptom and a regression here would be invisible
  // from the other file if the two ever drift.
  const engine = read('src/main/agent/engine.ts')
  const label = /^\s*case 'result': \{/m.exec(engine)
  assert.ok(label, 'could not find the result handler')
  const rest = engine.slice(label.index + 10)
  const nextCase = rest.search(/^\s*case '/m)
  const block = nextCase > 0 ? rest.slice(0, nextCase) : rest
  const code = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(code, /onStatus\(\s*'idle'\s*\)/, 'a result ends a run; runTurn may start another immediately')
})

await checkAsync('a send that is refused does not leave the agent looking busy', async () => {
  const { events } = recorder()
  const s = new AgentSession(events, 'auto', undefined, () => '')
  // Pretend a run is in flight: `current` set is what the guard must respect,
  // even though `interrupt()` may already have cleared `busy`.
  s.busy = false
  s.current = { interrupt: async () => {} }
  // Stubbed for the same reason as the next check: a missing guard must fail
  // this suite, not send it into a provider call and hang.
  let turned = 0
  s.runTurn = () => {
    turned++
    return Promise.resolve()
  }
  await assert.rejects(() => s.send('a follow-up'), /already running/i)
  assert.equal(turned, 0, 'send() began a run instead of refusing the message')
  assert.equal(s.state.busy, false, 'a rejected message must not claim the turn')
})

await checkAsync('a message that arrives while the turn is unwinding is refused, not swallowed', async () => {
  /*
   * The original code accepted this message, pushed it onto the queue, and
   * returned early. The run it was queued for had already finished reading that
   * queue, so the message was never executed — the turn ended, the pill said
   * idle, and the user's follow-up silently did nothing. Refusing it is the
   * honest outcome: the user is told, and nothing is lost in a dead queue.
   *
   * `runTurn` is stubbed out so this measures the guard and nothing else. Left
   * real, a missing guard sends the test into a live provider call, and the
   * whole suite hangs instead of failing — which is how this assertion first
   * went wrong.
   */
  const { events, seen } = recorder()
  const s = new AgentSession(events, 'auto', undefined, () => '')
  let ranTurn = 0
  s.runTurn = () => {
    ranTurn++
    return Promise.resolve()
  }
  s.busy = false
  s.current = { interrupt: async () => {} }
  await assert.rejects(() => s.send('second message'), /already running/i, 'the message has no live consumer, so it must be refused')
  assert.equal(ranTurn, 0, 'send() started a run while an old one was still unwinding')
  assert.equal(seen.filter((e) => e.status === 'idle').length, 0, 'nothing was running, so nothing may be declared idle')
  s.current = null
})

await checkAsync('the state clock is cleared by a stop', async () => {
  const { events, seen } = recorder()
  const s = new AgentSession(events, 'auto', undefined, () => '')
  s.busy = true
  s.turnStartedAt = Date.now() - 5000
  await s.interrupt()
  assert.deepEqual(s.state, { busy: false, startedAt: null }, 'a stopped turn must not leave a clock running')
  assert.ok(seen.some((e) => e.status === 'idle'), 'the user pressed Stop and needs to see it took effect')
})

/* ----------------------------- engine: automode's resumes stay "working" */

check('every resume path announces what it is doing before starting again', () => {
  /*
   * The pill shows `statusDetail` when there is one, so a resume that emitted a
   * bare `thinking` would show the word "working" for four minutes with no
   * reason. Each of these carries its reason.
   */
  const engine = read('src/main/agent/engine.ts')
  for (const [name, re] of [
    ['continuation', /onStatus\('thinking',\s*`continuing/],
    ['automode resume', /onStatus\('thinking',\s*`\$\{verdict\.reason\}/],
    ['provider retry', /onStatus\('thinking',\s*`retrying/]
  ]) {
    assert.match(engine, re, `${name} should say why it is still working`)
  }
})

check('the idles inside runTurn are only the give-up exits', () => {
  /*
   * runTurn may announce idle in exactly two places: the continuation ceiling
   * and automode's resume ceiling. Both end the turn and say so. Any *other*
   * idle in there is the v0.5.9 bug coming back, because runTurn starts the
   * next run as soon as the current one returns.
   */
  const engine = read('src/main/agent/engine.ts')
  const stripped = engine.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const runTurnStart = stripped.indexOf('private async runTurn(')
  assert.ok(runTurnStart > 0, 'could not find runTurn')
  const interruptStart = stripped.indexOf('async interrupt(', runTurnStart)
  const body = stripped.slice(runTurnStart, interruptStart)
  // Each legitimate idle is immediately followed by clearing `busy` and leaving
  // the loop — that shape is what distinguishes "the turn is over" from "this
  // run is over".
  const idles = [...body.matchAll(/onStatus\(\s*'idle'\s*\)/g)]
  assert.equal(idles.length, 2, `expected the two give-up exits, found ${idles.length}`)
  for (const m of idles) {
    const after = body.slice(m.index, m.index + 160)
    assert.match(after, /this\.busy = false/, 'a turn-ending idle must also clear the flag')
    assert.match(after, /this\.turnStartedAt = null/, 'and the clock, or the next turn starts hours ago')
    assert.match(after, /return/, 'and actually leave, rather than falling through to another run')
  }
})

/* ------------------------------------------ renderer: the pill's authority */

const app = read('src/renderer/src/App.tsx')

check('the renderer does not clear busy on a run result', () => {
  /*
   * This is the fix for the reported symptom. `agent:result` is emitted at the
   * end of every run; `agent:status idle` is emitted at the end of the turn.
   * Only the second may clear the flag.
   */
  const idx = app.indexOf('api.events.onResult(')
  assert.ok(idx > 0, 'could not find the result handler')
  const end = app.indexOf('\n      }),', idx)
  const block = app.slice(idx, end > 0 ? end : idx + 2500)
  const code = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(code, /setBusy\(false\)/, 'a result ends a run, not the turn — automode resumes right after one')
  assert.doesNotMatch(code, /setBusySince\(null\)/, 'the clock must keep running across a run boundary')
})

check('a live status re-asserts busy, so idle cannot get stuck on', () => {
  const idx = app.indexOf("if (p.status === 'idle')")
  assert.ok(idx > 0)
  const block = app.slice(idx, idx + 700)
  const code = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.match(code, /setBusy\(true\)/, 'main saying "thinking" is main saying the turn is alive')
  assert.match(code, /setBusySince\(\(t\) => t \?\? Date\.now\(\)\)/, 'a live status must not reset a clock that is already running')
})

/* ------------------------------------- renderer: a reloaded window can ask */

check('the renderer asks main whether a turn is running', () => {
  assert.match(app, /api\.chat\.state\(\)/, 'a reloaded window has no events to replay and must ask')
})

check('the ask happens at startup, not only on an event', () => {
  const idx = app.indexOf('// ---------------- bootstrap ----------------')
  assert.ok(idx > 0)
  const block = app.slice(idx, idx + 1400)
  assert.match(block, /syncTurnState\(\)/, 'opening the window mid-turn must not draw an idle pill')
})

check('the ask repeats when the window is shown again', () => {
  assert.match(app, /addEventListener\('focus'/, 're-focusing is when a stale pill is noticed')
  assert.match(app, /visibilitychange/, 'a minimised window gets no events')
  assert.match(app, /removeEventListener\('focus'/, 'a listener added in an effect has to be removed with it')
})

check('the state channel is wired through main, preload and the typed api', () => {
  const main = read('src/main/ipc/index.ts')
  const preload = read('src/preload/index.ts')
  const api = read('src/renderer/src/lib/api.ts')
  assert.match(main, /ipcMain\.handle\('chat:state'/, 'main has to answer the question')
  assert.match(preload, /state:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('chat:state'\)/, 'preload has to forward it')
  assert.match(api, /state:\s*\(\)\s*=>\s*Promise<\{ busy: boolean; startedAt: number \| null \}>/, 'and the renderer needs the type')
})

check('main answers from the engine that owns the turn', () => {
  const main = read('src/main/ipc/index.ts')
  const idx = main.indexOf("ipcMain.handle('chat:state'")
  assert.ok(idx > 0)
  const block = main.slice(idx, idx + 200)
  assert.match(block, /session\?\.state/, 'the answer must be the engine\'s, not a guess')
})

/* ---------------------------------- main: a reset cannot orphan a live turn */

check('a session reset waits for the running turn instead of dropping it', () => {
  /*
   * `resetSession` is called from a dozen places — switching project, changing
   * instance, linking reference sources — and any of them can fire mid-build.
   * Nulling the session then answers "not busy" for a turn that is still going,
   * and a second send would start a second engine alongside the first.
   */
  const main = read('src/main/ipc/index.ts')
  const idx = main.indexOf('function resetSession()')
  assert.ok(idx > 0)
  const block = main.slice(idx, idx + 400)
  assert.match(block, /session\?\.active/, 'a live turn is a reason to defer, not to drop')
  assert.match(block, /resetWhenIdle/, 'the deferred reset has to be remembered')
})

check('the deferred reset runs when the turn ends', () => {
  const main = read('src/main/ipc/index.ts')
  assert.match(main, /if \(status === 'idle' && resetWhenIdle\)/, 'otherwise the reset never happens and the old engine outlives the switch')
})

console.log(`\n${failures.length ? `${failures.length} check(s) failed` : `all ${passed} turn-state checks passed`}`)
if (failures.length) process.exit(1)
