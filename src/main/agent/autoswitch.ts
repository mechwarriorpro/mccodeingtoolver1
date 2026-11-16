import { loadConfig } from '../config'
import { KNOWN_MODELS, PROVIDERS, providerById, type ProviderId, type ProviderModel } from '../providers'
import { log } from '../diag'
import type { AppConfig } from '../../shared/types'

/**
 * AutoSwitch: keep the chat alive when a model will not.
 *
 * A free tier running out mid-turn is the single most common way this app
 * stalls — the run dies, and the user is left holding a half-finished edit and a
 * message that says "no credit". The turn itself is usually fine; only the model
 * is exhausted. So the failure classes that mean *this model cannot continue but
 * another one could* trigger a switch instead of an error.
 *
 * What is deliberately **not** switched:
 *
 *  - `auth` from a bad key. Every provider with the same key will fail the same
 *    way, and switching would hide a settings problem behind a slow rotation.
 *  - `context`. A smaller free model will hold less, not more.
 *  - `symlink`. The run succeeded; nothing to rescue.
 *
 * Out of credit is separated from a bad key by the error text rather than by the
 * class, because `classifyRunError` groups them: a 402 is "this account is empty"
 * (switchable), a 401 is "this key is wrong" (not).
 */

export interface SwitchTarget {
  provider: ProviderId
  model: string
  label: string
  free: boolean
  /** Why this one is a sensible next step, shown to the user. */
  why: string
}

/** Failure classes where another model can plausibly succeed. */
export const SWITCHABLE_KINDS = new Set(['rate-limit', 'overloaded', 'model'])

/** A 402/payment failure dressed as an auth failure — switchable; a 401 is not. */
export function isCreditExhausted(error: unknown): boolean {
  const text = (error instanceof Error ? error.message : String(error ?? '')).replace(/\s+/g, ' ')
  return /\b402\b|credit balance|insufficient (credit|quota)|quota exceeded|out of credit|billing/i.test(text)
}

export function isSwitchWorthy(kind: string, error: unknown): boolean {
  if (isCreditExhausted(error)) return true
  return SWITCHABLE_KINDS.has(kind)
}

/**
 * Order the free models by how likely they are to carry an agent loop.
 *
 * Tool calling is the hard requirement — a model that cannot call tools cannot
 * edit a file — so anything without it is last regardless of size. After that,
 * a comfortable context window matters more than raw benchmarks, because a long
 * build-fix loop is what breaks a small-context model.
 */
function score(m: ProviderModel): number {
  let s = 0
  if (m.tools) s += 100
  if (m.vision) s += 10
  const ctx = parseInt((m.context ?? '').replace(/[^\d]/g, ''), 10)
  if (Number.isFinite(ctx)) s += Math.min(ctx / 1000, 200) / 10
  return s
}

function freeModelsOf(provider: ProviderId): ProviderModel[] {
  const list = KNOWN_MODELS[provider] ?? []
  return list
    .filter((m) => m.free && m.tools)
    .slice()
    .sort((a, b) => score(b) - score(a))
}

/**
 * The models of `provider` worth offering, minus anything already in the set.
 *
 * Filtering here rather than at each call site matters: the first version
 * checked `same()` in one branch and forgot it in another, so a chain could
 * offer the model that had just failed as its own replacement — an endless loop
 * that looks like a hang.
 */
function candidatesFor(provider: ProviderId, exclude: Set<string>): ProviderModel[] {
  return freeModelsOf(provider).filter((m) => !exclude.has(`${provider}/${m.id}`))
}

/**
 * Every model worth trying, in order, excluding the one that just failed.
 *
 * Free models from every configured provider come first — the point of the
 * feature is not to spend money — then local models if the user allowed them,
 * then paid models as a last resort when nothing free is left and the user's own
 * key is present. A paid fallback is never silent: the returned `why` says so.
 */
export function switchChain(cfg: AppConfig, current: { provider: ProviderId; model: string }): SwitchTarget[] {
  const out: SwitchTarget[] = []
  const same = (p: ProviderId, m: string): boolean => p === current.provider && m === current.model

  /**
   * The key that would be sent to a provider.
   *
   * There is one key in this app, and it belongs to the provider the user chose.
   * Sending it to a different host would be both a credential leak and a
   * guaranteed 401, so another provider only counts as reachable when it is the
   * configured one or the vision provider with its own key. Getting this wrong
   * offers a switch that cannot possibly work, which is worse than ending the
   * turn honestly.
   */
  const keyFor = (p: ProviderId): string => {
    if (providerById(p).local) return ''
    if (p === current.provider) return cfg.apiKey
    if (p === (cfg.visionProvider as ProviderId) && cfg.visionProviderKey) return cfg.visionProviderKey
    return ''
  }

  // 1. Free models on the current provider first: the same key is already known
  //    to work, so the switch is one request away.
  const exclude = new Set([`${current.provider}/${current.model}`])
  for (const m of candidatesFor(current.provider, exclude)) {
    if (same(current.provider, m.id)) continue
    out.push({
      provider: current.provider,
      model: m.id,
      label: m.label,
      free: true,
      why: `another free model on ${providerById(current.provider).label}`
    })
  }

  // 2. Free models on the other providers with a key configured.
  for (const p of PROVIDERS) {
    if (p.id === current.provider) continue
    if (p.local && !cfg.autoSwitchIncludeLocal) continue
    if (!p.local && !keyFor(p.id)) continue
    const models = candidatesFor(p.id, exclude)
    for (const m of p.local ? models.slice(0, 1) : models) {
      out.push({
        provider: p.id,
        model: m.id,
        label: m.label,
        free: true,
        why: `free tier on ${p.label}`
      })
    }
  }

  // 3. Local models, when allowed — genuinely free and still working offline.
  //    Only models the user has actually pulled: the static list is a catalogue,
  //    not an inventory, and offering an uninstalled model is offering a 404.
  if (cfg.autoSwitchIncludeLocal) {
    const installed = [...(cfg.local?.roles?.agent ?? []), ...(cfg.local?.roles?.quick ?? []), ...(cfg.local?.roles?.vision ?? [])]
    for (const id of installed) {
      if (!id || same('ollama', id)) continue
      out.push({ provider: 'ollama', model: id, label: id, free: true, why: 'local model, no quota at all' })
    }
  }

  // 4. Paid models the user can actually pay for. Last, and labelled.
  const paid: { p: ProviderId; m: ProviderModel }[] = []
  for (const p of PROVIDERS) {
    if (p.local) continue
    if (p.id === 'openrouter' || p.id === 'zai') continue // their free roster is covered above
    if (!keyFor(p.id)) continue
    for (const m of KNOWN_MODELS[p.id] ?? []) {
      if (m.free || !m.tools) continue
      if (exclude.has(`${p.id}/${m.id}`)) continue
      paid.push({ p: p.id, m })
    }
  }
  for (const { p, m } of paid.slice(0, 2)) {
    out.push({
      provider: p,
      model: m.id,
      label: m.label,
      free: false,
      why: `paid, on your ${providerById(p).label} key — this costs money`
    })
  }

  return out
}

