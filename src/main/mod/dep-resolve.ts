import fs from 'node:fs'
import path from 'node:path'
import type { Dependency } from './deps'

/**
 * Finding a real download for a dependency, and declaring it in the build file.
 *
 * Two separate jobs, deliberately in one module because they answer one question:
 * "can this project be made to compile, and what exactly is going to be added?"
 *
 *  - **Finding** a file. Modrinth's API is the only source here that returns a
 *    direct download link for a mod, keyed by Minecraft version and loader. The
 *    search is by name, because an import package (`com.simibubi.create`) is not
 *    a Modrinth slug.
 *  - **Declaring** it. A downloaded jar in `libs/` is not enough on its own: gradle
 *    must be told about it. Adding `implementation files('libs/x.jar')` compiles
 *    against the class files without needing a maven coordinate, which is the
 *    difference between "the file is there" and "the build works".
 */

export interface DependencyCandidate {
  /** Where the offer came from. */
  source: 'modrinth' | 'manual'
  name: string
  /** Modrinth project id, for a second request to pick a version. */
  projectId?: string
  slug?: string
  homepage?: string
  description?: string
  downloads?: number
  /** Whether the project publishes builds for the asked-for loader. */
  loaders?: string[]
}

export interface DependencyFile {
  name: string
  url: string
  /** The Modrinth version id, for a stable record. */
  versionId?: string
  /** The version number as the author writes it. */
  versionNumber?: string
  /** Files that only matter for development (`-dev`, `-sources`). */
  primary: boolean
  size?: number
}

const UA = { 'User-Agent': 'MC-Forge-Agent' }

async function getJson<T>(url: string, timeoutMs = 20000): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal, headers: UA })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

/** The words worth searching for: `com.simibubi.create` is not a Modrinth query. */
export function searchTermFor(dep: Pick<Dependency, 'name' | 'package'>): string {
  if (dep.name) {
    // "a Vazkii mod (Botania/Quark)" searches badly; keep the leading word.
    const clean = dep.name.replace(/\s*\(.*\)\s*$/, '').replace(/^a /i, '').trim()
    if (clean) return clean
  }
  const parts = dep.package.split('.')
  // com.simibubi.create → create ; net.createmod.catnip → createmod
  return parts[2] ?? parts[parts.length - 1] ?? dep.package
}

/**
 * Search Modrinth for a project that could satisfy this dependency.
 *
 * Returns nothing rather than guessing when the API is unreachable: an offline
 * laptop should see "cannot look this up", not a confident wrong answer.
 */
export async function findCandidates(
  dep: Pick<Dependency, 'name' | 'package'>,
  opts: { mcVersion: string; loader: string; limit?: number } = { mcVersion: '', loader: '' }
): Promise<{ ok: boolean; candidates: DependencyCandidate[]; error?: string }> {
  const term = searchTermFor(dep)
  const query = new URLSearchParams({ query: term, limit: String(opts.limit ?? 5) })
  // Facets are optional: an empty loader would filter everything out.
  const facets: string[][] = [['project_type:mod']]
  if (opts.loader) facets.push([`categories:${opts.loader}`])
  if (opts.mcVersion) facets.push([`versions:${opts.mcVersion}`])
  query.set('facets', JSON.stringify(facets))
  try {
    const res = await getJson<{
      hits: {
        project_id: string
        slug: string
        title: string
        description: string
        downloads: number
        categories?: string[]
      }[]
    }>(`https://api.modrinth.com/v2/search?${query.toString()}`)
    return {
      ok: true,
      candidates: (res.hits ?? []).map((h) => ({
        source: 'modrinth' as const,
        name: h.title,
        projectId: h.project_id,
        slug: h.slug,
        homepage: `https://modrinth.com/mod/${h.slug}`,
        description: h.description,
        downloads: h.downloads,
        loaders: h.categories
      }))
    }
  } catch (e) {
    return { ok: false, candidates: [], error: `Could not reach Modrinth: ${(e as Error).message}` }
  }
}

