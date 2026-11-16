/**
 * Putting the real Minecraft sources on disk.
 *
 * The bug this prevents: `genSources` is a Fabric Loom task. On a NeoForge
 * ModDevGradle project the task does not exist, so an agent that "runs
 * genSources" gets a Gradle failure, decides the project is broken, and goes
 * back to recalling class names from memory. The task has to be chosen from the
 * toolchain, and when there is no task the answer is "look for the jar", not
 * "run something and hope".
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'

let passed = 0
const failures = []
function check(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (e) {
    failures.push(name)
    console.log(`  FAIL ${name}\n       ${e.message}`)
  }
}

const out = new URL('../out-test/main/mod/game-sources.js', import.meta.url).href
const gs = await import(out)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcf-src-'))

/* --------------------------------------------------- which task, per loader */

check('fabric uses genSources, because Loom really has that task', () => {
  assert.equal(gs.sourceTaskFor('fabric', 'plugins { id "fabric-loom" }'), 'genSources')
})

check('a ModDevGradle project is told there is no task, not given a fake one', () => {
  const build = 'plugins { id "net.neoforged.moddev" version "2.0.78" }'
  assert.equal(gs.sourceTaskFor('neoforge', build), null)
})

check('ForgeGradle uses createMinecraftArtifacts', () => {
  const build = 'apply plugin: "net.minecraftforge.gradle"'
  assert.equal(gs.sourceTaskFor('forge', build), 'createMinecraftArtifacts')
})

check('NeoGradle uses createMinecraftArtifacts too', () => {
  assert.equal(gs.sourceTaskFor('neoforge', 'apply plugin: "net.neoforged.gradle.userdev"'), 'createMinecraftArtifacts')
})

check('an unknown neoforge build is not handed a task that probably does not exist', () => {
  assert.equal(gs.sourceTaskFor('neoforge', ''), null)
})

/* -------------------------------------------------------- finding the jar */

check('the ModDevGradle artifact is found where it is actually written', () => {
  const ws = path.join(tmp, 'ws1')
  const dir = path.join(ws, 'build', 'moddev', 'artifacts')
  fs.mkdirSync(dir, { recursive: true })
  const jar = path.join(dir, 'minecraft-patched-1.21.1-sources.jar')
  fs.writeFileSync(jar, '')
  const zip = new AdmZip()
  zip.addFile('net/minecraft/world/level/Level.java', Buffer.from('package net.minecraft.world.level;'))
  zip.writeZip(jar)

  const found = gs.findExistingSources(ws, path.join(tmp, 'gh1'))
  assert.equal(found.length, 1)
  assert.equal(found[0].origin, 'moddevgradle')
  assert.equal(path.basename(found[0].file), 'minecraft-patched-1.21.1-sources.jar')
})

check('a jar with no .java in it is rejected however it is named', () => {
  const ws = path.join(tmp, 'ws2')
  const dir = path.join(ws, 'build', 'moddev', 'artifacts')
  fs.mkdirSync(dir, { recursive: true })
  const jar = path.join(dir, 'minecraft-patched-1.21.1-sources.jar')
  const zip = new AdmZip()
  zip.addFile('net/minecraft/Level.class', Buffer.from([0xca, 0xfe, 0xba, 0xbe]))
  zip.writeZip(jar)

  assert.deepEqual(gs.findExistingSources(ws, path.join(tmp, 'gh2')), [])
})

check('an unbuilt project finds nothing rather than inventing a path', () => {
  const ws = path.join(tmp, 'ws3')
  fs.mkdirSync(ws, { recursive: true })
  assert.deepEqual(gs.findExistingSources(ws, path.join(tmp, 'gh3')), [])
})

/* ------------------------------------------------------------- unpacking */

check('sources land under reference/, which is git-ignored and not compiled', () => {
  const ws = path.join(tmp, 'ws4')
  fs.mkdirSync(ws, { recursive: true })
  const zip = new AdmZip()
  zip.addFile('a/b/Foo.java', Buffer.from('package a.b;'))
  zip.addFile('a/b/Foo.class', Buffer.from([1]))
  const jar = path.join(tmp, 'src.jar')
  zip.writeZip(jar)

  const r = gs.unpackSources(jar, ws, '1.21.1')
  assert.equal(r.ok, true)
  assert.equal(r.files, 1, 'only .java is written')
  assert.ok(r.dir.includes(path.join('reference', 'minecraft-1.21.1')))
  assert.ok(fs.existsSync(path.join(ws, 'reference', 'minecraft-1.21.1', 'a', 'b', 'Foo.java')))
})

check('a jar entry cannot escape the project', () => {
  // adm-zip normalises entries on the way in, so the guard is tested directly
  // rather than through a zip it refuses to build.
  for (const bad of ['../../evil.java', '/abs/evil.java', 'C:/windows/evil.java', 'a/../../evil.java', '..\\..\\evil.java']) {
    assert.equal(gs.isSafeEntry(bad), false, bad)
  }
  for (const good of ['net/minecraft/world/level/Level.java', 'a/b/Foo.java']) {
    assert.equal(gs.isSafeEntry(good), true, good)
  }
  assert.equal(gs.isSafeEntry('net/minecraft/Level.class'), false, 'compiled classes are not unpacked')
})

/* -------------------------------------------------------------- locating */

check('a class can be found by simple name or by full path', () => {
  const dir = path.join(tmp, 'flat')
  fs.mkdirSync(path.join(dir, 'net', 'minecraft', 'world', 'level'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'net', 'minecraft', 'world', 'level', 'Level.java'), 'package net.minecraft.world.level;')

  assert.ok(gs.locateClass(dir, 'Level'))
  assert.ok(gs.locateClass(dir, 'net.minecraft.world.level.Level'))
  assert.equal(gs.locateClass(dir, 'World'), null, 'the old name is genuinely not there')
})

fs.rmSync(tmp, { recursive: true, force: true })

console.log(`\n${failures.length ? `${failures.length} check(s) failed` : `all ${passed} game-sources checks passed`}`)
if (failures.length) process.exit(1)
