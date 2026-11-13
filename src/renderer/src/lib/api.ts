
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

export interface EvolveRules {
  quality: number
  speed: number
  size: number
  ram: number
}

export interface EvolveStep {
  phase: string
  generation?: number
  detail?: string
}

export interface EvolveGeneration {
  id: number
  createdAt: number
  thesis: string
  score?: number
  parts?: Record<string, number>
  status: string
  outcome?: string
  parent: number | null
  builds?: boolean
  classBytes?: number
  sourceBytes?: number
  buildMs?: number
  minHeapMb?: number | null
  note?: string
}

export interface EvolveStatus {
  ok: boolean
  running: boolean
  paused: boolean
  active: { id: number; thesis: string; score?: number; status: string } | null
  best: { id: number; score?: number } | null
  generations: EvolveGeneration[]
  rules: EvolveRules
  config: { evolving: boolean; evolveCount: number; evolveMaxGenerations: number; evolveMaxHeapMb: number }
  instructions: string
  mutator: string
  sourcesDir: string
}

export type RunMode = 'code' | 'learn' | 'research'

export interface LessonSummary {
  id: string
  rule: string
  fix?: string
  avoid?: string
  kind?: 'failure' | 'topic' | 'research'
  topic?: string
  sources?: string[]
  loader?: string
  mcVersion?: string
  seen: number
  confirmed?: boolean
}

export interface ModesStatus {
  mode: RunMode
  learningMode: boolean
  deepResearch: boolean
  autoSwitch: boolean
  autoSwitchLimit: number
  autoSwitchIncludeLocal: boolean
  researchTopic: string
  /** Human-readable model the next run will use. */
  runningOn: string
  /** What deep research would spend, if it were turned on. */
  best: { provider: string; model: string; label: string; free: boolean; why: string } | null
  lessons: number
  research: { topic: string; startedAt: number; model: string; notes: { file: string; title: string; updatedAt: number }[] } | null
}

/** One line in the diagnostics panel. */
export interface DiagEntry {
  id: string
  at: number
  level: 0 | 1 | 2 | 3
  source: 'agent' | 'sdk' | 'tool' | 'provider' | 'stream' | 'build' | 'game' | 'ipc' | 'app'
  label: string
  detail?: unknown
  note?: string
}

export interface DiagState {
  level: 0 | 1 | 2 | 3
  name: 'off' | 'errors' | 'verbose' | 'trace'
  logPath: string
}

export interface VersionChoice {
  id: string
  type: 'release' | 'snapshot' | 'old_beta' | 'old_alpha'
  releasedAt: string
  /** Loaders with a build for this Minecraft version. */
  loaders: Loader[]
}

export type ModelKind = 'block' | 'item' | 'entity' | 'animation'

export type TexturePattern = 'flat' | 'noise' | 'grain' | 'brick' | 'ore' | 'metal' | 'planks' | 'frame'
export type TexturePalette = 'stone' | 'wood' | 'metal' | 'gem' | 'organic' | 'dark'

export interface TextureResult {
  ok: boolean
  error?: string
  /** Path relative to the project root. */
  path?: string
  bytes?: number
  /** The namespaced id a model should point at. */
  ref?: string
}

export interface ShaderStage {
  can: string[]
  cannot: string[]
}

export interface RendererSupport {
  mcVersion: string
  api: 'gl11' | 'gl20' | 'gl33' | 'core' | 'blaze3d' | 'pipeline'
  apiLabel: string
  shadingLanguage: string
  howShadersLoad: string
  needsShaderMod: 'none' | 'iris-sodium' | 'optifine-shaders' | 'both'
  stage: ShaderStage
  ceiling: string
  constraints: string[]
}

export interface RendererInfo {
  ok: boolean
  mcVersion: string
  loader: string
  support: RendererSupport
  verdict: { achievable: boolean; how: string }
}

/* ------------------------------------------------------------------ shaders */

export type UseCase = 'looks' | 'performance' | 'realism' | 'custom-renderer' | 'pbr-materials' | 'low-end' | 'compare'

