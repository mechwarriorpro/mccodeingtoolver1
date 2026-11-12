/**
 * Test runner. Compiles the pure (non-Electron) modules to out-test/ with tsc,
 * then runs each tests/*.test.mjs in a fresh Node process.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'out-test')

fs.rmSync(outDir, { recursive: true, force: true })

const sources = [
  'src/main/mod/scaffold.ts',
  'src/main/build/gradle.ts',
  'src/main/agent/tools.ts',
  'src/main/game/technic.ts',
  'src/main/mod/jar.ts',
  'src/main/util/exec.ts'
]

// The modules import electron for app paths; map it to a tiny stub for tests.
const stub = path.join(outDir, '__electron_stub.mjs')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(
  stub,
  `export const app = { getPath: () => ${JSON.stringify(path.join(root, '.test-tmp'))}, getAppPath: () => ${JSON.stringify(root)}, getVersion: () => '0.1.0-test', isPackaged: false }
export const shell = { openPath: async () => '' }
export const screen = { getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }) }
export const nativeImage = { createFromPath: () => ({ getSize: () => ({ width: 0, height: 0 }), toPNG: () => Buffer.alloc(0) }) }
export default { app, shell, screen, nativeImage }
`
)

console.log('compiling testable modules…')
// Call tsc's JS entry point with the current node binary: `npx` is npx.cmd on Windows
// and execFileSync cannot launch it without a shell.
const tscBin = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')
execFileSync(
  process.execPath,
  [
    tscBin,
    ...sources,
    '--outDir',
    outDir,
    '--module',
    'esnext',
    '--target',
    'es2022',
    '--moduleResolution',
    'bundler',
    '--skipLibCheck',
    '--rootDir',
    'src'
  ],
  { cwd: root, stdio: 'inherit' }
)

// Files in the test build use extensionless relative imports (bundler style);
// Node's ESM loader needs explicit extensions, so append .js to relative specifiers.
const fixRelativeImports = (code) =>
  code.replace(/(from\s+["'])(\.{1,2}\/[^"']+?)(["'])/g, (m, a, spec, c) =>
    /\.(js|mjs|json)$/.test(spec) ? m : `${a}${spec}.js${c}`
  )

// Rewrite the bare "electron" import in compiled output to the stub.
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (p.endsWith('.js')) {
      const src = fs.readFileSync(p, 'utf8')
      const depth = path.relative(path.dirname(p), outDir).split(path.sep).filter(Boolean).length
      const rel = depth ? '../'.repeat(depth) + '__electron_stub.mjs' : './__electron_stub.mjs'
      const withStub = src.replace(/from ["']electron["']/g, `from ${JSON.stringify(rel)}`)
      fs.writeFileSync(p, fixRelativeImports(withStub))
    }
  }
}
walk(outDir)

// repo.test.mjs uses git directly, so it runs without the compiled modules
const tests = fs.readdirSync(path.join(root, 'tests')).filter((f) => f.endsWith('.test.mjs'))
let failed = 0
for (const t of tests) {
  console.log(`\n=== ${t} ===`)
  try {
    execFileSync(process.execPath, [path.join(root, 'tests', t)], { stdio: 'inherit', cwd: root })
  } catch (e) {
    failed++
    // Surface the failing output in the CI step summary: Actions log downloads are
    // unreliable behind proxies, but annotations always come through.
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`
    const lines = out.split(/\r?\n/).filter((l) => /FAIL|Error|error:|not found/.test(l))
    if (process.env.GITHUB_ACTIONS) {
      console.log(`::error title=${t} failed::${(lines.slice(0, 6).join(' | ') || 'see step log').replace(/%/g, '%25').slice(0, 900)}`)
    }
    console.log(lines.slice(0, 20).join('\n') || String(e.message).slice(0, 800))
  }
}
console.log(failed ? `\n${failed} test file(s) failed` : '\nall tests passed')
process.exit(failed ? 1 : 0)
