/**
 * Free-model provider tests.
 *
 * The important properties are not "does the API return 200" — that needs
 * network and a key. They are:
 *
 *  1. **No credential crosses providers.** The agent empties ANTHROPIC_API_KEY
 *     for every third party; a test here is the only thing that would catch a
 *     future refactor quietly reintroducing the leak.
 *  2. **The model alias is always overridden** for non-Anthropic providers,
 *     because Claude Code otherwise asks a free provider for "claude-sonnet-…"
 *     and gets a 404.
 *  3. **The free lists parse** from real payload shapes, including odd ones.
 */
import { check, section, finish } from './helpers.mjs'

process.on('uncaughtException', (err) => {
  const msg = `${err && err.stack ? err.stack : err}`.replace(/%/g, '%25').replace(/\r?\n/g, ' | ').slice(0, 600)
  console.log(`::error title=provider.test.mjs crash::${msg}`)
  process.exit(1)
})

const prov = await import('../out-test/main/providers.js')

section('the provider list offers genuine free routes')
const free = prov.PROVIDERS.filter((p) => p.id !== 'anthropic')
check('there is more than one alternative to Anthropic', free.length >= 3)
check('Z.ai uses its Anthropic endpoint', prov.providerBaseUrl('zai') === 'https://api.z.ai/api/anthropic')
check('OpenRouter uses its Anthropic skin', prov.providerBaseUrl('openrouter') === 'https://openrouter.ai/api')
check('Ollama is local and needs no key', prov.providerById('ollama').local === true && prov.requiresKey('ollama') === false)
check('Anthropic has no base-url override', prov.providerBaseUrl('anthropic') === '')
check('every provider offers a signup/docs link', prov.PROVIDERS.every((p) => /^https:\/\//.test(p.signupUrl)))

section('a third-party request never carries the Anthropic key')
const env = prov.providerEnv('zai', 'zai-key', 'glm-4.7-flash')
check('the Anthropic key is emptied, not left set', env.ANTHROPIC_API_KEY === '')
check('the provider key goes in the auth token', env.ANTHROPIC_AUTH_TOKEN === 'zai-key')
check('the base URL points at the provider', env.ANTHROPIC_BASE_URL === 'https://api.z.ai/api/anthropic')
check('the model alias is forced to the chosen model', env.ANTHROPIC_MODEL === 'glm-4.7-flash')
check('all three Claude aliases are overridden', ['ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'].every((k) => env[k] === 'glm-4.7-flash'))
check('a long timeout is set for slow free models', Number(env.API_TIMEOUT_MS) >= 300_000)

section('Anthropic keeps its own behaviour')
const a = prov.providerEnv('anthropic', 'sk-ant-real', 'claude-sonnet-4-5-20250929')
check('the real key is passed through', a.ANTHROPIC_API_KEY === 'sk-ant-real')
check('no base URL is forced', !a.ANTHROPIC_BASE_URL)
check('no bearer token is introduced', !a.ANTHROPIC_AUTH_TOKEN)
check('no alias rewriting happens', !a.ANTHROPIC_MODEL)

section('Ollama works without an account')
const o = prov.providerEnv('ollama', '', 'qwen3-coder')
check('the token falls back to the provider name', o.ANTHROPIC_AUTH_TOKEN === 'ollama')
check('it points at localhost', o.ANTHROPIC_BASE_URL === 'http://localhost:11434')

section('the bundled model lists are usable offline')
for (const p of prov.PROVIDERS) {
  const models = prov.KNOWN_MODELS[p.id]
  check(`${p.id} has at least one model`, Array.isArray(models) && models.length > 0)
  check(`${p.id} has a default model`, !!prov.DEFAULT_MODELS[p.id])
}
const zaiFree = prov.KNOWN_MODELS.zai.filter((m) => m.free)
check('Z.ai offers a free model with tools', zaiFree.some((m) => m.free && m.tools))
check('Z.ai offers a free model with vision', zaiFree.some((m) => m.free && m.vision))
check('OpenRouter offers a free model with vision', prov.KNOWN_MODELS.openrouter.some((m) => m.free && m.vision))
check('the Ollama default is a tool-capable coding model', prov.KNOWN_MODELS.ollama.find((m) => m.id === prov.DEFAULT_MODELS.ollama)?.tools === true)
check('models that cannot call tools are marked', prov.KNOWN_MODELS.ollama.some((m) => !m.tools))

section('OpenRouter live lists keep only free models')
const live = prov.parseOpenRouterModels({
  data: [
    { id: 'free/with-vision:free', name: 'Free Vision', pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text', 'image'] }, context_length: 131072 },
    { id: 'free/text-only:free', name: 'Free Text', pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'] }, context_length: 262144 },
    { id: 'paid/model', name: 'Paid', pricing: { prompt: '0.000003', completion: '0.000015' }, architecture: { input_modalities: ['text'] } }
  ]
})
check('paid models are dropped', !live.some((m) => m.id === 'paid/model'))
check('free models are kept', live.length === 2)
check('vision is detected from input modalities', live.find((m) => m.id === 'free/with-vision:free')?.vision === true)
check('a text-only model is not marked visionary', live.find((m) => m.id === 'free/text-only:free')?.vision === false)
check('context is shown as K', live.find((m) => m.id === 'free/text-only:free')?.context === '262K')
check('a malformed payload yields no models rather than throwing', prov.parseOpenRouterModels({ nope: true }).length === 0)
check('a null payload is tolerated', prov.parseOpenRouterModels(null).length === 0)

section('Ollama local lists')
const local = prov.parseOllamaModels({ models: [{ name: 'qwen3-coder:30b', details: { parameter_size: '30B' } }, { name: 'llava:13b' }] })
check('local models are listed', local.length === 2)
check('the parameter size is shown', local[0].label.includes('30B'))
check('a vision model is recognised', local.find((m) => m.id === 'llava:13b')?.vision === true)
check('everything local is free', local.every((m) => m.free))

section('caveats say what the free tier actually costs you')
const caveats = prov.providerCaveats('openrouter', 'qwen/qwen3-coder:free')
check('the model is named as not-Claude', /not Claude/i.test(caveats.join(' ')))
check('the daily limit is stated', /50\/day|50 req/.test(caveats.join(' ')))
check('Anthropic gets no caveat', prov.providerCaveats('anthropic', 'claude-sonnet-4-5-20250929').length === 0)
check('Ollama mentions local hardware', /your machine|hardware/i.test(prov.providerCaveats('ollama', 'qwen3-coder').join(' ')))

section('agent capability is gated on tool calling')
check('a tool-less model is not agent capable', prov.agentCapable({ id: 'x', label: 'x', free: true, tools: false, vision: true }) === false)
check('a tool-capable model is', prov.agentCapable({ id: 'y', label: 'y', free: true, tools: true, vision: false }) === true)

finish('free model providers')
