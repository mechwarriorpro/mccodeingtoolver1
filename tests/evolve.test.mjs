import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const metrics = await import('../out-test/main/evolve/metrics.js')
const genome = await import('../out-test/main/evolve/genome.js')
const evaluate = await import('../out-test/main/evolve/evaluate.js')
const loop = await import('../out-test/main/evolve/loop.js')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcb-evolve-'))
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

console.log('the four rules become words')
const rules = { quality: 70, speed: 10, size: 10, ram: 10 }

check('the weights are normalized into percentages', () => {
  const text = metrics.rulesToInstructions(rules)
  assert.match(text, /Quality of code: 70%/)
  assert.match(text, /Speed to build: 10%/)
})

check('the heaviest weight is named as the priority', () => {
  assert.match(metrics.rulesToInstructions(rules), /\*\*Quality of code is the priority/i)
  assert.match(metrics.rulesToInstructions({ quality: 0, speed: 0, size: 0, ram: 100 }), /\*\*RAM used is the priority/i)
})

check('a zero weight is explicit permission to trade it away', () => {
  const text = metrics.rulesToInstructions({ quality: 100, speed: 0, size: 0, ram: 0 })
  assert.match(text, /may sacrifice/i)
  assert.match(text, /quality/i)
})

check('a ram-first generation is told what that means in code', () => {
  const text = metrics.rulesToInstructions({ quality: 10, speed: 10, size: 10, ram: 70 })
  assert.match(text, /light to compile and run/i)
  assert.match(text, /static initialisation/i)
})

check('a hardware limit becomes a hard instruction', () => {
  assert.match(metrics.rulesToInstructions(rules, { maxHeapMb: 512 }), /512 MB/)
})

check('all-zero weights do not divide by zero', () => {
  const text = metrics.rulesToInstructions({ quality: 0, speed: 0, size: 0, ram: 0 })
  assert.ok(text.length > 0)
})

console.log('\nmeasuring is real')