/**
 * The next model to try, or null when the chain is exhausted.
 *
 * `tried` holds `provider/model` pairs already attempted this turn, so a cycle
 * of failures walks forward instead of bouncing between two models.
 */
export function nextModel(
  cfg: AppConfig,
  current: { provider: ProviderId; model: string },
  tried: Set<string>
): SwitchTarget | null {
  if (!cfg.autoSwitch) return null
  const chain = switchChain(cfg, current)
  const limit = Math.max(1, cfg.autoSwitchLimit || 3)
  const alreadySwitched = [...tried].filter((k) => k !== `${current.provider}/${current.model}`).length
  if (alreadySwitched >= limit) {
    log('provider', 'warn', `AutoSwitch: gave up after ${alreadySwitched} switches`, { tried: [...tried] }, 1)
    return null
  }
  for (const target of chain) {
    const key = `${target.provider}/${target.model}`
    if (tried.has(key)) continue
    return target
  }
  return null
}

/**
 * Where "deep research" should run.
 *
 * The instruction is "the best model available, whatever it costs", so this is
 * the one place a paid model is chosen without being asked. Order reflects
 * coding ability on a long agent loop, not price or context size.
 */
export function bestAvailable(cfg: AppConfig): SwitchTarget | null {
  const rank = (p: ProviderId, m: string): number => {
    // Higher is better. Claude Opus/Sonnet lead because this app is built
    // against their tool use; GLM-4.7 and DeepSeek follow.
    if (m.includes('opus')) return 100
    if (m.includes('sonnet')) return 90
    if (p === 'deepseek') return 70
    if (m === 'glm-4.7') return 65
    if (m.includes('qwen3-coder')) return 60
    if (m.includes('nemotron')) return 55
    if (m.includes('deepseek')) return 50
    if (m.includes('glm')) return 40
    return 20
  }
  // Only providers this app can actually reach: the configured one, or the
  // vision provider with its own key. A local model counts only when one has
  // been installed, otherwise "deep research" would quietly run on nothing.
  const installedLocal = [...(cfg.local?.roles?.agent ?? []), ...(cfg.local?.roles?.quick ?? [])].filter(Boolean)
  const reachable = (p: ProviderId): boolean => {
    if (p === 'ollama') return installedLocal.length > 0
    if (p === (cfg.provider as ProviderId)) return !!cfg.apiKey || !!providerById(p).keyOptional
    if (p === (cfg.visionProvider as ProviderId)) return !!cfg.visionProviderKey
    return false
  }

  let best: SwitchTarget | null = null
  let bestScore = -1
  for (const p of PROVIDERS) {
    if (!reachable(p.id)) continue
    const candidates = p.id === 'ollama' ? KNOWN_MODELS.ollama.filter((m) => installedLocal.includes(m.id)) : KNOWN_MODELS[p.id] ?? []
    for (const m of candidates) {
      if (!m.tools) continue
      const s = rank(p.id, m.id)
      if (s > bestScore) {
        bestScore = s
        best = {
          provider: p.id,
          model: m.id,
          label: m.label,
          free: m.free,
          why: m.free ? 'the strongest model on your free keys' : `the strongest model on your ${providerById(p.id).label} key`
        }
      }
    }
  }
  return best
}

/** The config a run should use, given the chat's active model and mode. */
export function effectiveRunTarget(cfg: AppConfig): { provider: ProviderId; model: string; deep: boolean } {
  const provider = (cfg.provider || 'anthropic') as ProviderId
  if (!cfg.deepResearch) return { provider, model: cfg.model, deep: false }
  const best = bestAvailable(cfg)
  if (!best) return { provider, model: cfg.model, deep: false }
  return { provider: best.provider, model: best.model, deep: true }
}

/** One line for the UI: which model is doing the work right now. */
export function describeRunTarget(cfg: AppConfig): string {
  const t = effectiveRunTarget(cfg)
  const label = KNOWN_MODELS[t.provider]?.find((m) => m.id === t.model)?.label ?? t.model
  return t.deep ? `${label} (deep research)` : label
}

export function loadSwitchConfig(): AppConfig {
  return loadConfig()
}
