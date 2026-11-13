import fs from 'node:fs'
import { readProps } from '../mod/props'
import { javaForVersion, resolveEra } from '../versions/eras'
import path from 'node:path'
import { app } from 'electron'
import { run } from '../util/exec'
import { ensureForkGitignore, repoState, suggestRepoName } from './repo'
import { authToken, fetchUser, readAuth } from '../github/oauth'
import type { BuildResult } from './gradle'

export interface GhConfig {
  owner: string
  repo: string
  branch: string
}

export interface GhPreflight {
  /** The CLI is installed (optional: the app has its own token). */
  ghFound: boolean
  /** Signed in either through the app or through `gh`. */
  authed: boolean
  repoOk: boolean
  /** What is doing the authenticating, for the UI status line. */
  identity?: { login: string; via: 'app' | 'cli' }
  messages: string[]
}

/**
 * Credentials for git and the GitHub API.
 *
 * The app signs in with GitHub itself (device flow) and stores a token; the CLI
 * is only used when no token is stored, so a machine without `gh` still works.
 * A personal access token in GITHUB_TOKEN/GH_TOKEN is the last resort, which
 * keeps CI and power users working.
 */
export interface GithubContext {
  token: string
  login?: string
  ghCli: boolean
}

export async function githubContext(): Promise<GithubContext> {
  // Order matters. A token the user just signed in with must win over anything
  // ambient, and an explicit `gh auth login` must win over GITHUB_TOKEN, which
  // is often a stale CI variable that cannot push.
  const stored = readAuth()
  if (stored?.token) return { token: stored.token, login: stored.login, ghCli: false }

  const ver = await run('gh', ['--version'], { timeoutMs: 15000 }).catch(() => null)
  const ghCli = !!ver && ver.code === 0
  if (ghCli) {
    const auth = await run('gh', ['auth', 'token'], {
      timeoutMs: 20000,
      // gh prints the env token instead of the stored one when these are set;
      // hide them so we get the account the user actually signed in with.
      env: { ...process.env, GITHUB_TOKEN: '', GH_TOKEN: '' }
    }).catch(() => null)
    const cliToken = auth && auth.code === 0 ? auth.stdout.trim() : ''
    if (cliToken) {
      const login = await fetchUser(cliToken).then((u) => u.login).catch(() => undefined)
      if (login) return { token: cliToken, login, ghCli: true }
    }
  }

  const envToken = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim()
  if (envToken) {
    const login = await fetchUser(envToken).then((u) => u.login).catch(() => undefined)
    return { token: envToken, login, ghCli: false }
  }
  return { token: '', ghCli }
}

/** Environment for git: an askpass helper keeps the token off the command line. */
function gitEnv(ctx: GithubContext): NodeJS.ProcessEnv | undefined {
  if (!ctx.ghCli || !ctx.token) return undefined
  return { ...process.env }
}

async function ghApi(
  ctx: GithubContext,
  pathOrUrl: string,
  init: RequestInit = {}
): Promise<{ ok: boolean; status: number; data: any; text: string }> {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `https://api.github.com${pathOrUrl}`
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'MC-Forge-Agent',
      ...(ctx.token ? { Authorization: `Bearer ${ctx.token}` } : {}),
      ...(init.headers as Record<string, string> | undefined)
    }
  })
  const text = await res.text()
  let data: any = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    /* non-JSON error page */
  }
  return { ok: res.ok, status: res.status, data, text }
}

/** True when the token may push to the repo (admin/push permission). */
async function canPush(ctx: GithubContext, owner: string, repo: string): Promise<boolean> {
  const res = await ghApi(ctx, `/repos/${owner}/${repo}`)
  if (res.status === 404) return false
  if (!res.ok) return false
  const perms = res.data?.permissions
  if (perms) return !!(perms.push || perms.admin || perms.maintain)
  return true
}

/**
 * Choose the JDK for the CI workflow from the project it is building.
 *
 * This used to hard-code 21, which is right for the app's own 1.21.1 projects
 * and wrong for every old one: a 1.12.2 Forge project runs on Java 8 and cannot
 * build on 21 at all. The workflow is derived from the same rule as the local
 * build, so the two never disagree about what "build this project" means.
 */
export function workflowJava(dir: string): { java: number; gradle: string } {
  const props = readProps(path.join(dir, 'gradle.properties'))
  const mcVersion = props.minecraft_version ?? props.mc_version ?? props.minecraftVersion ?? ''
  const loaderRaw = (props.loader ?? props.mod_loader ?? '').toLowerCase()
  const loader = loaderRaw.includes('neoforge') ? 'neoforge' : loaderRaw.includes('fabric') ? 'fabric' : 'forge'
  if (!mcVersion) return { java: 17, gradle: '8.x' }
  const era = resolveEra(loader, mcVersion)
  const java = era ? javaForVersion(loader, mcVersion, era) : 8
  return { java, gradle: era?.gradle ?? '8.x' }
}

