import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { AppConfig } from '../shared/types'

const defaultConfig: AppConfig = {
  apiKey: '',
  baseUrl: '',
  model: 'claude-sonnet-4-5-20250929',
  maxBudgetUsd: 5,
  autonomy: 'review',
  workspaceDir: '',
  github: { owner: '', repo: '', branch: '' },
  javaPath: '',
  decompilerJar: '',
  preferWrapper: true,
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

export function effectiveApiKey(): string {
  const cfg = loadConfig()
  return (cfg.apiKey || process.env.ANTHROPIC_API_KEY || '').trim()
}

export function effectiveBaseUrl(): string {
  const cfg = loadConfig()
  return (cfg.baseUrl || process.env.ANTHROPIC_BASE_URL || '').trim()
}

/** Never let the API key leave the main process. */
export function redactConfig(cfg: AppConfig): AppConfig {
  return { ...cfg, apiKey: cfg.apiKey ? '••••••••' : '' }
}

export function defaultUserConfig(): AppConfig {
  return structuredClone(defaultConfig)
}