export interface ShaderPackInfo {
  id: string
  name: string
  author: string
  style: 'vanilla-plus' | 'realistic' | 'fantasy' | 'cinematic' | 'performance'
  weight: 'light' | 'medium' | 'heavy' | 'extreme'
  runsOn: ('iris' | 'optifine')[]
  minGpu: string
  bestFor: string
  caveat: string
  url: string
  popularity: number
}

export interface RenderEngineInfo {
  id: string
  name: string
  kind: 'pack-loader' | 'perf' | 'sdk' | 'instancing' | 'legacy'
  gives: string
  misread: string
  loaders: ('fabric' | 'forge' | 'neoforge')[]
  versions: { min: string; max?: string }
  dependOn: boolean
  needs?: string[]
  conflicts?: string[]
  url: string
  cost: string
}

export interface ShaderPick {
  id: string
  name: string
  kind: 'pack' | 'engine'
  why: string
  action: string
}

export interface ShaderRecommendation {
  useCase: UseCase
  mcVersion: string
  loader: string
  picks: ShaderPick[]
  avoid?: string
  userInstalls: boolean
}

export interface ShaderCatalogue {
  ok: boolean
  mcVersion: string
  loader: string
  useCases: Record<UseCase, string>
  available: { packs: ShaderPackInfo[]; engines: RenderEngineInfo[] }
  all: { packs: ShaderPackInfo[]; engines: RenderEngineInfo[] }
  recommendations: Record<UseCase, ShaderRecommendation>
}

export interface CompatibilityNote {
  severity: 'error' | 'warning'
  message: string
}

export interface ModelInfo {
  ok: boolean
  modId: string
  mcVersion: string
  /** Pre-1.13: no geo/ or animations/ folders exist, and entity models are Java. */
  legacy: boolean
  note: string
  folders: {
    blockModels: string
    itemModels: string
    blockstates: string
    geo: string | null
    animations: string | null
  }
}

export interface ModelIssue {
  severity: 'error' | 'warning'
  message: string
  fix: string
}

export interface ModelCreateResult {
  ok: boolean
  error?: string
  written?: string[]
  issues?: ModelIssue[]
  /** The texture id the model refers to, e.g. ruby:block/ruby_block. */
  texture?: string | null
  /** The png that must exist, or the block renders as a checkerboard. */
  textureFile?: string | null
}

export interface LocalModelDef {
  id: string
  label: string
  sizeGb: number
  tools: boolean
  vision: boolean
  suits: string[]
  note: string
}

export interface LocalRoleDef {
  id: 'agent' | 'vision' | 'quick'
  label: string
  helps: string
  needs: 'tools' | 'vision'
}

export interface BundleDef {
  id: string
  label: string
  summary: string
  models: string[]
  covers: string[]
}

export interface LocalInfo {
  installed: boolean
  /** The packaged app already contains the Ollama installer. */
  bundledInstaller: boolean
  exe: string | null
  running: boolean
  anthropicCompatible: boolean
  version?: string
  modelsDir: string
  defaultModelsDir: string
  freeGb?: number
  installedModels: { id: string; sizeGb: number }[]
  roles: { agent: string[]; vision: string[]; quick: string[] }
  models: LocalModelDef[]
  bundles: BundleDef[]
  roleDefs: LocalRoleDef[]
  hardware: HardwareInfo
  /** 0 means "choose from the GPU automatically". */
  contextLength: number
}

export interface HardwareInfo {
  gpus: GpuInfo[]
  primary?: GpuInfo
  recommendedBundle: string
  suggestedContext: number
  system: SystemInfo
  verdicts: Record<string, ModelVerdict>
  /** Largest model that runs comfortably, if any. */
  bestModel?: string
  /** Nothing in the catalogue can run here. */
  noneRun: boolean
}

export type Verdict = 'good' | 'slow' | 'tight' | 'impossible'

export interface SystemInfo {
  platform: string
  ramGb: number
  cpuCores: number
  cpus: string
  gpus: GpuInfo[]
  primary?: GpuInfo
  usableGb: number
  cpuOnly: boolean
  summary: string
  notes: string[]
}

export interface ModelVerdict {
  modelId: string
  verdict: Verdict
  needGb: number
  haveGb: number
  reason?: string
  fix?: string
  onCpu: boolean
}