export function ensureWorkflow(dir: string, modId: string): string {
  const wfDir = path.join(dir, '.github', 'workflows')
  fs.mkdirSync(wfDir, { recursive: true })
  const file = path.join(wfDir, 'build.yml')
  const jdk = workflowJava(dir)
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

      - name: Setup JDK ${jdk.java}
        uses: actions/setup-java@v4
        with:
          java-version: '${jdk.java}'
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
  const ctx = await githubContext()
  const authed = !!ctx.token
  if (!authed) {
    messages.push(
      ghFound
        ? 'Not signed in. Use "Sign in with GitHub" in Settings, or run `gh auth login`.'
        : 'Not signed in. Use "Sign in with GitHub" in Settings — no GitHub CLI needed.'
    )
    return { ghFound, authed, repoOk: false, messages }
  }
  const identity = ctx.login ? { login: ctx.login, via: ctx.ghCli ? ('cli' as const) : ('app' as const) } : undefined

  let repoOk = false
  if (cfg.owner && cfg.repo) {
    repoOk = await canPush(ctx, cfg.owner, cfg.repo)
    if (!repoOk) messages.push(`Cannot push to ${cfg.owner}/${cfg.repo}${identity ? ` as ${identity.login}` : ''}. Check the repo name and the token's repo scope.`)
  } else {
    messages.push('Set the GitHub owner and repo in Settings.')
  }
  return { ghFound, authed, repoOk, identity, messages }
}

async function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string; err: string }> {
  const res = await run('git', args, { cwd, timeoutMs: 180000, env })
  return { code: res.code, out: res.stdout.trim(), err: res.stderr.trim() }
}

/**
 * Push with the stored token in an HTTP header, so the credential is never
 * written to .git/config (where it would show up in `git remote -v` and in any
 * copy of the project). `-c http.extraheader` applies to this one command only.
 */
async function gitPush(ctx: GithubContext, cwd: string, args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  const basic = Buffer.from(`x-access-token:${ctx.token}`).toString('base64')
  return git(['-c', `http.https://github.com/.extraheader=Authorization: Basic ${basic}`, ...args], cwd, gitEnv(ctx))
}

