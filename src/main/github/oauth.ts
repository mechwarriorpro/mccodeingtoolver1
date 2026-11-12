import fs from 'node:fs'
import path from 'node:path'
import { app, shell } from 'electron'
import { userDataDir } from '../config'

/**
 * Sign in to GitHub from inside the app, without the GitHub CLI.
 *
 * Two paths, tried in order:
 *
 *  1. OAuth device flow with the GitHub CLI's public client id. GitHub shows a
 *     short code (ABCD-1234) that the user types at github.com/login/device.
 *     No client secret is needed and no localhost listener is required, which
 *     matters because the renderer is served from a file:// origin in dev and a
 *     custom one when packaged.
 *
 *  2. If the device flow is unavailable (the client id was revoked, the network
 *     blocks github.com/login/device), fall back to the classic web flow on a
 *     loopback listener. The user still confirms in the browser, but the code is
 *     copied automatically.
 *
 * The token is stored in userData/github-auth.json with mode 0600 and never
 * leaves the main process: the renderer only ever receives the login name.
 */

/** Public client id of the GitHub CLI. Not a secret; it is in `gh`'s source. */
const GITHUB_CLI_CLIENT_ID = 'Iv1.b507a08c87ecfe98'

/** `repo` to push, `workflow` so the Actions build workflow can be dispatched. */
const SCOPES = 'repo workflow read:org'

const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const API = 'https://api.github.com'

export interface GithubAuth {
  token: string
  login: string
  name?: string
  avatarUrl?: string
  scopes: string[]
  /** When the token stops working, if GitHub told us. */
  expiresAt?: number
  method: 'device' | 'web' | 'pat'
  savedAt: number
}

export interface GithubUser {
  login: string
  name?: string
  avatarUrl?: string
  scopes: string[]
}

export interface DeviceCodeGrant {
  deviceCode: string
  userCode: string
  verificationUri: string
  /** Present in newer responses; the one to show when available. */
  verificationUriComplete?: string
  intervalSec: number
  expiresInSec: number
}

export class GithubAuthError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

function authFile(): string {
  return path.join(userDataDir(), 'github-auth.json')
}

let cached: GithubAuth | null | undefined

export function readAuth(): GithubAuth | null {
  if (cached !== undefined) return cached
  try {
    const raw = JSON.parse(fs.readFileSync(authFile(), 'utf8')) as GithubAuth
    cached = raw?.token ? raw : null
  } catch {
    cached = null
  }
  return cached
}

export function authToken(): string {
  return readAuth()?.token ?? ''
}

function writeAuth(auth: GithubAuth | null): void {
  cached = auth
  const file = authFile()
  if (!auth) {
    try {
      fs.unlinkSync(file)
    } catch {
      /* already gone */
    }
    return
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(auth, null, 2), { encoding: 'utf8', mode: 0o600 })
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* best effort on Windows */
  }
}

