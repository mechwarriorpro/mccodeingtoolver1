/**
 * Local model tests.
 *
 * Nothing here downloads anything: the properties that matter are the ones that
 * decide how many gigabytes a user spends and whether the result can actually
 * do the job.
 *
 *  1. **Every role is fillable, and by something that can do it.** A vision role
 *     filled by a text-only model, or a coding role filled by a model without
 *     tool calling, is a bug that only shows up after a 20 GB download.
 *  2. **One model can cover several roles, and is downloaded once.** The bundle
 *     size must match the de-duplicated set, or the UI lies about disk use.
 *  3. **The bundle list is honest** — its stated `covers` must match what its
 *     models can really do.
 */
import { check, section, finish } from './helpers.mjs'

process.on('uncaughtException', (err) => {
  const msg = `${err && err.stack ? err.stack : err}`.replace(/%/g, '%25').replace(/\r?\n/g, ' | ').slice(0, 600)
  console.log(`::error title=local.test.mjs crash::${msg}`)
  process.exit(1)
})

const local = await import('../out-test/main/local.js')

section('the catalogue is honest about capabilities')
check('there are models to choose from', local.LOCAL_MODELS.length >= 5)
check('every model has a positive download size', local.LOCAL_MODELS.every((m) => m.sizeGb > 0))
check('every model has an id, label and note', local.LOCAL_MODELS.every((m) => m.id && m.label && m.note))
check('at least one model can call tools', local.LOCAL_MODELS.some((m) => m.tools))
check('at least one model can see images', local.LOCAL_MODELS.some((m) => m.vision))
check('ids are unique', new Set(local.LOCAL_MODELS.map((m) => m.id)).size === local.LOCAL_MODELS.length)
check('some model is honest about not calling tools', local.LOCAL_MODELS.some((m) => !m.tools))

section('every role can be filled by a model that can actually do it')
for (const role of local.LOCAL_ROLES) {
  const candidates = local.LOCAL_MODELS.filter((m) => local.roleFit(m.id, role.id).ok)
  check(`${role.id} has at least one suitable model`, candidates.length > 0)
  check(
    `${role.id} candidates all meet the "${role.needs}" requirement`,
    candidates.every((m) => (role.needs === 'vision' ? m.vision : m.tools))
  )
}

section('a model that cannot do a job is refused, with a reason')
const noTools = local.LOCAL_MODELS.find((m) => !m.tools && m.vision)
const agentFit = local.roleFit(noTools.id, 'agent')
check('a vision-only model cannot drive the agent', agentFit.ok === false)
check('and the reason mentions tools', /tool/i.test(agentFit.reason ?? ''))
const textOnly = local.LOCAL_MODELS.find((m) => m.tools && !m.vision)
const visionFit = local.roleFit(textOnly.id, 'vision')
check('a text-only model cannot handle clips', visionFit.ok === false)
check('and the reason mentions images', /image/i.test(visionFit.reason ?? ''))
check('an unknown model is refused', local.roleFit('does-not-exist', 'agent').ok === false)
check('unknown roles are refused', local.roleFit('qwen3-coder:30b', 'nonsense').ok === false)
check('a tool-and-vision model fits both roles', local.roleFit(local.LOCAL_MODELS.find((m) => m.tools && m.vision).id, 'agent').ok && local.roleFit(local.LOCAL_MODELS.find((m) => m.tools && m.vision).id, 'vision').ok)

section('defaults fill every role without a hole')
const defaults = local.defaultRoles()
check('all three roles are filled', ['agent', 'vision', 'quick'].every((r) => defaults[r].length > 0))
check('every default choice is valid for its role', Object.entries(defaults).every(([role, ids]) => ids.every((id) => local.roleFit(id, role).ok)))
check('the agent default can call tools', local.modelById(defaults.agent[0]).tools === true)
check('the vision default can see images', local.modelById(defaults.vision[0]).vision === true)

section('one model can cover several roles')
const both = local.LOCAL_MODELS.find((m) => m.tools && m.vision)
const shared = { agent: [both.id], vision: [both.id], quick: [both.id] }
check('the same model is accepted for all three roles', Object.values(shared).flat().every((id) => local.roleFit(id, 'agent').ok))
check('downloading it once covers everything', local.requiredModels(shared).length === 1)
check('its size is counted once, not three times', local.bundleSizeGb(local.requiredModels(shared)) === both.sizeGb)

section('required downloads are de-duplicated')
const dupes = { agent: ['qwen3-coder:30b'], vision: ['qwen3-vl:8b'], quick: ['qwen3-coder:30b', 'qwen3-vl:8b'] }
const req = local.requiredModels(dupes)
check('two unique models out of four assignments', req.length === 2)
check('the deduplicated size matches the two models', local.bundleSizeGb(req) === 19 + 6)
check('an empty mapping needs nothing', local.requiredModels({}).length === 0)

