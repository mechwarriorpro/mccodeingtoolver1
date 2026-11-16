import fs from 'node:fs'
import path from 'node:path'
import AdmZip from 'adm-zip'

/**
 * Getting the real Minecraft sources onto disk.
 *
 * This exists because `genSources` is **not a universal task**. It is a Fabric
 * Loom task; ModDevGradle has no such task and produces
 * `build/moddev/artifacts/minecraft-patched-<ver>-sources.jar` as a side effect
 * of configuring the project; NeoGradle and ForgeGradle name theirs
 * `createMinecraftArtifacts`. An agent told "run genSources" on a NeoForge
 * project gets "Task 'genSources' not found", concludes the toolchain is broken,
 * and goes back to guessing class names — which is the exact failure this is
 * meant to stop.
 *
 * So: look for the jar first (it is often already there, no Gradle run at all),
 * and only ask Gradle to make one when it is genuinely missing.
 */

export interface SourceJar {
  /** Absolute path to a jar containing .java files. */
  file: string
  /** Which toolchain produced it, for saying so plainly. */
  origin: 'moddevgradle' | 'neogradle' | 'forgegradle' | 'loom' | 'neoform-cache' | 'unknown'
  /** Loader whose classes this jar is expected to contain. */
  loader: 'neoforge' | 'forge' | 'fabric'
}

/**
 * Where each toolchain drops its decompiled jar.
 *
 * Ordered most-specific first: `build/moddev` is checked before the caches so a
 * project that has already built never triggers a Gradle run.
 */
const CANDIDATE_GLOBS: { dir: string; test: (name: string) => boolean; origin: SourceJar['origin'] }[] = [
  {
    dir: 'build/moddev/artifacts',
    test: (n) => n.endsWith('-sources.jar') || (n.includes('sources') && n.endsWith('.jar')) || n.endsWith('-merged.jar'),
    origin: 'moddevgradle'
  },
  { dir: 'build/moddev', test: (n) => n.endsWith('.jar') && n.includes('sources'), origin: 'moddevgradle' },
  { dir: 'build/neoform', test: (n) => n.endsWith('sources.jar') || n.endsWith('-sources.jar'), origin: 'forgegradle' },
  { dir: 'build/neoformruntime', test: (n) => n.endsWith('sources.jar'), origin: 'forgegradle' },
  { dir: 'build/mods', test: (n) => n.endsWith('-sources.jar'), origin: 'unknown' }
]

/**
 * Fabric Loom keeps its output outside the project, under the Gradle cache:
 * `~/.gradle/caches/fabric-loom/<mc>/minecraftMaven/net/minecraft/minecraft-common/`.
 * The version folder varies, so it is walked rather than constructed.
 */
const LOOM_ROOT = ['caches', 'fabric-loom']

function listJars(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.jar'))
      .map((e) => path.join(dir, e.name))
  } catch {
    return []
  }
}

function walkDirs(root: string, depth: number, visit: (dir: string) => void): void {
  if (depth < 0) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  visit(root)
  for (const e of entries) if (e.isDirectory()) walkDirs(path.join(root, e.name), depth - 1, visit)
}

/**
 * Does this jar actually contain Java source?
 *
 * Name-based guesses are not enough — `-merged.jar` and `-sources.jar` are both
 * produced by ModDevGradle and only one has readable text in it. Reading the
 * entry list is cheap (the central directory, not the entries) and turns a
 * guess into a fact.
 */
export function jarHasSources(file: string): boolean {
  try {
    const zip = new AdmZip(file)
    let seen = 0
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory || !entry.entryName.endsWith('.java')) continue
      seen++
      if (seen >= 3) return true
    }
    return seen > 0
  } catch {
    return false
  }
}

/**
 * Find a sources jar that is already on disk. Returns `null` if the project has
 * never been built with source generation enabled, which is common.
 */
