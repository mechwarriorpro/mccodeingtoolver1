
import type {
  AppConfig,
  Conversation,
  DeviceLoginPrompt,
  EnvReport,
  GameInstance,
  GameStatus,
  GithubStatus,
  PermissionPrompt,
  ReferenceModUi,
  ReleaseOption,
  ScreenshotInfo,
  ToolTrace
} from '../../../shared/types'

export type Loader = 'neoforge' | 'forge' | 'fabric'

export interface VersionChoice {
  id: string
  type: 'release' | 'snapshot' | 'old_beta' | 'old_alpha'
  releasedAt: string
  /** Loaders with a build for this Minecraft version. */
  loaders: Loader[]
}

export interface ProviderDef {
  id: string
  label: string
  signupUrl: string
  keyOptional?: boolean
  local?: boolean
  baseUrl: string
  note: string
}

export interface ProviderModel {
  id: string
  label: string
  /** No payment needed: a free tier, or local. */
  free: boolean
  /** Can drive the agent (tool calling). */
  tools: boolean
  /** Accepts screenshots and clip frames. */
  vision: boolean
  limits?: string
  context?: string
}

export interface Lesson {
  id: string
  fingerprint: string
  rule: string
  avoid?: string
  fix?: string
  source: 'local-build' | 'actions' | 'crash' | 'vision' | 'manual'
  loader?: string
  mcVersion?: string
  sample: string
  logPath?: string
  seen: number
  firstSeen: number
  lastSeen: number
  confirmed?: boolean
}

export interface ClipFrame {
  path: string
  /** Milliseconds from the start of the clip. */
  t: number
  label?: string
}

export interface ClipRecord {
  id: string
  dir: string
  startedAt: number
  durationMs: number
  fps: number
  frames: ClipFrame[]
  ended: 'duration' | 'stopped' | 'error'
  error?: string
  note?: string
  analysis?: { at: number; model: string; text: string; frames: number }
}

export interface ForkInfo {
  id: string
  referenceId: string
  slug: string
  title: string
  license?: string
  homepage?: string
  repo?: string
  dir: string
  loader: Loader
  mcVersion: string
  loaderVersion: string
  packages: string[]
  files: number
  createdAt: number
  updatedAt: number
  dirty?: boolean
}

export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'none' | 'error'
  /** Version offered by the update, when there is one. */
  version?: string
  /** Release notes for the offered update. */
  notes?: string
  /** 0-100 while downloading. */
  percent?: number
  error?: string
  /** A dev checkout cannot self-update; the UI says so instead of failing. */
  supported: boolean
  checkedAt?: number
}

export interface ProjectSummary {
  open: boolean
  dir?: string
  props?: Record<string, string>
  git?: { dirty: string[]; branch: string | null; remote: string | null }
  files?: { path: string; dir: boolean }[]
  latestJar?: { path: string; name: string; size: number; modId?: string; version?: string; displayName?: string }
  isGradle?: boolean
  template?: string
}

