export type AutonomyMode = 'auto' | 'review' | 'ask'

/**
 * Local models. A role points at a list of model ids so one download can serve
 * several uses (a big coder can write code *and* describe screenshots); the
 * first entry is the one actually used.
 */
export interface LocalSettings {
  /** Where Ollama keeps its weights. Empty means Ollama's own default. */
  modelsDir: string
  /** Model ids per role. `agent` drives coding, `vision` looks at clips. */
  roles: { agent: string[]; vision: string[]; quick: string[] }
  /** Install directory for the Ollama program itself, Windows only. */
  installDir: string
  /** We started the daemon with OLLAMA_MODELS, so the app owns its lifetime. */
  managed: boolean
  /** Context window in tokens; 0 means "pick from the GPU's VRAM". */
  contextLength: number
}

export interface AppConfig {
  /** API key for the selected provider (Anthropic by default). */
  apiKey: string
  /** Which provider the agent talks to. See src/main/providers.ts. */
  provider: string
  /** Anthropic-compatible base URL (empty = default api.anthropic.com). */
  baseUrl: string
  /** Model id passed to the SDK. */
  model: string
  /** Max USD budget for a single agent run (0 = unlimited). */
  maxBudgetUsd: number
  /**
   * Diagnostic detail: 0 off, 1 errors only, 2 every agent step, 3 everything
   * including raw provider traffic.
   */
  diagLevel: 0 | 1 | 2 | 3
  /** Let the model think before acting, and show the reasoning when diag is on. */
  showThinking: boolean
  /** Token budget for that thinking (0 = the provider's default). */
  thinkingTokens: number

  /**
   * When a run dies from something another model could survive — out of credit,
   * rate limited, a retired model — carry on with the next free one instead of
   * ending the chat.
   */
  autoSwitch: boolean
  /** How many switches to allow in one turn before giving up and saying so. */
  autoSwitchLimit: number
  /** Local models take part in the chain, and come first when offline. */
  autoSwitchIncludeLocal: boolean

  /** Study a topic instead of coding, and keep what is learned as lessons. */
  learningMode: boolean
  /** Research hard with the strongest model available, writing lessons for weaker ones. */
  deepResearch: boolean
  /** What a deep-research run should investigate. Set when the mode is turned on. */
  researchTopic: string
  /** Default autonomy for new conversations. */
  autonomy: AutonomyMode

  /** Absolute path to the mod project folder on disk. */
  workspaceDir: string

  github: {
    owner: string
    repo: string
    /** Branch Actions builds are triggered from. */
    branch: string
  }

  /** Local builds need a JDK 21. Empty = auto-detect. */
  javaPath: string
  /** Optional decompiler jar to use instead of downloading Vineflower. */
  decompilerJar: string
  /** gradlew vs gradle. */
  preferWrapper: boolean
  /** Check GitHub releases for a newer build at startup (default on). */
  autoUpdate: boolean
  /** Vision model used to analyse gameplay clips. Empty = built-in default. */
  visionModel: string
  /** Provider+model used for clip analysis (empty = follow the agent's provider). */
  visionProvider: string
  /** Key for the vision provider, when it differs from the agent's provider. */
  visionProviderKey: string
  /** Local (Ollama) settings: which model fills each role, and where weights live. */
  local: LocalSettings

  game: {
    /** Every place we can install into: Technic instance, Prism instance, plain run dir. */
    instances: GameInstance[]
    /** Id of the instance currently targeted. */
    activeInstanceId: string
    /** Extra JVM args used when launching the dev client. */
    clientJvmArgs: string
    /** Extra program args (e.g. --width 1280 --height 720). */
    clientProgramArgs: string
    /** Start the game with a small window so screenshots stay readable. */
    windowWidth: number
    windowHeight: number
    /** Seconds to wait for the title screen before screenshotting anyway. */
    launchTimeoutSec: number
    /** Capture a screenshot automatically once the title screen is detected. */
    autoScreenshot: boolean
    /** Extra mods (absolute jar paths) copied into the instance mods folder for tests. */
    extraMods: string[]
  }
}

