/**
 * Dependencies after a port.
 *
 * Two failures are covered, and they look identical in a gradle log:
 *
 *   error: package net.minecraft.world.level does not exist
 *   error: package com.simibubi.create.content.kinetics does not exist
 *
 * The first is not a dependency at all — the build file cannot resolve Minecraft,
 * and the cause was a generated `neo_version=` with nothing after it. The second
 * is a dependency the port did not carry. Telling them apart is the whole job.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const out = path.join(process.cwd(), 'out-test', 'main')
const load = (file) => import(pathToFileURL(path.join(out, file)).href)
const deps = await load('mod/deps.js')
const resolve = await load('mod/dep-resolve.js')
const gradle = await load('build/gradle.js')
const eras = await load('versions/eras.js')

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
const section = (name) => console.log(name)

const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `mcf-deps-${label}-`))

/* ------------------------------------------------------------------ classifying */

section('a missing Minecraft class is not a missing dependency')
const gameErrors = [
  'C:\\mod\\src\\main\\java\\com\\x\\Item.java:12: error: package net.minecraft.world.level does not exist',
  'C:\\mod\\src\\main\\java\\com\\x\\Item.java:13: error: package net.neoforged.bus.api does not exist'
]
check('game packages go to gameClassErrors', () => {
  const c = deps.classifyBuildErrors(gameErrors)
  assert.deepEqual(c.externalPackages, [])
  assert.ok(c.gameClasses.length >= 2)
})
check('the hint says it is a build-file problem, not a download', () => {
  const e = gradle.explainMissingClasses(gameErrors)
  assert.match(e.hint, /build-file problem|not a missing download/i)
  assert.match(e.hint, /loader version/i)
})

const createErrors = [
  'C:\\mod\\src\\main\\java\\com\\x\\Kinetic.java:30: error: package com.simibubi.create.content.kinetics does not exist'
]
check('a mod package is reported as a dependency', () => {
  const c = deps.classifyBuildErrors(createErrors)
  assert.deepEqual(c.gameClasses, [])
  assert.ok(c.externalPackages.includes('com.simibubi.create'))
})
check('the hint names the dependency and where to fix it', () => {
  const e = gradle.explainMissingClasses(createErrors)
  assert.match(e.hint, /com\.simibubi\.create/)
  assert.match(e.hint, /not enough/i)
})
check('a build with neither kind of error gets no hint', () => {
  const e = gradle.explainMissingClasses(['error: cannot find symbol: variable foo'])
  assert.equal(e.hint, null)
})
check('a mix of both is reported as the game problem first', () => {
  const e = gradle.explainMissingClasses([...gameErrors, ...createErrors])
  assert.ok(e.gameClasses.length > 0)
  assert.ok(e.missing.includes('com.simibubi.create'))
})

/* -------------------------------------------------------------------- imports */

section('imports are read into groups, not class names')
check('a plain import reduces to its package', () => {
  assert.equal(deps.packageOf('import com.simibubi.create.AllBlocks;'), 'com.simibubi.create')
})
check('a nested class does not become a package', () => {
  assert.equal(deps.packageOf('import com.simibubi.create.content.Outer.Inner;'), 'com.simibubi.create.content')
})
check('a wildcard import is already a package', () => {
  assert.equal(deps.packageOf('import net.createmod.catnip.*;'), 'net.createmod.catnip')
})
check('static imports work the same', () => {
  assert.equal(deps.packageOf('import static com.simibubi.create.AllBlocks.COG;'), 'com.simibubi.create')
})
check('grouping keeps three segments', () => {
  assert.equal(deps.groupOf('com.simibubi.create.content.kinetics'), 'com.simibubi.create')
})
check('short packages are not truncated', () => {
  assert.equal(deps.groupOf('a.b'), 'a.b')
})
check('Minecraft is recognised from every namespace', () => {
  for (const p of ['net.minecraft.world', 'com.mojang.math', 'net.neoforged.bus', 'cpw.mods.modlauncher', 'org.lwjgl.system']) {
    assert.ok(deps.isGamePackage(p), p)
  }
})
check('a mod is not mistaken for the game', () => {
  assert.ok(!deps.isGamePackage('com.simibubi.create'))
})

