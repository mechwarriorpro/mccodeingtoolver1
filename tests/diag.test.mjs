import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const diag = await import('../out-test/main/diag.js')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcb-diag-'))
const logPath = path.join(root, 'logs', 'agent.log')

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

console.log('levels')
diag.setDiagLogPath(logPath)

check('off is the default', () => assert.equal(diag.getDiagLevel(), 0))

check('the four levels are named', () => {
  assert.equal(diag.levelName(0), 'off')
  assert.equal(diag.levelName(1), 'errors')
  assert.equal(diag.levelName(2), 'verbose')
  assert.equal(diag.levelName(3), 'trace')
})

check('a level can be parsed from a number, a string or a name', () => {
  assert.equal(diag.parseLevel(2), 2)
  assert.equal(diag.parseLevel('3'), 3)
  assert.equal(diag.parseLevel('verbose'), 2)
  assert.equal(diag.parseLevel('nonsense'), 0)
  assert.equal(diag.parseLevel(99), 0)
})

console.log('\nwhat each level records')

const seen = []
diag.attachDiagSink({ onEntry: (e) => seen.push(e), logPath: () => logPath })
diag.clearDiagHistory()

// The three kinds of entry this cares about:
//   errors    -> level 1, must show at 1 and above
//   a tool call -> level 2
//   raw traffic -> level 3
function emitAll() {
  diag.log('app', 'error', 'an error', { detail: 1 }, 1)
  diag.log('tool', 'info', 'a tool call', { input: 1 }, 2)
  diag.log('sdk', 'raw', 'raw traffic', { frame: 1 }, 3)
}

diag.setDiagLevel(0)
emitAll()
check('off records nothing at all', () => {
  assert.equal(seen.length, 0)
  assert.equal(diag.diagHistory().length, 0)
})

diag.setDiagLevel(1)
const afterOn = seen.length
emitAll()
check('errors shows the error and nothing else', () => {
  const added = seen.slice(afterOn)
  const labels = added.map((e) => e.label)
  assert.ok(labels.includes('an error'), 'error missing')
  assert.ok(!labels.includes('a tool call'), 'tool call leaked into errors mode')
  assert.ok(!labels.includes('raw traffic'), 'raw traffic leaked into errors mode')
})

diag.setDiagLevel(2)
const afterVerbose = seen.length
emitAll()
check('every step adds the tool call but not raw traffic', () => {
  const labels = seen.slice(afterVerbose).map((e) => e.label)
  assert.ok(labels.includes('an error'))
  assert.ok(labels.includes('a tool call'))
  assert.ok(!labels.includes('raw traffic'))
})

diag.setDiagLevel(3)
const afterTrace = seen.length
emitAll()
check('everything adds the raw traffic', () => {
  const labels = seen.slice(afterTrace).map((e) => e.label)
  assert.ok(labels.includes('an error'))
  assert.ok(labels.includes('a tool call'))
  assert.ok(labels.includes('raw traffic'))
})

check('every entry carries a source, a level and a time', () => {
  for (const e of diag.diagHistory()) {
    assert.ok(e.source, 'no source')
    assert.ok(typeof e.level === 'number')
    assert.ok(e.at > 0)
    assert.ok(e.id)
  }
})

check('the history is capped rather than growing forever', () => {
  diag.setDiagLevel(3)
  for (let i = 0; i < 3200; i++) diag.log('app', 'debug', `noise ${i}`, undefined, 2)
  assert.ok(diag.diagHistory().length <= 3000, `history grew to ${diag.diagHistory().length}`)
})

console.log('\nthe log file')

diag.clearDiagHistory()
diag.setDiagLevel(2)
diag.log('agent', 'info', 'a marker line', { answer: 42 }, 2)

check('a written entry reaches the file', () => {
  const text = fs.readFileSync(logPath, 'utf8')
  assert.ok(text.includes('a marker line'), 'marker missing from the log')
  assert.ok(text.includes('42'), 'detail missing from the log')
})

check('the file records the source and level of each line', () => {
  const line = fs.readFileSync(logPath, 'utf8').trim().split('\n').find((l) => l.includes('a marker line'))
  assert.match(line, /INFO/)
  assert.match(line, /agent/)
})

