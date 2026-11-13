/**
 * Build pipeline + jar inspection tests. These run offline against fixture data,
 * so they verify the parsing logic (javac error extraction, jar metadata, mods
 * folder replacement) without needing a JDK.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { check, section, finish } from './helpers.mjs'

// Any uncaught error is reported so CI annotations carry the cause.
process.on('uncaughtException', (err) => {
  const msg = `${err && err.stack ? err.stack : err}`.replace(/%/g, '%25').replace(/\r?\n/g, ' | ').slice(0, 600)
  console.log(`::error title=build.test.mjs crash::${msg}`)
  process.exit(1)
})
const { extractErrors, findBuiltJar, gradlewPath } = await import('../out-test/main/build/gradle.js')
const { javaHomeFor, sanitisedEnv, isBrokenJavaHome } = await import('../out-test/main/util/exec.js')
const { readJarInfo, installJar } = await import('../out-test/main/mod/jar.js')

async function main() {


section('javac error extraction')
const log = `
> Task :compileJava
/home/me/mod/src/main/java/com/x/RubyItem.java:21: error: cannot find symbol
        ItemStack stack = new ItemStack(RUBY);
        ^
  symbol:   variable RUBY
  location: class RubyItem
/workspace/src/main/java/com/x/Y.java:3: error: package net.minecraft.world.old does not exist
2 errors
> Task :compileJava FAILED
Execution failed for task ':compileJava'.
`
const errors = extractErrors(log)
check('captures both javac errors', errors.filter((l) => /error:/.test(l)).length === 2, JSON.stringify(errors))
check('captures symbol context', errors.some((l) => /symbol:\s+variable RUBY/.test(l)), JSON.stringify(errors))
check('captures failed task', errors.some((l) => /compileJava FAILED/.test(l)))

section('built jar discovery')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcfa-build-'))
const libs = path.join(tmp, 'build', 'libs')
fs.mkdirSync(libs, { recursive: true })
fs.writeFileSync(path.join(libs, 'rubytools-1.0.0-sources.jar'), 'x')
fs.writeFileSync(path.join(libs, 'rubytools-1.0.0-javadoc.jar'), 'x')
fs.writeFileSync(path.join(libs, 'rubytools-1.0.0.jar'), 'x')
check('ignores sources/javadoc jars', findBuiltJar(tmp)?.endsWith('rubytools-1.0.0.jar'), findBuiltJar(tmp))

section('gradlew resolution')
const gw = gradlewPath(tmp, true)
check('falls back to gradle when no wrapper', gw.cmd === 'gradle')
// Windows resolves gradlew.bat, everything else resolves the shell script.
const wrapperName = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'
fs.writeFileSync(path.join(tmp, wrapperName), process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n')
const wrapperCmd = gradlewPath(tmp, true).cmd
check('uses wrapper when present', wrapperCmd.endsWith(wrapperName), `${wrapperCmd} (expected ${wrapperName})`)
check('preferWrapper=false skips wrapper', gradlewPath(tmp, false).cmd === 'gradle')

const AdmZip = (await import('adm-zip')).default
const jarPath = path.join(tmp, 'rubytools-1.0.0.jar')
const zip = new AdmZip()
zip.addFile(
  'META-INF/neoforge.mods.toml',
  Buffer.from(`modLoader="javafml"
loaderVersion="[1,)"
license="MIT"
[[mods]]
modId="rubytools"
version="1.0.0"
displayName="Ruby Tools"
[[dependencies.rubytools]]
modId="minecraft"
type="required"
versionRange="[1.21.1]"
`)
)
zip.writeZip(jarPath)

const info = readJarInfo(jarPath)
check('reads mod id', info.modId === 'rubytools', JSON.stringify(info))
check('reads version', info.version === '1.0.0')
check('reads display name', info.displayName === 'Ruby Tools')
check('detects loader', info.loader === 'neoforge')
check('reads mc version range', info.mcVersion === '[1.21.1]', info.mcVersion)

const instance = path.join(tmp, 'instance')
fs.mkdirSync(path.join(instance, 'mods'), { recursive: true })
// old build of same mod + an unrelated mod must survive
const oldJar = path.join(instance, 'mods', 'rubytools-0.9.0.jar')
const oldZip = new AdmZip()
oldZip.addFile('META-INF/neoforge.mods.toml', Buffer.from('[[mods]]\nmodId="rubytools"\nversion="0.9.0"\n'))
oldZip.writeZip(oldJar)
fs.writeFileSync(path.join(instance, 'mods', 'jei-1.21.1.jar'), 'not really a zip')
const res = installJar(jarPath, instance)
check('installs new jar', fs.existsSync(res.installed))
check('removes previous build of same mod', !fs.existsSync(oldJar))
check('leaves other mods alone', fs.existsSync(path.join(instance, 'mods', 'jei-1.21.1.jar')))

fs.rmSync(tmp, { recursive: true, force: true })
finish('build')
}

main().catch((err) => {
  const msg = `${err && err.stack ? err.stack : err}`.replace(/%/g, '%25').replace(/\r?\n/g, ' | ').slice(0, 1200)
  console.log(`::error title=build.test.mjs crash::${msg}`)
  process.exit(1)
})

/* ------------------------------------------------------------------ JAVA_HOME */
/*
 * One real log:
 *
 *   [build] cwd=C:\Users\Owner\Desktop\thaum 1.21.1\thaumcraft_v4_2_3_5-1.21.1-neoforge
 *   [build] project=1.21.1 → needs Java 21
 *   [build] java=java
 *   ERROR: JAVA_HOME is set to an invalid directory: .
 *
 * The planner had found a working Java by running the bare name `java` from
 * PATH. The spawn code then wrote `dirname(dirname('java'))` into JAVA_HOME,
 * which is `'.'`, and Gradle refused to start. The probe had the answer and the
 * derivation threw it away. These checks exist so that cannot happen again
 * without a failure: a `'.'` must never leave this app, and a bare name must
 * either resolve to a real home or leave JAVA_HOME alone.
 */