export function findExistingSources(workspaceDir: string, gradleHome: string): SourceJar[] {
  const found: SourceJar[] = []
  const push = (file: string, origin: SourceJar['origin']): void => {
    if (found.some((f) => f.file === file)) return
    found.push({ file, origin, loader: 'neoforge' })
  }

  for (const c of CANDIDATE_GLOBS) {
    const dir = path.join(workspaceDir, c.dir)
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jar') || !c.test(e.name)) continue
      push(path.join(dir, e.name), c.origin)
    }
  }

  // Loom: ~/.gradle/caches/fabric-loom/<mc>/...
  const loom = path.join(gradleHome, ...LOOM_ROOT)
  walkDirs(
    loom,
    4,
    (dir) => {
      for (const jar of listJars(dir)) {
        const name = path.basename(jar).toLowerCase()
        if (name.includes('source')) push(jar, 'loom')
      }
    }
  )

  // NeoForm runtime keeps one copy per version and every toolchain copies from
  // it, so this is the fallback when a build folder was cleaned.
  walkDirs(
    path.join(gradleHome, 'caches', 'neoformruntime'),
    3,
    (dir) => {
      for (const jar of listJars(dir)) if (path.basename(jar).toLowerCase().includes('source')) push(jar, 'neoform-cache')
    }
  )

  // Only keep jars that really contain .java, most-likely first.
  const rank: Record<SourceJar['origin'], number> = {
    moddevgradle: 0,
    neogradle: 1,
    loom: 2,
    forgegradle: 3,
    'neoform-cache': 4,
    unknown: 5
  }
  return found
    .map((f) => ({ f, ok: jarHasSources(f.file) }))
    .filter((x) => x.ok)
    .map((x) => x.f)
    .sort((a, b) => rank[a.origin] - rank[b.origin])
}

/**
 * The Gradle task that will produce a sources jar for this toolchain, or `null`
 * when no such task exists and the jar appears as a side effect instead.
 *
 * Getting this wrong is worse than saying "no task": a failed Gradle run reads
 * as a broken project, and the agent then stops rather than fixing it.
 */
export function sourceTaskFor(loader: 'neoforge' | 'forge' | 'fabric', buildGradle: string): string | null {
  if (loader === 'fabric') return 'genSources'
  if (/net\.neoforged\.gradle\.moddev/i.test(buildGradle)) return null // side effect of any build
  if (loader === 'neoforge') return /neogradle|net\.neoforged\.gradle\.userdev/i.test(buildGradle) ? 'createMinecraftArtifacts' : null
  return 'createMinecraftArtifacts' // ForgeGradle
}

/** Read the build file, if there is one, so the task can be chosen from it. */
export function readBuildGradle(workspaceDir: string): string {
  for (const name of ['build.gradle', 'build.gradle.kts']) {
    try {
      return fs.readFileSync(path.join(workspaceDir, name), 'utf8')
    } catch {
      /* try the next */
    }
  }
  return ''
}

/**
 * Unpack a sources jar into `<workspace>/reference/minecraft-<label>/`.
 *
 * It goes under `reference/` on purpose: that folder is already git-ignored and
 * already excluded from the compile path, and the agent already knows to read it
 * without importing it. Minecraft code is Mojang's and must not end up in a
 * commit or a mod jar.
 */
/**
 * Is this jar entry safe to write inside the project?
 *
 * Jar entries are attacker-controlled in principle — a sources jar comes off the
 * network — and `zip-slip` is the classic way a build tool writes outside the
 * folder it promised to stay in.
 */
export function isSafeEntry(entryName: string): boolean {
  const rel = entryName.replace(/\\/g, '/')
  if (!rel.endsWith('.java')) return false
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return false
  return !rel.split('/').includes('..')
}

export function unpackSources(jar: string, workspaceDir: string, label: string): { ok: boolean; dir?: string; files?: number; error?: string } {
  const target = path.join(workspaceDir, 'reference', `minecraft-${label}`)
  try {
    fs.rmSync(target, { recursive: true, force: true })
    fs.mkdirSync(target, { recursive: true })
    const zip = new AdmZip(jar)
    let files = 0
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory || !isSafeEntry(entry.entryName)) continue
      const rel = entry.entryName.replace(/\\/g, '/')
      const out = path.join(target, rel)
      if (!out.startsWith(target + path.sep)) continue
      fs.mkdirSync(path.dirname(out), { recursive: true })
      fs.writeFileSync(out, entry.getData())
      files++
    }
    if (files === 0) {
      fs.rmSync(target, { recursive: true, force: true })
      return { ok: false, error: 'the jar contains no .java files' }
    }
    return { ok: true, dir: target, files }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/**
 * Where a class lives, so the agent can open exactly the right file.
 *
 * Accepts `Level` or `net.minecraft.world.level.Level`. With a package given it
 * matches the path tail, which also catches inner classes and the
 * `com.mojang.blaze3d` style packages that do not start with `net.minecraft`.
 */
export function locateClass(sourcesDir: string, className: string): string | null {
  const normalized = className.trim().replace(/\./g, '/')
  const simple = normalized.split('/').pop()!
  const wantTail = `${normalized}.java`.toLowerCase()
  let fallback: string | null = null

  const stack = [sourcesDir]
  while (stack.length) {
    const dir = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        stack.push(p)
        continue
      }
      const rel = path.relative(sourcesDir, p).split(path.sep).join('/').toLowerCase()
      if (rel.endsWith(wantTail)) return p
      if (!fallback && rel.endsWith(`/${simple.toLowerCase()}.java`)) fallback = p
    }
  }
  return fallback
}
