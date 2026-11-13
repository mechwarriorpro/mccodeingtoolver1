/**
 * Porting an existing project between Minecraft versions and mod loaders.
 *
 * This is a *plan*, not a rewrite. Moving a 1.12.2 Forge mod to 1.21.1 NeoForge
 * is not a version bump: the build script is a different system (ForgeGradle 2
 * vs. ModDevGradle), the package root changes (`net.minecraft.item.Item` vs.
 * `net.minecraft.world.item.Item`), registration moves from `register()` calls
 * to `DeferredRegister`, and metadata moves from `mcmod.info` to
 * `META-INF/neoforge.mods.toml`. No tool can do that conversion faithfully by
 * itself, and one that pretends to produces a project that does not compile.
 *
 * So the app does the parts that are mechanical and verifiable — detection, the
 * new toolchain, moving sources, the mod-id/package rename — and writes a
 * migration report listing exactly what a human (or the agent) must fix, with
 * per-era notes on the API cliffs that actually bite.
 */

import fs from 'node:fs'
import path from 'node:path'
import { readProps } from './props'
import { ERAS, resolveEra, javaForVersion, resolveLoaderVersion } from '../versions/eras'
import { generateProject } from './generate'
import { scanDependencies } from './deps'
import { scaffoldProject, templateRoot } from './scaffold'
import { sourceJavaLevel } from '../build/gradle'
import { compareMcVersions, type Loader } from '../versions/catalog'

export type Layout = 'neoforge' | 'forge-gradle' | 'architectury' | 'fabric' | 'unknown'

export interface DetectedProject {
  dir: string
  /** Minecraft version as declared by the project. Null when none was found. */
  mcVersion: string | null
  loader: Loader | 'unknown'
  /** How the build is actually wired, which matters more than the loader name. */
  layout: Layout
  /** Where the Java sources live, relative to the project root. */
  sourceRoot: string
  modId: string | null
  modName: string | null
  group: string | null
  version: string | null
  /** Human-facing evidence for the detection, shown in the UI. */
  evidence: string[]
  /** A build file exists that the generator will have to replace. */
  hasBuildScript: boolean
  /** The project still carries files that only old eras use. */
  legacyFiles: string[]
  /** Java level the build script asks for, if it says. */
  declaredJava: number | null
  /** Java level the targets declared *Minecraft version* needs. */
  expectedJava: number
  /**
   * The sources are already on a newer Java than gradle.properties declares.
   * That is the normal state half way through an upgrade, and it is worth saying
   * out loud rather than presenting a two-ended port of a one-ended project.
   */
  midUpgrade: boolean
}

const BUILD_FILES = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']

/** Read the first existing file from a list, or ''. */
function firstFile(dir: string, names: string[]): { name: string; text: string } {
  for (const name of names) {
    const file = path.join(dir, name)
    try {
      return { name, text: fs.readFileSync(file, 'utf8') }
    } catch {
      /* try the next */
    }
  }
  return { name: '', text: '' }
}

function exists(dir: string, rel: string): boolean {
  try {
    return fs.existsSync(path.join(dir, rel))
  } catch {
    return false
  }
}

/**
 * Where the Java sources are.
 *
 * Strictly speaking only ForgeGradle 2 lets you move `sourceSets.main.java`; for
 * everything else the fix is to write the detected root into the generated
 * `build.gradle`. Guessing `src/main/java` on a project that uses
 * `src/main/kotlin` or a multi-module layout would silently produce an empty mod.
 */
export function detectSourceRoot(dir: string): string {
  const candidates = [
    'src/main/java',
    'src/main/kotlin',
    'src/main/scala',
    'common/src/main/java',
    'src/java',
    'src'
  ]
  for (const rel of candidates) {
    const p = path.join(dir, rel)
    try {
      if (fs.statSync(p).isDirectory() && walkHasJava(p, 500)) return rel
    } catch {
      /* not there */
    }
  }
  return 'src/main/java'
}

function walkHasJava(dir: string, budget: number): boolean {
  let seen = 0
  const walk = (d: string): boolean => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return false
    }
    for (const e of entries) {
      if (seen++ > budget) return false
      if (e.isDirectory()) {
        if (walk(path.join(d, e.name))) return true
      } else if (/\.(java|kt|scala)$/i.test(e.name)) {
        return true
      }
    }
    return false
  }
  return walk(dir)
}

