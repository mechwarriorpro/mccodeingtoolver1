import fs from 'node:fs'
import path from 'node:path'

/**
 * What else a mod needs to compile, and whether the ported project declares it.
 *
 * The failure this exists for: port a mod with the Update tab, build it locally,
 * and gradle reports
 *
 *   error: package net.minecraft.world.level does not exist
 *   error: cannot find symbol: class FoodProperties
 *
 * Those are *Minecraft* classes, and their absence means the port's build file is
 * not resolving the game at the right version — not that a dependency is missing.
 * A different error has the same smell and a different cause:
 *
 *   error: package com.simibubi.create.content.kinetics does not exist
 *
 * That one is a real dependency: the mod compiled against Create, Create is not
 * declared in the new build file, and nothing will fix it but declaring it.
 *
 * Both arrive from gradle as "package … does not exist", so the first job is to
 * tell them apart. Only the second is something the user can *download*, and
 * only the second is what this module reports as a dependency.
 *
 * Two sources of truth, because neither is complete on its own:
 *
 *  - The old build files list what the project declared before the port. That is
 *    the authoritative list, with versions, but a decompiled fork has no build
 *    file from the original.
 *  - The sources' own imports show what the code reaches for. That catches a
 *    decompiled fork, whose imports are all that survive, but it cannot give a
 *    version for anything.
 *
 * So both are scanned and merged, and anything found is reported by *name*, which
 * is what the user needs to search for. Guessing a version is worse than saying
 * "you will need a build for 1.21.1".
 */

export type DependencyKind =
  /** A Minecraft or loader class: comes from the game, never a separate download. */
  | 'game'
  /** A well-known library mod that the port dropped. */
  | 'mod'
  /** A library that is not Minecraft-specific. */
  | 'library'
  /** An import we cannot attribute to anything; reported so it is not invisible. */
  | 'unknown'

export interface Dependency {
  /** `com.simibubi.create` — stable identity, also what the user searches for. */
  package: string
  /** The project or library this looks like, when we can name one. */
  name?: string
  kind: DependencyKind
  /** How many distinct source files import it. A pack-off signal. */
  files: number
  /** Versions the old build files declared, when there were any. */
  declared?: string[]
  /** A page to download it from, when we are sure enough to offer one. */
  homepage?: string
  /** Why this matters for the build. */
  note?: string
}

/**
 * Packages that come from Minecraft itself or from the loader.
 *
 * These are never a download: if one is missing, the port's build file is not
 * resolving the game, and telling the user to download "net.minecraft" would send
 * them looking for a jar that does not exist. They are recognised so the report
 * can say the right thing instead.
 */
const GAME_PREFIXES = [
  'net.minecraft.',
  'com.mojang.',
  'net.minecraftforge.',
  'net.neoforged.',
  'net.fabricmc.',
  'cpw.mods.',
  'org.slf4j.',
  'org.apache.logging.',
  'com.google.gson.',
  'com.google.common.',
  'io.netty.',
  'org.joml.',
  'org.lwjgl.',
  'it.unimi.',
  'org.objectweb.asm.',
  'java.',
  'javax.',
  'sun.'
]

/**
 * Library mods people actually depend on, so the report can name them and link
 * somewhere useful instead of presenting a bare package.
 *
 * Deliberately short and certain: a wrong link is worse than no link. Anything
 * not here is still reported — it just says where the import came from.
 */
