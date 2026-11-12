import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { run } from '../util/exec'
import type { BuildResult } from './gradle'

export interface GhConfig {
  owner: string
  repo: string
  branch: string
}

export interface GhPreflight {
  ghFound: boolean
  authed: boolean
  repoOk: boolean
  messages: string[]
}

export function ensureWorkflow(dir: string, modId: string): string {
  const wfDir = path.join(dir, '.github', 'workflows')
  fs.mkdirSync(wfDir, { recursive: true })
  const file = path.join(wfDir, 'build.yml')
  const body = `name: Build

on:
  push:
    branches: [ "**" ]
  pull_request:
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0
          fetch-tags: true

      - name: Setup JDK 21
        uses: actions/setup-java@v4
        with:
          java-version: '21'
          distribution: 'temurin'

      - name: Setup Gradle
        uses: gradle/actions/setup-gradle@v4

      - name: Build with Gradle
        run: ./gradlew build --stacktrace --console=plain

      - name: Upload mod jar
        uses: actions/upload-artifact@v4
        with:
          name: ${modId}-jar
          path: build/libs/*.jar
          if-no-files-found: error
          retention-days: 14
`
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const changed = existing !== body
  if (changed) fs.writeFileSync(file, body, 'utf8')
  return file
}

export async function ghPreflight(cfg: GhConfig, dir: string): Promise<GhPreflight> {
  const messages: string[] = []
  const ver = await run('gh', ['--version'], { timeoutMs: 20000 }).catch(() => null)
  const ghFound = !!ver && ver.code === 0
  if (!ghFound) {
    messages.push('GitHub CLI (gh) not found. Install it from https://cli.github.com and sign in with `gh auth login`.')
    return { ghFound, authed: false, repoOk: false, messages }
  }
  const auth = await run('gh', ['auth', 'status'], { cwd: dir, timeoutMs: 30000 }).catch(() => null)
  const authed = !!auth && auth.code === 0
  if (!authed) messages.push('gh is installed but not signed in. Run `gh auth login` in a terminal.')

  let repoOk = false
  if (authed && cfg.owner && cfg.repo) {
    const repo = await run('gh', ['repo', 'view', `${cfg.owner}/${cfg.repo}`, '--json', 'nameWithOwner,defaultBranchRef'], {
      cwd: dir,
      timeoutMs: 40000
    }).catch(() => null)
    repoOk = !!repo && repo.code === 0
    if (!repoOk) messages.push(`Cannot access ${cfg.owner}/${cfg.repo} with the signed-in account.`)
  } else if (authed) {
    messages.push('Set the GitHub owner and repo in Settings.')
  }
  return { ghFound, authed, repoOk, messages }
}

async function git(args: string[], cwd: string): Promise<{ code: number | null; out: string; err: string }> {
  const res = await run('git', args, { cwd, timeoutMs: 180000 })
  return { code: res.code, out: res.stdout.trim(), err: res.stderr.trim() }
}

/**
 * Push local changes and run the workflow. Uses gh for the run discovery + artifact
 * download, and a local git commit/push for the source sync.
 */
