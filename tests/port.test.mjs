import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const port = await import('../out-test/main/mod/port.js')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcb-port-'))
let seq = 0

function write(base, files) {
  for (const [rel, body] of Object.entries(files)) {
    const f = path.join(base, rel)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, body)
  }
  return base
}

/** A fixture project in its own folder. */
function fixture(label, files) {
  const dir = path.join(root, `${label}-${seq++}`)
  fs.mkdirSync(dir, { recursive: true })
  return write(dir, files)
}

function check(name, fn) {
  try {
    fn()
    console.log(`  ok   ${name}`)
  } catch (e) {
    console.log(`  FAIL ${name}`)
    console.log(`       ${e.message}`)
    process.exitCode = 1
  }
}

const FORGE_112 = {
  'gradle.properties': [
    'mod_id=icbm',
    'mod_name=ICBM Classic',
    'mod_group_id=com.builtbroken.icbm',
    'mod_version=6.4.1',
    'minecraft_version=1.12.2',
    ''
  ].join('\n'),
  'build.gradle': 'buildscript { dependencies { classpath "net.minecraftforge:forgegradle:2.3" } }\n',
  'src/main/resources/mcmod.info': '[{"modid":"icbm"}]\n',
  'src/main/java/com/builtbroken/icbm/ICBM.java': 'package com.builtbroken.icbm;\npublic class ICBM {}\n',
  'src/main/java/com/builtbroken/icbm/content/Missile.java': 'package com.builtbroken.icbm.content;\npublic class Missile {}\n'
}

const FORGE_1201 = {
  'gradle.properties': 'mod_id=thing\nmod_name=Thing\nminecraft_version=1.20.1\nmod_version=1.2.0\n',
  'build.gradle': 'id "net.minecraftforge.gradle" version "6.0"\n',
  'src/main/resources/META-INF/mods.toml': 'modLoader="javafml"\n',
  'src/main/java/a/Thing.java': 'package a;\npublic class Thing {}\n'
}

const FABRIC_118 = {
  'gradle.properties': 'mod_version=0.1.0\nminecraft_version=1.18.2\n',
  'build.gradle': 'id "fabric-loom" version "1.0"\n',
  'src/main/resources/fabric.mod.json': '{"id":"cloth","version":"0.1.0"}\n',
  'src/main/java/b/Cloth.java': 'package b;\npublic class Cloth {}\n'
}

console.log('detecting a project from its files')

check('1.12.2 Forge is read as forge-gradle 1.12.2', () => {
  const p = port.detectProject(fixture('d1', FORGE_112))
  assert.equal(p.mcVersion, '1.12.2')
  assert.equal(p.loader, 'forge')
  assert.equal(p.layout, 'forge-gradle')
})

check('the mod id and group come from gradle.properties', () => {
  const p = port.detectProject(fixture('d2', FORGE_112))
  assert.equal(p.modId, 'icbm')
  assert.equal(p.group, 'com.builtbroken.icbm')
  assert.equal(p.version, '6.4.1')
})

check('the java source root is found, not assumed', () => {
  const p = port.detectProject(fixture('d3', FORGE_112))
  assert.equal(p.sourceRoot, 'src/main/java')
})

check('a kotlin-only tree is found under src/main/kotlin', () => {
  const p = port.detectProject(
    fixture('d4', {
      'gradle.properties': 'minecraft_version=1.20.1\n',
      'build.gradle': 'id "net.minecraftforge.gradle" version "6.0"\n',
      'src/main/kotlin/a/Thing.kt': 'class Thing\n'
    })
  )
  assert.equal(p.sourceRoot, 'src/main/kotlin')
})

check('mcmod.info is reported as legacy metadata', () => {
  const p = port.detectProject(fixture('d5', FORGE_112))
  assert.ok(p.legacyFiles.some((f) => f.endsWith('mcmod.info')))
})

check('1.20.1 Forge is not mistaken for 1.12.2', () => {
  const p = port.detectProject(fixture('d6', FORGE_1201))
  assert.equal(p.mcVersion, '1.20.1')
  assert.equal(p.loader, 'forge')
})

