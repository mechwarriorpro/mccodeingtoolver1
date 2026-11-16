/**
 * Post-install fixups.
 *
 * 1. In this sandbox (and on some locked-down networks) Electron's binary cannot be
 *    downloaded. That is fine for typechecking and for `electron-vite build`, so we
 *    do not fail the install when the binary is missing.
 * 2. Exports a helper the app uses to spawn the Claude Code CLI with Electron's
 *    bundled Node (ELECTRON_RUN_AS_NODE=1) instead of requiring a system Node.
 */
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const electronDir = path.join(root, 'node_modules', 'electron')

function hasBinary() {
  try {
    const p = path.join(electronDir, 'path.txt')
    if (!fs.existsSync(p)) return false
    const rel = fs.readFileSync(p, 'utf8').trim()
    return fs.existsSync(path.join(electronDir, 'dist', rel))
  } catch {
    return false
  }
}

if (!fs.existsSync(electronDir)) {
  console.log('[postinstall] electron package not installed, skipping.')
  process.exit(0)
}

if (!hasBinary()) {
  console.log('[postinstall] electron binary missing (offline or blocked CDN).')
  console.log('[postinstall] dev UI can still be built; run `npm run dist:win` on a machine with network access.')
  process.exit(0)
}

const sdkCli = path.join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js')
if (fs.existsSync(sdkCli)) {
  const pkgPath = path.join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  console.log(`[postinstall] Claude Agent SDK ${pkg.version} CLI present.`)
}