const KNOWN: { match: RegExp; name: string; homepage?: string; kind: DependencyKind }[] = [
  { match: /^com\.simibubi\.create|^net\.createmod\./, name: 'Create', homepage: 'https://modrinth.com/mod/create', kind: 'mod' },
  { match: /^dev\.architectury\./, name: 'Architectury API', homepage: 'https://modrinth.com/mod/architectury-api', kind: 'library' },
  { match: /^dev\.emi\./, name: 'EMI', homepage: 'https://modrinth.com/mod/emi', kind: 'mod' },
  { match: /^mezz\.jei|^mezz\.jade/, name: 'JEI', homepage: 'https://modrinth.com/mod/jei', kind: 'mod' },
  { match: /^top\.theillusivec4\.curios/, name: 'Curios API', homepage: 'https://modrinth.com/mod/curios', kind: 'library' },
  { match: /^net\.minecraftforge\.event\.|^net\.neoforged\.bus/, name: 'the loader event bus', kind: 'game' },
  { match: /^com\.mojang\.blaze3d|^com\.mojang\.math/, name: 'Minecraft (Blaze3D/Math)', kind: 'game' },
  { match: /^vazkii\./, name: 'a Vazkii mod (Botania/Quark)', homepage: 'https://modrinth.com/user/Vazkii', kind: 'mod' },
  { match: /^net\.mezz\./, name: 'a mezz mod (JEI/Jade)', homepage: 'https://modrinth.com/user/mezz', kind: 'mod' },
  { match: /^org\.jetbrains\.annotations/, name: 'JetBrains annotations', homepage: 'https://www.jetbrains.com/help/idea/annotating-source-code.html', kind: 'library' },
  { match: /^org\.antlr/, name: 'ANTLR runtime', homepage: 'https://www.antlr.org/', kind: 'library' },
  { match: /^com\.electronwill\.nightconfig|^net\.minecraftforge\.config/, name: 'NightConfig', homepage: 'https://github.com/ElectronWill/night-config', kind: 'library' },
  { match: /^org\.spongepowered\.mixin/, name: 'Mixin', homepage: 'https://github.com/SpongePowered/Mixin', kind: 'game' },
  { match: /^com\.github\.oshi|^oshi\./, name: 'OSHI', homepage: 'https://github.com/oshi/oshi', kind: 'library' },
  { match: /^org\.jline/, name: 'JLine', homepage: 'https://github.com/jline/jline3', kind: 'library' }
]

/** Is this import satisfied by the game or loader rather than a download? */
export function isGamePackage(pkg: string): boolean {
  return GAME_PREFIXES.some((prefix) => pkg === prefix.replace(/\.$/, '') || pkg.startsWith(prefix))
}

/**
 * The package a class belongs to, from an import statement.
 *
 * `import static a.b.C.member;` and `import a.b.C;` both reduce to `a.b`. Wildcard
 * imports are already a package. This over-approximates for nested classes
 * (`a.b.Outer.Inner` gives `a.b.Outer`), which is fine: the report groups by the
 * top three segments anyway.
 */
export function packageOf(importLine: string): string | null {
  const m = importLine.match(/^\s*import\s+(?:static\s+)?([\w.$*]+)\s*;?/)
  if (!m) return null
  const target = m[1].replace(/\.\*$/, '')
  const parts = target.split('.').filter(Boolean)
  if (parts.length < 2) return null
  if (parts.some((p) => p === '*' || !/^[A-Za-z_$][\w$]*$/.test(p))) return null
  // A class name is the last, capitalised segment; strip it and any nested ones.
  while (parts.length > 1 && /^[A-Z]/.test(parts[parts.length - 1])) parts.pop()
  return parts.join('.')
}

/** The `com.foo` prefix that groups a dependency: three segments, or two if short. */
export function groupOf(pkg: string): string {
  const parts = pkg.split('.')
  if (parts.length <= 3) return pkg
  // com.simibubi.create.content.kinetics → com.simibubi.create
  return parts.slice(0, 3).join('.')
}

const SKIP_DIRS = new Set(['build', 'out', '.gradle', '.git', 'run', 'logs', '.idea', 'node_modules', '.agent', 'reference'])
const MAX_FILES = 4000

/**
 * Imports in a source tree.
 *
 * Bounded deliberately: a decompiled fork can hold tens of thousands of files, and
 * a scanner that takes a minute is one a user stops running.
 */