/** Fetch a URL to disk, following redirects (Actions artifact blobs redirect to storage). */
async function downloadFile(ctx: GithubContext, url: string, target: string, onLine: (l: string) => void): Promise<{ ok: boolean; error?: string }> {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { Authorization: `Bearer ${ctx.token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'MC-Forge-Agent' }
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} downloading ${url}` }
    const buf = Buffer.from(await res.arrayBuffer())
    fs.writeFileSync(target, buf)
    onLine(`downloaded ${(buf.length / 1024 / 1024).toFixed(1)} MB -> ${path.basename(target)}`)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: `download failed: ${(e as Error).message}` }
  }
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
  const ctxEarly = await githubContext()
  if (!ctxEarly.token) return fail('Not signed in to GitHub. Sign in from Settings > GitHub.')
  const target = resolveGithubTarget(cfg, dir, ctxEarly.login)
  if (target.inferred) {
    push(`[actions] using ${target.owner}/${target.repo} (inferred from the signed-in account and the folder name)`)
  }
  if (!target.owner || !target.repo) {
    return fail('Set the GitHub owner and repo in Settings > GitHub, or sign in so the account can be used.')
  }
  // Create the repository before touching git: pressing "Build on GitHub" on a
  // project that has never been pushed is a normal thing to do, not a setup error.
  // A repository created as a side effect of a build is public by default, which
  // is what the app's own settings say; the explicit setup action asks.
  const ensured = await ensureGithubRepo(ctxEarly, target.owner, target.repo, false, push)
  if (!ensured.ok) return fail(ensured.error ?? 'Could not create the GitHub repository.')
  push(`[actions] repo=${target.owner}/${target.repo} branch=${cfg.branch || '(current)'}`)

  // 1. Make the folder a repository on a remote that points at the GitHub repo.
  //
  // This used to fail with "Not a git repository. Create one first (Settings >
  // GitHub)" — which was wrong twice: the app can create a repository itself,
  // and Settings is where you sign in, not where git repositories are made. A
  // project made by decompiling a mod has exactly this shape: real sources,
  // buildable, never pushed anywhere.
  const remotes = await git(['remote'], dir)
  const state = repoState(dir, remotes.code === 0 ? remotes.out.split(/\s+/).filter(Boolean) : null)
  if (state.state === 'no-repo') {
    push(`[actions] ${dir} is not a git repository; creating one`)
    // Ignore rules first: the first commit of a decompiled-mod fork would
    // otherwise carry the reference jar, the gradle cache and the run dirs.
    ensureForkGitignore(dir)
    const init = await git(['init', '-b', cfg.branch || 'main'], dir)
    if (init.code !== 0) return fail(`git init failed: ${init.err || init.out}`)
  }
  if (state.state !== 'ready') {
    const url = `https://github.com/${target.owner}/${target.repo}.git`
    push(`[actions] adding remote origin ${url}`)
    const add = await git(['remote', 'add', 'origin', url], dir)
    if (add.code !== 0) return fail(`git remote add failed: ${add.err || add.out}`)
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
  // A git repo created moments ago has no branch in `cfg`, and `rev-parse` on an
  // empty repository answers "HEAD" with a non-zero status. Fall back to main.
  const branch = cfg.branch || (branchRes.code === 0 ? branchRes.out : '') || 'main'
  push(`[actions] pushing ${branch}`)
  const ctx = ctxEarly
  const pushRes = await gitPush(ctx, dir, ['push', '-u', 'origin', `HEAD:${branch}`])
  if (pushRes.code !== 0) return fail(`git push failed: ${simplifyGitError(pushRes.err || pushRes.out, ctx)}`)

  const head = await git(['rev-parse', 'HEAD'], dir)
  const sha = head.out

  // 4. Trigger the workflow and find the run for this commit
  push('[actions] dispatching workflow')
  const dispatch = await ghApi(ctx, `/repos/${target.owner}/${target.repo}/actions/workflows/build.yml/dispatches`, {
    method: 'POST',
    body: JSON.stringify({ ref: branch })
  })
  if (!dispatch.ok) {
    push(`[actions] dispatch failed (${dispatch.status}); the push may already have started a run: ${dispatch.text.slice(0, 200)}`)
  }

  let runId: number | null = null
  let runUrl = ''
  for (let attempt = 0; attempt < 20 && !runId; attempt++) {
    await sleep(4000)
    if (signal?.aborted) return fail('cancelled')
    const list = await ghApi(ctx, `/repos/${target.owner}/${target.repo}/actions/workflows/build.yml/runs?branch=${encodeURIComponent(branch)}&per_page=10`)
    if (!list.ok) {
      push(`[actions] listing runs failed: ${list.status} ${list.text.slice(0, 160)}`)
      continue
    }
    const runs = (list.data?.workflow_runs ?? []) as { id: number; head_sha: string; html_url: string }[]
    const match = runs.find((r) => r.head_sha === sha) ?? runs[0]
    if (match) {
      runId = match.id
      runUrl = match.html_url ?? ''
      push(`[actions] run ${runId} ${runUrl}`)
    }
  }
  if (!runId) {
    return fail(
      `Could not find a workflow run for this commit. Check that .github/workflows/build.yml exists on ${branch} and that the token has the "workflow" scope.`,
      runUrl
    )
  }

  // 5. Wait for completion (poll; no gh needed)
  let conclusion = ''
  const deadline = Date.now() + 45 * 60 * 1000
  while (Date.now() < deadline) {
    if (signal?.aborted) return fail('cancelled', runUrl)
    await sleep(8000)
    const view = await ghApi(ctx, `/repos/${target.owner}/${target.repo}/actions/runs/${runId}`)
    if (!view.ok) {
      push(`[actions] polling run failed: ${view.status}`)
      continue
    }
    runUrl = view.data?.html_url ?? runUrl
    const status = String(view.data?.status ?? '')
    push(`[actions] run ${runId}: ${status}${view.data?.conclusion ? ` (${view.data.conclusion})` : ''}`)
    if (status === 'completed') {
      conclusion = String(view.data?.conclusion ?? 'unknown')
      break
    }
  }
  if (!conclusion) return fail('Timed out waiting for the workflow to finish.', runUrl)

  if (conclusion !== 'success') {
    const jobs = await ghApi(ctx, `/repos/${target.owner}/${target.repo}/actions/runs/${runId}/jobs`)
    const failed = ((jobs.data?.jobs ?? []) as { id: number; name: string; conclusion: string; steps?: { name: string; conclusion: string }[] }[]).filter(
      (j) => j.conclusion && j.conclusion !== 'success'
    )
    for (const job of failed) {
      const badSteps = (job.steps ?? []).filter((st) => st.conclusion && !['success', 'skipped'].includes(st.conclusion))
      push(`[actions] job "${job.name}" ${job.conclusion}; failing steps: ${badSteps.map((st) => st.name).join(', ') || '(none reported)'}`)
    }
    const tail = await fetchFailedLogTail(ctx, target.owner, target.repo, runId, failed.map((j) => j.id), push)
    return {
      ok: false,
      code: 1,
      logPath,
      errors: [`Workflow finished with "${conclusion}". See ${runUrl || 'the Actions tab'}.`, ...failed.map((j) => `job ${j.name}: ${j.conclusion}`), ...extractGradleErrors(tail)],
      durationMs: Date.now() - started
    }
  }
  push(`[actions] workflow succeeded ${runUrl}`)

  // 6. Download the jar artifact through the REST API
  const dlDir = path.join(dir, '.agent', 'artifacts', String(runId))
  fs.mkdirSync(dlDir, { recursive: true })
  const artifacts = await ghApi(ctx, `/repos/${target.owner}/${target.repo}/actions/runs/${runId}/artifacts`)
  if (!artifacts.ok) return fail(`listing artifacts failed: ${artifacts.status}`, runUrl)
  const list = (artifacts.data?.artifacts ?? []) as { id: number; name: string; archive_download_url: string; expired: boolean }[]
  const artifact = list.find((a) => /jar/i.test(a.name)) ?? list[0]
  if (!artifact) return fail('Workflow succeeded but published no artifact.', runUrl)
  if (artifact.expired) return fail('The workflow artifact has already expired.', runUrl)
  const zipPath = path.join(dlDir, `${artifact.name}.zip`)
  const dl = await downloadFile(ctx, artifact.archive_download_url, zipPath, push)
  if (!dl.ok) return fail(`artifact download failed: ${dl.error}`, runUrl)
  extractZip(zipPath, dlDir)

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

/**
 * Fill in an owner and repo that were never set.
 *
 * A scaffolded project usually has both, because the user typed them when they
 * created it. A fork of a decompiled mod does not: it was never created *for*
 * GitHub. The signed-in account is the obvious owner and the folder name is a
 * serviceable repo name, so the build proceeds instead of asking for settings
 * the app can infer.
 */
export function resolveGithubTarget(
  cfg: GhConfig,
  dir: string,
  login?: string
): { owner: string; repo: string; inferred: boolean } {
  const owner = (cfg.owner || login || '').trim()
  const repo = (cfg.repo || suggestRepoName(path.basename(dir))).trim()
  return { owner, repo, inferred: !cfg.owner || !cfg.repo }
}

/**
 * Make sure `owner/repo` exists on GitHub, creating it when it does not.
 *
 * Shared by the build and by the explicit "create a repo" action: pressing
 * **Build on GitHub** should not require a separate setup step first. Returns an
 * error string rather than throwing, because the caller already knows how to
 * report a failure in the build log.
 */
async function ensureGithubRepo(
  ctx: GithubContext,
  owner: string,
  repo: string,
  isPrivate: boolean,
  push: (line: string) => void
): Promise<{ ok: boolean; error?: string }> {
  if (!owner || !repo) return { ok: false, error: 'Set the GitHub owner and repo in Settings → GitHub.' }
  const exists = await ghApi(ctx, `/repos/${owner}/${repo}`)
  if (exists.ok) return { ok: true }
  if (exists.status !== 404) {
    return { ok: false, error: `Cannot check ${owner}/${repo}: ${exists.status} ${exists.text.slice(0, 160)}` }
  }
  push(`[github] creating ${owner}/${repo}`)
  const create = await ghApi(ctx, '/user/repos', {
    method: 'POST',
    body: JSON.stringify({
      name: repo,
      private: isPrivate,
      description: 'Minecraft mod (MC Forge Agent)',
      has_issues: true,
      has_wiki: false
    })
  })
  if (!create.ok) {
    return { ok: false, error: `repo create failed: ${create.status} ${create.data?.message ?? create.text.slice(0, 200)}` }
  }
  push(`[github] created ${create.data?.full_name ?? `${owner}/${repo}`}`)
  return { ok: true }
}

/** Create the GitHub repo (if needed) and push the current project. */
export async function initGithubRepo(cfg: GhConfig, dir: string, isPrivate: boolean, onLine: (l: string) => void): Promise<{ ok: boolean; url?: string; error?: string }> {
  const push = onLine
  // A fork made from a decompiled mod arrives with no owner/repo filled in far
  // more often than a scaffolded project does. The signed-in account is the
  // owner in that case, and the mod id is a serviceable repo name, so this asks
  // "owner and repo are required" far less often than it needs to.
  const ctx = await githubContext()
  if (!ctx.token) return { ok: false, error: 'Sign in to GitHub first (Settings > GitHub).' }
  const resolved = resolveGithubTarget(cfg, dir, ctx.login)
  if (resolved.inferred) push(`[github] using ${resolved.owner}/${resolved.repo} (from the signed-in account and the folder name)`)
  const target = { ...cfg, owner: resolved.owner, repo: resolved.repo }
  const ensured = await ensureGithubRepo(ctx, target.owner, target.repo, isPrivate, push)
  if (!ensured.ok) return { ok: false, error: ensured.error ?? 'Could not create the repository.' }

  if (!fs.existsSync(path.join(dir, '.git'))) {
    // Before the first commit, so the decompiled tree and its jars never enter it.
    ensureForkGitignore(dir)
    const init = await run('git', ['init', '-b', target.branch || 'main'], { cwd: dir, timeoutMs: 60000 })
    if (init.code !== 0) return { ok: false, error: init.stderr.trim() }
  }
  const remotes = await run('git', ['remote'], { cwd: dir })
  if (!remotes.stdout.split(/\s+/).includes('origin')) {
    await run('git', ['remote', 'add', 'origin', `https://github.com/${target.owner}/${target.repo}.git`], { cwd: dir })
  }
  await run('git', ['add', '-A'], { cwd: dir })
  await run('git', ['-c', 'user.name=MC Forge Agent', '-c', 'user.email=agent@localhost', 'commit', '-m', 'Initial mod project (MC Forge Agent)'], { cwd: dir })
  const branch = target.branch || 'main'
  const pushed = await gitPush(ctx, dir, ['push', '-u', 'origin', `HEAD:${branch}`])
  if (pushed.code !== 0) return { ok: false, error: simplifyGitError(pushed.err || pushed.out, ctx) }
  return { ok: true, url: `https://github.com/${target.owner}/${target.repo}` }
}

/** Turn git's auth failures into something a user can act on. */
function simplifyGitError(text: string, ctx: GithubContext): string {
  const raw = text.trim()
  if (/Authentication failed|could not read Username|terminal prompts disabled|Invalid username or password/i.test(raw)) {
    return `GitHub refused the stored credentials${ctx.login ? ` for ${ctx.login}` : ''}. Sign out and in again from Settings > GitHub, and make sure the account has push access. (git said: ${raw.slice(0, 200)})`
  }
  if (/protected branch|GH006|refusing to allow/i.test(raw)) {
    return `The ${ctx.login ? '' : ''}branch is protected and rejected the push. (git said: ${raw.slice(0, 300)})`
  }
  return raw
}

/**
 * Download the log zip for failed jobs and return the tail. The logs endpoint
 * redirects to storage; if that host is unreachable (corporate proxy), the job
 * and step names from the API are still enough to say what broke.
 */
async function fetchFailedLogTail(ctx: GithubContext, owner: string, repo: string, runId: number, jobIds: number[], push: (l: string) => void): Promise<string> {
  const chunks: string[] = []
  for (const jobId of jobIds.slice(0, 3)) {
    try {
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`, {
        redirect: 'follow',
        headers: { Authorization: `Bearer ${ctx.token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'MC-Forge-Agent' }
      })
      if (!res.ok) {
        push(`[actions] log download for job ${jobId} failed: HTTP ${res.status}`)
        continue
      }
      const buf = Buffer.from(await res.arrayBuffer())
      const zipPath = path.join(app.getPath('temp'), `mcf-logs-${runId}-${jobId}.zip`)
      fs.writeFileSync(zipPath, buf)
      const outDir = path.join(app.getPath('temp'), `mcf-logs-${runId}-${jobId}`)
      extractZip(zipPath, outDir)
      for (const file of fs.readdirSync(outDir)) {
        const full = path.join(outDir, file)
        if (fs.statSync(full).isFile()) chunks.push(fs.readFileSync(full, 'utf8'))
      }
      fs.rmSync(outDir, { recursive: true, force: true })
      fs.rmSync(zipPath, { force: true })
    } catch (e) {
      push(`[actions] log download failed: ${(e as Error).message}`)
    }
  }
  const tail = chunks.join('\n').split(/\r?\n/).slice(-200).join('\n')
  if (tail) push(tail)
  return tail
}

/** Actions artifacts are zip files; both the jar and the logs need unpacking. */
function extractZip(zipPath: string, destDir: string): void {
  const AdmZip = require('adm-zip') as typeof import('adm-zip')
  const zip = new AdmZip(zipPath)
  zip.extractAllTo(destDir, true)
}