/**
 * The file to download for a project on a specific Minecraft version and loader.
 *
 * Modrinth lists versions newest-first; the first with a normal jar is the one to
 * offer. A `-dev` or `-sources` jar is not a usable mod dependency, so a version
 * with only those is skipped rather than offered and then failing to compile.
 */
export async function findVersionFile(
  projectId: string,
  opts: { mcVersion: string; loader: string }
): Promise<{ ok: boolean; file?: DependencyFile; versionId?: string; error?: string }> {
  // Omitting the loaders parameter entirely is different from sending []: Modrinth
  // treats an empty list as "no loader matches" and returns nothing.
  const query = new URLSearchParams()
  if (opts.loader) query.set('loaders', JSON.stringify([opts.loader]))
  if (opts.mcVersion) query.set('game_versions', JSON.stringify([opts.mcVersion]))
  try {
    const versions = await getJson<
      {
        id: string
        version_number: string
        files: { url: string; filename: string; primary: boolean; size?: number }[]
      }[]
    >(`https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}/version?${query.toString()}`)
    for (const v of versions ?? []) {
      const file = (v.files ?? []).find((f) => f.primary && !/-sources|-javadoc/i.test(f.filename)) ?? v.files?.[0]
      if (!file) continue
      if (/-sources|-javadoc/i.test(file.filename)) continue
      return {
        ok: true,
        versionId: v.id,
        file: {
          name: file.filename,
          url: file.url,
          versionId: v.id,
          versionNumber: v.version_number,
          primary: file.primary,
          size: file.size
        }
      }
    }
    return { ok: false, error: `No ${opts.loader || 'matching'} build for Minecraft ${opts.mcVersion}.` }
  } catch (e) {
    return { ok: false, error: `Could not read versions: ${(e as Error).message}` }
  }
}

/** Where the app puts a downloaded dependency jar. */
export function libsDir(projectDir: string): string {
  return path.join(projectDir, 'libs')
}

/**
 * Write a jar into `libs/` and declare it in the build file.
 *
 * The declaration is `implementation files(...)` rather than a maven coordinate
 * on purpose: a coordinate needs a repository that happens to be up and a version
 * that happens to match, while the jar we just downloaded is the exact file the
 * user chose. It also means the build works offline afterwards.
 *
 * Idempotent: adding the same jar twice does not produce two lines.
 */
export function declareJarDependency(projectDir: string, jarPath: string): { ok: boolean; added: boolean; error?: string } {
  const build = ['build.gradle', 'build.gradle.kts']
    .map((n) => path.join(projectDir, n))
    .find((p) => {
      try {
        return fs.statSync(p).isFile()
      } catch {
        return false
      }
    })
  if (!build) return { ok: false, added: false, error: 'No build.gradle or build.gradle.kts in this project.' }

  const rel = path.relative(projectDir, jarPath).replace(/\\/g, '/')
  const line = `    implementation files('${rel}')`
  let text = ''
  try {
    text = fs.readFileSync(build, 'utf8')
  } catch (e) {
    return { ok: false, added: false, error: (e as Error).message }
  }
  if (text.includes(`files('${rel}')`) || text.includes(`files("${rel}")`)) {
    return { ok: true, added: false }
  }

  const block = /(^dependencies\s*\{)/m.exec(text)
  if (!block) {
    // Some generated builds have no dependencies block at all (an old flatDir
    // template). Appending one is valid gradle and better than failing.
    const next = `${text.trimEnd()}\n\ndependencies {\n${line}\n}\n`
    fs.writeFileSync(build, next, 'utf8')
    return { ok: true, added: true }
  }
  const start = block.index + block[0].length
  const next = `${text.slice(0, start)}\n${line}${text.slice(start)}`
  fs.writeFileSync(build, next, 'utf8')
  return { ok: true, added: true }
}

/**
 * The repositories a file-based dependency still needs.
 *
 * `files(...)` needs none, but the maven coordinates a ported project keeps do,
 * and a generated build file for Forge/NeoForge may not list Modrinth's maven.
 */
export function hasModrinthRepo(buildFileText: string): boolean {
  return /maven\.modrinth\.com/i.test(buildFileText)
}
