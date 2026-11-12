/**
 * Run-failure tests.
 *
 * These come from a real crash log, and the point is not classification for its
 * own sake. Two failures arrived together and meant opposite things:
 *
 *  1. `EPERM ... symlink` — a Windows Developer Mode restriction the SDK hits
 *     while spawning a subagent, which it *catches* and recovers from. Presenting
 *     that as the reason a run failed would send the user to fix something that
 *     is not broken.
 *  2. `529 overloaded_error` — genuinely fatal to the turn, and genuinely
 *     temporary, so it should be retried rather than thrown away.
 *
 * Confusing those two either blames the wrong thing or gives up too early.
 */
import { check, section, finish } from './helpers.mjs'

process.on('uncaughtException', (err) => {
  const msg = `${err && err.stack ? err.stack : err}`.replace(/%/g, '%25').replace(/\r?\n/g, ' | ').slice(0, 600)
  console.log(`::error title=errors.test.mjs crash::${msg}`)
  process.exit(1)
})

const { classifyRunError } = await import('../out-test/main/agent/engine.js')

const e = (message) => classifyRunError(new Error(message))

section('the Windows symlink error is recognised as cosmetic')
const real = e(
  "Error: EPERM: operation not permitted, symlink 'C:\\Users\\Owner\\.claude\\projects\\x\\agent-aa0cba3.jsonl' -> " +
    "'C:\\Users\\Owner\\AppData\\Local\\Temp\\claude\\x\\tasks\\aa0cba3.output'"
)
check('it is classified as a symlink problem', real.kind === 'symlink')
check('it is not retried', real.retryable === false)
check('the message says the run was not affected', /not\s+affected/i.test(real.message))
check('it names something the user can actually turn on', /Developer Mode/i.test(real.message))
check('it does not present as a generic failure', !/^The run failed/.test(real.message))
check('a bare symlink EPERM is still caught', e('EPERM: operation not permitted, symlink').kind === 'symlink')
check('an unrelated EPERM is not blamed on symlinks', e('EPERM: operation not permitted, open file').kind !== 'symlink')

section('an overloaded provider is retried, not given up on')
const busy = e(
  'Error: 529 {"type":"error","error":{"type":"overloaded_error","code":"1305","message":"[1305][The service may be temporarily overloaded, please try again later]"}}'
)
check('it is classified as overloaded', busy.kind === 'overloaded')
check('it is marked retryable', busy.retryable === true)
check('the message tells the user to wait rather than fix', /wait|again/i.test(busy.message))
check('the raw JSON is not shown verbatim', !busy.message.includes('{"type"'))
check('a plain overloaded_error also matches', e('overloaded_error').kind === 'overloaded')

section('the two messages are told apart')
check('a log containing both prefers the transient one', e(`${real.message} then 529 overloaded_error`).kind === 'overloaded')
check('symlink alone stays cosmetic', e('EPERM symlink').kind === 'symlink')

section('other failures get advice, not a stack trace')
check('a bad key is not retried', e('Error: 401 {"error":{"type":"authentication_error"}}').retryable === false)
check('and it points at Settings', /Settings/i.test(e('401 authentication_error').message))
check('no credit is not retried', e('402 credit balance is too low').retryable === false)
check('no credit suggests a free model', /free model/i.test(e('402 insufficient quota').message))
check('a rate limit is retryable', e('429 rate_limit_error').retryable === true)
check('a 429 mentions free-tier limits', /free tier/i.test(e('429 Too Many Requests').message))
check('a network drop is retryable', e('fetch failed').retryable === true)
check('a network drop mentions Ollama when local', /Ollama/i.test(e('ECONNREFUSED 127.0.0.1:11434').message))
check('a missing model is not retryable', e('404 model not found').retryable === false)
check('a missing model suggests Refresh', /Refresh/i.test(e('404 model does not exist').message))
check('an over-long conversation is explained', /new chat|context/i.test(e('prompt is too long: 250000 tokens').message))
check('an unknown error stays readable', e('something odd happened').message.length > 0)
check('an unknown error keeps its text', e('something odd happened').message.includes('something odd'))
check('a huge unknown error is truncated', e('x'.repeat(5000)).message.length <= 620)
check('a non-Error value is handled', classifyRunError('a bare string').kind === 'unknown')
check('null is handled', classifyRunError(null).message.length > 0)
check('undefined is handled', classifyRunError(undefined).kind === 'unknown')

section('retryable and kind never disagree')
const samples = ['429 rate limit', '401 bad key', '404 model', 'fetch failed', '529 overloaded', 'EPERM symlink', 'weird']
check('every kind is a known value', samples.map((s) => e(s).kind).every((k) =>
  ['overloaded', 'rate-limit', 'auth', 'network', 'model', 'context', 'symlink', 'unknown'].includes(k)
))
check('only transient kinds are retryable', samples.map((s) => e(s)).every((r) =>
  r.retryable === ['overloaded', 'rate-limit', 'network'].includes(r.kind)
))
check('every classification has a message', samples.map((s) => e(s)).every((r) => r.message.length > 0))
// An unrecognised error keeps its own text rather than being replaced with a
// vague sentence — inventing a message would hide the one clue there is.
check('an unknown error is passed through unchanged', e('weird').message === 'weird')
check('every recognised kind explains itself at length', samples.filter((s) => e(s).kind !== 'unknown').every((s) => e(s).message.length > 40))

finish('run failures')
