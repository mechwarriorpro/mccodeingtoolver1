import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { AppConfig } from '../shared/types'
import { providerBaseUrl } from './providers'

const defaultConfig: AppConfig = {
  apiKey: '',
  provider: 'anthropic',
  baseUrl: '',
  model: 'claude-sonnet-4-5-20250929',
  maxBudgetUsd: 5,
  // Quiet by default: someone who has never opened a log should not be shown one.
  diagLevel: 0,
  showThinking: false,
  thinkingTokens: 0,
  // A chat that dies because a free tier ran out is the most common way this app
  // stalls, so carrying on with another free model is the default.
  autoSwitch: true,
  autoSwitchLimit: 3,
  autoSwitchIncludeLocal: false,
  learningMode: false,
  deepResearch: false,
  researchTopic: '',
  // Off by default: a loop that rewrites its own prompt is something to opt into.
  evolving: false,
  // Quality first, the rest as tie-breakers. These are ratios, not percentages.
  evolveRules: { quality: 70, speed: 10, size: 10, ram: 10 },
  evolveCount: 3,
  evolveMaxGenerations: 20,
  evolveMaxHeapMb: 1024,
  autonomy: 'review',
  workspaceDir: '',
  github: { owner: '', repo: '', branch: '' },
  javaPath: '',
  decompilerJar: '',
  preferWrapper: true,
  autoUpdate: true,
  visionModel: '',
  visionProvider: '',
  visionProviderKey: '',
  local: {
    modelsDir: '',
    roles: { agent: [], vision: [], quick: [] },
    installDir: '',
    managed: false,
    contextLength: 0
  },
  game: {
    instances: [],
    activeInstanceId: '',
    clientJvmArgs: '',
    clientProgramArgs: '',
    windowWidth: 1280,
    windowHeight: 720,
    launchTimeoutSec: 180,
    autoScreenshot: true,
    extraMods: []
  }
}

let cached: AppConfig | null = null

export function userDataDir(): string {
  return app.getPath('userData')
}

export function configPath(): string {
  return path.join(userDataDir(), 'config.json')
}

export function attachmentsDir(): string {
  const dir = path.join(userDataDir(), 'attachments')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function conversationsDir(): string {
  const dir = path.join(userDataDir(), 'conversations')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function screenshotsDir(): string {
  const dir = path.join(userDataDir(), 'screenshots')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function logsDir(): string {
  const dir = path.join(userDataDir(), 'logs')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return (patch as T) ?? base
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    const current = (base as Record<string, unknown>)[key]
    out[key] = current && typeof current === 'object' && !Array.isArray(current) ? deepMerge(current, value) : value
  }
  return out as T
}

export function loadConfig(): AppConfig {
  if (cached) return cached
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'))
    cached = deepMerge(defaultConfig, raw)
  } catch {
    cached = structuredClone(defaultConfig)
  }
  return cached
}

export function saveConfig(patch: Partial<AppConfig>): AppConfig {
  const next = deepMerge(loadConfig(), patch)
  cached = next
  fs.mkdirSync(path.dirname(configPath()), { recursive: true })
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8')
  return next
}

/**
 * The key for the selected provider.
 *
 * A non-Anthropic key is never read from ANTHROPIC_API_KEY: that variable means
 * "Anthropic" and reusing it for a third party would be both confusing and a
 * way to send the wrong credential. Providers that need no key (Ollama) get an
 * empty string on purpose.
 */
export function effectiveApiKey(): string {
  const cfg = loadConfig()
  if ((cfg.provider || 'anthropic') === 'anthropic') {
    return (cfg.apiKey || process.env.ANTHROPIC_API_KEY || '').trim()
  }
  return (cfg.apiKey || '').trim()
}

/**
 * A base URL set explicitly in Settings always wins. Otherwise the provider
 * decides; an empty result means "leave the SDK's default Anthropic endpoint".
 */
export function effectiveBaseUrl(): string {
  const cfg = loadConfig()
  if (cfg.baseUrl) return cfg.baseUrl.trim()
  const provider = (cfg.provider || 'anthropic') as Parameters<typeof providerBaseUrl>[0]
  return providerBaseUrl(provider) || (process.env.ANTHROPIC_BASE_URL || '').trim()
}

/** Never let the API key leave the main process. */
export function redactConfig(cfg: AppConfig): AppConfig {
  return {
    ...cfg,
    apiKey: cfg.apiKey ? '••••••••' : '',
    visionProviderKey: cfg.visionProviderKey ? '••••••••' : ''
  }
}

export function defaultUserConfig(): AppConfig {
  return structuredClone(defaultConfig)
}