export interface GameInstance {
  id: string
  name: string
  /** 'technic' | 'prism' | 'custom' */
  kind: 'technic' | 'prism' | 'custom'
  /** Instance/game directory that receives mods/ and the launch. */
  path: string
  /** Java executable for this instance. Empty = global config. */
  javaPath?: string
  /** Where the official NeoForge installer should put loader files (usually path/.minecraft). */
  minecraftDir?: string
  /** Auto-detected Technic launcher exe, if any. */
  technicExe?: string
  notes?: string
}

export interface BuildRecord {
  id: string
  createdAt: number
  source: 'local' | 'actions'
  status: 'running' | 'success' | 'failed' | 'cancelled'
  label: string
  jarPath?: string
  logPath?: string
  runId?: number
  runUrl?: string
  commit?: string
  exitCode?: number | null
  error?: string
}

export interface ChatAttachment {
  id: string
  kind: 'image' | 'text' | 'file'
  name: string
  /** Absolute path in the app-managed attachments folder. */
  path: string
  mediaType: string
  size: number
  addedAt: number
  /** Short note for the model, e.g. "title screen after crash". */
  note?: string
}

export interface PermissionPrompt {
  id: string
  toolName: string
  input: Record<string, unknown>
  reason?: string
  createdAt: number
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt: number
  attachments?: { path: string; name: string; kind: string }[]
  /** Tool calls rendered inline under the assistant message. */
  tools?: ToolTrace[]
  error?: string
  costUsd?: number
  /** Model reasoning for this message, shown only when the user asks for it. */
  thinking?: string
}

export interface ToolTrace {
  id: string
  name: string
  input: Record<string, unknown>
  status: 'running' | 'ok' | 'error' | 'denied'
  detail?: string
  startedAt: number
  endedAt?: number
  /** Reasoning the model produced before this call, when thinking is on. */
  thinking?: string
  /** The agent (subagent name) that made the call; empty for the coordinator. */
  agent?: string
}

/** Why the agent is running on a different model than the user picked. */
export interface ModelSwitch {
  at: number
  from: { provider: string; model: string }
  to: { provider: string; model: string }
  reason: string
  /** The failure class that triggered it, from classifyRunError(). */
  kind: string
}

export interface Conversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  sessionId?: string
  /** Model switches that happened in this conversation, newest last. */
  switches?: ModelSwitch[]
}

export interface ScreenshotInfo {
  path: string
  createdAt: number
  label?: string
  width?: number
  height?: number
}

export interface GameStatus {
  running: boolean
  pid?: number
  instanceId?: string
  titleScreen?: boolean
  logPath?: string
  startedAt?: number
  exitCode?: number | null
  message?: string
}

export interface EnvReport {
  ok: boolean
  items: { id: string; label: string; ok: boolean; detail: string; fix?: string }[]
}

export interface GithubStatus {
  /** Signed in and the token still works. */
  connected: boolean
  login: string
  name?: string
  avatarUrl?: string
  scopes: string[]
  method: 'device' | 'web' | 'pat'
  savedAt: number
  /** The GitHub CLI is also present; the app does not need it. */
  ghCliFound: boolean
  repoOk: boolean
  repoMessage?: string
  /** Set when the token was rejected and the user must sign in again. */
  error?: string
}

export interface DeviceLoginPrompt {
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresInSec: number
}

export interface ReferenceModUi {
  id: string
  /** Folder name under <project>/reference/. */
  slug: string
  title: string
  version: string
  source: 'github-release' | 'modrinth' | 'local-file'
  repo?: string
  homepage?: string
  license?: string
  jarName: string
  jarSize: number
  modId?: string
  loader?: string
  mcVersion?: string
  decompiled: boolean
  decompiler?: string
  sourcesDir?: string
  linked?: boolean
  createdAt: number
  error?: string
}

export interface ReleaseOption {
  tag: string
  name: string
  publishedAt?: string
  prerelease: boolean
  jars: { name: string; size: number; downloads: number }[]
}

export interface JarInfo {
  path: string
  name: string
  size: number
  modId?: string
  version?: string
  displayName?: string
  mcVersion?: string
  loader?: string
  builtAt?: number
}
