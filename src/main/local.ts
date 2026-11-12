/**
 * Local models (Ollama): installing it, downloading model bundles, and mapping
 * models onto the app's use cases.
 *
 * Ollama serves an Anthropic-compatible `/v1/messages` endpoint (v0.14+), so the
 * agent needs no proxy — but it is a *separate program with a multi-gigabyte
 * weight store*, and pretending otherwise produces a bad first run. Three
 * consequences shape this module:
 *
 *  1. **The installer is a download, not a bundle.** The Windows installer is
 *     ~1 GB and model weights run to tens of GB. Shipping either inside a 100 MB
 *     Electron installer is impossible, so the app fetches what it needs on
 *     demand, offers a disk location for the weights before anything is
 *     downloaded, and reports progress the whole way.
 *  2. **A model that cannot call tools cannot edit files.** The app uses models
 *     in exactly two places — the coding agent, and vision for clips and
 *     screenshots — so bundles are built around those, and every entry carries
 *     what it can actually do.
 *  3. **One model can serve several roles.** Roles are a list of refs, not a
 *     single choice: a large coding model can cover the agent *and* clips, and
 *     picking the same model twice is explicitly allowed and de-duplicated at
 *     download time so nothing is fetched twice.
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { app } from 'electron'

export type LocalRole = 'agent' | 'vision' | 'quick'

export interface RoleDef {
  id: LocalRole
  label: string
  /** Shown under the picker. */
  helps: string
  /** A model used here must support this capability. */
  needs: 'tools' | 'vision'
}

/**
 * The roles are the app's real model call sites, not abstractions: the agent
 * (engine.ts) and vision for clips/screenshots (clip.ts, tools.ts). `quick` is
 * the cheap model the SDK asks for as its Haiku alias on non-Anthropic
 * providers, which is why it wants tools but not vision.
 */
export const LOCAL_ROLES: RoleDef[] = [
  {
    id: 'agent',
    label: 'Coding agent',
    helps: 'Writes the mod, changes files and runs builds. Needs tool calling; the bigger the model, the better the code.',
    needs: 'tools'
  },
  {
    id: 'vision',
    label: 'Screenshots & clips',
    helps: 'Looks at the game window and at recorded clips. Needs a model that accepts images.',
    needs: 'vision'
  },
  {
    id: 'quick',
    label: 'Background / quick tasks',
    helps: 'Small, fast model for short turns and the SDK’s internal Haiku requests. Needs tool calling.',
    needs: 'tools'
  }
]

export interface LocalModelDef {
  id: string
  label: string
  /** Download size in GB, rounded up from Ollama's published blob sizes. */
  sizeGb: number
  /** Verified to call tools through Ollama's Anthropic layer. */
  tools: boolean
  /** Accepts images. */
  vision: boolean
  /** The roles this model covers without strain. */
  suits: LocalRole[]
  note: string
}

/**
 * The curated list.
 *
 * Deliberately small: a "pick a model" screen with 80 tags is a worse product
 * than six with a sentence each. Sizes are the pull size, which is what the
 * user's disk actually loses.
 */
