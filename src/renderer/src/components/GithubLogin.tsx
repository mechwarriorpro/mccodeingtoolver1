import { useCallback, useEffect, useRef, useState } from 'react'
import type { DeviceLoginPrompt, GithubStatus } from '../../../shared/types'
import { api } from '../lib/api'

interface Props {
  onToast: (text: string, kind?: 'ok' | 'err') => void
  /** Called after a successful sign-in or sign-out so the parent can refresh. */
  onChanged?: (status: GithubStatus) => void
}

/**
 * Sign in to GitHub from inside the app.
 *
 * Primary path is the OAuth device flow: the user gets a short code, types it at
 * github.com/login/device once, and the app stores the token. The GitHub CLI is
 * not required. A personal access token is offered as a fallback for networks
 * that block the device endpoint.
 */
export default function GithubLogin({ onToast, onChanged }: Props): JSX.Element {
  const [status, setStatus] = useState<GithubStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [prompt, setPrompt] = useState<DeviceLoginPrompt | null>(null)
  const [secondsLeft, setSecondsLeft] = useState(0)
  const [showPat, setShowPat] = useState(false)
  const [pat, setPat] = useState('')
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef(false)

  const refresh = useCallback(async () => {
    const s = await api.github.status()
    setStatus(s)
    onChanged?.(s)
  }, [onChanged])

  useEffect(() => {
    void refresh()
    const offs = [
      api.events.onGithubDeviceCode((p) => {
        setPrompt(p)
        setSecondsLeft(p.expiresInSec)
      }),
      api.events.onGithubDeviceTick((p) => setSecondsLeft(p.secondsLeft))
    ]
    return () => offs.forEach((off) => off())
  }, [refresh])

  async function signInDevice(): Promise<void> {
    setBusy(true)
    setError(null)
    setPrompt(null)
    pollRef.current = true
    try {
      const res = await api.github.loginDevice({ openBrowser: true })
      if (res.ok) {
        onToast('Signed in to GitHub')
        await refresh()
      } else if (res.error && res.error !== 'Sign-in cancelled.') {
        setError(res.error)
      }
    } finally {
      setPrompt(null)
      setBusy(false)
      pollRef.current = false
    }
  }

  async function signInToken(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const res = await api.github.loginToken(pat)
      if (res.ok) {
        setPat('')
        setShowPat(false)
        onToast('Signed in with a personal access token')
        await refresh()
      } else {
        setError(res.error ?? 'That token was rejected.')
      }
    } finally {
      setBusy(false)
    }
  }

  async function signOut(): Promise<void> {
    await api.github.logout()
    setStatus(null)
    onToast('Signed out of GitHub')
    await refresh()
  }

  const mm = Math.floor(secondsLeft / 60)
  const ss = String(secondsLeft % 60).padStart(2, '0')

  if (status?.connected) {
    return (
      <div className="gh-signin">
        <div className="gh-user">
          {status.avatarUrl ? <img src={status.avatarUrl} alt="" width={34} height={34} /> : <div className="gh-avatar-fallback">{(status.login || '?')[0].toUpperCase()}</div>}
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>
              {status.login} <span className="badge green">signed in</span>
            </div>
            <div className="dim small">
              {status.method === 'pat' ? 'Personal access token' : status.method === 'device' ? 'GitHub sign-in' : 'Browser sign-in'}
              {status.scopes.length ? ` · ${status.scopes.join(', ')}` : ''}
            </div>
          </div>
          <button className="small ghost" style={{ marginLeft: 'auto' }} onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
        {status.repoMessage && (
          <div className={status.repoOk ? 'hint' : 'hint warn'} style={{ marginTop: 8 }}>
            {status.repoOk ? `Repo reachable: ${status.repoMessage}` : status.repoMessage}
          </div>
        )}
        {!status.repoOk && <div className="hint">Set owner, repository and branch below, then press “Create repo &amp; push”.</div>}
        {!status.ghCliFound && <div className="dim small" style={{ marginTop: 6 }}>GitHub CLI not installed — not needed, the app talks to the API directly.</div>}
      </div>
    )
  }

  return (
    <div className="gh-signin">
      <div className="hint" style={{ marginBottom: 10 }}>
        Sign in here so the app can create the repo, push, run the build workflow and fetch the jar. No GitHub CLI needed.
      </div>

      {prompt ? (
        <div className="device-code">
          <div className="dim small">Enter this code at {prompt.verificationUri.replace('https://', '')}</div>
          <div className="code">{prompt.userCode}</div>
          <div className="dim small">
            Waiting for approval{secondsLeft ? ` — code expires in ${mm}:${ss}` : '…'}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="small" onClick={() => void api.github.openDevicePage()}>
              Open GitHub
            </button>
            <button className="small ghost" onClick={() => void navigator.clipboard.writeText(prompt.userCode).then(() => onToast('Code copied'))}>
              Copy code
            </button>
          </div>
        </div>
      ) : (
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button className="primary small" disabled={busy} onClick={() => void signInDevice()}>
            {busy ? 'Waiting for GitHub…' : 'Sign in with GitHub'}
          </button>
          <button className="small ghost" disabled={busy} onClick={() => setShowPat((v) => !v)}>
            {showPat ? 'Hide token field' : 'Use a token instead'}
          </button>
        </div>
      )}

      {showPat && !prompt && (
        <div style={{ marginTop: 10 }}>
          <div className="field">
            <label>Personal access token</label>
            <input type="password" value={pat} placeholder="ghp_… or github_pat_…" onChange={(e) => setPat(e.target.value)} />
            <div className="hint">
              Create one at github.com/settings/tokens with the <code>repo</code> and <code>workflow</code> scopes.
            </div>
          </div>
          <button className="small" disabled={!pat.trim() || busy} onClick={() => void signInToken()}>
            Save token
          </button>
        </div>
      )}

      {error && <div className="hint warn" style={{ marginTop: 10 }}>{error}</div>}
      {status && !status.ghCliFound && <div className="dim small" style={{ marginTop: 8 }}>GitHub CLI not found on PATH — that is fine, it is optional.</div>}
    </div>
  )
}
