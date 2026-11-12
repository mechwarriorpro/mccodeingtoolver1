/**
 * Build-invocation tests.
 *
 * Both come from one real failure log:
 *
 * ```
 * [build] cwd=C:\Users\Owner\AppData\Roaming\MC Forge Agent\forks\icbm-classic-1.12.2-6.4.1
 * [build] java=java
 * 'C:\Users\Owner\AppData\Roaming\MC' is not recognized as an internal or external command
 * ```
 *
 * Two separate bugs hid in three lines:
 *
 *  1. **The command was never quoted.** `shell: true` does not make Node quote
 *     the command, so cmd.exe split the path at the space in "MC Forge Agent"
 *     and tried to run `C:\Users\Owner\AppData\Roaming\MC`.
 *  2. **The Java version was taken from the app, not the project.** The app's
 *     launcher is fixed on Java 21, so `findJava()` demanded 21 for a 1.12.2
 *     project that only builds on Java 8.
 */
import { check, section, finish } from './helpers.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.on('uncaughtException', (err) => {
  const msg = `${err && err.stack ? err.stack : err}`.replace(/%/g, '%25').replace(/\r?\n/g, ' | ').slice(0, 600)
  console.log(`::error title=buildplan.test.mjs crash::${msg}`)
  process.exit(1)
})

const gradle = await import('../out-test/main/build/gradle.js')

const SPACED = 'C:\\Users\\Owner\\AppData\\Roaming\\MC Forge Agent\\forks\\icbm-classic-1.12.2-6.4.1\\gradlew.bat'
const plan = (cmd, args = ['build'], platform = 'win32', shell = true) => gradle.buildSpawnPlan({ cmd, shell }, args, platform)

section('a .bat under a path with spaces is quoted by us')
const p = plan(SPACED)
check('it goes through cmd.exe, not the shell', /cmd(\.exe)?$/i.test(p.cmd))
check('no shell is used (Node would not quote the command)', p.shell === false)
check('the command line is passed through verbatim', p.verbatim === true)
check('the batch file path is fully quoted', p.args.some((a) => a.includes(`"${SPACED}"`)))
check('the whole line is wrapped once more for /s', p.args[p.args.length - 1].startsWith('"') && p.args[p.args.length - 1].endsWith('"'))
check('the task is still there', p.args[p.args.length - 1].includes('build'))
check('/s and /c are used', p.args.includes('/s') && p.args.includes('/c'))
check('it would not split on the space again', !p.args.slice(0, 3).some((a) => a === 'C:\\Users\\Owner\\AppData\\Roaming\\MC'))

section('arguments containing spaces are quoted too')
const withSpace = plan(SPACED, ['build', '-PmodName=ICBM Classic'])
// The final arg is cmd.exe's whole command line, wrapped once more for /s, so
// unwrap it before inspecting: the quotes we care about are the inner ones.
const inner = withSpace.args[withSpace.args.length - 1].slice(1, -1)
check('a spaced argument keeps its space', inner.includes('ICBM Classic'))
check('and is quoted', inner.includes('"-PmodName=ICBM Classic"'))
check('the batch path is still quoted inside', inner.startsWith(`""${SPACED}"`) || inner.includes(`"${SPACED}"`))
const quoted = plan(SPACED, ['-Pmsg=say "hi"'])
check('quotes inside an argument are doubled', quoted.args[quoted.args.length - 1].includes('""hi""'))
check('an unspaced argument is left alone', plan(SPACED, ['--stacktrace']).args.at(-1).includes('--stacktrace"'))

section('other platforms and commands keep their simple form')
const bare = plan('gradle', ['build'], 'win32', true)
check('a bare command on PATH still uses the shell', bare.shell === true)
check('no cmd.exe wrapper is added for it', bare.cmd === 'gradle')
const posix = plan('/home/u/proj/gradlew', ['build'], 'linux', false)
check('a POSIX wrapper runs directly', posix.shell === false && posix.cmd.endsWith('gradlew'))
check('no cmd.exe on POSIX', !/cmd/i.test(posix.cmd))
const posixSpaced = plan('/home/u/MC Forge Agent/proj/gradlew', ['build'], 'linux', false)
check('a POSIX path with spaces needs no special handling', posixSpaced.args.length === 1 && posixSpaced.args[0] === 'build')

section('Java comes from the project, not the app')
// A 1.12.2 project must not be told it needs Java 21.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcb-'))
const write = (sub, props, build) => {
  const d = path.join(dir, sub)
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, 'gradle.properties'), props)
  if (build !== undefined) fs.writeFileSync(path.join(d, 'build.gradle'), build)
  return d
}

const old = write('old', 'minecraft_version=1.12.2\nloader=forge\n', '    sourceCompatibility = 1.8\n')
const oldPlan = gradle.planBuildJava(old)
check('a 1.12.2 project targets Java 8', oldPlan.targetJava === 8)
check('and its version is read', oldPlan.mcVersion === '1.12.2')