function parseScopes(header: string | null): string[] {
  // "repo, workflow, read:org" or "repo,workflow" depending on the endpoint.
  return (header ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Ask GitHub who this token belongs to. Also proves the token still works, so
 * every entry point that needs authentication starts here rather than trusting
 * a stale cache.
 */
export async function fetchUser(token: string): Promise<GithubUser> {
  const res = await fetch(`${API}/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'MC-Forge-Agent'
    }
  })
  if (res.status === 401) throw new GithubAuthError('bad_token', 'GitHub rejected the token (it may have been revoked or expired).')
  if (!res.ok) throw new GithubAuthError('api_error', `GitHub API responded ${res.status} ${res.statusText}.`)
  const body = (await res.json()) as { login?: string; name?: string; avatar_url?: string }
  if (!body.login) throw new GithubAuthError('api_error', 'GitHub returned no login name for this token.')
  return {
    login: body.login,
    name: body.name ?? undefined,
    avatarUrl: body.avatar_url ?? undefined,
    scopes: parseScopes(res.headers.get('x-oauth-scopes'))
  }
}

/** Save a token the user pasted (a classic PAT from github.com/settings/tokens). */
export async function loginWithToken(token: string): Promise<GithubAuth> {
  const clean = token.trim()
  if (!clean) throw new GithubAuthError('empty_token', 'Paste a token first.')
  const user = await fetchUser(clean)
  const auth: GithubAuth = {
    token: clean,
    login: user.login,
    name: user.name,
    avatarUrl: user.avatarUrl,
    scopes: user.scopes,
    method: 'pat',
    savedAt: Date.now()
  }
  writeAuth(auth)
  return auth
}

export function logout(): void {
  writeAuth(null)
}

/** Start the device flow: returns the code to show the user. */
export async function beginDeviceFlow(): Promise<DeviceCodeGrant> {
  const res = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'MC-Forge-Agent' },
    body: JSON.stringify({ client_id: GITHUB_CLI_CLIENT_ID, scope: SCOPES })
  })
  if (!res.ok) {
    throw new GithubAuthError('device_unavailable', `GitHub's device-login endpoint returned ${res.status}. Use a personal access token instead.`)
  }
  const body = (await res.json()) as {
    device_code?: string
    user_code?: string
    verification_uri?: string
    verification_uri_complete?: string
    interval?: number
    expires_in?: number
    error?: string
    error_description?: string
  }
  if (body.error || !body.device_code || !body.user_code) {
    throw new GithubAuthError(body.error ?? 'device_unavailable', body.error_description ?? 'GitHub did not return a device code.')
  }
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri ?? 'https://github.com/login/device',
    verificationUriComplete: body.verification_uri_complete,
    intervalSec: Math.max(5, body.interval ?? 5),
    expiresInSec: body.expires_in ?? 900
  }
}

interface PollResult {
  ok: boolean
  slowDown?: boolean
  pending?: boolean
  token?: string
  scopes?: string[]
  error?: string
}

async function pollDeviceOnce(grant: DeviceCodeGrant): Promise<PollResult> {
  const res = await fetch(ACCESS_TOKEN_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'MC-Forge-Agent' },
    body: JSON.stringify({
      client_id: GITHUB_CLI_CLIENT_ID,
      device_code: grant.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
    })
  })
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string
    scope?: string
    error?: string
    error_description?: string
    interval?: number
  }
  if (body.access_token) {
    return { ok: true, token: body.access_token, scopes: (body.scope ?? '').split(',').map((s) => s.trim()).filter(Boolean) }
  }
  switch (body.error) {
    case 'authorization_pending':
      return { ok: false, pending: true }
    case 'slow_down':
      return { ok: false, slowDown: true, pending: true }
    case 'expired_token':
      return { ok: false, error: 'The code expired before it was entered. Start again.' }
    case 'access_denied':
      return { ok: false, error: 'Sign-in was cancelled on GitHub.' }
    default:
      return { ok: false, error: body.error_description ?? body.error ?? 'GitHub did not return a token.' }
  }
}

/**
 * Poll until the user approves, the code expires, or the signal aborts.
 * `onTick` receives elapsed seconds so the UI can show progress.
 */
export async function awaitDeviceApproval(
  grant: DeviceCodeGrant,
  signal: AbortSignal | undefined,
  onTick?: (secondsLeft: number) => void
): Promise<GithubAuth> {
  const deadline = Date.now() + grant.expiresInSec * 1000
  let interval = grant.intervalSec
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new GithubAuthError('cancelled', 'Sign-in cancelled.')
    await sleep(interval * 1000, signal)
    if (signal?.aborted) throw new GithubAuthError('cancelled', 'Sign-in cancelled.')
    const result = await pollDeviceOnce(grant)
    if (result.ok && result.token) {
      const user = await fetchUser(result.token)
      const auth: GithubAuth = {
        token: result.token,
        login: user.login,
        name: user.name,
        avatarUrl: user.avatarUrl,
        scopes: result.scopes?.length ? result.scopes : user.scopes,
        method: 'device',
        savedAt: Date.now()
      }
      writeAuth(auth)
      return auth
    }
    if (result.slowDown) interval += 5
    else if (!result.pending) throw new GithubAuthError('device_failed', result.error ?? 'Sign-in failed.')
    onTick?.(Math.max(0, Math.round((deadline - Date.now()) / 1000)))
  }
  throw new GithubAuthError('expired_token', 'The code expired before it was entered. Start again.')
}

export function openVerificationPage(grant: DeviceCodeGrant): Promise<void> {
  return shell.openExternal(grant.verificationUriComplete ?? grant.verificationUri)
}

/**
 * Classic web flow on a loopback listener. Only used when the device flow is
 * refused; GitHub lets a public OAuth app use a localhost redirect.
 */