check('Fabric is recognised, and its mod id comes from the json', () => {
  const p = port.detectProject(fixture('d7', FABRIC_118))
  assert.equal(p.loader, 'fabric')
  assert.equal(p.mcVersion, '1.18.2')
  assert.equal(p.modId, 'cloth')
})

check('the folder name is ignored — a badly named folder still reads right', () => {
  const dir = fixture('my-mod-1.12.2', FORGE_1201)
  const p = port.detectProject(dir)
  assert.equal(p.mcVersion, '1.20.1')
})

check('an empty folder is unknown, not a guess', () => {
  const p = port.detectProject(fixture('d8', { 'README.md': 'hi\n' }))
  assert.equal(p.layout, 'unknown')
  assert.equal(p.mcVersion, null)
  assert.equal(p.loader, 'unknown')
})

console.log('\nplanning the move')

check('Forge 1.12.2 → NeoForge 1.21.1 is a major jump needing Java 21', () => {
  const plan = port.planPort(fixture('p1', FORGE_112), { loader: 'neoforge', mcVersion: '1.21.1' })
  assert.equal(plan.java, 21)
  assert.equal(plan.majorJump, true)
  assert.equal(plan.blockers.length, 0)
})

check('the plan names the era cliffs that actually apply', () => {
  const plan = port.planPort(fixture('p2', FORGE_112), { loader: 'neoforge', mcVersion: '1.21.1' })
  const titles = plan.manual.map((m) => m.title).join(' | ')
  assert.match(titles, /Registry and registration/)
  assert.match(titles, /Recipes are JSON/)
  assert.match(titles, /Item components replace NBT/)
  assert.match(titles, /Package rename/)
})

check('a small step inside one era does not invent cliffs', () => {
  const plan = port.planPort(fixture('p3', FORGE_1201), { loader: 'forge', mcVersion: '1.21.1' })
  const titles = plan.manual.map((m) => m.title).join(' | ')
  assert.doesNotMatch(titles, /Registry and registration/)
  assert.doesNotMatch(titles, /Recipes are JSON/)
  assert.match(titles, /Replace the build script/)
})

check('the build step is stated once, not once per reason', () => {
  const plan = port.planPort(fixture('p4', FORGE_112), { loader: 'neoforge', mcVersion: '1.21.1' })
  const build = plan.manual.filter((m) => m.kind === 'build' && /build script/i.test(m.title))
  assert.equal(build.length, 1)
})

check('Forge → Fabric is described as a rewrite, not a port', () => {
  const plan = port.planPort(fixture('p5', FORGE_1201), { loader: 'fabric', mcVersion: '1.21.1' })
  const titles = plan.manual.map((m) => m.title).join(' | ')
  assert.match(titles, /Rewriting, not porting/)
})

check('every automatic step says what it will do', () => {
  const plan = port.planPort(fixture('p6', FORGE_112), { loader: 'neoforge', mcVersion: '1.21.1' })
  assert.ok(plan.automatic.length >= 3)
  assert.ok(plan.automatic.some((a) => a.includes('icbm')))
  assert.ok(plan.automatic.some((a) => a.includes('src/main/java')))
})

check('a target with no known toolchain is blocked, with the reason', () => {
  const plan = port.port ? null : port.planPort(fixture('p7', FORGE_112), { loader: 'neoforge', mcVersion: '1.5.2' })
  assert.ok(plan.blockers.length > 0)
  assert.match(plan.blockers[0], /No build toolchain/)
})

check('an Architectury project is refused rather than silently losing a loader', () => {
  const dir = fixture('p8', {
    'gradle.properties': 'minecraft_version=1.20.1\n',
    'settings.gradle': "include 'common', 'fabric', 'forge'\n",
    'build.gradle': "id 'architectury-plugin' version '3.4'\n",
    'common/src/main/java/a/A.java': 'package a;\nclass A {}\n'
  })
  const plan = port.planPort(dir, { loader: 'neoforge', mcVersion: '1.21.1' })
  assert.ok(plan.blockers.some((b) => /Architectury/i.test(b)))
})

check('a project with no declared version is blocked, not guessed', () => {
  const plan = port.planPort(fixture('p9', { 'build.gradle': 'id "fabric-loom"\n' }), { loader: 'fabric', mcVersion: '1.21.1' })
  assert.ok(plan.blockers.some((b) => /version could not be read/i.test(b)))
})