check('turning the level down does not lose later errors', () => {
  diag.setDiagLevel(1)
  diag.log('app', 'error', 'a later error', undefined, 1)
  const text = fs.readFileSync(logPath, 'utf8')
  assert.ok(text.includes('a later error'), 'error not logged at level 1')
})

check('a missing log directory is created rather than throwing', () => {
  const nested = path.join(root, 'deep', 'deeper', 'x.log')
  diag.setDiagLogPath(nested)
  diag.setDiagLevel(2)
  diag.log('app', 'info', 'nested write', undefined, 2)
  assert.ok(fs.existsSync(nested))
  diag.setDiagLogPath(logPath)
})

console.log('\nserialising')

check('an Error becomes its message and stack', () => {
  const text = diag.safeJson(new Error('boom'))
  assert.match(text, /boom/)
  assert.match(text, /stack/)
})

check('a cycle does not throw', () => {
  const a = { name: 'a' }
  a.self = a
  const text = diag.safeJson(a)
  assert.match(text, /circular/)
})

check('a buffer is summarised, not dumped', () => {
  const text = diag.safeJson({ bytes: new Uint8Array(2048) })
  assert.match(text, /2048 bytes/)
})

check('long output is truncated with a note', () => {
  const text = diag.safeJson({ big: 'x'.repeat(9000) }, 200)
  assert.ok(text.length < 400)
  assert.match(text, /more characters/)
})

console.log('\nno stray numbers in the chat')

// The bug behind "sometimes it just says 0": a JSX guard of the form
//   {(text || m.tools?.length) && ...}
// yields the number 0 when there is no text and the tools array is empty, and
// React renders 0 — a blank assistant bubble containing a lone "0".
// Guarding the length with a comparison is the fix, so check no such guard
// survives anywhere in the renderer.
const rendererDir = path.join(process.cwd(), 'src', 'renderer', 'src')
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    return e.isDirectory() ? walk(full) : full.endsWith('.tsx') ? [full] : []
  })
}

check('no JSX guard renders a bare array length', () => {
  const offenders = []
  for (const file of walk(rendererDir)) {
    const text = fs.readFileSync(file, 'utf8')
    text.split('\n').forEach((line, i) => {
      // The dangerous form is a *bare* length used as truthiness:
      //   {x.length && (          -> renders 0 when empty
      //   {(a || b?.length) && (  -> renders 0 when both are empty
      // `!x.length` and `x.length > 0` are booleans and safe, so they are
      // excluded rather than flagged.
      // A guard is dangerous when any of its top-level terms *is* a length:
      //   {x.length && ...}            -> 0
      //   {(a || b?.length) && ...}    -> 0 when both are empty
      // `!x.length`, `x.length > 0` and `(a || b?.length > 0)` are booleans.
      const guard = line.match(/\{([^{}]*\.length[^{}]*)&&/)
      if (!guard) return
      const expr = guard[1].replace(/[()]/g, '')
      const terms = expr.split('||').map((t) => t.trim())
      const numeric = terms.filter((t) => /\.length$/.test(t))
      // Ignore terms that were negated or compared: those are booleans already.
      const dangerous = numeric.filter((t) => !t.startsWith('!') && !/[<>]=?|===|!==/.test(t))
      if (dangerous.length) {
        offenders.push(`${path.relative(rendererDir, file)}:${i + 1} ${line.trim()}`)
      }
    })
  }
  assert.deepEqual(offenders, [], `unguarded length in JSX:\n${offenders.join('\n')}`)
})

check('the chat guard compares instead of trusting the number', () => {
  const text = fs.readFileSync(path.join(rendererDir, 'components', 'ChatPanel.tsx'), 'utf8')
  assert.match(text, /\(m\.tools\?\.length \?\? 0\) > 0/)
})

console.log('\nthe empty-run message')

// A run that produced no prose is a real state, and the chat must say so
// rather than showing a blank bubble.
const engine = await import('../out-test/main/agent/engine.js')

check('the engine exports the error classifier it relies on', () => {
  assert.equal(typeof engine.classifyRunError, 'function')
})

fs.rmSync(root, { recursive: true, force: true })

if (process.exitCode) {
  console.log('\ndiagnostics checks failed')
} else {
  console.log(`\nall diagnostics checks passed (${passed})`)
}