export const LOCAL_MODELS: LocalModelDef[] = [
  {
    id: 'qwen3-coder:30b',
    label: 'Qwen3 Coder 30B',
    sizeGb: 19,
    tools: true,
    vision: false,
    suits: ['agent', 'quick'],
    note: 'The best general coding choice that fits in 24 GB of VRAM. Strong tool calling.'
  },
  {
    id: 'qwen3-coder:7b',
    label: 'Qwen3 Coder 7B',
    sizeGb: 5,
    tools: true,
    vision: false,
    suits: ['agent', 'quick'],
    note: 'Runs on an 8 GB card. Weaker at long agentic loops, fine for small changes.'
  },
  {
    id: 'gpt-oss:20b',
    label: 'GPT-OSS 20B',
    sizeGb: 13,
    tools: true,
    vision: false,
    suits: ['agent', 'quick'],
    note: 'Good reasoning for its size; a sensible default on a 12–16 GB card.'
  },
  {
    id: 'qwen3-vl:8b',
    label: 'Qwen3-VL 8B',
    sizeGb: 6,
    tools: true,
    vision: true,
    suits: ['vision', 'quick'],
    note: 'Reads screenshots and clip frames, and calls tools. The vision default.'
  },
  {
    id: 'gemma4:12b',
    label: 'Gemma 4 12B',
    sizeGb: 8,
    tools: true,
    vision: true,
    suits: ['agent', 'vision'],
    note: 'One download for every job: it codes and reads images. The best pick for an 8 GB card — it needs about 8 GB at Q4, so keep the context modest.'
  },
  {
    id: 'llama3.2-vision:11b',
    label: 'Llama 3.2 Vision 11B',
    sizeGb: 8,
    tools: false,
    vision: true,
    suits: ['vision'],
    note: 'Describes screenshots well but cannot call tools, so it cannot drive the agent.'
  }
]

export type BundleId = 'compact' | 'essential' | 'recommended' | 'vision' | 'max'

export interface BundleDef {
  id: BundleId
  label: string
  /** What the user gets, in one line. */
  summary: string
  models: string[]
  /** Whether the bundle covers each role, computed once so UI and tests agree. */
  covers: LocalRole[]
}

/**
 * Bundles are role coverage, not "download everything".
 *
 * `essential` is chosen so a 8 GB machine gets a working app in ~11 GB, and
 * `max` is the only one that pulls all six.
 */
export const BUNDLES: BundleDef[] = [
  {
    id: 'compact',
    label: '8 GB GPU (one model)',
    summary: 'Gemma 4 12B alone. Codes and reads screenshots, so one 8 GB download covers every job.',
    models: ['gemma4:12b'],
    covers: ['agent', 'vision', 'quick']
  },
  {
    id: 'essential',
    label: 'Essential',
    summary: 'One coding model and one vision model. The smallest setup that can actually finish a task.',
    models: ['qwen3-coder:7b', 'qwen3-vl:8b'],
    covers: ['agent', 'quick', 'vision']
  },
  {
    id: 'recommended',
    label: 'Recommended',
    summary: 'A 24 GB-class coder plus the vision model. Best quality per gigabyte for most machines.',
    models: ['qwen3-coder:30b', 'qwen3-vl:8b'],
    covers: ['agent', 'quick', 'vision']
  },
  {
    id: 'vision',
    label: 'Vision only',
    summary: 'Keep coding on Claude or a free cloud model and only look at screenshots locally.',
    models: ['qwen3-vl:8b'],
    covers: ['vision']
  },
  {
    id: 'max',
    label: 'Everything',
    summary: 'All six models, so every role has a strong candidate and you can compare them.',
    models: LOCAL_MODELS.map((m) => m.id),
    covers: ['agent', 'quick', 'vision']
  }
]

export function modelById(id: string): LocalModelDef | undefined {
  return LOCAL_MODELS.find((m) => m.id === id)
}

export function bundleById(id: BundleId): BundleDef | undefined {
  return BUNDLES.find((b) => b.id === id)
}

/** Total download for a set of model ids, de-duplicated. */
export function bundleSizeGb(modelIds: string[]): number {
  const unique = [...new Set(modelIds)]
  return unique.reduce((sum, id) => sum + (modelById(id)?.sizeGb ?? 0), 0)
}

/**
 * Whether a bundle can fill a role.
 *
 * This asks about *capability* (`roleFit`), not preference (`suits`): a bundle
 * promising to cover the quick tasks is making a statement about what will
 * work, and a model that can call tools will work there whether or not it is
 * the model you would have chosen.
 */
export function bundleCoversBundle(b: BundleDef, role: LocalRole): boolean {
  return b.models.some((id) => roleFit(id, role).ok)
}

/**
 * Could this model fill this role? Returns a reason when it cannot, because
 * "why is this greyed out" is the question a user actually asks.
 */