const neo = write('neo', 'minecraft_version=1.21.1\nloader=neoforge\n', '    sourceCompatibility = JavaVersion.VERSION_21\n')
check('a 1.21.1 project targets Java 21', gradle.planBuildJava(neo).targetJava === 21)

const java17 = write('j17', 'minecraft_version=1.20.1\nloader=forge\n', '    sourceCompatibility = JavaVersion.VERSION_17\n')
check('a 1.20.1 project targets Java 17', gradle.planBuildJava(java17).targetJava === 17)

const fabric16 = write('fab', 'minecraft_version=1.16.5\nloader=fabric\n', '    sourceCompatibility = JavaVersion.VERSION_1_8\n')
check('a 1.16.5 Fabric project targets Java 8', gradle.planBuildJava(fabric16).targetJava === 8)

section('a half-finished upgrade is detected rather than mis-built')
// This is the exact situation: the folder still says 1.12.2, but the agent has
// already rewritten the sources for 1.21.1. Building with Java 8 would fail on
// the first `record` or `var`; building with 21 and saying so is the useful
// answer.
const mid = write('mid', 'minecraft_version=1.12.2\nloader=forge\n', '    sourceCompatibility = JavaVersion.VERSION_21\n')
const midPlan = gradle.planBuildJava(mid)
check('the sources raise the required level to 21', midPlan.targetJava === 21)
check('the declared version is still reported', midPlan.mcVersion === '1.12.2')
check('the log explains the mismatch', /still says 1\.12\.2|finish the upgrade/i.test(midPlan.note ?? ''))
check('it does not silently claim it is a 1.12.2 build', midPlan.targetJava !== 8)

section('sources are read from either build file')
check('build.gradle.kts languageVersion is understood', (() => {
  const d = path.join(dir, 'kts')
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, 'gradle.properties'), 'minecraft_version=1.12.2\nloader=forge\n')
  fs.writeFileSync(path.join(d, 'build.gradle.kts'), 'java { languageVersion = JavaLanguageVersion.of(21) }\n')
  return gradle.planBuildJava(d).targetJava === 21
})())
check('a project with no declared version falls back to 17', (() => {
  const d = path.join(dir, 'empty')
  fs.mkdirSync(d, { recursive: true })
  const r = gradle.planBuildJava(d)
  return r.targetJava === 17 && /no minecraft_version/i.test(r.note ?? '')
})())
check('a project with no build file at all does not throw', (() => {
  const d = path.join(dir, 'bare')
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, 'gradle.properties'), 'minecraft_version=1.12.2\n')
  return typeof gradle.planBuildJava(d).targetJava === 'number'
})())

section('the CI workflow uses the same rule as a local build')
// Hard-coded JDK 21 in the workflow meant a 1.12.2 project could build locally
// and then fail in CI, or vice versa, depending on which path was tried.
const actions = await import('../out-test/main/build/actions.js')
check('a 1.12.2 workflow gets Java 8', actions.workflowJava(old).java === 8)
check('a 1.21.1 workflow gets Java 21', actions.workflowJava(neo).java === 21)
check('a 1.20.1 workflow gets Java 17', actions.workflowJava(java17).java === 17)
check('it matches what the local build demands', actions.workflowJava(old).java === oldPlan.targetJava)
// 'bare' still declares 1.12.2, so it correctly gets 8; a project with no
// gradle.properties at all is the actual unknown case.
const noProps = path.join(dir, 'noprops')
fs.mkdirSync(noProps, { recursive: true })
check('a project with no declared version falls back to 17', actions.workflowJava(noProps).java === 17)
check('a 1.12.2 project with no build.gradle still gets Java 8', actions.workflowJava(path.join(dir, 'bare')).java === 8)
check('the written workflow names the right JDK', (() => {
  actions.ensureWorkflow(old, 'icbm')
  const yml = fs.readFileSync(path.join(old, '.github', 'workflows', 'build.yml'), 'utf8')
  return yml.includes("java-version: '8'") && !yml.includes("java-version: '21'")
})())
check('and a 1.21.1 project writes 21', (() => {
  actions.ensureWorkflow(neo, 'neo')
  return fs.readFileSync(path.join(neo, '.github', 'workflows', 'build.yml'), 'utf8').includes("java-version: '21'")
})())

section('a failed Java lookup explains itself instead of guessing')
check('the plan always reports what it needs', typeof oldPlan.targetJava === 'number')
check('a missing JDK yields an actionable error', oldPlan.path !== null || /Java 8|adoptium/i.test(oldPlan.error ?? ''))
check('an unknown Java level is never NaN', !Number.isNaN(gradle.planBuildJava(old).targetJava))

fs.rmSync(dir, { recursive: true, force: true })
finish('build invocation')
