/**
 * "Learn from past mistakes" tests.
 *
 * The important behaviour is the fingerprint: the same mistake reported from a
 * different file, line, temp path or hash has to collapse to the same key, while
 * two genuinely different errors must not. That is pure logic, so it is all
 * checked here. Persistence is checked against the real files in the test
 * user-data dir, which the electron stub points at `.test-tmp`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { check, section, finish } from './helpers.mjs'

process.on('uncaughtException', (err) => {
  const msg = `${err && err.stack ? err.stack : err}`.replace(/%/g, '%25').replace(/\r?\n/g, ' | ').slice(0, 600)
  console.log(`::error title=learn.test.mjs crash::${msg}`)
  process.exit(1)
})

const learn = await import('../out-test/main/learn.js')

// Start from a clean store so counts are deterministic.
learn.clearLessons()

section('the same mistake from a different file is the same mistake')
const a = learn.fingerprint('C:\\proj\\src\\RubySword.java:42: error: cannot find symbol: class DeferredItem')
const b = learn.fingerprint('/home/dev/proj/src/OtherThing.java:7: error: cannot find symbol: class DeferredItem')
check('different file and path collapse to one fingerprint', a === b.replace('<path>', '<path>'), `\n  a=${a}\n  b=${b}`)
check('the symbol name survives', a.includes('deferreditem'))
check('line numbers are gone', !/\b42\b/.test(a) && !/\b7\b/.test(b))
check('windows path is gone', !/c:\\/i.test(a))

section('different mistakes stay different')
const x = learn.fingerprint('error: cannot find symbol: class DeferredItem')
const y = learn.fingerprint('error: cannot find symbol: class FoodProperties')
check('two different symbols do not collapse', x !== y)
check(
  'similarity scores an unrelated error near zero',
  learn.similarity(learn.fingerprint('package net.minecraft.world.item does not exist'), learn.fingerprint('out of memory: java heap space')) < 0.2
)
check('similarity scores the same text as 1', learn.similarity(x, x) === 1)
check(
  'similarity scores a near miss well above the recall threshold',
  learn.similarity(x, learn.fingerprint('error: cannot find symbol: class DeferredItem (Foo.java:12)')) >= 0.7
)

section('generic noise is not learnable')
check('a bare "cannot find symbol" is too generic', !learn.isLearnable('error: cannot find symbol'))
check('"build failed" is too generic', !learn.isLearnable('BUILD FAILED'))
check('a cancelled build is not a lesson', !learn.isLearnable('cancelled'))
check('a real javac error is learnable', learn.isLearnable('RubySword.java:42: error: cannot find symbol: class DeferredItem'))
check(
  'a dependency resolution failure is learnable',
  learn.isLearnable('Could not resolve net.neoforged:neoforge:21.1.999 because it does not exist in any repository')
)

section('a failure is recorded once, then counted')
const err = 'RubySword.java:42: error: cannot find symbol: class DeferredItem'
const first = learn.recordFailure({ error: err, loader: 'neoforge', mcVersion: '1.21.1' })
check('the first occurrence is new', first.added === true)
check('it counts as seen once', first.lesson.seen === 1)
check('it gets a usable rule', first.lesson.rule.length > 10)
const second = learn.recordFailure({ error: 'RubySword.java:99: error: cannot find symbol: class DeferredItem', loader: 'neoforge' })
check('the second is not a new lesson', second.added === false)
check('but the count goes up', second.lesson.seen === 2)
check('only one lesson exists', learn.listLessons().length === 1)

section('recall finds the lesson for a repeat in another file')
const hits = learn.recall('OtherMod.java:5: error: cannot find symbol: class DeferredItem', { loader: 'neoforge' })
check('something was recalled', hits.length >= 1)
check('the exact fingerprint scores 1', hits[0].score === 1)
const fuzzy = learn.recall('RubySword.java:42: error: cannot find symbol: class DeferredItemm', {})
check('a typo still matches fuzzily', fuzzy.length >= 1 && fuzzy[0].score < 1)

section('a fix makes the lesson useful')
const fixed = learn.confirmLesson(first.lesson.id, {
  fix: 'Use DeferredRegister.Items and register the item on the mod event bus',
  avoid: 'Do not import DeferredItem from an older NeoForge line'
})
check('confirm marks the lesson', fixed.confirmed === true)
check('the fix is stored', /DeferredRegister/.test(learn.listLessons()[0].fix))
check('the prompt block includes the fix', /DeferredRegister/.test(learn.lessonsForPrompt({ loader: 'neoforge' })))
check('the prompt block names how often it happened', /seen 2/.test(learn.lessonsForPrompt({ loader: 'neoforge' })))

section('a lesson for another loader is ranked lower, not dropped')
const forgeHits = learn.recall('RubySword.java:42: error: cannot find symbol: class DeferredItem', { loader: 'forge' })
check('it is still recalled', forgeHits.length >= 1)
check('but scored below the same-loader match', forgeHits[0].score < 1)

section('deleting a lesson keeps it deleted')
learn.retireLesson(first.lesson.id)
check('it is gone from the list', learn.listLessons().length === 0)
check('and gone from the prompt', learn.lessonsForPrompt({}) === '')
check('and not recalled again', learn.recall(err, {}).length === 0)

section('the error index counts repeats and points at logs')
learn.clearLessons()
// Earlier sections indexed nothing, but a previous run may have left the index
// behind; start from an empty one so the counts are deterministic.
try {
  fs.rmSync(path.join('.test-tmp', 'errors.json'))
} catch {
  /* first run */
}
const logA = path.join('.test-tmp', 'build-a.log')
const logB = path.join('.test-tmp', 'build-b.log')
learn.indexErrors(['Placement.java:3: error: incompatible types: ItemStack cannot be converted to BlockItem'], { logPath: logA, loader: 'fabric' })
const second2 = learn.indexErrors(['Placement.java:3: error: incompatible types: ItemStack cannot be converted to BlockItem'], { logPath: logB, loader: 'fabric' })
check('the repeat is counted', second2.repeats === 1)
const entries = learn.loadErrors()
check('one entry in the index', entries.length === 1)
check('the count is 2', entries[0].count === 2)
check('both logs are remembered', entries[0].logPaths.length === 2)
check('the newest log comes first', entries[0].logPaths[0] === logB)

section('the store survives a restart')
const before = learn.listLessons().length
const reloaded = (await import('../out-test/main/learn.js?reload')).listLessons()
check('lessons are on disk, not only in memory', reloaded.length === before)
check('the file exists', fs.existsSync(path.join('.test-tmp', 'learn.json')))

learn.clearLessons()
finish()