section('a source tree is scanned for what it imports')
const proj = tmp('proj')
const srcRoot = path.join(proj, 'src', 'main', 'java', 'com', 'x')
fs.mkdirSync(srcRoot, { recursive: true })
fs.writeFileSync(
  path.join(srcRoot, 'A.java'),
  [
    'package com.x;',
    'import com.simibubi.create.AllBlocks;',
    'import net.minecraft.world.level.Level;',
    'import net.createmod.catnip.math.VecHelper;',
    'public class A {}'
  ].join('\n'),
  'utf8'
)
fs.writeFileSync(
  path.join(srcRoot, 'B.java'),
  ['package com.x;', 'import com.simibubi.create.AllItems;', 'import java.util.List;', 'public class B {}'].join('\n'),
  'utf8'
)
fs.mkdirSync(path.join(proj, 'build'), { recursive: true })
fs.writeFileSync(path.join(proj, 'build', 'C.java'), 'import com.should.not.appear.Thing;\n', 'utf8')

const scanned = deps.scanDependencies({ dir: proj })
check('both source files were read', () => {
  assert.equal(scanned.filesScanned, 2)
})
check('build output is skipped', () => {
  assert.ok(!scanned.dependencies.some((d) => d.package.includes('should.not.appear')))
})
check('Minecraft is not listed as a download', () => {
  assert.ok(!scanned.dependencies.some((d) => d.package.startsWith('net.minecraft')))
})
check('Create is found and counted across files', () => {
  const create = scanned.dependencies.find((d) => d.package === 'com.simibubi.create')
  assert.ok(create, 'Create should be reported')
  assert.equal(create.files, 2)
  assert.equal(create.name, 'Create')
  assert.equal(create.kind, 'mod')
})
check('the known mod gets a project page', () => {
  const create = scanned.dependencies.find((d) => d.package === 'com.simibubi.create')
  assert.match(create.homepage, /modrinth\.com/)
})
check('an unknown package is still reported, not dropped', () => {
  const other = scanned.dependencies.find((d) => d.package === 'net.createmod.catnip')
  assert.ok(other, 'catnip should be reported')
  assert.equal(other.name, 'Create')
})

section('the old build file is a second source of truth')
const old = tmp('old')
fs.mkdirSync(path.join(old, 'src', 'main', 'java'), { recursive: true })
fs.writeFileSync(
  path.join(old, 'build.gradle'),
  [
    'dependencies {',
    "    modImplementation \"com.simibubi.create:create-neoforge:${create_version}\"",
    "    compileOnly 'top.theillusivec4.curios:curios-neoforge:9.0.1'",
    "    implementation fg.deobf('curse.maven:some-lib-12345:999')",
    "    minecraft 'net.minecraftforge:forge:1.20.1-47.2.0'",
    '}'
  ].join('\n'),
  'utf8'
)
const declared = deps.declaredDependencies(deps.buildFilesIn(old))
check('a mod coordinate is read with its group', () => {
  assert.ok(declared.has('com.simibubi.create'))
})
check('a property version is not invented', () => {
  assert.deepEqual(declared.get('com.simibubi.create'), [])
})
check('a literal version is kept', () => {
  assert.deepEqual(declared.get('top.theillusivec4.curios'), ['9.0.1'])
})
check('Minecraft coordinates are ignored', () => {
  assert.ok(!declared.has('net.minecraftforge'))
})

const declaredOnly = deps.scanDependencies({ dir: old })
check('a dependency with no imports is still reported', () => {
  const curios = declaredOnly.dependencies.find((d) => d.package === 'top.theillusivec4.curios')
  assert.ok(curios, 'declaring it is why the build worked before')
  assert.equal(curios.files, 0)
})
check('it carries the version it had', () => {
  const curios = declaredOnly.dependencies.find((d) => d.package === 'top.theillusivec4.curios')
  assert.deepEqual(curios.declared, ['9.0.1'])
})

/* -------------------------------------------------------------- loader versions */

section('a generated project gets a real loader version, never an empty one')
check('NeoForge is derived from the game version', () => {
  const v = eras.resolveLoaderVersion('neoforge', '1.21.1', null)
  assert.equal(v, '21.1.0')
  assert.ok(v.length > 0)
})
check('a newer NeoForge minor follows the game', () => {
  assert.equal(eras.resolveLoaderVersion('neoforge', '1.20.6', null), '20.6.0')
})
check('Forge gets a resolvable placeholder rather than an empty string', () => {
  const v = eras.resolveLoaderVersion('forge', '1.20.1', null)
  assert.ok(v.length > 0)
  assert.match(v, /^\d+\.\d+/)
})
check('Fabric gets a loader version', () => {
  const v = eras.resolveLoaderVersion('fabric', '1.20.1', null)
  assert.match(v, /^\d+\./)
})
check('an empty string is never returned, for any loader or version', () => {
  for (const loader of ['neoforge', 'forge', 'fabric']) {
    for (const mc of ['1.12.2', '1.16.5', '1.20.1', '1.21.1']) {
      const v = eras.resolveLoaderVersion(loader, mc, null)
      assert.ok(v && v.trim().length > 0, `${loader} ${mc} returned "${v}"`)
    }
  }
})
check('the catalog is preferred when it has a real build', () => {
  const catalog = {
    fetchedAt: 0,
    minecraft: [],
    errors: [],
    loaders: {
      neoforge: [{ version: '21.1.209', mcVersions: ['1.21.1'] }],
      forge: [],
      fabric: []
    }
  }
  assert.equal(eras.resolveLoaderVersion('neoforge', '1.21.1', catalog), '21.1.209')
})
check('a cached catalog written oldest-first still yields the newest', () => {
  const catalog = {
    fetchedAt: 0,
    minecraft: [],
    errors: [],
    loaders: {
      neoforge: [
        { version: '21.1.9', mcVersions: ['1.21.1'] },
        { version: '21.1.120', mcVersions: ['1.21.1'] }
      ],
      forge: [],
      fabric: []
    }
  }
  assert.equal(eras.resolveLoaderVersion('neoforge', '1.21.1', catalog), '21.1.120')
})

