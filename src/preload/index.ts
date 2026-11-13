import { contextBridge, ipcRenderer } from 'electron'

function on(channel: string, cb: (payload: any) => void): () => void {
  const handler = (_e: Electron.IpcRendererEvent, payload: any): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api = {
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (patch: unknown) => ipcRenderer.invoke('config:set', patch)
  },
  app: { version: () => ipcRenderer.invoke('app:version') },

  github: {
    status: () => ipcRenderer.invoke('github:status'),
    loginDevice: (opts?: { openBrowser?: boolean }) => ipcRenderer.invoke('github:loginDevice', opts),
    loginToken: (token: string) => ipcRenderer.invoke('github:loginToken', token),
    logout: () => ipcRenderer.invoke('github:logout'),
    authPath: () => ipcRenderer.invoke('github:authPath'),
    openDevicePage: () => ipcRenderer.invoke('github:openDevicePage')
  },

  refs: {
    list: () => ipcRenderer.invoke('ref:list'),
    resolve: (input: string) => ipcRenderer.invoke('ref:resolve', input),
    addGithub: (opts: { repo: string; tag?: string; assetName?: string }) => ipcRenderer.invoke('ref:addGithub', opts),
    addFiles: (opts?: { title?: string }) => ipcRenderer.invoke('ref:addFiles', opts),
    remove: (id: string) => ipcRenderer.invoke('ref:remove', id),
    link: (id: string) => ipcRenderer.invoke('ref:link', id),
    search: (opts: { query: string; id?: string; regex?: boolean }) => ipcRenderer.invoke('ref:search', opts),
    tree: (id: string) => ipcRenderer.invoke('ref:tree', id),
    readFile: (opts: { id: string; path: string }) => ipcRenderer.invoke('ref:readFile', opts),
    decompile: (id: string) => ipcRenderer.invoke('ref:decompile', id),
    openFolder: (id: string) => ipcRenderer.invoke('ref:openFolder', id),
    openHomepage: (url: string) => ipcRenderer.invoke('ref:openHomepage', url)
  },
  env: { report: () => ipcRenderer.invoke('env:report') },

  java: {
    status: () => ipcRenderer.invoke('java:status'),
    check: (javaPath: string) => ipcRenderer.invoke('java:check', javaPath),
    clearCache: () => ipcRenderer.invoke('java:clearCache')
  },

  local: {
    info: () => ipcRenderer.invoke('local:info'),
    probe: () => ipcRenderer.invoke('local:probe'),
    install: (opts: unknown) => ipcRenderer.invoke('local:install', opts),
    setModelsDir: (dir: string) => ipcRenderer.invoke('local:setModelsDir', dir),
    startDaemon: () => ipcRenderer.invoke('local:startDaemon'),
    pull: (modelId: string) => ipcRenderer.invoke('local:pull', modelId),
    pullBundle: (opts: unknown) => ipcRenderer.invoke('local:pullBundle', opts),
    cancelPull: () => ipcRenderer.invoke('local:cancelPull'),
    setRoles: (roles: unknown) => ipcRenderer.invoke('local:setRoles', roles),
    setContext: (tokens: number) => ipcRenderer.invoke('local:setContext', tokens),
    onInstallProgress: (cb: (p: unknown) => void) => on('local:install-progress', cb),
    onPullProgress: (cb: (p: unknown) => void) => on('local:pull-progress', cb),
    onBundleProgress: (cb: (p: unknown) => void) => on('local:bundle-progress', cb)
  },

  providers: {
    list: () => ipcRenderer.invoke('providers:list'),
    models: (opts: unknown) => ipcRenderer.invoke('providers:models', opts),
    test: (opts: unknown) => ipcRenderer.invoke('providers:test', opts),
    openSignup: async (url: string) => {
      await ipcRenderer.invoke('providers:openSignup', url)
    }
  },

  update: {
    state: () => ipcRenderer.invoke('update:state'),
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    setAuto: (enabled: boolean) => ipcRenderer.invoke('update:setAuto', enabled),
    clearCache: () => ipcRenderer.invoke('update:clearCache'),
    supported: () => ipcRenderer.invoke('update:supported')
  },

  learn: {
    list: () => ipcRenderer.invoke('learn:list'),
    recall: (opts: unknown) => ipcRenderer.invoke('learn:recall', opts),
    update: (opts: unknown) => ipcRenderer.invoke('learn:update', opts),
    remove: (id: string) => ipcRenderer.invoke('learn:remove', id),
    clear: () => ipcRenderer.invoke('learn:clear')
  },

  clips: {
    start: (opts?: unknown) => ipcRenderer.invoke('clip:start', opts),
    stop: () => ipcRenderer.invoke('clip:stop'),
    list: () => ipcRenderer.invoke('clip:list'),
    get: (id: string) => ipcRenderer.invoke('clip:get', id),
    remove: (id: string) => ipcRenderer.invoke('clip:remove', id),
    analyse: (opts: unknown) => ipcRenderer.invoke('clip:analyse', opts),
    digest: (id: string) => ipcRenderer.invoke('clip:digest', id)
  },

  forks: {
    list: () => ipcRenderer.invoke('fork:list'),
    suggest: (referenceId: string) => ipcRenderer.invoke('fork:suggest', referenceId),
    create: (opts: unknown) => ipcRenderer.invoke('fork:create', opts),
    remove: (id: string) => ipcRenderer.invoke('fork:remove', id),
    open: (id: string) => ipcRenderer.invoke('fork:open', id),
    tree: (id: string) => ipcRenderer.invoke('fork:tree', id),
    readFile: (opts: unknown) => ipcRenderer.invoke('fork:readFile', opts),
    writeFile: (opts: unknown) => ipcRenderer.invoke('fork:writeFile', opts)
  },

  /** A self-evolving agent: generations of its own prompt, scored on four rules. */
  evolve: {
    status: () => ipcRenderer.invoke('evolve:status'),
    rules: (rules: unknown) => ipcRenderer.invoke('evolve:rules', rules),
    run: (count?: number) => ipcRenderer.invoke('evolve:run', count),
    pause: (paused: boolean) => ipcRenderer.invoke('evolve:pause', paused),
    promote: (id: number) => ipcRenderer.invoke('evolve:promote', id),
    log: () => ipcRenderer.invoke('evolve:log'),
    genome: (id: number) => ipcRenderer.invoke('evolve:genome', id),
    onStep: (cb: (p: unknown) => void) => on('evolve:step', cb),
    onDone: (cb: (p: unknown) => void) => on('evolve:done', cb)
  },

  /** Learning mode, deep research, and the model-switch feed. */
  modes: {
    status: () => ipcRenderer.invoke('modes:status'),
    set: (patch: unknown) => ipcRenderer.invoke('modes:set', patch),
    knowledge: (topic?: string) => ipcRenderer.invoke('modes:knowledge', topic),
    startResearch: (topic: string) => ipcRenderer.invoke('modes:startResearch', topic),
    stopResearch: () => ipcRenderer.invoke('modes:stopResearch'),
    researchDir: () => ipcRenderer.invoke('modes:researchDir'),
    onChanged: (cb: (p: unknown) => void) => on('modes:changed', cb),
    onModelSwitch: (cb: (p: unknown) => void) => on('agent:model-switch', cb)
  },

  /** Three-level diagnostic output, plus the rolling log file. */
  diag: {
    level: () => ipcRenderer.invoke('diag:level'),
    setLevel: (value: number) => ipcRenderer.invoke('diag:setLevel', value),
    history: () => ipcRenderer.invoke('diag:history'),
    clear: () => ipcRenderer.invoke('diag:clear'),
    exportText: () => ipcRenderer.invoke('diag:exportText'),
    logPath: () => ipcRenderer.invoke('diag:logPath'),
    openLog: () => ipcRenderer.invoke('diag:openLog'),
    onEntry: (cb: (p: unknown) => void) => on('diag:entry', cb),
    onThinking: (cb: (p: unknown) => void) => on('agent:thinking', cb)
  },

  /** Updating an existing project to another version or loader. */
  port: {
    detect: (dir: string) => ipcRenderer.invoke('port:detect', dir),
    plan: (opts: unknown) => ipcRenderer.invoke('port:plan', opts),
    report: (opts: unknown) => ipcRenderer.invoke('port:report', opts),
    convert: (opts: unknown) => ipcRenderer.invoke('port:convert', opts)
  },

  versions: {
    catalog: (opts?: unknown) => ipcRenderer.invoke('versions:catalog', opts),
    loaders: (opts: unknown) => ipcRenderer.invoke('versions:loaders', opts),
    era: (opts: unknown) => ipcRenderer.invoke('versions:era', opts)
  },

  project: {
    scaffold: (opts: unknown) => ipcRenderer.invoke('project:scaffold', opts),
    validate: (opts: unknown) => ipcRenderer.invoke('project:validate', opts),
    summary: () => ipcRenderer.invoke('project:summary'),
    readFile: (rel: string) => ipcRenderer.invoke('project:readFile', rel),
    writeFile: (rel: string, content: string) => ipcRenderer.invoke('project:writeFile', rel, content),
    /** Make a folder the active project (empty = back to the scaffolded one). */
    activate: (dir: string) => ipcRenderer.invoke('project:activate', dir)
  },

  dialog: {
    pickFolder: (opts?: unknown) => ipcRenderer.invoke('dialog:pickFolder', opts),
    pickFiles: (opts?: unknown) => ipcRenderer.invoke('dialog:pickFiles', opts)
  },

  neoforge: {
    status: () => ipcRenderer.invoke('neoforge:status'),
    install: () => ipcRenderer.invoke('neoforge:install')
  },

  deps: {
    scan: (opts?: unknown) => ipcRenderer.invoke('deps:scan', opts),
    find: (opts: unknown) => ipcRenderer.invoke('deps:find', opts),
    install: (opts: unknown) => ipcRenderer.invoke('deps:install', opts)
  },

  /** A modpack's mods folder: scan it, then update from it. */
  pack: {
    scan: (dir: string) => ipcRenderer.invoke('pack:scan', dir),
    identify: (dir: string) => ipcRenderer.invoke('pack:identify', dir),
    updates: (opts: unknown) => ipcRenderer.invoke('pack:updates', opts),
    plan: (opts: unknown) => ipcRenderer.invoke('pack:plan', opts),
    preview: (opts: unknown) => ipcRenderer.invoke('pack:preview', opts),
    download: (opts: unknown) => ipcRenderer.invoke('pack:download', opts),
    adopt: (opts: unknown) => ipcRenderer.invoke('pack:adopt', opts),
    remove: (file: string) => ipcRenderer.invoke('pack:remove', file)
  },

  build: {
    local: (opts?: unknown) => ipcRenderer.invoke('build:local', opts),
    actions: () => ipcRenderer.invoke('build:actions'),
    preflight: () => ipcRenderer.invoke('build:preflight'),
    initRepo: (isPrivate: boolean) => ipcRenderer.invoke('build:initRepo', isPrivate),
    repoState: () => ipcRenderer.invoke('build:repoState'),
    openLog: (p: string) => ipcRenderer.invoke('build:openLog', p)
  },

  instance: {
    detect: () => ipcRenderer.invoke('instance:detect'),
    list: () => ipcRenderer.invoke('instance:list'),
    setActive: (id: string) => ipcRenderer.invoke('instance:setActive', id),
    add: (instance: unknown) => ipcRenderer.invoke('instance:add', instance),
    remove: (id: string) => ipcRenderer.invoke('instance:remove', id)
  },

  game: {
    status: () => ipcRenderer.invoke('game:status'),
    launch: () => ipcRenderer.invoke('game:launch'),
    stop: () => ipcRenderer.invoke('game:stop'),
    log: (lines?: number) => ipcRenderer.invoke('game:log', lines),
    screenshot: (label?: string) => ipcRenderer.invoke('game:screenshot', label),
    screenshots: () => ipcRenderer.invoke('game:screenshots'),
    openFolder: () => ipcRenderer.invoke('game:openFolder'),
    installJar: (jarPath?: string) => ipcRenderer.invoke('game:installJar', jarPath),
    exportTechnic: () => ipcRenderer.invoke('game:exportTechnic'),
    launchDirect: () => ipcRenderer.invoke('game:launchDirect'),
    directStatus: () => ipcRenderer.invoke('game:directStatus'),
    stopAny: () => ipcRenderer.invoke('game:stopAny')
  },

  /** 3D models and animations: the paths for this project's version, and a one-click generator. */
  models: {
    info: () => ipcRenderer.invoke('models:info'),
    create: (req: unknown) => ipcRenderer.invoke('models:create', req)
  },

  /** Generated PNG textures, and what this version can actually render. */
  textures: {
    create: (req: unknown) => ipcRenderer.invoke('textures:create', req)
  },
  renderer: {
    capabilities: () => ipcRenderer.invoke('renderer:capabilities')
  },

  shaders: {
    catalogue: () => ipcRenderer.invoke('shaders:catalogue'),
    check: (ids: string[]) => ipcRenderer.invoke('shaders:check', ids),
    explain: (useCase: string) => ipcRenderer.invoke('shaders:explain', useCase)
  },

  chat: {
    list: () => ipcRenderer.invoke('chat:list'),
    load: (id: string) => ipcRenderer.invoke('chat:load', id),
    new: () => ipcRenderer.invoke('chat:new'),
    remove: (id: string) => ipcRenderer.invoke('chat:delete', id),
    send: (payload: unknown) => ipcRenderer.invoke('chat:send', payload),
    interrupt: () => ipcRenderer.invoke('chat:interrupt'),
    permission: (payload: unknown) => ipcRenderer.invoke('chat:permission', payload),
    autonomy: (mode: string) => ipcRenderer.invoke('chat:autonomy', mode),
    attachImage: (payload: unknown) => ipcRenderer.invoke('chat:attachImage', payload),
    attachFile: (filePath: string) => ipcRenderer.invoke('chat:attachFile', filePath)
  },

  events: {
    onAgentText: (cb: (p: { text: string }) => void) => on('agent:text', cb),
    onNotice: (cb: (p: { text: string }) => void) => on('agent:notice', cb),
    onAgentBlock: (cb: (p: { text: string }) => void) => on('agent:block', cb),
    onToolStart: (cb: (p: unknown) => void) => on('agent:tool-start', cb),
    onToolEnd: (cb: (p: unknown) => void) => on('agent:tool-end', cb),
    onPermission: (cb: (p: unknown) => void) => on('agent:permission', cb),
    onPermissionResolved: (cb: (p: unknown) => void) => on('agent:permission-resolved', cb),
    onStatus: (cb: (p: unknown) => void) => on('agent:status', cb),
    onResult: (cb: (p: unknown) => void) => on('agent:result', cb),
    onOutput: (cb: (p: unknown) => void) => on('agent:output', cb),
    onUserMessage: (cb: (p: unknown) => void) => on('chat:user-message', cb),
    onAssistantStart: (cb: (p: unknown) => void) => on('chat:assistant-start', cb),
    onBuildLine: (cb: (p: unknown) => void) => on('build:line', cb),
    onBuildDone: (cb: (p: unknown) => void) => on('build:done', cb),
    onGameLine: (cb: (p: unknown) => void) => on('game:line', cb),
    onGameStatus: (cb: (p: unknown) => void) => on('game:status', cb),
    onScreenshot: (cb: (p: unknown) => void) => on('screenshot:new', cb),
    onGithubDeviceCode: (cb: (p: unknown) => void) => on('github:device-code', cb),
    onGithubDeviceTick: (cb: (p: unknown) => void) => on('github:device-tick', cb),
    onRefLine: (cb: (p: unknown) => void) => on('ref:line', cb),
    onRefListChanged: (cb: () => void) => on('ref:list-changed', cb),
    onUpdateState: (cb: (p: unknown) => void) => on('update:state', cb),
    onForkListChanged: (cb: () => void) => on('fork:list-changed', cb),
    onClipStarted: (cb: (p: { maxMs: number }) => void) => on('clip:started', cb),
    onClipFrame: (cb: (p: { t: number; index: number; total: number; path: string }) => void) => on('clip:frame', cb),
    onClipDone: (cb: (p: { clip: unknown }) => void) => on('clip:done', cb),
    onClipAnalysing: (cb: (p: { id: string }) => void) => on('clip:analysing', cb)
  },

  shell: {
    openPath: (p: string) => ipcRenderer.invoke('build:openLog', p)
  }
}

contextBridge.exposeInMainWorld('mcf', api)

export type McfApi = typeof api
