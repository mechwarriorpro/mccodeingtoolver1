import type { AppConfig, Conversation, EnvReport, GameInstance, GameStatus, PermissionPrompt, ScreenshotInfo, ToolTrace } from '../../../shared/types'

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
  env: { report: () => Promise<EnvReport> }
  project: {
    scaffold: (opts: {
      parentDir: string
      modId: string
      modName: string
      group: string
      modVersion: string
      author?: string
      license?: string
      neoVersion?: string
    }) => Promise<{ ok: true; dir: string } | { ok: false; error: string }>
    validate: (opts: { modId: string; group: string }) => Promise<{ modId: string | null; group: string | null }>
    summary: () => Promise<ProjectSummary>
    readFile: (rel: string) => Promise<{ ok: boolean; text?: string; error?: string }>
    writeFile: (rel: string, content: string) => Promise<{ ok: boolean; error?: string }>
  }
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
  }
}

declare global {
  interface Window {
    mcf: McfApi
  }
}

export const api: McfApi = window.mcf
