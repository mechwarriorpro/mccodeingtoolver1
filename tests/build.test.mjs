/**
 * Build pipeline + jar inspection tests. These run offline against fixture data,
 * so they verify the parsing logic (javac error extraction, jar metadata, mods
 * folder replacement) without needing a JDK.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let failures = 0
function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`)
  }
}

const { extractErrors, findBuiltJar, gradlewPath } = await import('../out-test/main/build/gradle.js')
const { readJarInfo, installJar } = await import('../out-test/main/mod/jar.js')

console.log('javac error extraction')
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

console.log('built jar discovery')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcfa-build-'))
const libs = path.join(tmp, 'build', 'libs')
fs.mkdirSync(libs, { recursive: true })
fs.writeFileSync(path.join(libs, 'rubytools-1.0.0-sources.jar'), 'x')
fs.writeFileSync(path.join(libs, 'rubytools-1.0.0-javadoc.jar'), 'x')
fs.writeFileSync(path.join(libs, 'rubytools-1.0.0.jar'), 'x')
check('ignores sources/javadoc jars', findBuiltJar(tmp)?.endsWith('rubytools-1.0.0.jar'), findBuiltJar(tmp))

console.log('gradlew resolution')
const gw = gradlewPath(tmp, true)
check('falls back to gradle when no wrapper', gw.cmd === 'gradle')
fs.writeFileSync(path.join(tmp, 'gradlew'), '#!/bin/sh\n')
// The Windows wrapper is gradlew.bat, so accept both spellings.
const wrapperCmd = gradlewPath(tmp, true).cmd
check('uses wrapper when present', /gradlew(\.bat)?$/.test(wrapperCmd), wrapperCmd)
check('preferWrapper=false skips wrapper', gradlewPath(tmp, false).cmd === 'gradle')

console.log('jar metadata + install')
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
console.log(failures ? `\n${failures} check(s) failed` : '\nall build checks passed')
process.exit(failures ? 1 : 0)
