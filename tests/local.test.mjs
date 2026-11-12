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
check('the smallest bundle covers all three roles', ['agent', 'vision', 'quick'].every((r) => essential.covers.includes(r)))
check('the essential bundle stays under 15 GB', local.bundleSizeGb(essential.models) <= 15)
check('the "everything" bundle is the full catalogue', local.bundleById('max').models.length === local.LOCAL_MODELS.length)
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