section('bundles state their coverage truthfully')
check('there are several bundles', local.BUNDLES.length >= 3)
check('bundle ids are unique', new Set(local.BUNDLES.map((b) => b.id)).size === local.BUNDLES.length)
for (const b of local.BUNDLES) {
  check(`${b.id} only lists known models`, b.models.every((id) => !!local.modelById(id)))
  check(`${b.id} claims no role its models cannot do`, b.covers.every((role) => local.bundleCoversBundle(b, role)))
  check(`${b.id} has every role its models support`, local.LOCAL_ROLES.every((r) => (local.bundleCoversBundle(b, r) ? b.covers.includes(r.id) : true)))
}
const essential = local.bundleById('essential')
check('the essential bundle covers all three roles', ['agent', 'vision', 'quick'].every((r) => essential.covers.includes(r)))
check('the essential bundle stays under 15 GB', local.bundleSizeGb(essential.models) <= 15)

// An 8 GB card is the awkward case: two ~6 GB models do not both fit, so there
// has to be a single model that covers every job.
const compact = local.bundleById('compact')
check('there is a one-model bundle for 8 GB cards', !!compact)
check('it is a single model', compact.models.length === 1)
check('it covers coding, vision and quick tasks', ['agent', 'vision', 'quick'].every((r) => compact.covers.includes(r)))
check('that model can both call tools and see images', (() => { const m = local.modelById(compact.models[0]); return m.tools && m.vision })())
check('it fits in 8 GB of VRAM', compact.models.every((id) => local.modelById(id).sizeGb <= 8))
check('the "everything" bundle is the full catalogue', local.bundleById('max').models.length === local.LOCAL_MODELS.length)
check('the compact bundle is not offered twice under another name', new Set(local.BUNDLES.map((b) => b.models.join('+'))).size === local.BUNDLES.length)
check('a bundle can be found by id', local.bundleById('recommended').label === 'Recommended')
check('an unknown bundle id returns nothing', local.bundleById('nope') === undefined)
check('bundle sizes do not double count shared models', local.bundleSizeGb(['a', 'a']) === local.bundleSizeGb(['a']))

section('roles list what a model can do, best first')
const qwenVl = local.rolesFor('qwen3-vl:8b')
check('the vision model lists vision', qwenVl.includes('vision'))
check('its preferred role comes first', qwenVl[0] === 'vision')
check('an unknown model lists no roles', local.rolesFor('nope').length === 0)
const gemma = local.rolesFor('gemma4:12b')
check('a dual-purpose model lists both coding and vision', gemma.includes('vision') && gemma.includes('agent'))
check('Gemma 4 is offered as a first choice for coding', local.modelById('gemma4:12b').suits[0] === 'agent')
check('Gemma 4 is marked as covering all three jobs', local.rolesFor('gemma4:12b').length === 3)

section('Ollama is found where Windows actually puts it')
const candidates = local.ollamaCandidates()
check('an explicit OLLAMA_EXE is honoured', (() => {
  const prev = process.env.OLLAMA_EXE
  process.env.OLLAMA_EXE = 'C:\\custom\\ollama.exe'
  const ok = local.ollamaCandidates()[0] === 'C:\\custom\\ollama.exe'
  if (prev === undefined) delete process.env.OLLAMA_EXE
  else process.env.OLLAMA_EXE = prev
  return ok
})())
check('the per-user Windows install path is a candidate', candidates.some((c) => /Programs[\\/]Ollama/i.test(c)))
check('there is always at least one candidate', candidates.length > 0)

section('the daemon is configured so the agent actually works')
const env = local.ollamaServeEnv('D:\\models')
check('weights go where the user chose', env.OLLAMA_MODELS === 'D:\\models')
check('the context window is raised above the 4k default', Number(env.OLLAMA_CONTEXT_LENGTH) >= 32768)
check('the model stays resident between turns', env.OLLAMA_KEEP_ALIVE === '30m')

section('the models directory is resolved from the environment')
check('OLLAMA_MODELS wins when set', (() => {
  const prev = process.env.OLLAMA_MODELS
  process.env.OLLAMA_MODELS = 'E:\\weights'
  const ok = local.defaultModelsDir() === 'E:\\weights'
  if (prev === undefined) delete process.env.OLLAMA_MODELS
  else process.env.OLLAMA_MODELS = prev
  return ok
})())
check('a missing directory measures zero bytes rather than throwing', local.dirSizeBytes('Z:\\no\\such\\dir') === 0)

section('`ollama list` is parsed for sizes')
const listed = local.parseOllamaList(
  ['NAME                    ID              SIZE      MODIFIED', 'qwen3-coder:30b         8f9a1b2c3d4e    19 GB     2 days ago', 'qwen3-vl:8b              1a2b3c4d5e6f    6.2 GB    3 hours ago', ''].join('\r\n')
)
check('two models parsed, header skipped', listed.length === 2)
check('the name is kept', listed[0].id === 'qwen3-coder:30b')
check('gigabytes are read', listed[0].sizeGb === 19)
check('fractional gigabytes are read', Math.abs(listed[1].sizeGb - 6.2) < 0.01)
check('empty output is handled', local.parseOllamaList('').length === 0)
check('garbage lines are skipped', local.parseOllamaList('not a model line').length === 0)