export interface GpuInfo {
  name: string
  vendor: 'amd' | 'nvidia' | 'intel' | 'unknown'
  vramGb?: number
  /** RDNA 1 card, which ROCm dropped; Ollama uses Vulkan instead. */
  needsVulkan: boolean
  note?: string
}

export interface InstallProgress {
  phase: 'download' | 'install' | 'done' | 'error'
  progress?: number
  receivedMb?: number
  totalMb?: number
  message: string
}

export interface PullProgress {
  model: string
  status: string
  progress?: number
  done: boolean
  error?: string
}

export interface BundleProgress {
  index: number
  of: number
  model: string
  state: 'start' | 'done' | 'error' | 'skipped'
  error?: string
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
  analysis?: { at: number; model: string; text: string; frames: number; mode?: 'bug' | 'look' }
}

export type ModuleLayout = 'neoforge' | 'forge-gradle' | 'architectury' | 'fabric' | 'unknown'

/** What a project on disk actually is, read from its own files. */
export interface DetectedProject {
  dir: string
  mcVersion: string | null
  loader: Loader | 'unknown'
  layout: ModuleLayout
  modId: string | null
  modName: string | null
  group: string | null
  version: string | null
  sourceRoot: string
  legacyFiles: string[]
  declaredJava: number | null
  expectedJava: number
  midUpgrade: boolean
}

export interface PortStep {
  kind: 'build' | 'api' | 'metadata' | 'mechanical'
  title: string
  detail: string
}