export async function runActionsBuild(
  cfg: GhConfig,
  dir: string,
  modId: string,
  onLine: (line: string) => void,
  signal?: AbortSignal
): Promise<BuildResult> {
  const started = Date.now()
  const logPath = path.join(app.getPath('userData'), 'logs', `actions-${new Date().toISOString().replace(/[:.]/g, '-')}.log`)
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  const stream = fs.createWriteStream(logPath, { flags: 'a' })
  const push = (l: string): void => {
    stream.write(l + '\n')
    onLine(l)
  }
  const fail = (error: string, runUrl?: string): BuildResult => {
    push(`[actions] FAILED: ${error}`)
    stream.end()
    return { ok: false, code: 1, logPath, errors: [error], durationMs: Date.now() - started }
  }

  ensureWorkflow(dir, modId)
  push(`[actions] repo=${cfg.owner}/${cfg.repo} branch=${cfg.branch || '(current)'}`)

  // 1. Make sure the repo exists and has a remote
  const remotes = await git(['remote'], dir)
  if (remotes.code !== 0) return fail('Not a git repository. Create one first (Settings > GitHub).')
  if (!remotes.out.split(/\s+/).includes('origin')) {
    const url = `https://github.com/${cfg.owner}/${cfg.repo}.git`
    push(`[actions] adding remote origin ${url}`)
    const add = await git(['remote', 'add', 'origin', url], dir)
    if (add.code !== 0) return fail(`git remote add failed: ${add.err}`)
  }

  // 2. Commit anything the agent changed
  const status = await git(['status', '--porcelain'], dir)
  if (status.out) {
    push(`[actions] committing ${status.out.split('\n').length} changed path(s)`)
    await git(['add', '-A'], dir)
    const commit = await git(
      ['-c', 'user.name=MC Forge Agent', '-c', 'user.email=agent@localhost', 'commit', '-m', `agent: automated build ${new Date().toISOString()}`],
      dir
    )
    if (commit.code !== 0 && !/nothing to commit/i.test(commit.out + commit.err)) {
      return fail(`git commit failed: ${commit.err || commit.out}`)
    }
  } else {
    push('[actions] working tree clean')
  }

  // 3. Push
  const branchRes = await git(['rev-parse', '--abbrev-ref', 'HEAD'], dir)
  const branch = cfg.branch || branchRes.out || 'main'
  push(`[actions] pushing ${branch}`)
  const pushRes = await git(['push', '-u', 'origin', `HEAD:${branch}`], dir)
  if (pushRes.code !== 0) return fail(`git push failed: ${pushRes.err || pushRes.out}`)

  const head = await git(['rev-parse', 'HEAD'], dir)
  const sha = head.out

  // 4. Trigger the workflow and find the run for this commit
  push('[actions] dispatching workflow')
  await git(['-c', 'core.quotepath=false', 'rev-parse', '--verify', 'HEAD'], dir) // noop keeps log readable
  const dispatch = await run('gh', ['workflow', 'run', 'build.yml', '--ref', branch], { cwd: dir, timeoutMs: 60000 })
  if (dispatch.code !== 0) {
    push(`[actions] workflow run failed to start: ${dispatch.stderr.trim()}`)
  }

  let runId: number | null = null
  for (let attempt = 0; attempt < 14 && !runId; attempt++) {
    await sleep(4000)
    if (signal?.aborted) return fail('cancelled')
    const list = await run(
      'gh',
      ['run', 'list', '--workflow', 'build.yml', '--branch', branch, '--limit', '10', '--json', 'databaseId,headSha,status,conclusion,url,displayTitle'],
      { cwd: dir, timeoutMs: 60000 }
    )
    if (list.code !== 0) {
      push(`[actions] run list failed: ${list.stderr.trim()}`)
      continue
    }
    try {
      const runs = JSON.parse(list.stdout) as { databaseId: number; headSha: string; url: string }[]
      const match = runs.find((r) => r.headSha === sha) ?? runs[0]
      if (match) {
        runId = match.databaseId
        push(`[actions] run ${runId} ${match.url}`)
      }
    } catch {
      push('[actions] could not parse gh run list output')
    }
  }
  if (!runId) return fail('Could not find a workflow run for this commit.')

  // 5. Wait for completion
  const watch = await run('gh', ['run', 'watch', String(runId), '--exit-status', '--interval', '8'], {
    cwd: dir,
    timeoutMs: 45 * 60 * 1000,
    onLine: (line) => push(`[gh] ${line}`),
    signal
  })
  const view = await run('gh', ['run', 'view', String(runId), '--json', 'conclusion,url'], { cwd: dir, timeoutMs: 60000 })
  let runUrl = ''
  let conclusion = ''
  try {
    const parsed = JSON.parse(view.stdout) as { conclusion: string; url: string }
    runUrl = parsed.url
    conclusion = parsed.conclusion
  } catch {
    /* ignore */
  }
  if (conclusion !== 'success') {
    const logDump = await run('gh', ['run', 'view', String(runId), '--log-failed'], { cwd: dir, timeoutMs: 120000 })
    const tail = logDump.stdout.split(/\r?\n/).slice(-120).join('\n')
    push(tail)
    return {
      ok: false,
      code: watch.code,
      logPath,
      errors: [`Workflow finished with "${conclusion || 'failure'}". See ${runUrl || 'the Actions tab'}.`, ...extractGradleErrors(tail)],
      durationMs: Date.now() - started
    }
  }
  push(`[actions] workflow succeeded ${runUrl}`)

  // 6. Download the jar artifact
  const dlDir = path.join(dir, '.agent', 'artifacts', String(runId))
  fs.mkdirSync(dlDir, { recursive: true })
  const dl = await run('gh', ['run', 'download', String(runId), '--dir', dlDir], { cwd: dir, timeoutMs: 300000, onLine: (l) => push(`[gh] ${l}`) })
  if (dl.code !== 0) return fail(`artifact download failed: ${dl.stderr.trim()}`, runUrl)

  const jar = findJar(dlDir)
  if (!jar) return fail('Workflow succeeded but no jar was found in the artifact.', runUrl)

  // keep a stable copy for install/testing
  const stableDir = path.join(dir, '.agent', 'latest')
  fs.mkdirSync(stableDir, { recursive: true })
  const stable = path.join(stableDir, path.basename(jar))
  fs.copyFileSync(jar, stable)
  push(`[actions] downloaded ${path.basename(jar)} -> ${stable}`)
  stream.end()
  return { ok: true, code: 0, logPath, jarPath: stable, errors: [], durationMs: Date.now() - started }
}