export function roleFit(modelId: string, role: LocalRole): { ok: boolean; reason?: string } {
  const m = modelById(modelId)
  if (!m) return { ok: false, reason: 'Unknown model.' }
  const r = LOCAL_ROLES.find((x) => x.id === role)
  if (!r) return { ok: false, reason: 'Unknown role.' }
  if (r.needs === 'vision' && !m.vision) return { ok: false, reason: `${m.label} cannot read images.` }
  if (r.needs === 'tools' && !m.tools) return { ok: false, reason: `${m.label} cannot call tools, so it cannot edit files.` }
  return { ok: true }
}

/**
 * The roles a model covers, best first. A model's `suits` is a preference, so a
 * coding model that happens to accept images still lists `vision` last.
 */
export function rolesFor(modelId: string): LocalRole[] {
  const m = modelById(modelId)
  if (!m) return []
  return LOCAL_ROLES.filter((r) => roleFit(modelId, r.id).ok).map((r) => r.id).sort(
    (a, b) => Number(m.suits.includes(a)) === Number(m.suits.includes(b)) ? 0 : m.suits.includes(a) ? -1 : 1
  )
}

/**
 * Build a default assignment: each role gets its best-suited model, and roles
 * happily share one model when it can do both.
 */
export function defaultRoles(): Record<LocalRole, string[]> {
  const out = { agent: [], vision: [], quick: [] } as Record<LocalRole, string[]>
  for (const role of LOCAL_ROLES) {
    const best = LOCAL_MODELS.find((m) => m.suits[0] === role.id && roleFit(m.id, role.id).ok)
    if (best) out[role.id] = [best.id]
  }
  // Every role must be filled or the app has a hole; fall back to any fit.
  for (const role of LOCAL_ROLES) {
    if (!out[role.id].length) {
      const any = LOCAL_MODELS.find((m) => roleFit(m.id, role.id).ok)
      if (any) out[role.id] = [any.id]
    }
  }
  return out
}

/** Every model referenced by any role, de-duplicated: what actually downloads. */
export function requiredModels(roles: Record<string, string[]>): string[] {
  return [...new Set(Object.values(roles).flat())]
}

// ---------------------------------------------------------------- environment

/** Where Ollama lives, in order of preference. */
export function ollamaCandidates(): string[] {
  const out: string[] = []
  if (process.env.OLLAMA_EXE) out.push(process.env.OLLAMA_EXE)
  // The per-user install (what OllamaSetup.exe does by default) lives under
  // LOCALAPPDATA, but that variable is absent on some machines and in CI, so the
  // documented shape is always a candidate too.
  if (process.env.LOCALAPPDATA) out.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'))
  out.push(
    'C:\\Program Files\\Ollama\\ollama.exe',
    'C:\\Users\\Public\\AppData\\Local\\Programs\\Ollama\\ollama.exe',
    '/usr/local/bin/ollama',
    '/usr/bin/ollama',
    '/opt/homebrew/bin/ollama'
  )
  return out
}

export function findOllama(): string | null {
  for (const c of ollamaCandidates()) {
    try {
      if (fs.existsSync(c)) return c
    } catch {
      // A broken env var should not stop the search.
    }
  }
  return null
}

export interface OllamaStatus {
  installed: boolean
  path: string | null
  /** The daemon answered on 11434. */
  running: boolean
  version?: string
  modelsDir: string
  modelsDirIsDefault: boolean
  /** Free space in GB on the models drive, when it can be read. */
  freeGb?: number
  installedModels: { id: string; sizeGb: number }[]
}

export function defaultModelsDir(): string {
  if (process.env.OLLAMA_MODELS) return process.env.OLLAMA_MODELS
  const home = process.env.USERPROFILE || process.env.HOME || ''
  return home ? path.join(home, '.ollama', 'models') : ''
}