export interface McfApi {
  config: { get: () => Promise<AppConfig & { apiKeySet: boolean }>; set: (patch: Partial<AppConfig>) => Promise<AppConfig & { apiKeySet: boolean }> }
  app: { version: () => Promise<{ version: string; electron: string; node: string }> }
  github: {
    status: () => Promise<GithubStatus>
    loginDevice: (opts?: { openBrowser?: boolean }) => Promise<{ ok: boolean; auth?: Omit<GithubStatus, 'connected'>; error?: string }>
    loginToken: (token: string) => Promise<{ ok: boolean; auth?: unknown; error?: string }>
    logout: () => Promise<{ ok: boolean }>
    authPath: () => Promise<string>
    openDevicePage: () => Promise<void>
  }
  refs: {
    list: () => Promise<ReferenceModUi[]>
    resolve: (input: string) => Promise<{ ok: boolean; repo?: string; releases?: ReleaseOption[]; error?: string; needsAuth?: boolean }>
    addGithub: (opts: { repo: string; tag?: string; assetName?: string }) => Promise<{ ok: boolean; mod?: ReferenceModUi; error?: string }>
    addFiles: (opts?: { title?: string }) => Promise<{ ok: boolean; mods?: ReferenceModUi[]; error?: string }>
    remove: (id: string) => Promise<{ ok: boolean; mods: ReferenceModUi[] }>
    link: (id: string) => Promise<{ ok: boolean; dir?: string; files?: number; error?: string }>
    search: (opts: { query: string; id?: string; regex?: boolean }) => Promise<{ hits: { id: string; file: string; line: number; text: string }[]; error?: string }>
    tree: (id: string) => Promise<{ path: string; dir: boolean; size?: number }[]>
    readFile: (opts: { id: string; path: string }) => Promise<{ ok: boolean; text?: string; error?: string }>
    decompile: (id: string) => Promise<{ ok: boolean; mod?: ReferenceModUi; error?: string }>
    openFolder: (id: string) => Promise<void>
    openHomepage: (url: string) => Promise<void>
  }
  env: { report: () => Promise<EnvReport> }
  java: {
    status: () => Promise<{
      game: { path: string | null; version?: string; error?: string }
      tools: { path: string | null; version?: string; error?: string }
      split: boolean
    }>
    check: (javaPath: string) => Promise<{ ok: boolean; version?: string; major?: number; suitsGame?: boolean; suitsTools?: boolean; error?: string; cleared?: boolean }>
    clearCache: () => Promise<{ ok: boolean }>
  }
  providers: {
    list: () => Promise<{
      providers: ProviderDef[]
      models: Record<string, ProviderModel[]>
      defaults: Record<string, string>
    }>
    models: (opts: { provider: string; apiKey?: string }) => Promise<{
      ok: boolean
      models: ProviderModel[]
      source: 'live' | 'known'
      error?: string
    }>
    test: (opts: { provider: string; model: string; apiKey?: string }) => Promise<{
      ok: boolean
      reply?: string
      ms?: number
      error?: string
    }>
    openSignup: (url: string) => Promise<void>
  }
  update: {
    state: () => Promise<UpdateState & { versionLabel: string }>
    check: () => Promise<UpdateState>
    install: () => Promise<{ ok: boolean; error?: string }>
    setAuto: (enabled: boolean) => Promise<UpdateState>
    clearCache: () => Promise<{ ok: boolean; bytes?: number; error?: string }>
    supported: () => Promise<{ supported: boolean }>
  }
  learn: {
    list: () => Promise<Lesson[]>
    recall: (opts: { error: string; loader?: Loader; mcVersion?: string }) => Promise<{ lesson: Lesson; score: number; exact: boolean }[]>
    update: (opts: { id: string; rule?: string; fix?: string; avoid?: string }) => Promise<Lesson | null>
    remove: (id: string) => Promise<Lesson[]>
    clear: () => Promise<Lesson[]>
  }
  clips: {
    start: (opts?: { durationMs?: number; fps?: number; note?: string }) => Promise<{ ok: boolean; clip?: ClipRecord; error?: string }>
    stop: () => Promise<{ ok: boolean; error?: string }>
    list: () => Promise<ClipRecord[]>
    get: (id: string) => Promise<ClipRecord | null>
    remove: (id: string) => Promise<ClipRecord[]>
    analyse: (opts: { id: string; goal?: string; model?: string }) => Promise<{ ok: boolean; text?: string; model?: string; frames?: number; error?: string }>
    digest: (id: string) => Promise<{ ok: boolean; text?: string; error?: string }>
  }
  forks: {
    list: () => Promise<ForkInfo[]>
    suggest: (referenceId: string) => Promise<{
      ok: boolean
      loader?: Loader
      mcVersion?: string
      title?: string
      license?: string
      repo?: string
      warning?: string
      error?: string
    }>
    create: (opts: {
      referenceId: string
      loader?: Loader
      mcVersion?: string
      loaderVersion?: string
      parentDir?: string
    }) => Promise<{ ok: boolean; fork?: ForkInfo; error?: string; warning?: string }>
    remove: (id: string) => Promise<ForkInfo[]>
    open: (id: string) => Promise<{ ok: boolean; dir?: string; error?: string }>
    tree: (id: string) => Promise<{ path: string; dir: boolean }[]>
    readFile: (opts: { id: string; path: string }) => Promise<{ ok: boolean; text?: string; error?: string }>
    writeFile: (opts: { id: string; path: string; text: string }) => Promise<{ ok: boolean; error?: string }>
  }
  versions: {
    catalog: (opts?: { force?: boolean; snapshots?: boolean }) => Promise<{
      ok: boolean
      fetchedAt: number
      errors: string[]
      minVersion: string
      versions: VersionChoice[]
    }>
    loaders: (opts: { mcVersion: string; loader: Loader }) => Promise<{
      ok: boolean
      versions: string[]
      loaders: Loader[]
    }>
    era: (opts: { loader: Loader; mcVersion: string }) => Promise<{
      ok: boolean
      era?: { id: string; label: string; buildable: boolean; java: number; notes: string[] }
      error?: string
    }>
  }
  project: {
    scaffold: (opts: {
      parentDir: string
      modId: string
      modName: string
      group: string
      modVersion: string
      author?: string
      license?: string
      loader: Loader
      mcVersion: string
      loaderVersion: string
    }) => Promise<
      | { ok: true; dir: string; era?: { id: string; label: string; buildable: boolean; notes: string[] } }
      | { ok: false; error: string }
    >
    validate: (opts: { modId: string; group: string }) => Promise<{ modId: string | null; group: string | null }>
    summary: () => Promise<ProjectSummary>
    readFile: (rel: string) => Promise<{ ok: boolean; text?: string; error?: string }>
    writeFile: (rel: string, content: string) => Promise<{ ok: boolean; error?: string }>
  }
  shell: { openPath: (p: string) => Promise<string> }
  dialog: {
    pickFolder: (opts?: { title?: string; defaultPath?: string }) => Promise<string | null>
    pickFiles: (opts?: { title?: string; filters?: { name: string; extensions: string[] }[]; multi?: boolean }) => Promise<string[]>
  }
  neoforge: {
    status: () => Promise<{ instance: string | null; minecraftDir: string; neoVersion: string; installed: boolean; javaFound: boolean }>
    install: () => Promise<{ ok: boolean; minecraftDir: string; versionId?: string; log: string; error?: string }>
  }
  build: {
    local: (opts?: { task?: 'build' | 'compileJava' }) => Promise<{ ok: boolean; code: number | null; logPath: string; jarPath?: string; errors: string[]; durationMs: number }>
    actions: () => Promise<{ ok: boolean; code: number | null; logPath: string; jarPath?: string; errors: string[]; durationMs: number }>
    preflight: () => Promise<{ ghFound: boolean; authed: boolean; repoOk: boolean; messages: string[] }>
    initRepo: (isPrivate: boolean) => Promise<{ ok: boolean; url?: string; error?: string }>
    openLog: (p: string) => Promise<void>
  }
  instance: {
    detect: () => Promise<GameInstance[]>
    list: () => Promise<{ instances: GameInstance[]; activeId: string }>
    setActive: (id: string) => Promise<unknown>
    add: (instance: GameInstance) => Promise<unknown>
    remove: (id: string) => Promise<unknown>
  }
  game: {
    status: () => Promise<GameStatus>
    launch: () => Promise<{ ok: boolean; error?: string }>
    stop: () => Promise<{ ok: boolean }>
    log: (lines?: number) => Promise<{ logPath?: string; text: string; crash?: string }>
    screenshot: (label?: string) => Promise<{ ok: boolean; path?: string; base64?: string; error?: string }>
    screenshots: () => Promise<ScreenshotInfo[]>
    openFolder: () => Promise<void>
    installJar: (jarPath?: string) => Promise<{ ok: boolean; installed?: string; error?: string }>
    exportTechnic: () => Promise<{ ok: boolean; zip?: string; error?: string }>
    launchDirect: () => Promise<{ ok: boolean; error?: string }>
    directStatus: () => Promise<{ running: boolean; pid?: number; titleScreen?: boolean; logPath?: string; exitCode?: number | null }>
    stopAny: () => Promise<{ ok: boolean; error?: string }>
  }
  chat: {
    list: () => Promise<{ id: string; title: string; updatedAt: number }[]>
    load: (id: string) => Promise<Conversation | null>
    new: () => Promise<Conversation>
    remove: (id: string) => Promise<{ id: string; title: string; updatedAt: number }[]>
    send: (payload: { text: string; attachments?: { path: string; name: string; kind: string; mediaType?: string }[] }) => Promise<{ ok: boolean; error?: string }>
    interrupt: () => Promise<{ ok: boolean }>
    permission: (payload: { id: string; allow: boolean; remember: boolean }) => Promise<{ ok: boolean }>
    autonomy: (mode: 'auto' | 'review' | 'ask') => Promise<{ ok: boolean }>
    attachImage: (payload: { base64: string; name: string }) => Promise<{ path: string; name: string; kind: string; size: number }>
    attachFile: (filePath: string) => Promise<{ path: string; name: string; kind: string; size: number }>
  }
  events: {
    onAgentText: (cb: (p: { text: string }) => void) => () => void
    onAgentBlock: (cb: (p: { text: string }) => void) => () => void
    onToolStart: (cb: (p: ToolTrace) => void) => () => void
    onToolEnd: (cb: (p: { id: string; status: ToolTrace['status']; detail?: string }) => void) => () => void
    onPermission: (cb: (p: PermissionPrompt) => void) => () => void
    onPermissionResolved: (cb: (p: { id: string }) => void) => () => void
    onStatus: (cb: (p: { status: string; detail?: string }) => void) => () => void
    onResult: (cb: (p: { text: string; costUsd?: number; isError?: boolean; sessionId?: string }) => void) => () => void
    onOutput: (cb: (p: { line: string; source: 'build' | 'game' }) => void) => () => void
    onUserMessage: (cb: (p: unknown) => void) => () => void
    onAssistantStart: (cb: (p: unknown) => void) => () => void
    onBuildLine: (cb: (p: { line: string }) => void) => () => void
    onBuildDone: (cb: (p: unknown) => void) => () => void
    onGameLine: (cb: (p: { line: string }) => void) => () => void
    onGameStatus: (cb: (p: GameStatus) => void) => () => void
    onScreenshot: (cb: (p: { path: string; label?: string }) => void) => () => void
    onGithubDeviceCode: (cb: (p: DeviceLoginPrompt) => void) => () => void
    onGithubDeviceTick: (cb: (p: { secondsLeft: number }) => void) => () => void
    onRefLine: (cb: (p: { line: string }) => void) => () => void
    onRefListChanged: (cb: () => void) => () => void
    onUpdateState: (cb: (p: UpdateState) => void) => () => void
    onForkListChanged: (cb: () => void) => () => void
    onClipStarted: (cb: (p: { maxMs: number }) => void) => () => void
    onClipFrame: (cb: (p: { t: number; index: number; total: number; path: string }) => void) => () => void
    onClipDone: (cb: (p: { clip: ClipRecord }) => void) => () => void
    onClipAnalysing: (cb: (p: { id: string }) => void) => () => void
  }
}

declare global {
  interface Window {
    mcf: McfApi
  }
}

export const api: McfApi = window.mcf