export function scanImports(sourceDir: string): { files: number; imports: Map<string, number> } {
  const imports = new Map<string, number>()
  let files = 0
  const walk = (dir: string): void => {
    if (files >= MAX_FILES) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files >= MAX_FILES) return
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name))
        continue
      }
      if (!/\.(java|kt)$/.test(entry.name)) continue
      let text = ''
      try {
        text = fs.readFileSync(path.join(dir, entry.name), 'utf8')
      } catch {
        continue
      }
      files++
      const seen = new Set<string>()
      for (const line of text.split(/\r?\n/)) {
        if (!line.trimStart().startsWith('import ')) continue
        const pkg = packageOf(line)
        if (!pkg || isGamePackage(pkg)) continue
        const group = groupOf(pkg)
        if (seen.has(group)) continue
        seen.add(group)
        imports.set(group, (imports.get(group) ?? 0) + 1)
      }
    }
  }
  if (fs.existsSync(sourceDir)) walk(sourceDir)
  return { files, imports }
}

/**
 * Dependencies declared by the *old* build files.
 *
 * Covers both styles because a ported project can have come from either:
 *
 *   modImplementation "com.simibubi.create:create-fabric:${create_version}"
 *   implementation fg.deobf("curse.maven:jei-238222:5101347")
 *   compileOnly "top.theillusivec4.curios:curios-neoforge:9.0.1"
 *
 * The group is the part before the first colon, which is the same key the import
 * scan produces often enough to merge. A maven coordinate whose group we cannot
 * read is skipped rather than guessed.
 */
export function declaredDependencies(buildFiles: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const file of buildFiles) {
    let text = ''
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split(/\r?\n/)) {
      if (!/(implementation|compileOnly|api|include|modCompileOnly)\b/i.test(line)) continue
      if (line.trimStart().startsWith('//')) continue
      // The version part may be a Gradle property reference:
      //
      //   modImplementation "com.simibubi.create:create-neoforge:${create_version}"
      //
      // An earlier pattern excluded `$` from the version class, which made the
      // closing quote impossible to reach and dropped the whole coordinate — so a
      // dependency declared with a property (the normal style) was invisible, and
      // the report said the project needed nothing. Capture anything up to the
      // quote, then decide whether it is a literal version.
      for (const m of line.matchAll(/["']([\w.-]+):([\w.-]+)(?::([^"']*))?["']/g)) {
        const group = m[1]
        const raw = (m[3] ?? '').trim()
        if (!group || isGamePackage(group)) continue
        // `$prop` / `${prop}` is not a version we know; leaving it out is honest.
        const version = raw && !/[$%]|\$\{/.test(raw) ? raw : ''
        const list = out.get(group) ?? []
        if (version && !list.includes(version)) list.push(version)
        // Declaring the group is the point; an unknown version still counts.
        out.set(group, list)
      }
    }
  }
  return out
}

/** Candidate build files for a project, old or new. */
export function buildFilesIn(dir: string): string[] {
  const names = ['build.gradle', 'build.gradle.kts', 'gradle.properties']
  return names.map((n) => path.join(dir, n)).filter((p) => {
    try {
      return fs.statSync(p).isFile()
    } catch {
      return false
    }
  })
}

export interface DependencyScan {
  /** Source tree that was read, for the report. */
  sourceDir: string
  filesScanned: number
  /** Everything found, most-used first. */
  dependencies: Dependency[]
  /**
   * Game classes were reported as missing while scanning. Present only when the
   * caller passed build errors: it means the build file is wrong, not that a
   * dependency is missing.
   */
  gameClassErrors: string[]
}

export interface ScanOptions {
  /** Root of the project to scan. */
  dir: string
  /** Relative source root; `src/main/java` when omitted. */
  sourceRoot?: string
  /**
   * Errors from a failed build. When present, they decide which of the two
   * problems this is: a missing Minecraft class is a build-file problem, and
   * saying "download Create" would not help.
   */
  buildErrors?: string[]
}

/**
 * Turn a failed build's messages into the two categories that need different
 * answers. Exported so the build panel and the report agree.
 */
