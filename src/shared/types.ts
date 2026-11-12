export type AutonomyMode = 'auto' | 'review' | 'ask'

export interface AppConfig {
  /** Anthropic API key used for the Claude Agent SDK. */
  apiKey: string
  /** Anthropic-compatible base URL (empty = default api.anthropic.com). */
  baseUrl: string
  /** Model id passed to the SDK. */
  model: string
  /** Max USD budget for a single agent run (0 = unlimited). */
  maxBudgetUsd: number
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
  /** gradlew vs gradle. */
  preferWrapper: boolean

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
}

export interface ToolTrace {
  id: string
  name: string
  input: Record<string, unknown>
  status: 'running' | 'ok' | 'error' | 'denied'
  detail?: string
  startedAt: number
  endedAt?: number
}

export interface Conversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  sessionId?: string
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
