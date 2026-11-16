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

/* ------------------------------------------------------- identifying what a jar is */

/**
 * The SHA-1 of a jar, which is how Modrinth identifies a file exactly.
 *
 * Matching by file name is guesswork — packs rename jars, and two builds of the
 * same mod can share a name. The hash is the same identifier Modrinth itself uses
 * for deduplication, so a lookup by it either finds the exact project and version
 * or finds nothing. Nothing is a fine answer; a wrong match is not.
 */
export async function sha1Of(file: string): Promise<string | null> {
  const crypto = await import('node:crypto')
  return new Promise((resolve) => {
    try {
      const hash = crypto.createHash('sha1')
      const stream = fs.createReadStream(file)
      stream.on('data', (chunk) => hash.update(chunk))
      stream.on('error', () => resolve(null))
      stream.on('end', () => resolve(hash.digest('hex')))
    } catch {
      resolve(null)
    }
  })
}

export interface IdentifiedFile {
  /** The jar this hash came from, so the caller can map back. */
  path: string
  hash: string
  projectId?: string
  /** The version this exact file is; the newest version is what an update compares to. */
  versionId?: string
  versionNumber?: string
  projectSlug?: string
  projectName?: string
}

/**
 * Resolve many jars to Modrinth projects in one request.
 *
 * `/v2/version_files` takes up to a few hundred hashes at once, which is the
 * difference between a scan of 200 mods taking two seconds and taking four
 * minutes. Jars the service has never seen are simply absent from the answer.
 */
export async function identifyFiles(files: { path: string; hash: string }[]): Promise<{ ok: boolean; found: IdentifiedFile[]; error?: string }> {
  if (!files.length) return { ok: true, found: [] }
  const byHash = new Map(files.map((f) => [f.hash, f.path]))
  try {
    const res = await fetch('https://api.modrinth.com/v2/version_files', {
      method: 'POST',
      headers: { ...UA, 'Content-Type': 'application/json' },
      body: JSON.stringify({ hashes: [...byHash.keys()], algorithm: 'sha1' })
    })
    if (!res.ok) return { ok: false, found: [], error: `Modrinth answered HTTP ${res.status}` }
    const data = (await res.json()) as Record<
      string,
      { id: string; version_number: string; project_id: string }
    >
    const found: IdentifiedFile[] = []
    for (const [hash, version] of Object.entries(data ?? {})) {
      found.push({
        path: byHash.get(hash) ?? '',
        hash,
        projectId: version.project_id,
        versionId: version.id,
        versionNumber: version.version_number
      })
    }
    return { ok: true, found }
  } catch (e) {
    return { ok: false, found: [], error: `Could not reach Modrinth: ${(e as Error).message}` }
  }
}

/** Project names and slugs for a set of ids, so a report can say "Create" not "PtS8h". */
export async function projectInfo(ids: string[]): Promise<Record<string, { title: string; slug: string }>> {
  const unique = [...new Set(ids)].filter(Boolean)
  if (!unique.length) return {}
  try {
    const res = await fetch(`https://api.modrinth.com/v2/projects?ids=${encodeURIComponent(JSON.stringify(unique))}`, {
      headers: UA
    })
    if (!res.ok) return {}
    const list = (await res.json()) as { id: string; title: string; slug: string }[]
    return Object.fromEntries((list ?? []).map((p) => [p.id, { title: p.title, slug: p.slug }]))
  } catch {
    return {}
  }
}

/** The newest version of a project for a game version and loader, or null. */
export async function newestVersionFor(
  projectId: string,
  opts: { mcVersion: string; loader: string }
): Promise<{ id: string; versionNumber: string; file: DependencyFile } | null> {
  const res = await findVersionFile(projectId, opts)
  if (!res.ok || !res.file || !res.versionId) return null
  return { id: res.versionId, versionNumber: res.file.versionNumber ?? '', file: res.file }
}
