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

fs.rmSync(tmp, { recursive: true, force: true })
finish('scaffold')