check('source bytes are counted from disk, not guessed', () => {
  const dir = path.join(root, 'src-measure')
  fs.mkdirSync(path.join(dir, 'src/main/java/a'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src/main/java/a/A.java'), 'x'.repeat(500))
  fs.writeFileSync(path.join(dir, 'src/main/java/a/B.java'), 'y'.repeat(300))
  const m = metrics.measureSources(dir)
  assert.equal(m.sourceFiles, 2)
  assert.ok(m.sourceBytes >= 800, `got ${m.sourceBytes}`)
})

check('build output is not counted as source', () => {
  const dir = path.join(root, 'src-skip')
  fs.mkdirSync(path.join(dir, 'build/classes'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src/A.java'), 'x'.repeat(100))
  fs.writeFileSync(path.join(dir, 'build/classes/A.java'), 'y'.repeat(9999))
  assert.ok(metrics.measureSources(dir).sourceBytes < 500)
})

check('an unreadable jar measures zero rather than throwing', () => {
  assert.deepEqual(metrics.measureJar(path.join(root, 'nope.jar')), { classBytes: 0, classCount: 0 })
})

console.log('\nscoring')

const baseline = { classBytes: 10_000, sourceBytes: 5_000, buildMs: 1000, minHeapMb: 256, errorCount: 0 }
function m(patch) {
  return {
    builds: true,
    errorCount: 0,
    classBytes: 10_000,
    classCount: 10,
    sourceBytes: 5_000,
    sourceFiles: 2,
    buildMs: 1000,
    minHeapMb: 256,
    note: '',
    ...patch
  }
}

check('an identical generation scores exactly 1.0', () => {
  const s = metrics.scoreGeneration(m({}), baseline, rules)
  assert.ok(Math.abs(s.score - 1) < 0.001, `got ${s.score}`)
})

check('a generation that does not compile scores exactly zero, however small', () => {
  const s = metrics.scoreGeneration(m({ builds: false, errorCount: 3, classBytes: 1, sourceBytes: 1, buildMs: 1 }), baseline, {
    quality: 70,
    speed: 10,
    size: 10,
    ram: 10
  })
  assert.equal(s.parts.quality, 0)
  assert.equal(s.score, 0, `a non-compiling generation scored ${s.score}`)
  // ...even when the rules weight size and speed far above quality.
  const sizeFirst = metrics.scoreGeneration(
    m({ builds: false, errorCount: 3, classBytes: 1, sourceBytes: 1, buildMs: 1 }),
    baseline,
    { quality: 1, speed: 50, size: 49, ram: 0 }
  )
  assert.equal(sizeFirst.score, 0, 'a size-weighted run promoted code that does not build')
})

check('using half the RAM raises the ram part', () => {
  const s = metrics.scoreGeneration(m({ minHeapMb: 128 }), baseline, rules)
  assert.ok(s.parts.ram > 1, `ram part was ${s.parts.ram}`)
})

check('a halved build time raises the speed part', () => {
  const s = metrics.scoreGeneration(m({ buildMs: 500 }), baseline, rules)
  assert.ok(s.parts.speed > 1)
})

check('halving the size raises the size part', () => {
  const s = metrics.scoreGeneration(m({ classBytes: 5_000, sourceBytes: 2_500 }), baseline, rules)
  assert.ok(s.parts.size > 1)
})

check('a freak result cannot dominate the score', () => {
  const s = metrics.scoreGeneration(m({ buildMs: 1 }), baseline, rules)
  assert.ok(s.parts.speed <= 1.5, `speed part was ${s.parts.speed}`)
})

check('an unmeasurable RAM figure is not counted as an improvement', () => {
  const s = metrics.scoreGeneration(m({ minHeapMb: null }), baseline, rules)
  assert.equal(s.parts.ram, 1)
})

check('the first generation is scored on quality alone', () => {
  const s = metrics.scoreGeneration(m({}), null, rules)
  assert.equal(s.score, 1)
  assert.match(s.note, /first generation/i)
})

check('weights actually change the ranking', () => {
  // Half the size, but slower: prefers size, dislikes speed.
  const smaller = m({ classBytes: 5_000, sourceBytes: 2_500, buildMs: 1500 })
  const sizeFirst = metrics.scoreGeneration(smaller, baseline, { quality: 0, speed: 0, size: 100, ram: 0 }).score
  const speedFirst = metrics.scoreGeneration(smaller, baseline, { quality: 0, speed: 100, size: 0, ram: 0 }).score
  assert.ok(sizeFirst > speedFirst, `size-first ${sizeFirst} should beat speed-first ${speedFirst}`)
})

console.log('\nthe genome is fenced in')

check('only the three evolvable files are accepted', () => {
  const dir = path.join(root, 'genome-scope')
  fs.mkdirSync(dir, { recursive: true })
  const res = genome.writeGenome({
    dir,
    edits: [
      { path: 'src/main/agent/prompt.ts', text: 'export const x = 1\n' },
      { path: 'src/main/ipc/index.ts', text: 'evil()\n' },
      { path: 'src/main/evolve/metrics.ts', text: 'rigged()\n' }
    ]
  })
  assert.deepEqual(res.written, ['src/main/agent/prompt.ts'])
  assert.equal(res.rejected.length, 2)
  // `ipc/index.ts` is not in the genome at all; `evolve/metrics.ts` is the code
  // that does the scoring. The second reason must name that, because it is the
  // guarantee that matters — a mutation cannot rewrite its own judge.
  const ipc = res.rejected.find((r) => r.path.includes('ipc'))
  const metricsRej = res.rejected.find((r) => r.path.includes('evolve/metrics'))
  assert.ok(ipc, 'ipc/index.ts was accepted')
  assert.ok(metricsRej, 'evolve/metrics.ts was accepted')
  assert.ok(/protected/.test(metricsRej.reason), `metrics rejection said: ${metricsRej.reason}`)
  assert.ok(!res.rejected.some((r) => /not one of the evolvable/.test(r.reason) && r.path.includes('evolve/')), 'the judge was only weakly refused')
})

check('an empty file is rejected', () => {
  const dir = path.join(root, 'genome-empty')
  fs.mkdirSync(dir, { recursive: true })
  const res = genome.writeGenome({ dir, edits: [{ path: 'src/main/agent/prompt.ts', text: '   ' }] })
  assert.equal(res.ok, false)
  assert.ok(/empty/.test(res.rejected[0].reason))
})

check('an implausibly large file is rejected', () => {
  const dir = path.join(root, 'genome-big')
  fs.mkdirSync(dir, { recursive: true })
  const res = genome.writeGenome({ dir, edits: [{ path: 'src/main/agent/prompt.ts', text: 'x'.repeat(500_000) }] })
  assert.equal(res.ok, false)
  assert.ok(/large/.test(res.rejected[0].reason))
})

check('the protected list covers the code that does the evaluating', () => {
  for (const p of ['src/main/evolve/', 'src/main/build/', 'src/main/agent/engine.ts']) {
    assert.ok(genome.PROTECTED.some((x) => p.startsWith(x)), `${p} is not protected`)
  }
})

console.log('\nparsing the mutator')

check('file blocks and the thesis are extracted', () => {
  const reply = [
    'Here you go.',
    '```file src/main/agent/prompt.ts',
    'export const a = 1',
    '```',
    '```file src/main/agent/tools.ts',
    'export const b = 2',
    '```',
    'THESIS: tighter build instructions'
  ].join('\n')
  const parsed = loop.parseMutation(reply)
  assert.equal(parsed.edits.length, 2)
  assert.equal(parsed.edits[0].path, 'src/main/agent/prompt.ts')
  assert.match(parsed.edits[1].text, /export const b/)
  assert.equal(parsed.thesis, 'tighter build instructions')
})

check('a reply with no blocks yields no edits, not a crash', () => {
  assert.deepEqual(loop.parseMutation('I could not do it.').edits, [])
})

check('a code fence without a path is not treated as a file', () => {
  assert.equal(loop.parseMutation('```java\nclass A {}\n```').edits.length, 0)
})

console.log('\nextracting the answer')

check('a fenced java block is found', () => {
  assert.match(evaluate.extractJava('sure\n```java\npackage a;\nclass A {}\n```\n'), /package a;/)
})

check('an unfenced answer starting at package is accepted', () => {
  assert.match(evaluate.extractJava('package a;\npublic class A {}'), /public class A/)
})

check('prose with no code yields null', () => {
  assert.equal(evaluate.extractJava('I think you should use DeferredRegister.'), null)
})

console.log('\nthe loop refuses to promote garbage')

async function asyncChecks() {
  const evalRoot = path.join(root, 'eval-noncompile')
  // An answer that cannot compile must score zero and must not be promoted.
  const res = await evaluate.evaluateGenome({
    ask: async () => '```java\npackage a;\nthis is not java at all\n```',
    workDir: evalRoot,
    baseline: null,
    rules,
    javaPath: process.env.JAVA_FOR_TEST || undefined
  })
  check('code that does not compile scores zero on quality', () => {
    assert.equal(res.metrics.builds, false)
    assert.equal(res.parts.quality, 0)
  })

  check('an answer with no code is rejected before compiling', async () => {})
  const noCode = await evaluate.evaluateGenome({
    ask: async () => 'DeferredRegister is the way.',
    workDir: path.join(root, 'eval-nocode'),
    baseline: null,
    rules
  })
  check('an answer with no code is rejected with a reason', () => {
    assert.equal(noCode.ok, false)
    assert.match(noCode.error, /no Java code/i)
  })

  const broken = await evaluate.evaluateGenome({
    ask: async () => {
      throw new Error('provider exploded')
    },
    workDir: path.join(root, 'eval-throw'),
    baseline: null,
    rules
  })
  check('a failing agent scores zero rather than crashing the loop', () => {
    assert.equal(broken.ok, false)
    assert.equal(broken.score, 0)
    assert.match(broken.error, /provider exploded/)
  })

  // The important one: a mutation that fails to typecheck is never evaluated.
  //
  // evolveOnce reads the persisted store, so the generation cap has to be
  // cleared here. Without this the checks pass on the first run of a fresh
  // checkout and fail on the second, because the previous run left the store at
  // its 20-generation limit and evolveOnce returns "at the limit" before it
  // ever reaches the mutator. A test whose result depends on how many times it
  // has run is not a test.
  const freshStore = { active: 0, generations: [], paused: false, maxGenerations: 20, rules, root: '' }
  genome.saveStore(freshStore)

  const appDir = path.join(root, 'app-src')
  fs.mkdirSync(path.join(appDir, 'src/main/agent'), { recursive: true })
  fs.writeFileSync(path.join(appDir, 'src/main/agent/prompt.ts'), 'export const x = 1\n')

  const step = await loop.evolveOnce({
    appDir,
    askMutator: async () => '```file src/main/agent/prompt.ts\nthis is not typescript (((\n```\nTHESIS: broken',
    askCandidate: async () => 'never reached',
    javaPath: undefined
  })
  check('a mutation that does not typecheck is never evaluated', () => {
    assert.equal(step.ok, false)
    assert.match(step.verdict, /typecheck/i)
  })

  genome.saveStore(freshStore)

  const noEdit = await loop.evolveOnce({
    appDir,
    askMutator: async () => 'I refuse.',
    askCandidate: async () => 'never reached',
    javaPath: undefined
  })
  check('a mutator that changes nothing is reported, not accepted', () => {
    assert.equal(noEdit.ok, false)
    assert.match(noEdit.verdict, /empty mutation/i)
  })
}

await asyncChecks()

fs.rmSync(root, { recursive: true, force: true })

if (process.exitCode) {
  console.log('\nevolution checks failed')
} else {
  console.log(`\nall evolution checks passed (${passed})`)
}
