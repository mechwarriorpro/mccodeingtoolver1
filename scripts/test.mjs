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
  'src/main/mod/generate.ts',
  'src/main/versions/catalog.ts',
  'src/main/versions/eras.ts',
  'src/main/mod/scaffold.ts',
  'src/main/github/references.ts',
  'src/main/mod/fork.ts',
  'src/main/game/clip.ts',
  'src/main/learn.ts',
  'src/main/providers.ts',
  'src/main/local.ts',
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

console.log('building the app bundle (needed by the packaging test)…')
execFileSync(process.execPath, [path.join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'build'], {
  cwd: root,
  stdio: 'inherit'
})

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
const failures = []
for (const t of tests) {
  console.log(`\n=== ${t} ===`)
  try {
    // stdio:'inherit' keeps the child's own ::error annotations intact for Actions.
    execFileSync(process.execPath, [path.join(root, 'tests', t)], { stdio: 'inherit', cwd: root })
  } catch (e) {
    failed++
    // Actions log downloads are unreliable behind proxies, but annotations and the
    // step summary always come through, so report there too.
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`
    // Keep the assertion lines and the indented detail lines that follow them.
    const all = out.split(/\r?\n/).map((l) => l.replace(/\r/g, ''))
    const picked = []
    for (let i = 0; i < all.length; i++) {
      if (/^\s*FAIL /.test(all[i])) {
        picked.push(all[i].trim())
        const next = all[i + 1]
        if (next && /^\s{5,}\S/.test(next)) picked.push(next.trim().slice(0, 200))
      } else if (/Error:|error:|not found|Exception/.test(all[i]) && picked.length < 8) {
        picked.push(all[i].trim().slice(0, 200))
      }
    }
    // Keep enough of the raw tail to diagnose a crash even when no FAIL line was printed.
    const tail = all.filter(Boolean).slice(-6).join(' ~ ')
    failures.push({ file: t, detail: picked.slice(0, 4).join(' | ') || tail.slice(0, 600) || String(e.message).slice(0, 300) })
  }
}

// Always leave a machine-readable record of failures; CI uploads it as an artifact.
if (failures.length) {
  fs.writeFileSync(path.join(root, 'test-failures.json'), JSON.stringify(failures, null, 2))
}

if (failures.length && process.env.GITHUB_ACTIONS) {
  for (const f of failures) {
    // GitHub truncates multi-line annotation *messages* at the first line, so the
    // useful crash text goes in the title (single line, no newlines allowed).
    const msg = f.detail.replace(/%/g, '%25').replace(/\r?\n/g, ' ').slice(0, 400)
    const title = `${f.file} :: ${msg}`.replace(/[:-]/g, ' ').slice(0, 240)
    console.log(`::error title=${title}::${msg}`)
  }
  const summary = process.env.GITHUB_STEP_SUMMARY
  if (summary) {
    fs.appendFileSync(summary, `\n### Test failures\n${failures.map((f) => `- **${f.file}**: ${f.detail}`).join('\n')}\n`)
  }
}
console.log(failed ? `\n${failed} test file(s) failed` : '\nall tests passed')
process.exit(failed ? 1 : 0)
