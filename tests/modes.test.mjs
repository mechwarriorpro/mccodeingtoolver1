import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The compiled modules import `electron` for the user-data path, which the test
// build rewrites to a stub pointing at `.test-tmp` — the same store the learn
// tests use. So there is nothing to set up here, and nothing to clean up that
// would race the other suites.

const auto = await import('../out-test/main/agent/autoswitch.js')
const modes = await import('../out-test/main/agent/modes.js')
const engine = await import('../out-test/main/agent/engine.js')

const learn = await import('../out-test/main/learn.js')
learn.clearLessons()

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

/** A config good enough to reason about, without touching the real profile. */
function cfg(patch = {}) {
  return {
    apiKey: 'sk-ant-test',
    provider: 'anthropic',
    visionProvider: '',
    visionProviderKey: '',
    model: 'claude-sonnet-4-5-20250929',
    autoSwitch: true,
    autoSwitchLimit: 3,
    autoSwitchIncludeLocal: false,
    deepResearch: false,
    learningMode: false,
    researchTopic: '',
    ...patch
  }
}

console.log('which failures are worth switching for')

check('a real out-of-credit error is switchable', () => {
  const e = new Error('402 {"error":{"message":"Insufficient credit balance"}}')
  assert.equal(auto.isCreditExhausted(e), true)
  assert.equal(auto.isSwitchWorthy('auth', e), true)
})

check('a rejected key is NOT switchable', () => {
  const e = new Error('401 invalid x-api-key: authentication_error')
  assert.equal(auto.isCreditExhausted(e), false)
  assert.equal(auto.isSwitchWorthy('auth', e), false)
})

check('rate limits and overload are switchable', () => {
  assert.equal(auto.isSwitchWorthy('rate-limit', new Error('429 too many requests')), true)
  assert.equal(auto.isSwitchWorthy('overloaded', new Error('529 overloaded')), true)
})

check('a retired model is switchable', () => {
  assert.equal(auto.isSwitchWorthy('model', new Error('model not found')), true)
})

check('a context overflow and a symlink warning are not', () => {
  assert.equal(auto.isSwitchWorthy('context', new Error('prompt is too long')), false)
  assert.equal(auto.isSwitchWorthy('symlink', new Error('EPERM symlink')), false)
})

check('an unknown failure is not switched blind', () => {
  assert.equal(auto.isSwitchWorthy('unknown', new Error('something odd')), false)
})

console.log('\nthe order models are tried in')