export interface PortPlan {
  from: DetectedProject
  target: { loader: Loader; mcVersion: string }
  alreadyTarget: boolean
  majorJump: boolean
  java: number
  /** Things the app will do for you. */
  automatic: string[]
  /** Things that need a human or the agent. */
  manual: PortStep[]
  blockers: string[]
  summary: string
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

export interface DependencyInfo {
  package: string
  name?: string
  kind: 'mod' | 'library' | 'unknown'
  files: number
  declared?: string[]
  homepage?: string
  note?: string
}

export interface DependencyScan {
  ok: boolean
  dir?: string
  mcVersion?: string
  loader?: string
  filesScanned: number
  /** Minecraft classes the build failed to find — a build-file problem, not a download. */
  gameClassErrors: string[]
  dependencies: DependencyInfo[]
  error?: string
}

export interface DependencyCandidate {
  source: 'modrinth' | 'manual'
  name: string
  projectId?: string
  slug?: string
  homepage?: string
  description?: string
  downloads?: number
  loaders?: string[]
  /** The file that would be downloaded, when one applies to this version. */
  file?: { name: string; url: string; versionNumber?: string; versionId?: string; size?: number }
  /** Why no file applies, when one does not. */
  missing?: string
  versionId?: string
}

/** Mirrors `PackMod` in `src/main/mod/modpack.ts`. */
export interface PackMod {
  path: string
  file: string
  modId?: string
  name?: string
  version?: string
  loader: 'neoforge' | 'forge' | 'fabric' | 'quilt' | 'unknown'
  depends: { modId: string; versionRange?: string; kind: string; isLoaderOrGame: boolean }[]
  unreadable?: boolean
}

/** What a scan of a pack's `mods` folder found. */
export interface PackScan {
  dir: string
  mods: PackMod[]
  /** Dependencies no jar in the folder provides — the only download candidates. */
  missing: { modId: string; versionRange?: string; requiredBy: string[] }[]
  mismatched: { modId: string; have?: string; versionRange?: string; requiredBy: string[] }[]
  ignored: string[]
  loaders: string[]
  gameVersions: string[]
}

/** A jar matched to a Modrinth project, by hash. */
export interface PackIdentified {
  path: string
  hash: string
  projectId?: string
  versionId?: string
  versionNumber?: string
  projectName?: string
  projectSlug?: string
}

/** One mod that has a newer build for the pack's own game version. */
/**
 * One dependency of a mod being updated, and what has to happen to it.
 *
 * `keep` means the folder already has a compatible copy — the only decision left
 * is whether to decompile it. `download` means it is absent or too old, which is
 * the *only* case that reaches the network.
 */
export interface PackDependencyAction {
  modId: string
  displayName: string
  versionRange?: string
  path?: string
  file?: string
  version?: string
  needsNewer: boolean
  problem?: string
  action: 'keep' | 'download'
  reason: string
  target?: { name: string; url: string; version?: string; projectId?: string }
}

export interface PackUpdate {
  path: string
  file: string
  modId?: string
  projectId?: string
  projectName?: string
  haveVersion?: string
  newestVersion?: string
  newestFile?: { name: string; url: string; versionId: string; size?: number }
  updateAvailable: boolean
}

export type DependencyOutcome = 'already-present' | 'present-wrong-version' | 'missing' | 'needs-confirmation'

/** One dependency of an update, decided against the folder as it stands. */
export interface PlannedDependency {
  modId: string
  outcome: DependencyOutcome
  providedBy?: string
  haveVersion?: string
  versionRange?: string
  requiredBy: string[]
  declaredBy: string[]
}

/** The folder-first answer for one update. */
export interface UpdatePlan {
  modId?: string
  dependencies: PlannedDependency[]
  /** Usually empty: a working pack covers its own dependencies. */
  toDownload: PlannedDependency[]
  summary: string
}

export interface JavaStatus {
  game: { path: string | null; version?: string; error?: string }
  tools: { path: string | null; version?: string; error?: string }
  split: boolean
  /** What a build will export, and the unusable inherited value if there was one. */
  javaHome?: { set: string | null; broken: string | null }
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
    status: () => Promise<JavaStatus>
    check: (javaPath: string) => Promise<{ ok: boolean; version?: string; major?: number; suitsGame?: boolean; suitsTools?: boolean; error?: string; cleared?: boolean }>
    clearCache: () => Promise<{ ok: boolean }>
  }
  local: {
    info: () => Promise<LocalInfo>
    probe: () => Promise<{ exe: string | null; running: boolean; anthropic: boolean; version?: string }>
    install: (opts: { installDir?: string; modelsDir?: string }) => Promise<{ ok: boolean; path?: string; error?: string }>
    setModelsDir: (dir: string) => Promise<{ ok: boolean; modelsDir?: string; restartNeeded?: boolean; error?: string }>
    startDaemon: () => Promise<{ ok: boolean; error?: string; alreadyRunning?: boolean }>
    pull: (modelId: string) => Promise<{ ok: boolean; error?: string; hardware?: ModelVerdict }>
    pullBundle: (opts: { bundle?: string; models?: string[] }) => Promise<{ ok: boolean; done?: string[]; skipped?: string[]; error?: string }>
    cancelPull: () => Promise<{ cancelled: boolean; model?: string }>
    setRoles: (roles: { agent?: string[]; vision?: string[]; quick?: string[] }) => Promise<{ ok: boolean; roles?: Record<string, string[]>; error?: string }>
    setContext: (tokens: number) => Promise<{ ok: boolean; contextLength?: number; restartNeeded?: boolean; error?: string }>
    onInstallProgress: (cb: (p: InstallProgress) => void) => () => void
    onPullProgress: (cb: (p: PullProgress) => void) => () => void
    onBundleProgress: (cb: (p: BundleProgress) => void) => () => void
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
    download: () => Promise<UpdateState>
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
    analyse: (opts: { id: string; goal?: string; model?: string; mode?: 'bug' | 'look' }) => Promise<{ ok: boolean; text?: string; model?: string; frames?: number; error?: string }>
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
  evolve: {
    status: () => Promise<EvolveStatus>
    rules: (rules: EvolveRules) => Promise<{ ok: boolean; rules: EvolveRules; instructions: string }>
    run: (count?: number) => Promise<{
      ok: boolean
      error?: string
      results?: { ok: boolean; verdict: string; error?: string; id?: number; promoted?: boolean }[]
      promoted?: number
      logPath?: string
    }>
    pause: (paused: boolean) => Promise<{ ok: boolean; paused: boolean }>
    promote: (id: number) => Promise<{ ok: boolean; error?: string; needsRestart?: boolean }>
    log: () => Promise<{ ok: boolean; text: string }>
    genome: (id: number) => Promise<{ ok: boolean; error?: string; files?: { path: string; text: string }[] }>
    onStep: (cb: (p: EvolveStep) => void) => () => void
    onDone: (cb: (p: { results: number; promoted: number }) => void) => () => void
  }
  modes: {
    status: () => Promise<ModesStatus>
    set: (patch: { learningMode?: boolean; deepResearch?: boolean; researchTopic?: string }) => Promise<{
      ok: boolean
      mode: RunMode
      needsTopic: boolean
      researchTopic: string
    }>
    knowledge: (topic?: string) => Promise<LessonSummary[]>
    startResearch: (topic: string) => Promise<{ ok: boolean; topic?: string; dir?: string; error?: string }>
    stopResearch: () => Promise<{ ok: boolean }>
    researchDir: () => Promise<string>
    onChanged: (cb: (p: { mode: RunMode }) => void) => () => void
    onModelSwitch: (cb: (p: { from: string; to: string; provider: string; reason: string; kind: string }) => void) => () => void
  }
  diag: {
    level: () => Promise<DiagState>
    setLevel: (value: number) => Promise<DiagState>
    history: () => Promise<DiagEntry[]>
    clear: () => Promise<boolean>
    exportText: () => Promise<string>
    logPath: () => Promise<string>
    openLog: () => Promise<{ ok: boolean; error?: string }>
    onEntry: (cb: (p: DiagEntry) => void) => () => void
    onThinking: (cb: (p: { text: string }) => void) => () => void
  }
  port: {
    detect: (dir: string) => Promise<{ ok: boolean; project?: DetectedProject; error?: string }>
    plan: (opts: { dir: string; loader: Loader; mcVersion: string }) => Promise<{ ok: boolean; plan?: PortPlan; error?: string }>
    report: (opts: { dir: string; loader: Loader; mcVersion: string }) => Promise<{ ok: boolean; text?: string; error?: string }>
    convert: (opts: {
      sourceDir: string
      targetDir: string
      loader: Loader
      mcVersion: string
      modVersion?: string
      author?: string
      license?: string
      backup?: boolean
    }) => Promise<{
      ok: boolean
      error?: string
      plan?: PortPlan
      dir?: string
      reportPath?: string
      backupPath?: string
      copiedSources?: number
      copiedResources?: number
      skipped?: string[]
      /** What the sources still need; a port copies code, not build files. */
      dependencies?: { package: string; name?: string; kind: string; files: number; declared?: string[]; homepage?: string }[]
    }>
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
    /** Make a folder the active project (empty = back to the scaffolded one). */
    activate: (dir: string) => Promise<{ ok: boolean; dir?: string; error?: string }>
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
  deps: {
    scan: (opts?: { dir?: string; buildErrors?: string[] }) => Promise<DependencyScan>
    find: (opts: { package: string; name?: string; dir?: string }) => Promise<{
      ok: boolean
      mcVersion?: string
      loader?: string
      candidates: DependencyCandidate[]
      error?: string
    }>
    install: (opts: { url: string; name: string; dir?: string }) => Promise<{ ok: boolean; path?: string; added?: boolean; error?: string }>
  }
  /**
   * A modpack's `mods` folder, scanned and updated mod by mod.
   *
   * Everything here takes a folder and answers about the folder. `updates` and
   * `download` are separate on purpose: what a pack has is decided without the
   * network, and only a genuinely missing dependency ever reaches `download`.
   */
  pack: {
    scan: (dir: string) => Promise<{
      ok: boolean
      error?: string
      adjusted?: boolean
      versions?: { mcVersion?: string; loader?: string }
      /** One sentence: is this folder already complete? */
      verdict?: { headline: string; detail: string; healthy: boolean }
      scan?: PackScan
    }>
    identify: (dir: string) => Promise<{
      ok: boolean
      error?: string
      identified: PackIdentified[]
      unidentified?: { path: string; file: string; modId?: string }[]
      versions?: { mcVersion?: string; loader?: string }
    }>
    updates: (opts: { dir: string; only?: string[] }) => Promise<{
      ok: boolean
      error?: string
      mcVersion?: string
      loader?: string
      updates: PackUpdate[]
      scanned?: number
      unidentified?: number
    }>
    /**
     * The real flow: one mod chosen to update, and the dependencies its new build
     * needs, each resolved against the folder first.
     */
    updatePlan: (opts: { dir: string; incomingJar: string }) => Promise<{
      ok: boolean
      error?: string
      preview?: {
        modId?: string
        name?: string
        version?: string
        replaces?: string
        dependencies: unknown[]
        needNewer: unknown[]
        summary: string
      }
      dependencies: PackDependencyAction[]
      download: PackDependencyAction[]
      keep: PackDependencyAction[]
      versions?: { mcVersion?: string; loader?: string }
    }>
    /** Download, replace and optionally decompile the dependencies of an update. */
    updateApply: (opts: {
      dir: string
      items: { modId: string; url: string; name: string; replacePath?: string }[]
      decompile?: boolean
      /** The updated mod's own jar, decompiled but not installed. */
      modJar?: string
    }) => Promise<{
      ok: boolean
      results: { modId: string; ok: boolean; error?: string; path?: string; replaced?: string; sources?: string; sourcesError?: string }[]
      sourcesDir?: string
    }>
    /** Decompile jars that are already in the pack. Nothing is moved or downloaded. */
    decompile: (opts: { dir: string; jars: string[]; sourcesDir?: string }) => Promise<{
      ok: boolean
      done?: number
      failed: { jar: string; error?: string }[]
      sourcesDir?: string
    }>
    /** What a jar would do to the folder, before it is copied in. Writes nothing. */
    preview: (opts: { dir: string; jar: string }) => Promise<{
      ok: boolean
      error?: string
      replaces?: string
      plan?: UpdatePlan
      versions?: { mcVersion?: string; loader?: string }
    }>
    plan: (opts: { dir: string; modId?: string; incomingJar?: string }) => Promise<{
      ok: boolean
      plan?: UpdatePlan
      versions?: { mcVersion?: string; loader?: string }
    }>
    download: (opts: { dir: string; url: string; name: string; replacePath?: string }) => Promise<{
      ok: boolean
      error?: string
      path?: string
      removed?: string
      mod?: { modId?: string; version?: string; loader?: string }
    }>
    adopt: (opts: { dir: string; from: string; replace?: boolean }) => Promise<{
      ok: boolean
      error?: string
      path?: string
      mod?: { modId?: string; version?: string; loader?: string }
    }>
    remove: (file: string) => Promise<{ ok: boolean; error?: string }>
  }
  build: {
    local: (opts?: { task?: 'build' | 'compileJava' }) => Promise<{ ok: boolean; code: number | null; logPath: string; jarPath?: string; errors: string[]; durationMs: number; hint?: string; missingDependencies?: string[] }>
    actions: () => Promise<{ ok: boolean; code: number | null; logPath: string; jarPath?: string; errors: string[]; durationMs: number; hint?: string; missingDependencies?: string[] }>
    preflight: () => Promise<{ ghFound: boolean; authed: boolean; repoOk: boolean; messages: string[] }>
    initRepo: (isPrivate: boolean) => Promise<{ ok: boolean; url?: string; error?: string }>
    /** Whether the open folder can be pushed, and what is missing if not. */
    repoState: () => Promise<{
      ok: boolean
      dir?: string
      state: 'no-repo' | 'no-origin' | 'ready'
      message: string | null
      suggestion?: string
    }>
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
  textures: {
    create: (req: {
      name: string
      kind?: 'block' | 'item'
      pattern?: TexturePattern
      palette?: TexturePalette
      size?: number
      silhouette?: boolean
    }) => Promise<TextureResult>
  }
  renderer: {
    capabilities: () => Promise<RendererInfo>
  }
  shaders: {
    catalogue: () => Promise<ShaderCatalogue>
    check: (ids: string[]) => Promise<{ ok: boolean; notes: CompatibilityNote[] }>
    explain: (useCase: UseCase) => Promise<{ ok: boolean; recommendation: ShaderRecommendation }>
  }
  models: {
    info: () => Promise<ModelInfo>
    create: (req: {
      name: string
      kind: ModelKind
      texture?: string
      skeleton?: 'none' | 'quadruped'
      size?: [number, number, number]
    }) => Promise<ModelCreateResult>
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
    onNotice: (cb: (p: { text: string }) => void) => () => void
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