/** Bytes on disk for a directory, best effort: a missing dir is 0, not an error. */
export function dirSizeBytes(dir: string): number {
  let total = 0
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    try {
      if (e.isDirectory()) total += dirSizeBytes(p)
      else total += fs.statSync(p).size
    } catch {
      // A file can vanish between readdir and stat; ignore it.
    }
  }
  return total
}

export function freeSpaceGb(dir: string): number | undefined {
  try {
    const s = fs.statfsSync(path.parse(path.resolve(dir)).root)
    return (s.bavail * s.bsize) / 1e9
  } catch {
    return undefined
  }
}

/**
 * Verify the daemon really speaks the Anthropic protocol before the UI claims
 * local models will work. `/v1/messages` returns 400 for an empty body when the
 * endpoint exists, which is a pass; a 404 means the Ollama build is too old.
 */
export async function probeOllama(baseUrl = 'http://localhost:11434'): Promise<{
  running: boolean
  anthropic: boolean
  version?: string
  error?: string
}> {
  try {
    const version = await (await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(4000) })).json() as { version?: string }
    let anthropic = false
    try {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        signal: AbortSignal.timeout(8000),
        headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
        // Intentionally malformed: any answer that is not 404 proves the route
        // exists, and this costs no tokens.
        body: JSON.stringify({ model: 'probe', max_tokens: 1, messages: [] })
      })
      anthropic = res.status !== 404
    } catch {
      anthropic = false
    }
    return { running: true, anthropic, version: version.version }
  } catch {
    return { running: false, anthropic: false, error: 'Ollama is not answering on localhost:11434.' }
  }
}

/**
 * Parse `ollama list`. Columns are NAME, ID, SIZE, MODIFIED, and the size is the
 * only one needed; the model *name* is what `pull` and the API use.
 */
export function parseOllamaList(text: string): { id: string; sizeGb: number }[] {
  const out: { id: string; sizeGb: number }[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    // Skip the header row and blank lines.
    if (!line || /^NAME\s/i.test(line)) continue
    const name = line.split(/\s+/)[0]
    // The size column sits after the model id, and an id like `8f9a1b2c3d4e`
    // also contains patterns that look like a number and a unit. Taking the
    // *last* match on the line avoids both the tag (`...:30b`) and the id.
    const matches = [...line.matchAll(/([\d.]+)\s*(GB|MB|KB|B)(?![A-Za-z])/gi)]
    const size = matches.length ? matches[matches.length - 1] : null
    if (!name || !size) continue
    const v = Number(size[1]) || 0
    const unit = size[2].toUpperCase()
    const sizeGb = unit === 'GB' ? v : unit === 'MB' ? v / 1000 : unit === 'KB' ? v / 1e6 : v / 1e9
    out.push({ id: name, sizeGb: Math.round(sizeGb * 100) / 100 })
  }
  return out
}

// ------------------------------------------------------------------- hardware

export interface GpuInfo {
  name: string
  vendor: 'amd' | 'nvidia' | 'intel' | 'unknown'
  /** Adapter memory reported by the driver, in GB. */
  vramGb?: number
  /**
   * True when Ollama should reach this card through Vulkan rather than ROCm.
   * RDNA 1 (RX 5000 series, gfx1010) has no ROCm support — AMD dropped it and
   * Ollama's maintainers closed the request as not planned — so Vulkan is the
   * only accelerated path. Ollama enables Vulkan by default when the driver
   * provides it, which is why this still works with no extra setup.
   */
  needsVulkan: boolean
  /** A sentence the user can act on, shown in Settings. */
  note?: string
}

/** RDNA 1 cards share gfx1010 and were dropped by ROCm 6.x. */
const RDNA1 = /\b(rx ?5[567]0\d|rx ?5500|\b5500 ?xt\b|\b5600 ?xt\b|\b5700 ?xt\b|rx ?5700)\b/i