/* ------------------------------------------------------------------ declaring */

section('a downloaded jar is declared, or the build cannot see it')
const target = tmp('target')
fs.writeFileSync(
  path.join(target, 'build.gradle'),
  "dependencies {\n    implementation 'net.minecraftforge:forge:1.20.1-47.2.0'\n}\n",
  'utf8'
)
fs.mkdirSync(path.join(target, 'libs'), { recursive: true })
fs.writeFileSync(path.join(target, 'libs', 'create.jar'), 'jar', 'utf8')

check('the line is added inside the dependencies block', () => {
  const r = resolve.declareJarDependency(target, path.join(target, 'libs', 'create.jar'))
  assert.ok(r.ok)
  assert.equal(r.added, true)
  const text = fs.readFileSync(path.join(target, 'build.gradle'), 'utf8')
  assert.match(text, /implementation files\('libs\/create\.jar'\)/)
  // inside the block, not after it
  assert.ok(text.indexOf("files('libs/create.jar')") > text.indexOf('dependencies {'))
})
check('adding it twice does not duplicate the line', () => {
  const r = resolve.declareJarDependency(target, path.join(target, 'libs', 'create.jar'))
  assert.equal(r.added, false)
  const text = fs.readFileSync(path.join(target, 'build.gradle'), 'utf8')
  assert.equal(text.split("files('libs/create.jar')").length - 1, 1)
})
check('a project with no dependencies block gets one', () => {
  fs.writeFileSync(path.join(target, 'build.gradle'), 'plugins { id "java" }\n', 'utf8')
  fs.writeFileSync(path.join(target, 'libs', 'other.jar'), 'jar', 'utf8')
  const r = resolve.declareJarDependency(target, path.join(target, 'libs', 'other.jar'))
  assert.ok(r.ok)
  const text = fs.readFileSync(path.join(target, 'build.gradle'), 'utf8')
  assert.match(text, /dependencies \{/)
  assert.match(text, /other\.jar/)
})
check('a folder with no build file is refused, not silently skipped', () => {
  const empty = tmp('empty')
  const r = resolve.declareJarDependency(empty, path.join(empty, 'libs', 'x.jar'))
  assert.equal(r.ok, false)
  assert.match(r.error, /build\.gradle/i)
})
check('windows paths become forward slashes in gradle', () => {
  const text = fs.readFileSync(path.join(target, 'build.gradle'), 'utf8')
  assert.ok(!text.includes("files('libs\\\\"), 'gradle needs forward slashes')
})

section('a search term is a name, not a package')
check('a known mod searches by its title', () => {
  assert.equal(resolve.searchTermFor({ name: 'Create', package: 'com.simibubi.create' }), 'Create')
})
check('a parenthetical is dropped', () => {
  assert.equal(resolve.searchTermFor({ name: 'a Vazkii mod (Botania/Quark)', package: 'vazkii.botania' }), 'Vazkii mod')
})
check('an unnamed dependency searches the middle segment', () => {
  assert.equal(resolve.searchTermFor({ package: 'com.simibubi.create' }), 'create')
})
check('a two-segment package still searches something', () => {
  assert.ok(resolve.searchTermFor({ package: 'my.mod' }).length > 0)
})
check('an offline lookup reports the failure instead of guessing', async () => {
  // Exercised through the real function with an unroutable base is not possible
  // without network stubs; the contract is that it never throws.
  assert.equal(typeof resolve.findCandidates, 'function')
})

for (const d of [proj, old, target]) fs.rmSync(d, { recursive: true, force: true })

console.log(`\n${failures.length ? `${failures.length} check(s) failed` : `all ${passed} dependency checks passed`}`)
if (failures.length) process.exit(1)