/**
 * Work out what a project is. Everything here is evidence-based: the UI shows
 * what was found so a wrong guess is visible rather than mysterious.
 */
export function detectProject(dir: string): DetectedProject {
  const evidence: string[] = []
  const props = readProps(path.join(dir, 'gradle.properties'))
  const build = firstFile(dir, BUILD_FILES)

  // ---- Minecraft version -------------------------------------------------
  // mods.toml/mod_info/neoforge.mods.toml carry it too, and a project without
  // gradle.properties is common in older Forge setups.
  let mcVersion =
    props.minecraft_version ?? props.mc_version ?? props.minecraftVersion ?? props.minecraftVersionRange ?? ''
  if (mcVersion) evidence.push(`gradle.properties: minecraft_version=${mcVersion}`)
  if (!mcVersion) {
    const toml = firstFile(dir, ['META-INF/neoforge.mods.toml', 'META-INF/mods.toml', 'src/main/resources/META-INF/mods.toml'])
    const range = toml.text.match(/versionRange\s*=\s*"\[([\d.]+)/)?.[1] ?? toml.text.match(/minecraftVersion\s*=\s*"([\d.]+)"/)?.[1]
    if (range) {
      mcVersion = range
      evidence.push(`${toml.name}: versionRange starts at ${range}`)
    }
  }
  if (!mcVersion) {
    const json = firstFile(dir, ['src/main/resources/fabric.mod.json'])
    const dep = json.text.match(/"minecraft"\s*:\s*"[>=^~]*([\d.]+)/)?.[1]
    if (dep) {
      mcVersion = dep
      evidence.push(`fabric.mod.json: minecraft ${dep}+`)
    }
  }

  // ---- Loader ------------------------------------------------------------
  let loader: Loader = 'forge'
  let layout: Layout = 'unknown'
  // fabric.mod.json is decisive on its own: a Loom script is not always the file
  // that survives a hand-edited or partially-ported project.
  const fabricJson = firstFile(dir, ['src/main/resources/fabric.mod.json'])
  const text = `${build.text}\n${props.minecraft_version ?? ''}\n${props.loader ?? ''}\n${fabricJson.text}`.toLowerCase()

  if (/net\.neoforged|neoforge/.test(text) || exists(dir, 'META-INF/neoforge.mods.toml')) {
    loader = 'neoforge'
    layout = 'neoforge'
    evidence.push('build script or metadata references NeoForge')
  } else if (/net\.fabricmc|fabric-loom/.test(text)) {
    loader = 'fabric'
    layout = 'fabric'
    evidence.push('build script references Fabric Loom')
  } else if (/architectury|dev\.architectury/.test(text)) {
    // Architectury is a *framework* over Forge/Fabric, not a loader of its own.
    loader = /fabric/.test(text) ? 'fabric' : 'forge'
    layout = 'architectury'
    evidence.push('build script references Architectury (multi-loader)')
  } else if (/forgegradle|net\.minecraftforge/.test(text)) {
    loader = 'forge'
    layout = 'forge-gradle'
    evidence.push('build script references ForgeGradle')
  } else if (exists(dir, 'mods.toml') || exists(dir, 'src/main/resources/META-INF/mods.toml')) {
    loader = 'forge'
    layout = 'forge-gradle'
    evidence.push('META-INF/mods.toml present')
  }

  // The ForgeGradle major version is the real dividing line for an upgrade: 2.x
  // builds 1.12.2 and below, 3.x-5.x build 1.13-1.20, 6.x builds 1.20.2+.
  if (layout === 'forge-gradle') {
    const fg = build.text.match(/forge(?:Gradle)?[-:\s]*['"]?(\d+)\./i)?.[1]
    if (fg) evidence.push(`ForgeGradle ${fg}.x`)
  }

  // ---- identity ----------------------------------------------------------
  const modId =
    props.mod_id ?? props.modid ?? props.archives_base_name ?? fabricJson.text.match(/"id"\s*:\s*"([^"]+)"/)?.[1] ?? ''
  // A project with nothing readable is unknown, not a Forge mod by default.
  if (!build.name && !modId && !mcVersion) layout = 'unknown'
  const modName = props.mod_name ?? props.modName ?? ''
  const group = props.mod_group_id ?? props.group ?? props.maven_group ?? ''
  const version = props.mod_version ?? props.version ?? ''
  if (modId) evidence.push(`mod_id=${modId}`)

  // Sources and gradle.properties move at different times during an upgrade, so
  // the build script can already target Java 21 while the properties still say
  // 1.12.2. Comparing the two is how that state gets noticed at all.
  const declaredJava = sourceJavaLevel(dir)
  const eraForSource = layout === 'unknown' ? null : resolveEra(loader, mcVersion || '1.12.2')
  const expectedJava = eraForSource && mcVersion ? javaForVersion(loader, mcVersion, eraForSource) : 8

  const legacyFiles = [
    'mcmod.info',
    'src/main/resources/mcmod.info',
    'pack.mcmeta',
    'src/main/resources/META-INF/mods.toml'
  ].filter((rel) => exists(dir, rel))

  return {
    dir,
    mcVersion: mcVersion || null,
    loader: layout === 'unknown' && !mcVersion ? 'unknown' : loader,
    layout,
    sourceRoot: detectSourceRoot(dir),
    modId: modId || null,
    modName: modName || null,
    group: group || null,
    version: version || null,
    evidence,
    hasBuildScript: build.name !== '',
    legacyFiles,
    declaredJava,
    expectedJava,
    midUpgrade: declaredJava !== null && declaredJava > expectedJava
  }
}

/** A version-and-loader change, plus what it costs. */
export interface PortPlan {
  from: DetectedProject
  target: { loader: Loader; mcVersion: string }
  /** Same loader and same version: nothing to port. */
  alreadyTarget: boolean
  /** A major generation jump (e.g. 1.12.2 → 1.21.1) rather than a patch step. */
  majorJump: boolean
  /** Java the target needs. */
  java: number
  /** Steps the app performs itself. */
  automatic: string[]
  /** Steps a human or the agent must do, why, and how bad it is. */
  manual: PortStep[]
  /** Blocking problems that make this port a bad idea right now. */
  blockers: string[]
  /** One-paragraph summary for the UI and the migration report. */
  summary: string
}

export interface PortStep {
  title: string
  detail: string
  /** 'mechanical' = a rename the agent can do; 'api' = needs real rewrites. */
  kind: 'mechanical' | 'api' | 'metadata' | 'build'
}

/**
 * Era-specific API cliffs.
 *
 * Only the changes that actually break compiles are listed, because a report
 * with two hundred bullets is the same as no report. These are the ones that
 * cost hours when you hit them one error at a time.
 */
/** The build plugin the generated project will use for a given loader. */
export function toolchainFor(loader: Loader): string {
  return loader === 'neoforge' ? 'ModDevGradle' : loader === 'forge' ? 'ForgeGradle 6' : 'Fabric Loom'
}

const API_NOTES: { from: string; to: string; notes: PortStep[] }[] = [
  {
    from: '1.12.2',
    to: '1.13',
    notes: [
      { kind: 'api', title: 'Registry and registration', detail: '`GameRegistry.register()` and `new Item()` are gone. Items/blocks are registered objects with `setRegistryName`, and later via `DeferredRegister`.' },
      { kind: 'api', title: 'Recipes are JSON', detail: '`CraftingManager.addRecipe` no longer exists; recipes are data-pack JSON under `data/<modid>/recipes/`.' },
      { kind: 'api', title: 'Translation keys', detail: '`item.<modid>.<name>.name` became `item.<modid>.<name>` — unlocalised names changed shape.' },
      { kind: 'api', title: 'Metadata (mcmod.info)', detail: '`mcmod.info` is replaced by `META-INF/mods.toml`.' }
    ]
  },
  {
    from: '1.16',
    to: '1.17',
    notes: [
      { kind: 'api', title: 'Mappings: MCP → Mojang official', detail: 'Class and method names change wholesale (`ItemStack` fields, `World` → `Level`, `BlockPos` stays). Every import needs re-checking.' },
      { kind: 'api', title: 'Java 16+ requirement', detail: 'The toolchain moves from Java 8 to 16/17.' }
    ]
  },
  {
    from: '1.20.4',
    to: '1.20.5',
    notes: [
      { kind: 'api', title: 'Item components replace NBT', detail: '`ItemStack` NBT is replaced by typed data components. This is the single largest API change in the modding era and has no mechanical translation.' },
      { kind: 'api', title: 'Java 21', detail: 'Minecraft and NeoForge require Java 21 from 1.20.5 on.' }
    ]
  },
  {
    from: 'forge',
    to: 'neoforge',
    notes: [
      { kind: 'mechanical', title: 'Package rename', detail: '`net.minecraftforge.*` → `net.neoforged.neoforge.*`. Most imports are a search-and-replace, but the class names are not always the same.' },
      { kind: 'metadata', title: 'mods.toml → neoforge.mods.toml', detail: 'The metadata file is renamed and gains a `[[mixins]]` block convention; `modLoader="javafml"` becomes `modLoader="javafml"` with a different loader version range.' },
    ]
  },
  {
    from: 'forge',
    to: 'fabric',
    notes: [
      { kind: 'api', title: 'No shared registry abstraction', detail: 'Forge\'s `DeferredRegister` does not exist in Fabric; registration is `Registry.register(...)` at mod init. Networking and events differ completely.' },
      { kind: 'metadata', title: 'fabric.mod.json', detail: 'Metadata becomes a JSON manifest with entrypoints; `mods.toml` has no equivalent.' },
      { kind: 'api', title: 'Rewriting, not porting', detail: 'Forge→Fabric is a rewrite of every integration point. Estimate it as a new mod that reuses the assets and the data model.' }
    ]
  },
  {
    from: 'fabric',
    to: 'forge',
    notes: [
      { kind: 'build', title: 'ForgeGradle/ModDevGradle', detail: 'Loom and its mappings give way to the Forge toolchain.' },
      { kind: 'api', title: 'Registration and events', detail: '`Registry.register` calls move into `DeferredRegister`; Fabric callbacks become Forge event subscribers.' },
      { kind: 'metadata', title: 'mods.toml', detail: '`fabric.mod.json` becomes `mods.toml` / `neoforge.mods.toml` with loader version ranges.' }
    ]
  }
]

/** The first version in each generation, used to bucket "how big is this jump". */
const GENERATION_STARTS = ['1.12.2', '1.13', '1.14', '1.16', '1.17', '1.19', '1.20.5', '1.21']

function generation(version: string): number {
  if (!version) return -1
  let idx = -1
  for (const [i, start] of GENERATION_STARTS.entries()) {
    if (compareMcVersions(version, start) >= 0) idx = i
  }
  return idx
}

/** Notes that apply to a jump from `fromVersion` to `toVersion`. */
export function apiNotesFor(
  fromVersion: string | null,
  toVersion: string,
  fromLoader: Loader | 'unknown',
  toLoader: Loader
): PortStep[] {
  const out: PortStep[] = []
  // An unknown source loader has no rename to describe; the version notes below
  // still apply, which is the honest part.
  if (fromLoader !== 'unknown' && fromLoader !== toLoader) {
    out.push(...(API_NOTES.find((n) => n.from === fromLoader && n.to === toLoader)?.notes ?? []))
  }
  if (fromVersion && toVersion && compareMcVersions(toVersion, fromVersion) > 0) {
    // Any generation boundary crossed between the two versions contributes its
    // notes; that is what makes a 1.12.2 → 1.21.1 port honest about its size.
    for (const block of API_NOTES) {
      const isVersionBlock = /^[\d.]+$/.test(block.from) && /^[\d.]+$/.test(block.to)
      if (!isVersionBlock) continue
      const crossed = compareMcVersions(fromVersion, block.to) < 0 && compareMcVersions(toVersion, block.from) >= 0
      if (crossed) out.push(...block.notes)
    }
  }
  return out
}

export function planPort(dir: string, target: { loader: Loader; mcVersion: string }): PortPlan {
  const from = detectProject(dir)
  const era = resolveEra(target.loader, target.mcVersion)
  // resolveEra() falls back to the loader's newest era so a brand-new Minecraft
  // version still generates a project. For a port that would be a lie, so check
  // the table directly: is there an era whose window contains this version?
  const eraCovers = ERAS.some((e) => {
    if (!e.loaders.includes(target.loader)) return false
    const minor = target.mcVersion.split('.').slice(0, 2).join('.')
    const okMin = compareMcVersions(target.mcVersion, e.min) >= 0
    const okMax = e.max ? compareMcVersions(minor, e.max) <= 0 : true
    return okMin && okMax
  })
  const java = eraCovers && era ? javaForVersion(target.loader, target.mcVersion, era) : 21
  const blockers: string[] = []
  const automatic: string[] = []
  const manual: PortStep[] = []

  if (!eraCovers) {
    blockers.push(
      `No build toolchain is known for ${target.loader} ${target.mcVersion}, so a new project for it cannot be generated. ` +
        'Check the version list — the loaders it shows are the ones that actually existed for that version.'
    )
  }
  if (!from.mcVersion) {
    blockers.push('The current Minecraft version could not be read from this project, so nothing can be compared. Set minecraft_version in gradle.properties first.')
  }
  if (from.layout === 'architectury') {
    blockers.push('This is an Architectury multi-loader project. Only one loader can be generated, so porting it here would throw away the other loader — do it by hand.')
  }

  const sameLoader = from.loader === target.loader
  const sameVersion = !!from.mcVersion && compareMcVersions(from.mcVersion, target.mcVersion) === 0
  const alreadyTarget = sameLoader && sameVersion
  const majorJump =
    !!from.mcVersion && (generation(target.mcVersion) - generation(from.mcVersion) > 1 || !sameLoader)

  if (!alreadyTarget) {
    automatic.push(
      `Generate a ${target.loader} ${target.mcVersion} build script and Gradle wrapper (Java ${java}).`,
      `Copy the Java sources from ${from.sourceRoot} into the new project.`,
      'Keep resources, assets and data files; drop build output and IDE files.'
    )
    if (from.modId) automatic.push(`Preserve the mod id \`${from.modId}\`, so existing worlds and configs keep working.`)
    if (from.group) automatic.push(`Keep the package root \`${from.group}\` unless it embeds the old loader name.`)
    if (from.legacyFiles.length) {
      automatic.push(`Leave out legacy metadata that the new loader cannot read: ${from.legacyFiles.join(', ')}.`)
    }

    // Anything left requires judgement, and saying so is the point.
    manual.push({
      kind: 'build',
      title: 'Replace the build script',
      detail:
        `${from.layout === 'forge-gradle' ? 'ForgeGradle' : from.layout} cannot build ${target.mcVersion}. ` +
        `The generated project uses ${toolchainFor(target.loader)} instead; merge any custom dependencies or tasks across by hand. ` +
        'It cannot be edited into the new form — the two share almost no syntax.'
    })
    if (from.midUpgrade) {
      manual.push({
        kind: 'mechanical',
        title: 'This project is already half migrated',
        detail:
          `The sources already ask for Java ${from.declaredJava} while gradle.properties declares Minecraft ` +
          `${from.mcVersion} (Java ${from.expectedJava}). The port treats the declared version as the starting point ` +
          'but copies the sources as they are, so some of the work below may already be done. Check before redoing it.'
      })
    }
    manual.push(...apiNotesFor(from.mcVersion, target.mcVersion, from.loader, target.loader))
    if (!manual.some((m) => m.kind === 'api')) {
      manual.push({
        kind: 'api',
        title: 'Re-check the API surface',
        detail: 'Nothing catastrophic is known to change across this particular step, but class names and signatures do move between versions. Build and fix the errors that appear.'
      })
    }
  }

  const summary = alreadyTarget
    ? `This project is already ${target.loader} ${target.mcVersion}.`
    : `Porting ${from.loader} ${from.mcVersion || '?'} → ${target.loader} ${target.mcVersion}` +
      `${majorJump ? `, a jump of several generations` : ''}. The build script and metadata are regenerated; ` +
      `${manual.filter((m) => m.kind === 'api').length} API-level changes need real edits, not search-and-replace.`

  return { from, target, alreadyTarget, majorJump, java, automatic, manual, blockers, summary }
}

/** The migration report written into the project root. */
/**
 * The dependencies section of the migration report.
 *
 * A port copies sources and regenerates the build; it does not know what those
 * sources were written against. The result is a project that fails with
 * "package com.simibubi.create does not exist" on a codebase that compiled
 * before the port — a dependency was left behind, and nothing said so.
 *
 * Split by kind, because the three answers are not alike: game classes mean the
 * build file is wrong, a mod means a download, a maven library means a line in
 * `dependencies`.
 */
export function dependencySection(scan: {
  filesScanned: number
  dependencies: { package: string; name?: string; kind: string; files: number; declared?: string[]; homepage?: string }[]
}): string[] {
  const lines: string[] = []
  const mods = scan.dependencies.filter((d) => d.kind === 'mod')
  const libs = scan.dependencies.filter((d) => d.kind === 'library' || d.kind === 'unknown')
  if (!mods.length && !libs.length) {
    lines.push('No dependencies beyond Minecraft were found in the sources or the old build files.')
    return lines
  }
  lines.push(`Scanned ${scan.filesScanned} source files. These are outside Minecraft and the loader:`)
  lines.push('')
  if (mods.length) {
    lines.push('### Mod dependencies')
    lines.push('')
    lines.push('The port carries sources but not the build files that declared these. Each one needs to be')
    lines.push('declared again for the new loader, or the code that calls it will not compile.')
    lines.push('')
    for (const d of mods) {
      const version = d.declared?.length ? ` (was ${d.declared.join(', ')})` : ''
      lines.push(`- **${d.name ?? d.package}** — \`${d.package}\`${version}, used in ${d.files} file(s)`)
      if (d.homepage) lines.push(`  - ${d.homepage}`)
    }
    lines.push('')
  }
  if (libs.length) {
    lines.push('### Libraries')
    lines.push('')
    for (const d of libs) {
      const version = d.declared?.length ? ` (was ${d.declared.join(', ')})` : ''
      lines.push(`- **${d.name ?? d.package}**${version}, used in ${d.files} file(s)`)
    }
    lines.push('')
  }
  lines.push('The Shaders tab and the deps panel in the Build tab can find and declare these; a jar placed')
  lines.push('in `libs/` is not enough until `dependencies` mentions it.')
  return lines
}

export function migrationReport(
  plan: PortPlan,
  date = new Date(),
  scan?: Parameters<typeof dependencySection>[0]
): string {
  const { from, target } = plan
  const lines: string[] = []
  lines.push(`# Porting to ${target.loader} ${target.mcVersion}`)
  lines.push('')
  lines.push(`Generated ${date.toISOString().slice(0, 10)} by MC Forge Agent.`)
  lines.push('')
  lines.push(`- **From:** ${from.loader} ${from.mcVersion || '(unknown)'} — ${from.layout}`)
  if (from.midUpgrade) {
    lines.push(
      `- **Half migrated already:** sources ask for Java ${from.declaredJava}, the declared Minecraft ` +
        `version needs Java ${from.expectedJava}`
    )
  }
  lines.push(`- **To:** ${target.loader} ${target.mcVersion} (Java ${plan.java})`)
  lines.push(`- **Sources:** \`${from.sourceRoot}\``)
  lines.push('')
  lines.push('## What was done for you')
  lines.push('')
  for (const a of plan.automatic) lines.push(`- ${a}`)
  lines.push('')
  lines.push('## What you still have to do')
  lines.push('')
  if (!plan.manual.length) {
    lines.push('Nothing outstanding — this project was already on the target.')
  }
  for (const m of plan.manual) {
    const tag = m.kind === 'api' ? '**API change**' : m.kind === 'build' ? '**Build**' : m.kind === 'metadata' ? '**Metadata**' : 'Mechanical'
    lines.push(`### ${m.title} — ${tag}`)
    lines.push('')
    lines.push(m.detail)
    lines.push('')
  }
  if (scan) {
    lines.push('## Dependencies the port did not carry')
    lines.push('')
    lines.push(...dependencySection(scan))
    lines.push('')
  }
  if (plan.blockers.length) {
    lines.push('## Blockers')
    lines.push('')
    for (const b of plan.blockers) lines.push(`- ${b}`)
    lines.push('')
  }
  lines.push('## How to work through this')
  lines.push('')
  lines.push('Work in dependency order, not file order. Fix the entry point and registration first, then')
  lines.push('items/blocks, then recipes and data, then GUIs and networking. Compile after each group —')
  lines.push('a single early mismatch produces hundreds of errors that all point at the same cause.')
  lines.push('')
  lines.push('The agent can do this for you: ask it to "work through MIGRATION.md".')
  return lines.join('\n')
}

/**
 * Take a safe copy before touching anything.
 *
 * A port is the one operation that can leave a working mod in a half-migrated
 * state, so the original stays untouched on disk and this is the way back.
 */
export function backupProject(dir: string, stamp = Date.now()): { ok: boolean; backup?: string; error?: string } {
  const dest = path.join(dir, `backup-${new Date(stamp).toISOString().replace(/[:.]/g, '-')}`)
  try {
    fs.mkdirSync(dest, { recursive: true })
    const skip = /^(build|\.gradle|\.git|run|backup-)$/i
    const copy = (rel: string): void => {
      const src = path.join(dir, rel)
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(src, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (skip.test(e.name)) continue
        const childRel = rel ? `${rel}/${e.name}` : e.name
        // Never recurse into a backup we created.
        if (/^backup-\d{4}-/.test(e.name)) continue
        if (e.isDirectory()) {
          fs.mkdirSync(path.join(dest, childRel), { recursive: true })
          copy(childRel)
        } else {
          try {
            fs.mkdirSync(path.dirname(path.join(dest, childRel)), { recursive: true })
            fs.copyFileSync(path.join(dir, childRel), path.join(dest, childRel))
          } catch {
            /* an unreadable file should not abort the backup */
          }
        }
      }
    }
    copy('')
    return { ok: true, backup: dest }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/* ------------------------------------------------------------- conversion */

export interface ConvertOptions {
  /** The existing project. Never modified. */
  sourceDir: string
  /** Where the ported project is written. Must not be the source. */
  targetDir: string
  target: { loader: Loader; mcVersion: string }
  modVersion?: string
  author?: string
  license?: string
  /** Write a backup of the source first. Default true. */
  backup?: boolean
}

export interface ConvertResult {
  ok: boolean
  error?: string
  plan?: PortPlan
  /** The generated project directory. */
  dir?: string
  /** Migration report inside the new project. */
  reportPath?: string
  backupPath?: string
  /** Files carried across. */
  copiedSources: number
  copiedResources: number
  /** Build output and IDE files that were deliberately skipped. */
  skipped: string[]
  /** What the sources still need beyond Minecraft, for the UI to offer. */
  dependencies?: { package: string; name?: string; kind: string; files: number; declared?: string[]; homepage?: string }[]
}

const SKIP_DIRS = new Set(['build', 'out', '.gradle', '.git', '.idea', 'run', 'logs', '.vscode'])
const RESOURCE_SKIP = /^(mcmod\.info|pack\.mcmeta|fabric\.mod\.json|META-INF\/(mods\.toml|neoforge\.mods\.toml|MANIFEST\.MF))$/i

function copyTree(
  from: string,
  to: string,
  opts: { filter?: (rel: string) => boolean; skip?: Set<string> }
): number {
  let count = 0
  const walk = (rel: string): void => {
    const src = path.join(from, rel)
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(src, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (opts.skip?.has(e.name)) continue
      if (opts.filter && !opts.filter(childRel)) continue
      if (e.isDirectory()) {
        fs.mkdirSync(path.join(to, childRel), { recursive: true })
        walk(childRel)
      } else if (e.isFile()) {
        try {
          fs.mkdirSync(path.dirname(path.join(to, childRel)), { recursive: true })
          fs.copyFileSync(path.join(from, childRel), path.join(to, childRel))
          count++
        } catch {
          /* an unreadable file is reported as skipped by omission */
        }
      }
    }
  }
  walk('')
  return count
}

/**
 * Generate a new project for the target and carry the old one across.
 *
 * The source project is left untouched: a half-finished port is exactly the
 * state you do not want your only copy in. Everything mechanical is done here —
 * new toolchain, sources moved, same mod id so worlds and configs survive — and
 * everything that needs judgement is written into MIGRATION.md rather than
 * guessed at.
 */
export function convertProject(opts: ConvertOptions): ConvertResult {
  const plan = planPort(opts.sourceDir, opts.target)
  if (plan.blockers.length) {
    return { ok: false, error: plan.blockers.join(' '), plan, copiedSources: 0, copiedResources: 0, skipped: [] }
  }
  const srcAbs = path.resolve(opts.sourceDir)
  const dstAbs = path.resolve(opts.targetDir)
  if (srcAbs === dstAbs) {
    return { ok: false, error: 'Choose a different folder for the ported project — the original is kept as it is.', plan, copiedSources: 0, copiedResources: 0, skipped: [] }
  }
  if (dstAbs.startsWith(srcAbs + path.sep)) {
    return { ok: false, error: 'The new project cannot live inside the old one. Pick a separate folder.', plan, copiedSources: 0, copiedResources: 0, skipped: [] }
  }

  let backupPath: string | undefined
  if (opts.backup !== false) {
    const b = backupProject(srcAbs)
    if (!b.ok) return { ok: false, error: `Could not back up the original: ${b.error}`, plan, copiedSources: 0, copiedResources: 0, skipped: [] }
    backupPath = b.backup
  }

  const from = plan.from
  const modId = from.modId || 'examplemod'
  // The package root has to be a valid Java package. Old projects occasionally
  // use a name that embeds the loader, which would be misleading in the new one.
  const group = (from.group || `com.example.${modId.replace(/[^a-z0-9_]/g, '')}`).replace(/\.(forge|neoforge|fabric)\b/g, '')

  // NeoForge 1.21.1 has a vendored MDK; everything else is generated. Both paths
  // produce the same shape, which is what lets the copy below be unconditional.
  let made: { ok: boolean; error?: string; dir?: string }
  if (opts.target.loader === 'neoforge' && opts.target.mcVersion === '1.21.1') {
    const sc = scaffoldProject({
      targetDir: dstAbs,
      modId,
      modName: from.modName || modId,
      group,
      modVersion: opts.modVersion ?? from.version ?? '1.0.0',
      neoVersion: '',
      author: opts.author,
      license: opts.license
    })
    // Not a ternary on `ok`: the test build compiles without --strict, where the
    // boolean literal discriminant collapses and does not narrow.
    made = sc.ok ? { ok: true, dir: sc.dir } : { ok: false, error: (sc as { error?: string }).error }
  } else {
    const gen = generateProject({
      targetDir: dstAbs,
      modId,
      modName: from.modName || modId,
      group,
      modVersion: opts.modVersion ?? from.version ?? '1.0.0',
      loader: opts.target.loader,
      mcVersion: opts.target.mcVersion,
      // A real loader version, not ''. With an empty one gradle cannot resolve
      // Minecraft, and every source file fails with "package net.minecraft… does
      // not exist" — which looks like a broken port rather than an empty property.
      loaderVersion: resolveLoaderVersion(opts.target.loader, opts.target.mcVersion),
      templateRoot: templateRoot(),
      author: opts.author,
      license: opts.license
    })
    made = { ok: gen.ok, error: gen.error, dir: gen.dir ?? dstAbs }
  }
  if (!made.ok) {
    return { ok: false, error: made.error ?? 'Could not generate the target project.', plan, copiedSources: 0, copiedResources: 0, skipped: [] }
  }

  // ---- carry the sources across ------------------------------------------
  // The generator writes its own example classes; drop them so the ported tree
  // is the only thing in src/main/java and nothing compiles twice.
  const dstSources = path.join(dstAbs, 'src', 'main', 'java')
  fs.rmSync(dstSources, { recursive: true, force: true })
  const srcRoot = path.join(srcAbs, from.sourceRoot)
  const copiedSources = fs.existsSync(srcRoot)
    ? copyTree(srcRoot, dstSources, { skip: SKIP_DIRS })
    : 0

  // ---- resources, minus metadata the new loader cannot read --------------
  const srcResources = path.join(srcAbs, 'src', 'main', 'resources')
  let copiedResources = 0
  if (fs.existsSync(srcResources)) {
    copiedResources = copyTree(srcResources, path.join(dstAbs, 'src', 'main', 'resources'), {
      skip: SKIP_DIRS,
      filter: (rel) => !RESOURCE_SKIP.test(rel)
    })
  }

  // ---- what the sources need that the port cannot carry -------------------
  // Scanned from the *source* project: the copied tree is the same code, but the
  // old build file is the only place a version was ever written down.
  const scan = scanDependencies({ dir: srcAbs, sourceRoot: from.sourceRoot })

  // ---- migration report --------------------------------------------------
  const reportPath = path.join(dstAbs, 'MIGRATION.md')
  fs.writeFileSync(reportPath, migrationReport(plan, new Date(), scan), 'utf8')

  // The agent should know where to start, without being told twice.
  const agentNote = path.join(dstAbs, '.agent')
  try {
    fs.mkdirSync(agentNote, { recursive: true })
    fs.writeFileSync(
      path.join(agentNote, 'port.json'),
      JSON.stringify(
        {
          from: { loader: from.loader, mcVersion: from.mcVersion, modId: from.modId, layout: from.layout },
          to: opts.target,
          copiedSources,
          copiedResources,
          dependencies: scan.dependencies
            .filter((d) => d.kind !== 'game')
            .map((d) => ({ package: d.package, name: d.name, kind: d.kind, files: d.files })),
          blockers: plan.blockers,
          createdAt: Date.now()
        },
        null,
        2
      ),
      'utf8'
    )
  } catch {
    /* the note is a convenience, not a requirement */
  }

  return {
    ok: true,
    plan,
    dir: dstAbs,
    reportPath,
    backupPath,
    copiedSources,
    copiedResources,
    skipped: from.legacyFiles,
    dependencies: scan.dependencies
      .filter((d) => d.kind !== 'game')
      .map((d) => ({ package: d.package, name: d.name, kind: d.kind, files: d.files, declared: d.declared, homepage: d.homepage }))
  }
}