/**
 * Read the installed GPUs without a native module.
 *
 * `wmic` is deprecated and absent on newer Windows, so PowerShell's CIM query
 * comes first, with wmic as a fallback. Both are best-effort: no GPU information
 * must never block local models, only make the advice less specific.
 */
export function detectGpus(): GpuInfo[] {
  if (process.platform !== 'win32') return []
  const run = (cmd: string, args: string[]): string => {
    try {
      return execFileSync(cmd, args, { encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      return ''
    }
  }
  let raw = run('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Get-CimInstance Win32_VideoController | ForEach-Object { "$($_.Name)|$($_.AdapterRAM)" }'
  ])
  if (!raw.trim()) {
    raw = run('wmic', ['path', 'win32_VideoController', 'get', 'name,AdapterRAM', '/format:csv'])
  }
  const out: GpuInfo[] = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || /^name\b|^name,/i.test(trimmed) || /^Node,/i.test(trimmed)) continue
    // wmic CSV is Node,AdapterRAM,Name; the PowerShell pipe form is Name|Bytes.
    let name = ''
    let bytes = 0
    if (trimmed.includes('|')) {
      const [n, b] = trimmed.split('|')
      name = (n ?? '').trim()
      bytes = Number(b) || 0
    } else {
      const parts = trimmed.split(',')
      if (parts.length < 3) continue
      bytes = Number(parts[1]) || 0
      name = (parts[2] ?? '').trim()
    }
    if (!name || /microsoft basic|remote|virtual/i.test(name)) continue
    const vendor: GpuInfo['vendor'] = /amde|radeon|\bamd\b|ati /i.test(name)
      ? 'amd'
      : /nvidia|geforce|quadro|rtx|gtx/i.test(name)
        ? 'nvidia'
        : /intel|arc|iris|uhd/i.test(name)
          ? 'intel'
          : 'unknown'
    // AdapterRAM is a signed 32-bit value in WMI and wraps at 4 GB on cards
    // larger than that, so a low number is a floor, not the true size.
    const vramGb = bytes > 0 ? Math.round((bytes / 1e9) * 10) / 10 : undefined
    const amdRdna1 = vendor === 'amd' && RDNA1.test(name)
    out.push({
      name,
      vendor,
      vramGb,
      needsVulkan: amdRdna1,
      note: amdRdna1
        ? 'RDNA 1 card: AMD dropped ROCm for it, so Ollama runs it through Vulkan, which is enabled by default. If generation is slow, check the backend in the daemon log.'
        : undefined
    })
  }
  return out
}

/** The discrete card worth sizing models for: the largest reported, ignoring integrated GPUs. */
export function primaryGpu(gpus: GpuInfo[]): GpuInfo | undefined {
  const discrete = gpus.filter((g) => !/intel|iris|uhd/i.test(g.name) || /arc/i.test(g.name))
  const pool = discrete.length ? discrete : gpus
  return [...pool].sort((a, b) => (b.vramGb ?? 0) - (a.vramGb ?? 0))[0]
}

/** The run command for a model, used for the "already installed" check. */
export function ollamaPullArgs(modelId: string): string[] {
  return ['pull', modelId]
}

/**
 * Env for the daemon that makes it put weights where the user asked, plus
 * settings that materially help an agent loop on consumer hardware.
 */
/** Context defaults, chosen by VRAM class rather than one fixed number. */
export const CONTEXT_CHOICES = [
  { tokens: 8192, label: '8K — smallest memory use', forGb: 8 },
  { tokens: 12288, label: '12K — balanced for 8 GB cards', forGb: 8 },
  { tokens: 16384, label: '16K — needs a little growth room', forGb: 12 },
  { tokens: 32768, label: '32K — comfortable on 16 GB or more', forGb: 16 },
  { tokens: 65536, label: '64K — 24 GB cards', forGb: 24 }
] as const

/**
 * A KV cache is not free: on a 12B model roughly 0.14 GB per 1k tokens. The
 * agent needs a few thousand tokens for its system prompt and tools, but asking
 * for 32k on an 8 GB card spends ~4.5 GB of VRAM on cache alone and pushes the
 * model into system RAM, where it runs several times slower.
 */
