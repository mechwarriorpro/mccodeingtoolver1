/**
 * Guards the packaged main bundle against ERR_REQUIRE_ESM and against shipping a
 * package that cannot find Claude Code's CLI.
 *
 * The Claude Agent SDK is ESM-only ("type": "module", main: sdk.mjs). electron-vite
 * emits CommonJS for the main process, so the SDK must be *bundled* (not externalised)
 * or Electron throws:
 *   Error [ERR_REQUIRE_ESM]: require() of ES Module .../sdk.mjs not supported
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, section, finish } from './helpers.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = path.join(root, 'out', 'main', 'index.js')

section('main bundle exists')
if (!fs.existsSync(bundlePath)) {
  console.log('  (out/main/index.js missing - run `npm run build` first)')
  check('bundle built', false, 'npm run build')
  finish('packaging')
}

const bundle = fs.readFileSync(bundlePath, 'utf8')

section('no CommonJS require of the ESM-only SDK')
check(
  'bundle does not require @anthropic-ai/claude-agent-sdk',
  !/require\(\s*["']@anthropic-ai\/claude-agent-sdk["']\s*\)/.test(bundle)
)
check(
  'bundle does not reference sdk.mjs at runtime',
  !/require\(\s*["'][^"']*sdk\.mjs["']\s*\)/.test(bundle)
)

section('SDK is inlined into the bundle')
check('SDK version marker is in the bundle', bundle.includes('CLAUDE_AGENT_SDK_VERSION'))
check('query() implementation is in the bundle', /function query\(|const query = /.test(bundle) || bundle.includes('pathToClaudeCodeExecutable'))
check('mcp tool factory is in the bundle', bundle.includes('createSdkMcpServer') || bundle.includes('sdk-tools'))

section('bundled app loads as CommonJS (the exact failure mode from the crash)')
const { execFileSync } = await import('node:child_process')
const probe = `
const Module = require('module')
const orig = Module._load
const app = { requestSingleInstanceLock: () => false, on() {}, whenReady: () => ({ then() {} }),
  setAppUserModelId() {}, getPath: () => require('os').tmpdir(), getAppPath: () => process.cwd(),
  getVersion: () => '0.0.0-test', quit() {}, exit() {} }
Module._load = function (req) {
  if (req === 'electron') return new Proxy({ app }, { get: (t, k) => t[k] ?? (() => ({})) })
  return orig.apply(this, arguments)
}
require(${JSON.stringify(bundlePath)})
console.log('LOADED')
`
let loaded = false
let errText = ''
try {
  const out = execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8', cwd: root, timeout: 60000 })
  loaded = out.includes('LOADED')
} catch (e) {
  errText = `${e.stderr ?? ''}${e.stdout ?? ''}`.slice(0, 400)
}
check('main bundle loads without ERR_REQUIRE_ESM', loaded, errText)
check('no ERR_REQUIRE_ESM in output', !errText.includes('ERR_REQUIRE_ESM'), errText)

section('packaging config keeps the CLI spawnable')
const builderYml = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8')
check('SDK is asar-unpacked', /node_modules\/@anthropic-ai\/claude-agent-sdk\/\*\*\/\*/.test(builderYml))
check('template is shipped as an extra resource', /from:\s*template/.test(builderYml))
const viteConfig = fs.readFileSync(path.join(root, 'electron.vite.config.ts'), 'utf8')
check(
  'main build bundles (excludes) the SDK from externalisation',
  /externalizeDepsPlugin\(\{[^}]*exclude:[^}]*@anthropic-ai\/claude-agent-sdk/s.test(viteConfig)
)

section('GitHub sign-in and the decompiler survive bundling')
// Both features spawn/fetch from the main process. If electron-vite externalises
// a dependency they need, the packaged app dies at startup exactly like the SDK
// crash, so assert the modules were inlined and nothing new is required.
check('github sign-in is bundled', bundle.includes('login/device/code') && bundle.includes('login/oauth/access_token'))
check('reference decompiler is bundled', bundle.includes('vineflower') || bundle.includes('Vineflower'))
// adm-zip is plain CommonJS, so externalising it is correct: require() works and
// electron-builder ships it in the asar. What must never happen is requiring an
// ESM-only package (the SDK crash), which the checks above cover.
check('adm-zip is resolvable as CommonJS', fs.existsSync(path.join(root, 'node_modules', 'adm-zip', 'adm-zip.js')) || fs.existsSync(path.join(root, 'node_modules', 'adm-zip', 'package.json')))
check('adm-zip is listed in electron-builder files (production dep)', /dependencies/.test(fs.readFileSync(path.join(root, 'package.json'), 'utf8')))
check('asar still unpacks the Claude CLI', /claude-agent-sdk/.test(fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8')))

section('release workflow stamps the installer version from the tag')
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8')
check(
  'tag builds stamp package.json from the tag',
  /name: Stamp version from tag[\s\S]{0,900}?p\.version/.test(workflow)
)
check(
  'a misnamed installer asset fails the release',
  /does not match tag version/.test(workflow)
)

finish('packaging')
