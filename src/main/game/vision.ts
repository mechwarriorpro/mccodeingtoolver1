/**
 * Which model looks at screenshots and clips.
 *
 * There are three sensible answers, and they must agree everywhere vision is
 * used (the Clips panel and the agent's own clip tool), or the same clip would
 * analyse differently depending on how it was triggered:
 *
 *  1. A **local role mapping** when the agent runs on Ollama and the user mapped
 *     a vision model — the whole point of a local setup is that nothing leaves
 *     the machine.
 *  2. An explicit **vision provider** in Settings, for keeping a free vision
 *     model while the agent codes with something else.
 *  3. Otherwise the agent's own provider and key, which is what a plain
 *     Anthropic setup expects.
 */

import { effectiveApiKey, loadConfig } from '../config'
import { PROVIDERS, type ProviderId } from '../providers'

export interface VisionTarget {
  model: string | undefined
  apiKey: string
  baseUrl: string | undefined
  auth: 'anthropic' | 'bearer'
  providerId: ProviderId
  providerLabel: string
  /** Where the choice came from, for the UI to explain itself. */
  source: 'local' | 'settings' | 'agent'
}

export function resolveVisionModel(overrideModel?: string): VisionTarget {
  const cfg = loadConfig()
  const agentProvider = (cfg.provider || 'anthropic') as ProviderId

  // 1. Local role mapping.
  if (agentProvider === 'ollama') {
    const local = cfg.local?.roles?.vision?.[0]
    if (local) {
      const def = PROVIDERS.find((p) => p.id === 'ollama')
      return {
        model: overrideModel || local,
        apiKey: '',
        baseUrl: cfg.baseUrl || def?.baseUrl,
        auth: 'bearer',
        providerId: 'ollama',
        providerLabel: 'Ollama (local)',
        source: 'local'
      }
    }
  }

  // 2. An explicit vision provider, stored as "provider" with its own model.
  const [vp, vm] = (cfg.visionProvider || '').split(':')
  if (vp) {
    const def = PROVIDERS.find((p) => p.id === vp)
    const sameProvider = vp === agentProvider
    return {
      model: overrideModel || cfg.visionModel || vm || undefined,
      apiKey: sameProvider ? effectiveApiKey() : cfg.visionProviderKey || '',
      baseUrl: def?.baseUrl || undefined,
      auth: vp === 'anthropic' ? 'anthropic' : 'bearer',
      providerId: vp as ProviderId,
      providerLabel: def?.label ?? vp,
      source: 'settings'
    }
  }

  // 3. Follow the agent.
  const def = PROVIDERS.find((p) => p.id === agentProvider)
  return {
    model: overrideModel || cfg.visionModel || undefined,
    apiKey: effectiveApiKey(),
    baseUrl: def?.baseUrl || undefined,
    auth: agentProvider === 'anthropic' ? 'anthropic' : 'bearer',
    providerId: agentProvider,
    providerLabel: def?.label ?? 'The AI provider',
    source: 'agent'
  }
}