export function contextForVram(vramGb: number | undefined): number {
  if (vramGb === undefined) return 16384
  if (vramGb <= 8) return 12288
  if (vramGb <= 12) return 16384
  if (vramGb <= 16) return 32768
  return 65536
}

export function ollamaServeEnv(modelsDir: string, contextLength = 32768): Record<string, string> {
  return {
    OLLAMA_MODELS: modelsDir,
    // The agent sends a large system prompt; Ollama's 4k default truncates it and
    // the model then "forgets" its tools. The exact size is a memory trade-off.
    OLLAMA_CONTEXT_LENGTH: String(contextLength),
    // Keep the model resident between turns; reloading costs tens of seconds.
    OLLAMA_KEEP_ALIVE: '30m',
    // AMD cards (including RDNA 1, which ROCm dropped) run through Vulkan. It is
    // on by default when available; being explicit survives a stray OLLAMA_VULKAN=0.
    OLLAMA_VULKAN: '1'
  }
}

// -------------------------------------------------------------------- install

let currentInstall: ChildProcess | null = null

/** True when the packaged app carries its own Ollama installer. */
export function hasBundledInstaller(): boolean {
  try {
    return fs.existsSync(path.join(process.resourcesPath ?? app.getAppPath(), 'vendor', 'OllamaSetup.exe'))
  } catch {
    return false
  }
}

export interface InstallEvent {
  phase: 'download' | 'install' | 'done' | 'error'
  /** 0..1 when known. */
  progress?: number
  receivedMb?: number
  totalMb?: number
  message: string
}

/**
 * Download the official Windows installer and run it silently.
 *
 * Silent flags are Inno Setup's (`/VERYSILENT /SUPPRESSMSGBOXES /NORESTART`),
 * which is what OllamaSetup.exe is built with. `/DIR` places the binaries on the
 * chosen drive; weights go wherever `OLLAMA_MODELS` points, set separately.
 */
export async function installOllama(opts: {
  /** Place the program files here (the installer's /DIR). */
  installDir?: string
  /** A local installer to use instead of downloading one (for tests/offline). */
  installerPath?: string
  onEvent: (e: InstallEvent) => void
}): Promise<{ ok: boolean; path?: string; error?: string }> {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'The in-app installer is for Windows. Install Ollama with your package manager, then press Detect.' }
  }
  const event = (e: InstallEvent): void => {
    try {
      opts.onEvent(e)
    } catch {
      // A dead renderer must not abort an install.
    }
  }
  const tmp = path.join(app.getPath('temp'), 'OllamaSetup.exe')
  const target = opts.installerPath || tmp
  try {
    // Prefer an installer shipped inside the app: it makes an offline install
    // possible, and it cannot be tampered with in transit.
    const bundled = path.join(process.resourcesPath ?? app.getAppPath(), 'vendor', 'OllamaSetup.exe')
    const source = opts.installerPath || (hasBundledInstaller() ? bundled : undefined)
    if (!source) {
      event({ phase: 'download', message: 'Contacting GitHub for the Ollama installer…', progress: 0 })
      const res = await fetch('https://github.com/ollama/ollama/releases/latest/download/OllamaSetup.exe', { redirect: 'follow' })
      if (!res.ok || !res.body) return { ok: false, error: `Could not download the installer (HTTP ${res.status}).` }
      const total = Number(res.headers.get('content-length') ?? 0)
      const out = fs.createWriteStream(target)
      let received = 0
      let lastEmit = 0
      const stream = res.body as unknown as AsyncIterable<Uint8Array>
      for await (const chunk of stream) {
        out.write(chunk)
        received += chunk.length
        // Throttle: a 1 GB download must not emit ten thousand events.
        if (Date.now() - lastEmit > 250) {
          lastEmit = Date.now()
          event({
            phase: 'download',
            progress: total ? received / total : undefined,
            receivedMb: Math.round(received / 1e6),
            totalMb: total ? Math.round(total / 1e6) : undefined,
            message: total
              ? `Downloading Ollama… ${Math.round(received / 1e6)} / ${Math.round(total / 1e6)} MB`
              : `Downloading Ollama… ${Math.round(received / 1e6)} MB`
          })
        }
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))
    }

    const installer = source ?? target
    event({
      phase: 'install',
      message: source ? 'Using the installer bundled with the app…' : 'Running the installer (no window will appear)…'
    })
    const args = ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-']
    if (opts.installDir) args.push(`/DIR=${opts.installDir}`)
    const code = await new Promise<number>((resolve) => {
      currentInstall = spawn(installer, args, { stdio: 'ignore', windowsVerbatimArguments: false })
      currentInstall.on('error', () => resolve(-1))
      currentInstall.on('exit', (c: number | null) => resolve(c ?? -1))
    })
    currentInstall = null
    if (code !== 0) return { ok: false, error: `The installer exited with code ${code}.` }

    event({ phase: 'done', progress: 1, message: 'Ollama installed.' })
    return { ok: true, path: findOllama() ?? undefined }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  } finally {
    if (!opts.installerPath) {
      try {
        fs.rmSync(target, { force: true })
      } catch {
        // Leave a stray temp file rather than fail the install over it.
      }
    }
  }
}

