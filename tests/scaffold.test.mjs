/**
 * Scaffold smoke test. Runs the real generator against the vendored MDK and
 * verifies the produced project is coherent (ids, package path, metadata, lang).
 * Run with: npm test
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { check, section, finish } from './helpers.mjs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

const { scaffoldProject, validateModId, validatePackage } = await import('../out-test/main/mod/scaffold.js')
const { generateProject } = await import('../out-test/main/mod/generate.js')
const eras = await import('../out-test/main/versions/eras.js')

section('validation')
check('rejects uppercase mod id', validateModId('RubyMod') !== null)
check('rejects reserved mod id', validateModId('minecraft') !== null)
check('accepts rubytools', validateModId('rubytools') === null)
check('rejects bad package', validatePackage('com.1bad') !== null)
check('accepts com.example.rubytools', validatePackage('com.example.rubytools') === null)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcfa-'))
const target = path.join(tmp, 'rubytools')

section('scaffold')
const res = scaffoldProject({
  targetDir: target,
  modId: 'rubytools',
  modName: 'Ruby Tools',
  group: 'com.shadowclan.rubytools',
  modVersion: '2.3.1',
  neoVersion: '21.1.265',
  author: 'ShadowClan',
  license: 'MIT'
})
check('scaffold succeeds', res.ok, res.ok ? '' : res.error)

const props = fs.readFileSync(path.join(target, 'gradle.properties'), 'utf8')
check('mod_id written', /^mod_id=rubytools$/m.test(props))
check('mod_name written', /^mod_name=Ruby Tools$/m.test(props))
check('group written', /^mod_group_id=com\.shadowclan\.rubytools$/m.test(props))
check('version written', /^mod_version=2\.3\.1$/m.test(props))
check('neo version written', /^neo_version=21\.1\.265$/m.test(props))
check('minecraft 1.21.1 kept', /^minecraft_version=1\.21\.1$/m.test(props))

const mainClass = path.join(target, 'src/main/java/com/shadowclan/rubytools/Rubytools.java')
check('main class at package path', fs.existsSync(mainClass))
const java = fs.readFileSync(mainClass, 'utf8')
check('package declared', java.includes('package com.shadowclan.rubytools;'))
check('MODID matches mod id', java.includes('public static final String MODID = "rubytools";'))
check('@Mod annotation present', java.includes('@Mod(Rubytools.MODID)'))
check('no template leftovers', !java.includes('examplemod'))
check('no stray ${}', !java.includes('${'), java.match(/\$\{[^}]*\}/)?.[0])

const configJava = path.join(target, 'src/main/java/com/shadowclan/rubytools/Config.java')
check('config class exists', fs.existsSync(configJava))
check('config has SPEC', fs.readFileSync(configJava, 'utf8').includes('public static final ModConfigSpec SPEC;'))

const lang = JSON.parse(fs.readFileSync(path.join(target, 'src/main/resources/assets/rubytools/lang/en_us.json'), 'utf8'))
check('lang has item key', !!lang['item.rubytools.example_item'])
check('lang has tab key', !!lang['itemGroup.rubytools'])

const toml = fs.readFileSync(path.join(target, 'src/main/templates/META-INF/neoforge.mods.toml'), 'utf8')
check('toml keeps mod id placeholder expansion', toml.includes('modId="${mod_id}"'))
check('toml author filled', toml.includes('authors="ShadowClan"'))
check('toml is not the example text', !toml.includes('Example mod description'))

check('gradle wrapper copied', fs.existsSync(path.join(target, 'gradlew')) && fs.existsSync(path.join(target, 'gradlew.bat')))
check('workflow copied', fs.existsSync(path.join(target, '.github/workflows/build.yml')))
check('no example java left', !fs.existsSync(path.join(target, 'src/main/java/com/example')))

section('overwrite protection')
const again = scaffoldProject({ targetDir: target, modId: 'rubytools', modName: 'X', group: 'com.x.y', modVersion: '1.0.0' })
check('refuses non-empty dir without overwrite', again.ok === false, JSON.stringify(again))

section('every era produces metadata the loader will actually find')
// The metadata file lives in a different place and format per era. Two mistakes
// here are invisible until a jar silently does nothing in game: a NeoForge
// template that never gets copied into the resources, and a pack_format from
// another version.
const matrix = [
  ['neoforge', '1.21.4', '21.4.100', 'src/main/templates/META-INF/neoforge.mods.toml'],
  ['neoforge', '1.20.2', '20.2.88', 'src/main/templates/META-INF/neoforge.mods.toml'],
  ['forge', '1.20.1', '47.3.0', 'src/main/resources/META-INF/mods.toml'],
  ['forge', '1.8.9', '11.15.1.2318', 'src/main/resources/mcmod.info'],
  ['forge', '1.7.10', '10.13.4.1614', 'src/main/resources/mcmod.info'],
  ['fabric', '1.21.1', '0.16.9', 'src/main/resources/fabric.mod.json']
]
for (const [loader, mc, lv, metadataPath] of matrix) {
  const dir = path.join(tmp, `gen-${loader}-${mc}`)
  const res = generateProject({
    targetDir: dir,
    modId: 'rubytools',
    modName: 'Ruby Tools',
    group: 'com.example.rubytools',
    modVersion: '1.0.0',
    loader,
    mcVersion: mc,
    loaderVersion: lv,
    templateRoot: path.join(repoRoot, 'template', 'neoforge-1.21.1')
  })
  check(`${loader} ${mc} generates`, res.ok === true, res.error ?? '')
  check(`${loader} ${mc} has ${path.basename(metadataPath)}`, fs.existsSync(path.join(dir, metadataPath)))
  const meta = fs.existsSync(path.join(dir, metadataPath)) ? fs.readFileSync(path.join(dir, metadataPath), 'utf8') : ''
  // NeoForge and modern Forge use a template expanded by Gradle at build time, so
  // the literal mod id is not in the file; what matters is that the metadata
  // exists and is wired to the property that carries it.
  check(
    `${loader} ${mc} metadata is bound to the mod id`,
    meta.includes('rubytools') || /\$\{mod_id\}|\$\{version\}/.test(meta),
    meta.slice(0, 80)
  )
  const props = fs.readFileSync(path.join(dir, 'gradle.properties'), 'utf8')
  check(`${loader} ${mc} records its loader`, new RegExp(`^mod_loader=${loader}$`, 'm').test(props))
  check(`${loader} ${mc} records its version`, new RegExp(`^minecraft_version=${mc.replace(/\./g, '\\.')}$`, 'm').test(props))
}

section('NeoForge copies its metadata template into the jar')
// ModDevGradle only reads src/main/resources, so the build must expand
// src/main/templates through a generated resource root.
const neoDir = path.join(tmp, 'gen-neoforge-1.21.4')
const neoBuild = fs.readFileSync(path.join(neoDir, 'build.gradle'), 'utf8')
check('a generateModMetadata task exists', /generateModMetadata/.test(neoBuild))
check('it reads src/main/templates', /from "src\/main\/templates"/.test(neoBuild))
check('its output is a resource root', /sourceSets\.main\.resources\.srcDir generateModMetadata/.test(neoBuild))

section('pack_format matches the game version')
for (const [mc, want] of [
  ['1.12.2', 3],
  ['1.16.5', 6],
  ['1.20.1', 15],
  ['1.20.2', 18],
  ['1.21.1', 34],
  ['1.21.4', 46]
]) {
  check(`${mc} pack_format is ${want}`, eras.packFormatFor(mc) === want, `got ${eras.packFormatFor(mc)}`)
}

fs.rmSync(tmp, { recursive: true, force: true })
finish('scaffold')