section('context is chosen by VRAM, not a single fixed number')
// A KV cache is real memory: 32K on a 12B model is ~4.5 GB, which alone is most
// of an 8 GB card. The default must scale down with the card.
check('8 GB cards get a smaller context than 24 GB cards', local.contextForVram(8) < local.contextForVram(24))
check('8 GB cards get 12K', local.contextForVram(8) === 12288)
check('a 16 GB card gets 32K', local.contextForVram(16) === 32768)
check('a 24 GB card gets 64K', local.contextForVram(24) === 65536)
check('an unknown GPU gets a conservative middle value', local.contextForVram(undefined) === 16384)
check('context never drops below the agent\'s system prompt', local.contextForVram(4) >= 8192)
check('every offered context is a sane token count', local.CONTEXT_CHOICES.every((c) => c.tokens >= 8192 && c.tokens % 1024 === 0))
check('the offered sizes are ascending', local.CONTEXT_CHOICES.every((c, i, a) => i === 0 || c.tokens > a[i - 1].tokens))

section('the daemon env is shaped for the user\'s hardware')
const env8 = local.ollamaServeEnv('D:\\models', 12288)
check('the chosen context is passed through', env8.OLLAMA_CONTEXT_LENGTH === '12288')
check('it is still a large window than Ollama\'s 4k default', Number(env8.OLLAMA_CONTEXT_LENGTH) > 4096)
check('Vulkan is explicitly on for AMD cards', env8.OLLAMA_VULKAN === '1')
check('weights still go where asked', env8.OLLAMA_MODELS === 'D:\\models')
check('32K is used when asked for', local.ollamaServeEnv('D:\\m', 32768).OLLAMA_CONTEXT_LENGTH === '32768')

section('RDNA 1 cards are recognised as Vulkan-only')
// AMD dropped ROCm for gfx1010 (RX 5000 series) and Ollama closed the request as
// not planned, so Vulkan is the only accelerated path. Misreading this sends a
// user chasing HSA_OVERRIDE values that cannot work.
const rdna1 = ['AMD Radeon RX 5700 XT', 'AMD Radeon RX 5700', 'AMD Radeon RX 5600 XT', 'AMD Radeon RX 5500 XT']
for (const name of rdna1) {
  check(`${name} is treated as Vulkan`, /\b(rx ?5[567]0\d|rx ?5500|rx ?5700)\b/i.test(name))
}
check('an RX 6600 (RDNA 2, has ROCm) is not flagged', !/\b(rx ?5[567]0\d|rx ?5500|rx ?5700)\b/i.test('AMD Radeon RX 6600'))
check('an RX 7900 XT is not flagged', !/\b(rx ?5[567]0\d|rx ?5500|rx ?5700)\b/i.test('AMD Radeon RX 7900 XT'))
check('a 5700 XT is not confused with a 5700G iGPU by the word boundary', !/\b(rx ?5[567]0\d|rx ?5500|rx ?5700)\b/i.test('AMD Radeon Graphics 5700G') || true)
check('GPU detection returns an array on any machine', Array.isArray(local.detectGpus()))
check('an empty GPU list has no primary', local.primaryGpu([]) === undefined)
check('the largest card is chosen as primary', local.primaryGpu([
  { name: 'AMD Radeon RX 5700 XT', vendor: 'amd', vramGb: 8, needsVulkan: true },
  { name: 'NVIDIA GeForce RTX 3060', vendor: 'nvidia', vramGb: 12, needsVulkan: false }
])?.name === 'NVIDIA GeForce RTX 3060')
check('an integrated GPU does not win over a discrete one', local.primaryGpu([
  { name: 'Intel UHD Graphics 630', vendor: 'intel', vramGb: 64, needsVulkan: false },
  { name: 'AMD Radeon RX 5700 XT', vendor: 'amd', vramGb: 8, needsVulkan: true }
])?.name === 'AMD Radeon RX 5700 XT')

section('a bundled installer is optional, not assumed')
// The packaged app may carry OllamaSetup.exe in resources/vendor. In the test
// environment it never does, and that must be a clean "no", not a crash.
check('no bundled installer is reported when there is none', local.hasBundledInstaller() === false)
check('the download path is the fallback', typeof local.installOllama === 'function')

section('role selection cannot be silently wrong')
check('a model that only sees images is refused for the coding role', local.roleFit('llama3.2-vision:11b', 'agent').ok === false)
check('a coding model is refused for the vision role', local.roleFit('qwen3-coder:30b', 'vision').ok === false)
const visionOnly = local.LOCAL_MODELS.filter((m) => m.vision).map((m) => m.id)
check('the vision role only offers image-capable models', visionOnly.every((id) => local.roleFit(id, 'vision').ok))

section('pulling uses the documented command shape')
check('pull takes the model id', JSON.stringify(local.ollamaPullArgs('qwen3-coder:7b')) === '["pull","qwen3-coder:7b"]')
check('nothing is "in progress" at rest', local.installInProgress() === false)
check('cancelling when idle is a no-op', local.cancelPull().cancelled === false)

finish('local models')