/** Start the daemon ourselves with the right env, if the app has to. */
export function startOllamaServe(exe: string, modelsDir: string, contextLength?: number): ChildProcess | null {
  try {
    const ctx = contextLength ?? contextForVram(undefined)
    const env = { ...process.env, ...ollamaServeEnv(modelsDir, ctx) }
    const child = spawn(exe, ['serve'], { env, stdio: 'ignore', detached: false, windowsHide: true })
    child.on('error', () => undefined)
    return child
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------- usage

export interface PullProgress {
  model: string
  status: string
  progress?: number
  done: boolean
  error?: string
}

let currentPull: { controller: AbortController; model: string } | null = null

/**
 * Pull one model, streaming Ollama's own progress lines. Ollama reports each
 * layer separately, so the percentage shown is the current layer, not the whole
 * model; the status text is passed through so the UI never looks frozen.
 */
export async function pullModel(
  modelId: string,
  onProgress: (p: PullProgress) => void,
  baseUrl = 'http://localhost:11434'
): Promise<{ ok: boolean; error?: string }> {
  const controller = new AbortController()
  currentPull = { controller, model: modelId }
  try {
    const res = await fetch(`${baseUrl}/api/pull`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: modelId, stream: true })
    })
    if (!res.ok || !res.body) return { ok: false, error: `Ollama refused the pull (HTTP ${res.status}).` }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        let msg: { status?: string; total?: number; completed?: number; error?: string }
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.error) {
          onProgress({ model: modelId, status: 'error', done: true, error: msg.error })
          return { ok: false, error: msg.error }
        }
        const done = msg.status === 'success'
        onProgress({
          model: modelId,
          status: msg.status ?? 'pulling',
          progress: msg.total ? (msg.completed ?? 0) / msg.total : done ? 1 : undefined,
          done
        })
        if (done) return { ok: true }
      }
    }
    // Ollama normally sends a final "success" line; if the stream just ends,
    // report completion once from here instead of emitting it twice.
    onProgress({ model: modelId, status: 'success', done: true, progress: 1 })
    return { ok: true }
  } catch (e) {
    const msg = (e as Error).message
    return { ok: false, error: /abort/i.test(msg) ? 'Download cancelled.' : msg }
  } finally {
    currentPull = null
  }
}

export function cancelPull(): { cancelled: boolean; model?: string } {
  if (!currentPull) return { cancelled: false }
  const { controller, model } = currentPull
  controller.abort()
  return { cancelled: true, model }
}

export function installInProgress(): boolean {
  return !!currentInstall
}