check('the same target as the source is reported as already there', () => {
  const plan = port.planPort(fixture('p10', FORGE_1201), { loader: 'forge', mcVersion: '1.20.1' })
  assert.equal(plan.alreadyTarget, true)
  assert.equal(plan.manual.length, 0)
  assert.match(plan.summary, /already/i)
})

console.log('\nconverting')

const src = fixture('c1', FORGE_112)
const out = path.join(root, 'converted-1')
const res = port.convertProject({ sourceDir: src, targetDir: out, target: { loader: 'neoforge', mcVersion: '1.21.1' } })

check('the conversion succeeds', () => assert.equal(res.ok, true, res.error))

check('contextual sources are carried across', () => {
  assert.ok(fs.existsSync(path.join(out, 'src/main/java/com/builtbroken/icbm/ICBM.java')))
  assert.ok(fs.existsSync(path.join(out, 'src/main/java/com/builtbroken/icbm/content/Missile.java')))
  assert.equal(res.copiedSources, 2)
})

check('the new project declares the target version', () => {
  const props = fs.readFileSync(path.join(out, 'gradle.properties'), 'utf8')
  assert.match(props, /minecraft_version=1\.21\.1/)
  assert.match(props, /mod_id=icbm/)
})

check('the mod id survives, so worlds and configs keep working', () => {
  const props = fs.readFileSync(path.join(out, 'gradle.properties'), 'utf8')
  assert.match(props, /mod_id=icbm/)
})

check('legacy metadata is not copied into the new project', () => {
  assert.ok(!fs.existsSync(path.join(out, 'src/main/resources/mcmod.info')))
  assert.ok(res.skipped.some((f) => f.endsWith('mcmod.info')))
})

check('MIGRATION.md is written and lists the remaining work', () => {
  const text = fs.readFileSync(path.join(out, 'MIGRATION.md'), 'utf8')
  assert.match(text, /Porting to neoforge 1\.21\.1/)
  assert.match(text, /What you still have to do/)
  assert.match(text, /Item components replace NBT/)
})

check('the original project is untouched', () => {
  assert.ok(fs.existsSync(path.join(src, 'src/main/java/com/builtbroken/icbm/ICBM.java')))
  assert.ok(fs.existsSync(path.join(src, 'src/main/resources/mcmod.info')))
  assert.match(fs.readFileSync(path.join(src, 'gradle.properties'), 'utf8'), /minecraft_version=1\.12\.2/)
})

check('a backup of the original is made', () => {
  assert.ok(res.backupPath, 'no backup path returned')
  assert.ok(fs.existsSync(res.backupPath))
  assert.match(path.basename(res.backupPath), /^backup-/)
  assert.ok(fs.existsSync(path.join(res.backupPath, 'src/main/java/com/builtbroken/icbm/ICBM.java')))
})

check('the backup does not contain build output', () => {
  assert.ok(!fs.existsSync(path.join(res.backupPath, 'build')))
})

check('a marker file records where the project came from', () => {
  const marker = JSON.parse(fs.readFileSync(path.join(out, '.agent/port.json'), 'utf8'))
  assert.equal(marker.from.mcVersion, '1.12.2')
  assert.equal(marker.to.loader, 'neoforge')
})

check('converting into the source folder is refused', () => {
  const r = port.convertProject({ sourceDir: src, targetDir: src, target: { loader: 'neoforge', mcVersion: '1.21.1' } })
  assert.equal(r.ok, false)
  assert.match(r.error, /different folder/i)
})

check('converting into a folder inside the source is refused', () => {
  const r = port.convertProject({ sourceDir: src, targetDir: path.join(src, 'out'), target: { loader: 'neoforge', mcVersion: '1.21.1' } })
  assert.equal(r.ok, false)
  assert.match(r.error, /inside the old one/i)
})

check('a blocked plan converts nothing and reports why', () => {
  const arch = fixture('c2', {
    'gradle.properties': 'minecraft_version=1.20.1\n',
    'settings.gradle': "include 'common', 'fabric', 'forge'\n",
    'build.gradle': "id 'architectury-plugin'\n"
  })
  const r = port.convertProject({ sourceDir: arch, targetDir: path.join(root, 'arch-out'), target: { loader: 'forge', mcVersion: '1.21.1' } })
  assert.equal(r.ok, false)
  assert.match(r.error, /Architectury/i)
  assert.ok(!fs.existsSync(path.join(root, 'arch-out')))
})

