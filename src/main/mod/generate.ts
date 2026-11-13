/**
 * Project generation for any loader + Minecraft version.
 *
 * Two paths:
 *
 *  1. NeoForge 1.21.1 has a vendored, real ModDevGradle MDK, so it is copied and
 *     rewritten. That keeps the highest-fidelity output for the version the app is
 *     most used with, including the gradle wrapper jar.
 *
 *  2. Everything else is generated from the era tables in versions/eras.ts. The
 *     wrapper jar cannot be generated, so it is copied from the vendored template;
 *     the properties file points at the era's gradle version.
 *
 * Reference sources are not written here; they live in <project>/reference/.
 */
import fs from 'node:fs'
import path from 'node:path'
import { eraFiles, resolveEra, wrapperProperties, type ProjectConfig, type Era } from '../versions/eras'
import type { Loader } from '../versions/catalog'

export interface GenerateOptions {
  targetDir: string
  modId: string
  modName: string
  group: string
  modVersion: string
  author?: string
  license?: string
  loader: Loader
  mcVersion: string
  loaderVersion: string
  /** Path to the vendored template that supplies the gradle wrapper. */
  templateRoot: string
  overwrite?: boolean
}

export interface GenerateResult {
  ok: boolean
  dir?: string
  error?: string
  era?: { id: string; label: string; buildable: boolean; notes: string[] }
  /** True when the vendored MDK was used instead of generated files. */
  usedVendoredTemplate?: boolean
}

/** NeoForge 1.21.1 is the vendored MDK; everything else is generated. */
export function hasVendoredTemplate(loader: Loader, mcVersion: string): boolean {
  return loader === 'neoforge' && mcVersion === '1.21.1'
}

export function generateProject(opts: GenerateOptions): GenerateResult {
  const era = resolveEra(opts.loader, opts.mcVersion)
  if (!era) {
    return { ok: false, error: `No project template for ${opts.loader} ${opts.mcVersion}.` }
  }

  const dir = path.resolve(opts.targetDir)
  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0 && !opts.overwrite) {
    return { ok: false, error: `Folder is not empty: ${dir}` }
  }

  const cfg: ProjectConfig = {
    modId: opts.modId,
    modName: opts.modName,
    group: opts.group,
    version: opts.modVersion || '1.0.0',
    author: opts.author ?? '',
    license: opts.license ?? 'All Rights Reserved',
    mcVersion: opts.mcVersion,
    loaderVersion: opts.loaderVersion,
    loader: opts.loader,
    era
  }

  fs.mkdirSync(dir, { recursive: true })

  if (hasVendoredTemplate(opts.loader, opts.mcVersion) && fs.existsSync(opts.templateRoot)) {
    copyVendored(opts.templateRoot, dir)
    // Rewrite the MDK's properties + metadata rather than generating a build file.
    writeIfExists(
      path.join(dir, 'gradle.properties'),
      (text) => rewriteProps(text, cfg)
    )
    const tomlPath = path.join(dir, 'src', 'main', 'templates', 'META-INF', 'neoforge.mods.toml')
    if (fs.existsSync(tomlPath)) {
      const className = classNameFor(opts.modId)
      const src = path.join(dir, 'src', 'main', 'java', ...opts.group.split('.'), `${className}.java`)
      // The vendored MDK has example sources; replace them with ours.
      fs.rmSync(path.join(dir, 'src', 'main', 'java'), { recursive: true, force: true })
      fs.rmSync(path.join(dir, 'src', 'main', 'resources', 'assets'), { recursive: true, force: true })
      for (const file of eraFiles(cfg, className)) {
        if (file.path.startsWith('build.gradle') || file.path === 'settings.gradle') continue
        if (file.path.includes('neoforge.mods.toml')) continue // keep the MDK's real one
        writeFile(dir, file.path, file.content)
      }
      const toml = fs.readFileSync(tomlPath, 'utf8')
        .replace(/#authors=""/, `authors="${cfg.author}"`)
        .replace(/Example mod description\./, `${cfg.modName} - a NeoForge ${cfg.mcVersion} mod.`)
      fs.writeFileSync(tomlPath, toml, 'utf8')
      fs.rmSync(src, { force: true })
    }
    return { ok: true, dir, era: eraSummary(era), usedVendoredTemplate: true }
  }

  // Generated path
  const className = classNameFor(opts.modId)
  for (const file of eraFiles(cfg, className)) writeFile(dir, file.path, file.content)
  writeWrapper(dir, era, opts.templateRoot)
  writeGitignore(dir)
  return { ok: true, dir, era: eraSummary(era) }
}

function eraSummary(era: Era): { id: string; label: string; buildable: boolean; notes: string[] } {
  return { id: era.id, label: era.label, buildable: era.buildable, notes: era.notes }
}

/** "rubytools" -> "Rubytools", "ruby_tools" -> "RubyTools". */
export function classNameFor(modId: string): string {
  const name = modId
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((s) => s[0].toUpperCase() + s.slice(1))
    .join('')
  return /^[0-9]/.test(name) ? `Mod${name}` : name || 'ExampleMod'
}

function copyVendored(from: string, to: string): void {
  fs.cpSync(from, to, { recursive: true })
}

function writeIfExists(file: string, transform: (text: string) => string): void {
  if (!fs.existsSync(file)) return
  fs.writeFileSync(file, transform(fs.readFileSync(file, 'utf8')), 'utf8')
}

function rewriteProps(text: string, cfg: ProjectConfig): string {
  const set = (key: string, value: string): void => {
    const re = new RegExp(`^${key}=.*$`, 'm')
    text = re.test(text) ? text.replace(re, `${key}=${value}`) : `${text.trimEnd()}\n${key}=${value}\n`
  }
  set('mod_id', cfg.modId)
  set('mod_name', cfg.modName)
  set('mod_group_id', cfg.group)
  set('mod_version', cfg.version)
  set('mod_license', cfg.license)
  set('mod_authors', cfg.author)
  set('neo_version', cfg.loaderVersion)
  return text
}

function writeFile(dir: string, rel: string, content: string): void {
  const target = path.join(dir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content, 'utf8')
}

/**
 * The wrapper jar is a binary with a checksum; generating it is not possible, so
 * it is copied from the vendored template and the properties file is pointed at
 * the era's gradle distribution.
 */
function writeWrapper(dir: string, era: Era, templateRoot: string): void {
  const wrapperDir = path.join(dir, 'gradle', 'wrapper')
  fs.mkdirSync(wrapperDir, { recursive: true })
  const jar = path.join(templateRoot, 'gradle', 'wrapper', 'gradle-wrapper.jar')
  if (fs.existsSync(jar)) fs.copyFileSync(jar, path.join(wrapperDir, 'gradle-wrapper.jar'))
  fs.writeFileSync(path.join(wrapperDir, 'gradle-wrapper.properties'), wrapperProperties(era), 'utf8')
  for (const script of ['gradlew', 'gradlew.bat']) {
    const from = path.join(templateRoot, script)
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dir, script))
  }
}

function writeGitignore(dir: string): void {
  const lines = [
    '# gradle',
    '.gradle/',
    'build/',
    '',
    '# ide',
    '.idea/',
    '*.iml',
    '.vscode/',
    'eclipse/',
    '',
    '# minecraft run dirs',
    'run/',
    'logs/',
    '*.log',
    '',
    '# agent',
    '.agent/',
    'reference/',
    ''
  ]
  fs.writeFileSync(path.join(dir, '.gitignore'), lines.join('\n'), 'utf8')
}