section('JAVA_HOME is derived from a real java, never from a bare name')

check('a bare java name never yields "." as its home', (() => {
  const home = javaHomeFor('java', 'win32')
  return home !== '.' && home !== ''
})())

check('a .exe path gives the directory two levels up', (() => {
  const home = javaHomeFor('C:\\Program Files\\Eclipse Adoptium\\jdk-21\\bin\\java.exe', 'win32')
  return home === 'C:\\Program Files\\Eclipse Adoptium\\jdk-21'
})())

check('a POSIX java path gives the same', (() => {
  return javaHomeFor('/usr/lib/jvm/temurin-21/bin/java', 'linux') === '/usr/lib/jvm/temurin-21'
})())

check('a path that is not <home>/bin/java is refused rather than guessed', (() => {
  // Some launchers ship java under a differently-shaped folder; a made-up parent
  // would be a JAVA_HOME pointing at nothing, which is the bug again.
  return javaHomeFor('C:\\tools\\jre\\java.exe', 'win32') === null
})())

check('a relative java path is refused', javaHomeFor('.\\jre\\bin\\java.exe', 'win32') === null)

check('a Java 8 layout with a space in the path still resolves', (() => {
  const home = javaHomeFor('C:\\Program Files\\Java\\jre1.8.0_411\\bin\\java.exe', 'win32')
  return home === 'C:\\Program Files\\Java\\jre1.8.0_411'
})())

section('a broken JAVA_HOME is removed from the environment, not passed on')

check('JAVA_HOME=. is dropped', (() => {
  const env = sanitisedEnv({ JAVA_HOME: '.' })
  return !('JAVA_HOME' in env)
})())

check('an empty JAVA_HOME is dropped', (() => {
  const env = sanitisedEnv({ JAVA_HOME: '' })
  return !('JAVA_HOME' in env)
})())

check('a JAVA_HOME that does not exist is dropped', (() => {
  const env = sanitisedEnv({ JAVA_HOME: path.join(os.tmpdir(), 'no-such-jdk-' + Date.now()) })
  return !('JAVA_HOME' in env)
})())

check('a JAVA_HOME that is a file, not a folder, is dropped', (() => {
  const f = path.join(os.tmpdir(), `jh-file-${Date.now()}.txt`)
  fs.writeFileSync(f, 'x')
  const env = sanitisedEnv({ JAVA_HOME: f })
  fs.rmSync(f, { force: true })
  return !('JAVA_HOME' in env)
})())

check('a working JAVA_HOME is left exactly as it was', (() => {
  const env = sanitisedEnv({ JAVA_HOME: os.tmpdir() })
  return env.JAVA_HOME === os.tmpdir()
})())

check('the related JDK variables get the same treatment', (() => {
  const env = sanitisedEnv({ JDK_HOME: '.', JDK21_HOME: '.' })
  return !('JDK_HOME' in env) && !('JDK21_HOME' in env)
})())

check('the rest of the environment is untouched', (() => {
  const env = sanitisedEnv({ MCF_TEST_MARKER: 'kept' })
  return env.MCF_TEST_MARKER === 'kept'
})())

section('Settings can name a broken JAVA_HOME before a build fails')
const withJavaHome = (value, fn) => {
  const saved = process.env.JAVA_HOME
  if (value === undefined) delete process.env.JAVA_HOME
  else process.env.JAVA_HOME = value
  try {
    return fn()
  } finally {
    if (saved === undefined) delete process.env.JAVA_HOME
    else process.env.JAVA_HOME = saved
  }
}

check('isBrokenJavaHome sees a bare dot', withJavaHome('.', () => isBrokenJavaHome() === true))
check('isBrokenJavaHome accepts a real folder', withJavaHome(os.tmpdir(), () => isBrokenJavaHome() === false))
check('isBrokenJavaHome is quiet when the variable is absent', withJavaHome(undefined, () => isBrokenJavaHome() === false))

finish('JAVA_HOME handling')