check('build output and IDE files are not carried across', () => {
  const dirty = write(fixture('c3', FORGE_112), {
    'build/libs/old.jar': 'jar',
    '.idea/workspace.xml': '<x/>',
    'src/main/java/com/builtbroken/icbm/ICBM.java': 'package com.builtbroken.icbm;\npublic class ICBM {}\n'
  })
  const target = path.join(root, 'clean-out')
  const r = port.convertProject({ sourceDir: dirty, targetDir: target, target: { loader: 'neoforge', mcVersion: '1.21.1' }, backup: false })
  assert.equal(r.ok, true, r.error)
  assert.ok(!fs.existsSync(path.join(target, 'build/libs/old.jar')))
  assert.ok(!fs.existsSync(path.join(target, '.idea')))
})

check('assets and lang files come with the mod', () => {
  const withAssets = write(fixture('c4', FORGE_112), {
    'src/main/resources/assets/icbm/lang/en_us.json': '{"item.missile":"Missile"}\n',
    'src/main/resources/assets/icbm/textures/item/missile.png': 'png'
  })
  const target = path.join(root, 'assets-out')
  const r = port.convertProject({ sourceDir: withAssets, targetDir: target, target: { loader: 'neoforge', mcVersion: '1.21.1' }, backup: false })
  assert.equal(r.ok, true, r.error)
  assert.ok(fs.existsSync(path.join(target, 'src/main/resources/assets/icbm/lang/en_us.json')))
  assert.ok(fs.existsSync(path.join(target, 'src/main/resources/assets/icbm/textures/item/missile.png')))
})

check('a Fabric project can be moved to Forge', () => {
  const target = path.join(root, 'fabric-to-forge')
  const r = port.convertProject({ sourceDir: fixture('c5', FABRIC_118), targetDir: target, target: { loader: 'forge', mcVersion: '1.21.1' }, backup: false })
  assert.equal(r.ok, true, r.error)
  assert.ok(fs.existsSync(path.join(target, 'src/main/java/b/Cloth.java')))
  assert.ok(!fs.existsSync(path.join(target, 'src/main/resources/fabric.mod.json')))
})

console.log('\nthe report')

const plan = port.planPort(fixture('r1', FORGE_112), { loader: 'neoforge', mcVersion: '1.21.1' })
const report = port.migrationReport(plan, new Date('2026-05-01T00:00:00Z'))

check('it states both ends and the source root', () => {
  assert.match(report, /forge 1\.12\.2/)
  assert.match(report, /neoforge 1\.21\.1 \(Java 21\)/)
  assert.match(report, /src\/main\/java/)
})

check('it separates what was done from what is left', () => {
  assert.match(report, /## What was done for you/)
  assert.match(report, /## What you still have to do/)
  assert.ok(report.indexOf('What was done for you') < report.indexOf('What you still have to do'))
})

check('it tells the agent how to proceed', () => {
  assert.match(report, /work through MIGRATION\.md/i)
})

check('it is dated', () => assert.match(report, /2026-05-01/))

console.log('\nhelpers')

check('the toolchain is named per loader', () => {
  assert.equal(port.toolchainFor('neoforge'), 'ModDevGradle')
  assert.equal(port.toolchainFor('fabric'), 'Fabric Loom')
  assert.match(port.toolchainFor('forge'), /ForgeGradle/)
})

check('backing up does not recurse into an earlier backup', () => {
  const dir = fixture('b1', FORGE_112)
  const first = port.backupProject(dir, Date.UTC(2026, 0, 1))
  const second = port.backupProject(dir, Date.UTC(2026, 0, 2))
  assert.ok(first.ok && second.ok)
  const inside = fs.readdirSync(second.backup).filter((n) => n.startsWith('backup-'))
  assert.equal(inside.length, 0, 'nested backup found')
})

fs.rmSync(root, { recursive: true, force: true })

if (process.exitCode) {
  console.log('\nport checks failed')
} else {
  console.log('\nall port checks passed')
}
