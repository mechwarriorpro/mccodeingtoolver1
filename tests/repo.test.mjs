/**
 * Repository hygiene checks. These exist because a bare "build/" ignore rule once
 * excluded src/main/build/ from git, which only showed up in CI.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`)
  }
}

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

/** git prints CRLF on Windows; split on any newline and drop the stray carriage returns. */
function lines(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
}

let isRepo = true
try {
  git(['rev-parse', '--is-inside-work-tree'])
} catch {
  isRepo = false
}
if (!isRepo) {
  console.log('not a git checkout, skipping repo checks')
  process.exit(0)
}

console.log('no source file is ignored by .gitignore')
const sourceFiles = []
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.(ts|tsx|mjs|java|gradle|yml|json)$/.test(e.name)) sourceFiles.push(path.relative(root, p))
  }
}
for (const dir of ['src', 'tests', 'scripts', 'template']) {
  if (fs.existsSync(path.join(root, dir))) walk(path.join(root, dir))
}

let ignored = []
try {
  // check-ignore prints each ignored path and exits 1 when none match
  const out = execFileSync('git', ['check-ignore', ...sourceFiles], { cwd: root, encoding: 'utf8' })
  ignored = lines(out)
} catch {
  ignored = []
}
check('all source files are committable', ignored.length === 0, ignored.slice(0, 10).join('\n       '))

console.log('critical modules are tracked')
const mustTrack = [
  'src/main/build/gradle.ts',
  'src/main/build/actions.ts',
  'src/main/agent/engine.ts',
  'src/main/game/client.ts',
  // added with in-app GitHub sign-in and the reference decompiler
  'src/main/github/oauth.ts',
  'src/main/github/references.ts',
  'src/renderer/src/components/GithubLogin.tsx',
  'src/renderer/src/components/ReferencePanel.tsx'
]
const tracked = new Set(lines(git(['ls-files'])))
const missing = mustTrack.filter((f) => !tracked.has(f) && fs.existsSync(path.join(root, f)))
check('build/agent/game modules tracked', missing.length === 0, missing.join(', '))

console.log('vendored template is complete')
const tpl = path.join(root, 'template', 'neoforge-1.21.1')
for (const f of ['build.gradle', 'gradle.properties', 'gradlew', 'gradlew.bat', 'gradle/wrapper/gradle-wrapper.jar', 'settings.gradle']) {
  check(`template has ${f}`, fs.existsSync(path.join(tpl, f)))
}
check('template targets 1.21.1', /^minecraft_version=1\.21\.1$/m.test(fs.readFileSync(path.join(tpl, 'gradle.properties'), 'utf8')))

console.log('package scripts are wired')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
for (const script of ['build', 'test', 'typecheck', 'pack:win', 'dev']) {
  check(`npm script "${script}" exists`, typeof pkg.scripts?.[script] === 'string')
}
check('electron-builder config exists', fs.existsSync(path.join(root, 'electron-builder.yml')))
check('windows workflow exists', fs.existsSync(path.join(root, '.github/workflows/release.yml')))

console.log(failures ? `\n${failures} check(s) failed` : '\nall repo checks passed')
process.exit(failures ? 1 : 0)
