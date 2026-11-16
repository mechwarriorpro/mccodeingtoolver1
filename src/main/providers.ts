/**
 * Model providers.
 *
 * The agent runs on the Claude Agent SDK, which is a *client for the Anthropic
 * Messages API* (`POST /v1/messages`). It is not tied to Anthropic's servers:
 * point `ANTHROPIC_BASE_URL` at anything that speaks that protocol and the SDK
 * cannot tell the difference. That single fact is what makes free models possible
 * here — there is no translation layer to ship, no proxy to run, and the
 * tool-calling and image input the agent depends on come over the same wire.
 *
 * Two rules this module exists to enforce:
 *
 *  1. **Never send an Anthropic key to a third party.** `ANTHROPIC_API_KEY` is
 *     explicitly emptied for every non-Anthropic provider, and the provider key
 *     goes in `ANTHROPIC_AUTH_TOKEN` instead. Getting this wrong would leak the
 *     user's paid key to whatever host they selected.
 *  2. **Never claim a model does what it does not.** Each entry records whether
 *     it is verified to do tool calling and vision, because the agent is useless
 *     without tools and the screenshot/clip features are useless without vision.
 *     The UI shows those flags rather than a blanket "free!" badge.
 */

export type ProviderId = 'anthropic' | 'zai' | 'openrouter' | 'deepseek' | 'ollama'

export interface ProviderDef {
  id: ProviderId
  label: string
  /** Where the user gets a key. Opened in the browser from Settings. */
  signupUrl: string
  /** True when the key is optional (a local server that ignores it). */
  keyOptional?: boolean
  /** Local providers need no account and no network egress to a third party. */
  local?: boolean
  /**
   * The `ANTHROPIC_BASE_URL` value. Empty means "use Anthropic's own endpoint",
   * i.e. leave the SDK's default alone.
   */
  baseUrl: string
  /** Short, non-marketing description shown under the provider picker. */
  note: string
}

export interface ProviderModel {
  /** The id sent as `model`. */
  id: string
  label: string
  /** Free of charge, or included in a free tier the user can use right away. */
  free: boolean
  /** Verified to call tools correctly through the Anthropic protocol. */
  tools: boolean
  /** Accepts images (needed for screenshots and clip analysis). */
  vision: boolean
  /** Free-tier limits worth knowing before a long agent run. */
  limits?: string
  /** Context window, when it matters for a long session. */
  context?: string
}

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    signupUrl: 'https://console.anthropic.com/settings/keys',
    baseUrl: '',
    note: 'Paid, and the only provider whose models this app is built and tested against. Best tool use by a wide margin.'
  },
  {
    id: 'zai',
    label: 'Z.ai (GLM)',
    signupUrl: 'https://z.ai/manage-apikey/apikey-list',
    baseUrl: 'https://api.z.ai/api/anthropic',
    note: 'Speaks the Anthropic protocol natively. The Flash models are free and handle tool calls well; heavier GLM models are paid.'
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    signupUrl: 'https://openrouter.ai/keys',
    baseUrl: 'https://openrouter.ai/api',
    note: 'Anthropic-compatible "skin" in front of hundreds of models. The :free roster rotates, so Refresh picks up whatever is free today.'
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    signupUrl: 'https://platform.deepseek.com/api_keys',
    baseUrl: 'https://api.deepseek.com/anthropic',
    note: 'Has an Anthropic-compatible endpoint and is very cheap, but there is no standing free tier. Useful as a low-cost fallback.'
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    signupUrl: 'https://ollama.com/download',
    keyOptional: true,
    local: true,
    baseUrl: 'http://localhost:11434',
    note: 'Runs on your own machine: genuinely free, private, and works offline. Quality depends on the model you pull; tool calling varies.'
  }
]

export const DEFAULT_MODELS: Record<ProviderId, string> = {
  anthropic: 'claude-sonnet-4-5-20250929',
  zai: 'glm-4.7-flash',
  openrouter: 'openrouter/free',
  deepseek: 'deepseek-chat',
  ollama: 'qwen3-coder'
}

export function providerById(id: string | undefined): ProviderDef {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0]
}

/**
 * Known models per provider.
 *
 * `free: true` means "no payment needed to try it" — either a genuinely free
 * tier or, for Ollama, running locally. Free rosters change often, which is why
 * OpenRouter and Ollama also have live discovery (see `discoverModels`); this
 * static list is the offline floor so Settings is never empty.
 */