export async function beginWebFlow(signal?: AbortSignal): Promise<GithubAuth> {
  const http = await import('node:http')
  const crypto = await import('node:crypto')
  const state = crypto.randomBytes(16).toString('hex')

  const server = http.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  if (!port) {
    server.close()
    throw new GithubAuthError('web_unavailable', 'Could not open a local port for the browser redirect.')
  }
  const redirectUri = `http://127.0.0.1:${port}/callback`

  const codePromise = new Promise<string>((resolve, reject) => {
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', redirectUri)
      if (url.pathname !== '/callback') {
        res.writeHead(404).end('Not found')
        return
      }
      const code = url.searchParams.get('code')
      const returnedState = url.searchParams.get('state')
      const error = url.searchParams.get('error_description') ?? url.searchParams.get('error')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        `<!doctype html><meta charset="utf-8"><title>MC Forge Agent</title>` +
          `<body style="font:16px system-ui;background:#0e1116;color:#e6edf3;display:grid;place-items:center;height:100vh;margin:0">` +
          `<div style="text-align:center"><h2>${error ? 'Sign-in failed' : 'Signed in to GitHub'}</h2>` +
          `<p style="color:#9aa7b2">${error ? escapeHtml(error) : 'You can close this tab and return to MC Forge Agent.'}</p></div></body>`
      )
      if (error) reject(new GithubAuthError('web_failed', error))
      else if (!code) reject(new GithubAuthError('web_failed', 'GitHub did not return a code.'))
      else if (returnedState !== state) reject(new GithubAuthError('web_failed', 'The sign-in response did not match this request (state mismatch).'))
      else resolve(code)
    })
  })

  const authorizeUrl =
    `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(GITHUB_CLI_CLIENT_ID)}` +
    `&scope=${encodeURIComponent(SCOPES)}&state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`
  await shell.openExternal(authorizeUrl)

  const abort = (): void => {
    server.close()
  }
  signal?.addEventListener('abort', abort)
  try {
    const code = await Promise.race([
      codePromise,
      new Promise<string>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new GithubAuthError('expired_token', 'Timed out waiting for the browser to finish sign-in.')), 5 * 60 * 1000)
        signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new GithubAuthError('cancelled', 'Sign-in cancelled.'))
        })
      })
    ])
    const res = await fetch(ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'MC-Forge-Agent' },
      body: JSON.stringify({ client_id: GITHUB_CLI_CLIENT_ID, code, redirect_uri: redirectUri })
    })
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; scope?: string; error_description?: string }
    if (!body.access_token) throw new GithubAuthError('web_failed', body.error_description ?? 'GitHub did not return a token.')
    const user = await fetchUser(body.access_token)
    const auth: GithubAuth = {
      token: body.access_token,
      login: user.login,
      name: user.name,
      avatarUrl: user.avatarUrl,
      scopes: (body.scope ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      method: 'web',
      savedAt: Date.now()
    }
    writeAuth(auth)
    return auth
  } finally {
    signal?.removeEventListener('abort', abort)
    server.close()
  }
}

/** Reduce what the renderer is allowed to see. */
export function redactAuth(auth: GithubAuth | null): Omit<GithubAuth, 'token'> & { connected: boolean } {
  if (!auth) return { connected: false, login: '', scopes: [], method: 'pat', savedAt: 0 }
  const { token: _token, ...rest } = auth
  return { ...rest, connected: true }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new GithubAuthError('cancelled', 'Sign-in cancelled.'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
}

/** Absolute path of the stored credential, for the "where is this saved" hint. */
export function authFilePath(): string {
  return authFile()
}

/** ETag-aware JSON GET for the GitHub API, used by the reference-mod browser. */
export async function githubApi<T>(pathOrUrl: string, init: RequestInit = {}): Promise<{ data: T; headers: Headers; status: number }> {
  const token = authToken()
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${API}${pathOrUrl}`
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'MC-Forge-Agent',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers as Record<string, string> | undefined)
    }
  })
  if (res.status === 404) throw new GithubAuthError('not_found', `GitHub has no such resource: ${pathOrUrl}`)
  if (res.status === 403) {
    const remaining = res.headers.get('x-ratelimit-remaining')
    if (remaining === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset') ?? 0) * 1000
      const mins = Math.max(1, Math.round((reset - Date.now()) / 60000))
      throw new GithubAuthError('rate_limited', `GitHub API rate limit reached; resets in about ${mins} minute(s). Signing in raises the limit.`)
    }
    throw new GithubAuthError('forbidden', `GitHub refused the request (${res.status}). Check the token's scopes.`)
  }
  if (!res.ok) throw new GithubAuthError('api_error', `GitHub API responded ${res.status} ${res.statusText}.`)
  const data = (await res.json()) as T
  return { data, headers: res.headers, status: res.status }
}

/** Default branch + whether the repo exists, used by the reference-mod flow. */
export async function repoInfo(owner: string, repo: string): Promise<{ defaultBranch: string; private: boolean; htmlUrl: string }> {
  const { data } = await githubApi<{ default_branch?: string; private?: boolean; html_url?: string }>(`/repos/${owner}/${repo}`)
  return { defaultBranch: data.default_branch ?? 'main', private: !!data.private, htmlUrl: data.html_url ?? '' }
}

/** Only used to keep the `app` import meaningful for path helpers in tests. */
export function _appPathForTests(): string {
  return app.getAppPath()
}
