/**
 * electron-builder preflight. Packaging an uncompiled checkout produces an installer
 * whose main entry (out/main/index.js) does not exist, which only surfaces at runtime.
 */
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const entry = path.join(root, 'out', 'main', 'index.js')

if (!fs.existsSync(entry)) {
  console.error('\n[preflight] out/main/index.js is missing.')
  console.error('[preflight] Run `npm run build` (electron-vite) before packaging, or use `npm run dist:win`.\n')
  process.exit(1)
}

const renderer = path.join(root, 'out', 'renderer', 'index.html')
if (!fs.existsSync(renderer)) {
  console.error('[preflight] out/renderer/index.html is missing; the UI was not built.')
  process.exit(1)
}