function extractGradleErrors(log: string): string[] {
  return log
    .split(/\r?\n/)
    .filter((l) => /error:|FAILURE:|Execution failed|Caused by:/.test(l))
    .slice(0, 20)
}

function findJar(dir: string): string | undefined {
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()!
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, entry.name)
      if (entry.isDirectory()) stack.push(p)
      else if (entry.name.endsWith('.jar') && !/-sources|-javadoc/.test(entry.name)) return p
    }
  }
  return undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Create the GitHub repo (if needed) and push the current project. */
export async function initGithubRepo(cfg: GhConfig, dir: string, isPrivate: boolean, onLine: (l: string) => void): Promise<{ ok: boolean; url?: string; error?: string }> {
  const push = onLine
  if (!cfg.owner || !cfg.repo) return { ok: false, error: 'Owner and repo are required.' }
  const exists = await run('gh', ['repo', 'view', `${cfg.owner}/${cfg.repo}`], { cwd: dir, timeoutMs: 40000 })
  if (exists.code !== 0) {
    push(`[gh] creating ${cfg.owner}/${cfg.repo}`)
    const create = await run(
      'gh',
      ['repo', 'create', `${cfg.owner}/${cfg.repo}`, isPrivate ? '--private' : '--public', '--description', 'Minecraft 1.21.1 NeoForge mod (MC Forge Agent)'],
      { cwd: dir, timeoutMs: 120000, onLine: push }
    )
    if (create.code !== 0) return { ok: false, error: create.stderr.trim() || create.stdout.trim() }
  }
  if (!fs.existsSync(path.join(dir, '.git'))) {
    const init = await run('git', ['init', '-b', cfg.branch || 'main'], { cwd: dir, timeoutMs: 60000 })
    if (init.code !== 0) return { ok: false, error: init.stderr.trim() }
  }
  const remotes = await run('git', ['remote'], { cwd: dir })
  if (!remotes.stdout.split(/\s+/).includes('origin')) {
    await run('git', ['remote', 'add', 'origin', `https://github.com/${cfg.owner}/${cfg.repo}.git`], { cwd: dir })
  }
  await run('git', ['add', '-A'], { cwd: dir })
  await run('git', ['-c', 'user.name=MC Forge Agent', '-c', 'user.email=agent@localhost', 'commit', '-m', 'Initial mod project (MC Forge Agent)'], { cwd: dir })
  const branch = cfg.branch || 'main'
  const pushed = await run('git', ['push', '-u', 'origin', `HEAD:${branch}`], { cwd: dir, timeoutMs: 300000, onLine: push })
  if (pushed.code !== 0) return { ok: false, error: pushed.stderr.trim() }
  return { ok: true, url: `https://github.com/${cfg.owner}/${cfg.repo}` }
}