export const KNOWN_MODELS: Record<ProviderId, ProviderModel[]> = {
  anthropic: [
    { id: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5', free: false, tools: true, vision: true, context: '200K' },
    { id: 'claude-opus-4-1-20250805', label: 'Claude Opus 4.1', free: false, tools: true, vision: true, context: '200K' },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', free: false, tools: true, vision: true, context: '200K' }
  ],
  zai: [
    {
      id: 'glm-4.7-flash',
      label: 'GLM-4.7 Flash',
      free: true,
      tools: true,
      vision: true,
      limits: 'free tier, rate limited',
      context: '128K'
    },
    {
      id: 'glm-4.5-flash',
      label: 'GLM-4.5 Flash',
      free: true,
      tools: true,
      vision: false,
      limits: 'free tier, rate limited',
      context: '128K'
    },
    { id: 'glm-4.7', label: 'GLM-4.7 (coding plan)', free: false, tools: true, vision: true, context: '200K' }
  ],
  openrouter: [
    {
      id: 'openrouter/free',
      label: 'OpenRouter Free (auto-router)',
      free: true,
      tools: true,
      vision: true,
      limits: '20 req/min, 50 req/day (1000/day after a one-time $10 top-up)'
    },
    {
      id: 'qwen/qwen3-coder:free',
      label: 'Qwen3 Coder (free)',
      free: true,
      tools: true,
      vision: false,
      limits: 'free tier',
      context: '1M'
    },
    {
      id: 'nvidia/nemotron-3.5-super-vl:free',
      label: 'Nemotron 3.5 Super VL (free)',
      free: true,
      tools: true,
      vision: true,
      limits: 'free tier',
      context: '1M'
    },
    {
      id: 'deepseek/deepseek-v4-flash:free',
      label: 'DeepSeek V4 Flash (free)',
      free: true,
      tools: true,
      vision: false,
      limits: 'free tier',
      context: '1M'
    },
    {
      id: 'google/gemma-4-31b-it:free',
      label: 'Gemma 4 31B (free)',
      free: true,
      tools: true,
      vision: true,
      limits: 'free tier',
      context: '262K'
    },
    {
      id: 'meta-llama/llama-3.3-70b-instruct:free',
      label: 'Llama 3.3 70B (free)',
      free: true,
      tools: true,
      vision: false,
      limits: 'free tier',
      context: '131K'
    }
  ],
  deepseek: [
    { id: 'deepseek-chat', label: 'DeepSeek Chat', free: false, tools: true, vision: false, limits: 'paid, ~$0.28/M in', context: '128K' },
    { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner', free: false, tools: true, vision: false, limits: 'paid', context: '128K' }
  ],
  ollama: [
    { id: 'qwen3-coder', label: 'qwen3-coder', free: true, tools: true, vision: false, limits: 'local, free forever', context: 'depends on model' },
    { id: 'qwen3', label: 'qwen3', free: true, tools: true, vision: false, limits: 'local', context: 'depends on model' },
    { id: 'llama3.3', label: 'llama3.3', free: true, tools: true, vision: false, limits: 'local', context: '128K' },
    { id: 'gemma3', label: 'gemma3', free: true, tools: false, vision: true, limits: 'local', context: '128K' }
  ]
}

/**
 * The environment the SDK needs for a provider.
 *
 * `ANTHROPIC_API_KEY` is deliberately emptied (not deleted) for third parties:
 * Claude Code falls back to Anthropic auth when the variable is unset but *not*
 * when it is explicitly empty. Setting it to '' is the documented way to stop it
 * reaching for Anthropic credentials.
 */
export function providerEnv(
  providerId: ProviderId,
  apiKey: string,
  model: string
): Record<string, string> {
  const provider = providerById(providerId)
  const env: Record<string, string> = {}
  if (provider.id === 'anthropic') {
    env.ANTHROPIC_API_KEY = apiKey
    return env
  }
  env.ANTHROPIC_BASE_URL = provider.baseUrl
  env.ANTHROPIC_AUTH_TOKEN = apiKey || (provider.keyOptional ? provider.id : '')
  env.ANTHROPIC_API_KEY = ''
  // Claude Code asks for its own model names unless told otherwise; every
  // non-Anthropic provider needs the alias overridden or it gets a 404.
  env.ANTHROPIC_MODEL = model
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = model
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = model
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model
  // Slow free models routinely exceed the default request timeout.
  env.API_TIMEOUT_MS = String(3_000_000)
  return env
}

/**
 * The base URL for a provider, or '' for Anthropic's own endpoint. Kept as a
 * function rather than a property lookup so config.ts does not import the whole
 * registry (and the model lists) on every config read.
 */
export function providerBaseUrl(id: ProviderId): string {
  return providerById(id).baseUrl
}

/** Providers that need a key before the agent can run. */
export function requiresKey(providerId: ProviderId): boolean {
  return !providerById(providerId).keyOptional
}

/**
 * Which models can actually drive the agent. A model without tool calling
 * cannot read files or run a build, so it is offered for clip analysis only.
 */
export function agentCapable(model: ProviderModel): boolean {
  return model.tools
}

/** Turn a live `/api/v1/models` response into provider models. */
export function parseOpenRouterModels(json: unknown): ProviderModel[] {
  const data = (json as { data?: { id?: string; name?: string; context_length?: number; pricing?: { prompt?: string; completion?: string }; architecture?: { input_modalities?: string[] } }[] })?.data
  if (!Array.isArray(data)) return []
  const out: ProviderModel[] = []
  for (const m of data) {
    const id = m.id
    if (!id) continue
    const prompt = Number(m.pricing?.prompt ?? '1')
    const completion = Number(m.pricing?.completion ?? '1')
    const free = prompt === 0 && completion === 0
    // Only free models belong in a free picker; paid ones stay out of the way.
    if (!free) continue
    const modalities = m.architecture?.input_modalities ?? []
    out.push({
      id,
      label: m.name || id,
      free: true,
      // OpenRouter's free roster is overwhelmingly tool-capable; the ones that
      // are not fail loudly on the first tool call rather than silently.
      tools: true,
      vision: modalities.includes('image'),
      limits: 'free tier',
      context: m.context_length ? `${Math.round(m.context_length / 1000)}K` : undefined
    })
  }
  // Stable, readable order: model family, then name.
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

/** Turn an Ollama `/api/tags` response into models. */
export function parseOllamaModels(json: unknown): ProviderModel[] {
  const models = (json as { models?: { name?: string; details?: { parameter_size?: string } }[] })?.models
  if (!Array.isArray(models)) return []
  return models
    .filter((m) => !!m.name)
    .map((m) => ({
      id: m.name as string,
      label: `${m.name}${m.details?.parameter_size ? ` (${m.details.parameter_size})` : ''}`,
      free: true,
      // Ollama models advertise tool support inconsistently; treat unknown as
      // capable and let a failed tool call be the signal.
      tools: true,
      vision: /llava|vision|gemma3|qwen2\.5-vl|llama3\.2-vision/i.test(m.name as string),
      limits: 'local'
    }))
}

export interface DiscoveryResult {
  ok: boolean
  models: ProviderModel[]
  /** Source of truth for the UI: 'live' means fetched now, 'known' means offline list. */
  source: 'live' | 'known'
  error?: string
}

async function getJson(url: string, headers: Record<string, string>, timeoutMs = 12_000): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal, headers })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Ask the provider what it offers right now, falling back to the bundled list.
 * Never throws: an offline machine must still see a usable model list.
 */
export async function discoverModels(
  providerId: ProviderId,
  apiKey: string
): Promise<DiscoveryResult> {
  const known = KNOWN_MODELS[providerId] ?? []
  try {
    if (providerId === 'openrouter') {
      const json = await getJson('https://openrouter.ai/api/v1/models', {
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': 'MC-Forge-Agent'
      })
      const live = parseOpenRouterModels(json)
      if (live.length) return { ok: true, models: live, source: 'live' }
      return { ok: true, models: known, source: 'known', error: 'No free models in the live list; showing the bundled ones.' }
    }
    if (providerId === 'ollama') {
      const json = await getJson('http://localhost:11434/api/tags', {})
      const live = parseOllamaModels(json)
      if (live.length) return { ok: true, models: live, source: 'live' }
      return { ok: false, models: known, source: 'known', error: 'Ollama is running but has no models pulled. Try `ollama pull qwen3-coder`.' }
    }
  } catch (e) {
    const msg = (e as Error).message
    return {
      ok: false,
      models: known,
      source: 'known',
      error:
        providerId === 'ollama'
          ? 'Could not reach Ollama on localhost:11434. Is it running?'
          : `Could not fetch the live model list (${msg}). Showing the bundled models.`
    }
  }
  return { ok: true, models: known, source: 'known' }
}

/**
 * A plain-text warning about the provider choice, shown in Settings and
 * injected into the system prompt so the agent itself knows its constraints.
 */
export function providerCaveats(providerId: ProviderId, model: string): string[] {
  const out: string[] = []
  const provider = providerById(providerId)
  if (provider.id === 'anthropic') return out
  out.push(
    `This session runs on ${provider.label} (${model}) through the Anthropic-compatible API, not Claude. The app's own tools still work, but the model may be weaker at long agentic loops.`
  )
  if (provider.id === 'openrouter') {
    out.push('OpenRouter free models are rate limited (about 20 requests/min, 50/day). A long build-fix loop can hit that; the coding plan or credits remove the daily cap.')
  }
  if (provider.id === 'zai') {
    out.push('GLM Flash models are free but rate limited; long sessions may pause between turns.')
  }
  if (provider.id === 'ollama') {
    out.push('Local models run on your machine: quality, speed and tool-calling reliability depend on the model and your hardware.')
  }
  return out
}