check('the current model is never offered as its own replacement', () => {
  for (const start of [
    { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
    { provider: 'openrouter', model: 'openrouter/free' },
    { provider: 'zai', model: 'glm-4.7-flash' }
  ]) {
    const chain = auto.switchChain(cfg({ provider: start.provider, model: start.model }), start)
    assert.ok(
      !chain.some((t) => t.provider === start.provider && t.model === start.model),
      `${start.provider}/${start.model} was offered to replace itself`
    )
  }
})

check('free models come before paid ones', () => {
  const chain = auto.switchChain(cfg(), { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' })
  const firstPaid = chain.findIndex((t) => !t.free)
  const lastFree = chain.map((t) => t.free).lastIndexOf(true)
  if (firstPaid !== -1) assert.ok(firstPaid > lastFree, 'a paid model was offered before a free one')
})

check('a provider the user has no key for is skipped', () => {
  const noKey = cfg({ apiKey: '' })
  const chain = auto.switchChain(noKey, { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' })
  assert.ok(!chain.some((t) => t.provider === 'openrouter'), 'openrouter offered without a key')
  assert.ok(!chain.some((t) => t.provider === 'zai'), 'zai offered without a key')
})

check('local models are only in the chain when allowed', () => {
  const off = auto.switchChain(cfg(), { provider: 'anthropic', model: 'x' })
  const on = auto.switchChain(cfg({ autoSwitchIncludeLocal: true }), { provider: 'anthropic', model: 'x' })
  assert.ok(!off.some((t) => t.provider === 'ollama'), 'ollama offered while excluded')
  assert.ok(on.some((t) => t.provider === 'ollama'), 'ollama not offered while included')
})

check('every free model offered can actually call tools', () => {
  for (const t of auto.switchChain(cfg({ autoSwitchIncludeLocal: true }), { provider: 'anthropic', model: 'x' })) {
    assert.ok(t.model, `${t.provider} target has no model`)
    assert.ok(t.why, `${t.provider}/${t.model} has no stated reason`)
  }
})

check('the chain walks forward and never repeats a tried model', () => {
  const c = cfg({ visionProvider: 'zai', visionProviderKey: 'zk-test' })
  const tried = new Set(['anthropic/claude-sonnet-4-5-20250929'])
  const first = auto.nextModel(c, { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' }, tried)
  assert.ok(first)
  tried.add(`${first.provider}/${first.model}`)
  const second = auto.nextModel(c, { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' }, tried)
  assert.ok(second)
  assert.notEqual(`${second.provider}/${second.model}`, `${first.provider}/${first.model}`)
})

check('AutoSwitch switched off means no next model at all', () => {
  const c = cfg({ autoSwitch: false })
  assert.equal(auto.nextModel(c, { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' }, new Set()), null)
})

check('the limit stops an endless rotation', () => {
  const c = cfg({ autoSwitchLimit: 1 })
  const tried = new Set(['anthropic/claude-sonnet-4-5-20250929', 'zai/glm-4.7-flash'])
  // Already switched once, which is the limit.
  assert.equal(auto.nextModel(c, { provider: 'anthropic', model: 'zai/glm-4.7-flash' }, tried), null)
})

console.log('\ndeep research target selection')

check('with only an Anthropic key it picks the strongest Claude', () => {
  const best = auto.bestAvailable(cfg())
  assert.ok(best)
  assert.match(best.model, /claude/)
  assert.equal(best.free, false, 'a paid Claude should not be labelled free')
})

check('with no key at all it picks nothing rather than pretending', () => {
  assert.equal(auto.bestAvailable(cfg({ apiKey: '' })), null)
})

check('no key and no local model means nothing is offered', () => {
  assert.equal(auto.bestAvailable(cfg({ apiKey: '' })), null)
})

check('an installed local model is used when there is nothing else', () => {
  const best = auto.bestAvailable(cfg({ apiKey: '', local: { modelsDir: '', installDir: '', managed: false, contextLength: 0, roles: { agent: ['qwen3-coder'], quick: [], vision: [] } } }))
  assert.equal(best?.provider, 'ollama')
  assert.equal(best?.model, 'qwen3-coder')
})

check('an uninstalled local model is not offered as a fallback', () => {
  assert.equal(auto.bestAvailable(cfg({ apiKey: '', local: { roles: { agent: [], quick: [], vision: [] } } })), null)
})

check('deep research changes the model the run actually uses', () => {
  const normal = auto.effectiveRunTarget(cfg({ provider: 'openrouter', model: 'openrouter/free' }))
  const deep = auto.effectiveRunTarget(cfg({ provider: 'openrouter', model: 'openrouter/free', deepResearch: true }))
  assert.equal(normal.deep, false)
  assert.equal(normal.model, 'openrouter/free')
  assert.equal(deep.deep, true)
  assert.notEqual(deep.model, 'openrouter/free', 'deep research kept the weak model')
})

check('the reported model names what will run', () => {
  assert.match(auto.describeRunTarget(cfg({ deepResearch: true })), /deep research/)
  assert.doesNotMatch(auto.describeRunTarget(cfg()), /deep research/)
})

console.log('\nlearning and research modes')

check('research outranks learning when both are on', () => {
  assert.equal(modes.runMode(cfg({ learningMode: true, deepResearch: true })), 'research')
})

check('one mode at a time, defaulting to coding', () => {
  assert.equal(modes.runMode(cfg()), 'code')
  assert.equal(modes.runMode(cfg({ learningMode: true })), 'learn')
})

check('learning mode forbids editing the project', () => {
  const text = modes.learningPrompt('## The project\n- mod id: icbm')
  assert.match(text, /Do not modify the project/i)
  assert.match(text, /save_lesson/)
  assert.match(text, /icbm/)
})

check('research mode is written for a weaker reader, not the user', () => {
  const text = modes.researchPrompt('block entities', '## The project\n- mod id: icbm')
  assert.match(text, /less capable model|smaller, cheaper model/i)
  assert.match(text, /Traps/)
  assert.match(text, /unconfirmed/i)
  assert.match(text, /docs\/research/)
})

check('research state round-trips and can be cleared', () => {
  modes.saveResearch({ topic: 'datagen', startedAt: 1, notes: [], model: 'x' })
  assert.equal(modes.loadResearch()?.topic, 'datagen')
  modes.saveResearch(null)
  assert.equal(modes.loadResearch(), null)
})

check('the research dir lives inside the project so it ships with it', () => {
  assert.equal(modes.researchDir('/tmp/project'), path.join('/tmp/project', 'docs', 'research'))
})

console.log('\nlessons written by the modes')

check('a studied fact is stored as knowledge, not as a failure', () => {
  const res = learn.saveKnowledge({
    rule: 'Register items with DeferredRegister.createItems(MODID).',
    fix: 'private static final DeferredRegister.Items ITEMS = DeferredRegister.createItems("modid");',
    avoid: 'new Item() does not register anything.',
    kind: 'research',
    topic: 'item registration',
    sources: ['reference:some-mod'],
    confirmed: true
  })
  assert.equal(res.added, true)
  assert.equal(res.lesson.kind, 'research')
  assert.equal(res.lesson.confirmed, true)
})

check('the same rule twice strengthens one lesson instead of duplicating it', () => {
  const before = learn.loadLessons().lessons.length
  const again = learn.saveKnowledge({ rule: 'Register items with DeferredRegister.createItems(MODID).', kind: 'topic' })
  assert.equal(again.duplicate, true)
  assert.equal(again.lesson.seen, 2)
  assert.equal(learn.loadLessons().lessons.length, before)
})

check('a blank rule is refused', () => {
  assert.throws(() => learn.saveKnowledge({ rule: '   ' }))
})

check('knowledge reaches the prompt, in its own block', () => {
  learn.saveKnowledge({ rule: 'Use DataGeneration for recipes in 1.21.1, not handwritten JSON.', kind: 'topic', topic: 'datagen' })
  const block = learn.lessonsForPrompt({ loader: 'neoforge', mcVersion: '1.21.1' })
  assert.match(block, /What has already been worked out here/)
  assert.match(block, /DataGeneration/)
})

check('failure lessons and studied facts do not share a heading', () => {
  const rec = learn.recordFailure({
    error: "src/main/java/com/example/RubySword.java:42: error: cannot find symbol\n  symbol: class DeferredItem",
    source: 'local-build'
  })
  assert.ok(rec.added || rec.lesson, `fixture was not learnable: ${rec.ignored ?? 'no reason given'}`)
  const block = learn.lessonsForPrompt({})
  assert.match(block, /Mistakes already made on this project/)
  assert.match(block, /What has already been worked out here/)
  assert.ok(
    block.indexOf('Mistakes already made') < block.indexOf('What has already been worked out'),
    'warnings should come before recipes'
  )
})

check('knowledge can be looked up by topic', () => {
  const hits = learn.knowledgeOn('item registration')
  assert.ok(hits.length > 0)
  assert.match(hits[0].rule, /DeferredRegister/)
})

console.log('\nthe switch policy the engine applies')

check('the engine classifies a 402 as an auth failure — which is why policy needs the text', () => {
  const info = engine.classifyRunError(new Error('402 insufficient credit'))
  assert.equal(info.kind, 'auth')
  assert.equal(info.retryable, false)
  // The class alone would refuse to switch; the text is what rescues the turn.
  assert.equal(auto.isSwitchWorthy(info.kind, new Error('402 insufficient credit')), true)
})

check('a 401 still fails immediately with a sentence the user can act on', () => {
  const info = engine.classifyRunError(new Error('401 invalid x-api-key'))
  assert.equal(info.kind, 'auth')
  assert.equal(auto.isSwitchWorthy(info.kind, new Error('401 invalid x-api-key')), false)
  assert.match(info.message, /Settings/)
})

if (process.exitCode) {
  console.log('\nmode checks failed')
} else {
  console.log(`\nall mode checks passed (${passed})`)
}
