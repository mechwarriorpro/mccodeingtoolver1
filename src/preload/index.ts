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

  update: {
    state: () => ipcRenderer.invoke('update:state'),
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    setAuto: (enabled: boolean) => ipcRenderer.invoke('update:setAuto', enabled),
    clearCache: () => ipcRenderer.invoke('update:clearCache'),
    supported: () => ipcRenderer.invoke('update:supported')
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
    writeFile: (rel: string, content: string) => ipcRenderer.invoke('project:writeFile', rel, content)
  },

  dialog: {
    pickFolder: (opts?: unknown) => ipcRenderer.invoke('dialog:pickFolder', opts),
    pickFiles: (opts?: unknown) => ipcRenderer.invoke('dialog:pickFiles', opts)
  },

  neoforge: {
    status: () => ipcRenderer.invoke('neoforge:status'),
    install: () => ipcRenderer.invoke('neoforge:install')
  },

  build: {
    local: (opts?: unknown) => ipcRenderer.invoke('build:local', opts),
    actions: () => ipcRenderer.invoke('build:actions'),
    preflight: () => ipcRenderer.invoke('build:preflight'),
    initRepo: (isPrivate: boolean) => ipcRenderer.invoke('build:initRepo', isPrivate),
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
    onForkListChanged: (cb: () => void) => on('fork:list-changed', cb)
  },

  shell: {
    openPath: (p: string) => ipcRenderer.invoke('build:openLog', p)
  }
}

contextBridge.exposeInMainWorld('mcf', api)

export type McfApi = typeof api