export function classifyBuildErrors(errors: string[]): {
  gameClasses: string[]
  externalPackages: string[]
} {
  const gameClasses: string[] = []
  const externalPackages: string[] = []
  for (const raw of errors) {
    const line = raw.replace(/\s+/g, ' ').trim()
    const missing = line.match(/(?:package|symbol:?\s+class)\s+([\w.$]+)\s+does not exist/i) ?? line.match(/cannot find symbol.*?class\s+([\w.$]+)/i)
    if (!missing) continue
    const pkg = missing[1].replace(/\.\*$/, '')
    if (isGamePackage(pkg)) gameClasses.push(pkg)
    else externalPackages.push(groupOf(pkg))
  }
  return { gameClasses: [...new Set(gameClasses)], externalPackages: [...new Set(externalPackages)] }
}

/**
 * Scan a project for what it needs beyond the game.
 *
 * The output is split by kind because the answer differs completely: a `game`
 * entry means "your build file does not resolve Minecraft at this version", a
 * `mod` entry means "the port dropped a dependency, add it back", and a
 * `library` entry means "this is a maven artefact, not a mod".
 */
export function scanDependencies(opts: ScanOptions): DependencyScan {
  const sourceDir = path.join(opts.dir, opts.sourceRoot || path.join('src', 'main', 'java'))
  const { files, imports } = scanImports(sourceDir)
  const declared = declaredDependencies(buildFilesIn(opts.dir))
  const classified = classifyBuildErrors(opts.buildErrors ?? [])

  const dependencies: Dependency[] = []
  for (const [pkg, count] of imports) {
    const known = KNOWN.find((k) => k.match.test(pkg))
    const declaredVersions = declared.get(pkg) ?? findDeclaredByPrefix(declared, pkg)
    dependencies.push({
      package: pkg,
      name: known?.name,
      kind: known?.kind ?? (isGamePackage(pkg) ? 'game' : guessKind(pkg)),
      files: count,
      declared: declaredVersions.length ? declaredVersions : undefined,
      homepage: known?.homepage,
      note: dependencyNote(known?.kind ?? guessKind(pkg), declaredVersions.length > 0)
    })
  }

  // Declared but not imported: a dependency the port should carry even though this
  // particular source tree does not touch it yet (an API used only from resources,
  // or a mixin config). Reporting it is the difference between "the build works"
  // and "the build works until someone opens the one class that uses it".
  for (const [pkg, versions] of declared) {
    if (dependencies.some((d) => d.package === pkg || d.package.startsWith(`${pkg}.`))) continue
    if (isGamePackage(pkg)) continue
    const known = KNOWN.find((k) => k.match.test(pkg))
    dependencies.push({
      package: pkg,
      name: known?.name,
      kind: known?.kind ?? guessKind(pkg),
      files: 0,
      declared: versions.length ? versions : undefined,
      homepage: known?.homepage,
      note: 'Declared in the old build file but not imported by any source file.'
    })
  }

  dependencies.sort((a, b) => b.files - a.files || a.package.localeCompare(b.package))
  return {
    sourceDir,
    filesScanned: files,
    dependencies,
    gameClassErrors: classified.gameClasses
  }
}

function findDeclaredByPrefix(declared: Map<string, string[]>, pkg: string): string[] {
  for (const [group, versions] of declared) {
    if (pkg === group || pkg.startsWith(`${group}.`)) return versions
  }
  return []
}

function guessKind(pkg: string): DependencyKind {
  if (isGamePackage(pkg)) return 'game'
  if (/^(org|com|net|io|dev)\.[\w.]+/.test(pkg)) {
    // No reliable signal at this level; a library that is not a mod is the common
    // case for a group that is not a mod's own namespace.
    return 'library'
  }
  return 'unknown'
}

function dependencyNote(kind: DependencyKind, declared: boolean): string | undefined {
  if (kind === 'game') return 'Comes from Minecraft or the loader — nothing to download.'
  if (declared) return 'Declared in the old build file. The port needs it declared again for the new loader.'
  return 'Imported by the sources but not declared anywhere.'
}
