/**
 * Every Minecraft version and every loader version, fetched live.
 *
 * This is what lets the app support a Minecraft version that shipped after the
 * exe was built: nothing about the list is hard-coded beyond a bundled fallback
 * that is only used when the network is unavailable.
 *
 * Sources (all public, no key):
 *   Mojang      https://piston-meta.mojang.com/mc/game/version_manifest_v2.json
 *   Fabric      https://meta.fabricmc.net/v2/versions/game, /v2/versions/loader/<mc>
 *   NeoForge    https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml
 *   Forge       https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json
 *
 * Results are cached on disk for a day so opening the New Mod dialog is instant
 * and works offline with what was last seen.
 */
import fs from 'node:fs'
import path from 'node:path'
import { userDataDir } from '../config'

export type Loader = 'neoforge' | 'forge' | 'fabric'

export interface McVersion {
  id: string
  type: 'release' | 'snapshot' | 'old_beta' | 'old_alpha'
  releasedAt: string
  /** Java major required by this version, from the version json when known. */
  javaMajor?: number
}

export interface LoaderVersion {
  /** The loader's own version string, e.g. 21.1.265, 47.2.0, 0.16.9. */
  version: string
  /** Minecraft versions this loader build is known to support. */
  mcVersions: string[]
  /** Fabric only: newest Fabric API build per game version, e.g. 0.110.0+1.21.1. */
  apiByMc?: Record<string, string>
  /** Fabric only: newest yarn mappings build per game version, e.g. 1.21.1+build.3. */
  yarnByMc?: Record<string, string>
}

export interface Catalog {
  fetchedAt: number
  minecraft: McVersion[]
  loaders: {
    neoforge: LoaderVersion[]
    forge: LoaderVersion[]
    fabric: LoaderVersion[]
  }
  /** Per-source error text, so the UI can say what failed without hiding the rest. */
  errors: string[]
}

/** Oldest version the app will generate a project for. */
export const MIN_MC_VERSION = '1.2.5'

const CACHE_TTL_MS = 24 * 60 * 60 * 1000

function cacheFile(): string {
  return path.join(userDataDir(), 'cache', 'catalog.json')
}

function readCache(): Catalog | null {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')) as Catalog
    if (!raw?.minecraft?.length) return null
    return raw
  } catch {
    return null
  }
}

function writeCache(catalog: Catalog): void {
  try {
    fs.mkdirSync(path.dirname(cacheFile()), { recursive: true })
    fs.writeFileSync(cacheFile(), JSON.stringify(catalog), 'utf8')
  } catch {
    /* a cache write failure must not break the dialog */
  }
}

async function getJson<T>(url: string, timeoutMs = 20000): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'MC-Forge-Agent' }
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

async function getText(url: string, timeoutMs = 20000): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'MC-Forge-Agent' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

/** Minecraft versions, newest first. */
export async function fetchMinecraftVersions(): Promise<McVersion[]> {
  const manifest = await getJson<{
    latest: { release: string }
    versions: { id: string; type: string; releaseTime: string; url: string }[]
  }>('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')
  return manifest.versions.map((v) => ({
    id: v.id,
    type: (v.type as McVersion['type']) ?? 'release',
    releasedAt: v.releaseTime ?? ''
  }))
}

/**
 * NeoForge versions. The maven metadata lists them flat (21.1.265); the
 * Minecraft version is the "21.1" prefix, i.e. 1.<major>.<minor>.
 */
export async function fetchNeoForgeVersions(): Promise<LoaderVersion[]> {
  const xml = await getText('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml')
  const all = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1])
  const out: LoaderVersion[] = []
  for (const v of all) {
    // Skip prereleases and betas unless nothing else exists for that line.
    if (/(beta|alpha|rc)/i.test(v)) continue
    const m = v.match(/^(\d+)\.(\d+)\./)
    if (!m) continue
    out.push({ version: v, mcVersions: [`1.${m[1]}.${m[2]}`] })
  }
  return out
}

/** Forge promotions: {"1.21.1-recommended":"52.0.2","1.20.1-latest":"47.3.0"} */
export async function fetchForgeVersions(): Promise<LoaderVersion[]> {
  const json = await getJson<Record<string, string>>('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json')
  const out: LoaderVersion[] = []
  for (const [key, version] of Object.entries(json)) {
    if (key.endsWith('-latest') || key.endsWith('-beta')) continue
    const mc = key.replace(/-recommended$/, '')
    out.push({ version, mcVersions: [mc] })
  }
  return out
}

/**
 * Fabric API builds. The maven metadata is grouped by game version:
 * `<version>0.110.0+1.21.1</version>`, so "newest build for 1.21.1" is the last
 * match for that suffix. Missing Fabric API is not fatal — the project still
 * builds without it, the mod just cannot call its helpers.
 */
async function fetchFabricApiVersions(): Promise<Record<string, string>> {
  const xml = await getText('https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/maven-metadata.xml')
  const all = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1])
  const out: Record<string, string> = {}
  for (const v of all) {
    if (/-SNAPSHOT$/i.test(v)) continue
    const plus = v.indexOf('+')
    if (plus < 0) continue
    // Later entries in the metadata are newer, so keep overwriting.
    out[v.slice(plus + 1)] = v
  }
  return out
}

/** Newest yarn mappings build per game version, from `1.21.1+build.3` tags. */
async function fetchYarnBuilds(): Promise<Record<string, string>> {
  const xml = await getText('https://maven.fabricmc.net/net/fabricmc/yarn/maven-metadata.xml')
  const all = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1])
  const best: Record<string, number> = {}
  const tagged: Record<string, string> = {}
  for (const v of all) {
    const m = v.match(/^([^+]+)\+build\.(\d+)$/)
    if (!m) continue
    const build = Number(m[2])
    if (!best[m[1]] || build > best[m[1]]) {
      best[m[1]] = build
      tagged[m[1]] = v
    }
  }
  return tagged
}

/** Fabric: one loader build serves many game versions, so build a mapping. */
export async function fetchFabricVersions(): Promise<LoaderVersion[]> {
  const games = await getJson<{ version: string; stable: boolean }[]>('https://meta.fabricmc.net/v2/versions/game')
  const supported = games.filter((g) => g.stable !== false).map((g) => g.version)
  // The loader list is the same for every game version; fetch it once and attach
  // the versions Fabric itself reports as supported.
  const loaders = await getJson<{ version: string; stable: boolean }[]>('https://meta.fabricmc.net/v2/versions/loader')
  // Neither of these is fatal on its own: without them the project still builds,
  // the generated gradle.properties just falls back to a plain `<mc>+build.1`.
  const [apiByMc, yarnByMc] = await Promise.all([
    fetchFabricApiVersions().catch(() => ({}) as Record<string, string>),
    fetchYarnBuilds().catch(() => ({}) as Record<string, string>)
  ])
  return loaders
    .filter((l) => l.stable)
    .slice(0, 12)
    .map((l) => ({ version: l.version, mcVersions: supported, apiByMc, yarnByMc }))
}

/** Fabric API and yarn builds for one game version. */
export function fabricExtrasFor(
  catalog: Catalog,
  loaderVersion: string,
  mcVersion: string
): { fabricApi?: string; yarnMappings?: string } {
  const entry =
    catalog.loaders.fabric.find((l) => l.version === loaderVersion) ?? catalog.loaders.fabric[0]
  return {
    fabricApi: entry?.apiByMc?.[mcVersion],
    yarnMappings: entry?.yarnByMc?.[mcVersion]
  }
}

/**
 * Return the catalog, from cache when fresh. Individual sources are allowed to
 * fail: one unreachable host must not empty the whole list.
 */
export async function getCatalog(opts: { force?: boolean } = {}): Promise<Catalog> {
  const cached = readCache()
  if (!opts.force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached

  const errors: string[] = []
  const [minecraft, neo, forge, fabric] = await Promise.all([
    fetchMinecraftVersions().catch((e) => {
      errors.push(`Minecraft versions: ${(e as Error).message}`)
      return null
    }),
    fetchNeoForgeVersions().catch((e) => {
      errors.push(`NeoForge: ${(e as Error).message}`)
      return null
    }),
    fetchForgeVersions().catch((e) => {
      errors.push(`Forge: ${(e as Error).message}`)
      return null
    }),
    fetchFabricVersions().catch((e) => {
      errors.push(`Fabric: ${(e as Error).message}`)
      return null
    })
  ])

  const merged: Catalog = {
    fetchedAt: Date.now(),
    minecraft: minecraft ?? cached?.minecraft ?? FALLBACK_MINECRAFT,
    loaders: {
      neoforge: neo ?? cached?.loaders.neoforge ?? FALLBACK_NEOFORGE,
      forge: forge ?? cached?.loaders.forge ?? FALLBACK_FORGE,
      fabric: fabric ?? cached?.loaders.fabric ?? FALLBACK_FABRIC
    },
    errors
  }
  // Keep the previous copy if everything failed, so the app degrades instead of emptying.
  if (minecraft || neo || forge || fabric) writeCache(merged)
  return merged
}

/** Cached catalog for synchronous callers (IPC handlers that must answer at once). */
export function cachedCatalog(): Catalog | null {
  return readCache()
}

// ---------------------------------------------------------------- fallbacks

/**
 * A small bundled list, used only when the network is unavailable and nothing
 * has been cached. Deliberately covers one version per era so generation still
 * works offline; `getCatalog()` replaces it as soon as a fetch succeeds.
 */
export const FALLBACK_MINECRAFT: McVersion[] = [
  { id: '1.21.4', type: 'release', releasedAt: '2024-12-03' },
  { id: '1.21.1', type: 'release', releasedAt: '2024-08-08' },
  { id: '1.20.1', type: 'release', releasedAt: '2023-06-12' },
  { id: '1.19.2', type: 'release', releasedAt: '2022-08-05' },
  { id: '1.18.2', type: 'release', releasedAt: '2022-02-28' },
  { id: '1.16.5', type: 'release', releasedAt: '2021-01-14' },
  { id: '1.12.2', type: 'release', releasedAt: '2017-09-18' },
  { id: '1.10.2', type: 'release', releasedAt: '2016-11-11' },
  { id: '1.8.9', type: 'release', releasedAt: '2015-12-09' },
  { id: '1.7.10', type: 'release', releasedAt: '2014-06-26' },
  { id: '1.6.4', type: 'release', releasedAt: '2013-09-19' },
  { id: '1.5.2', type: 'release', releasedAt: '2013-05-02' },
  { id: '1.4.7', type: 'release', releasedAt: '2013-01-09' },
  { id: '1.2.5', type: 'release', releasedAt: '2012-04-04' }
]

export const FALLBACK_NEOFORGE: LoaderVersion[] = [
  { version: '21.4.95', mcVersions: ['1.21.4'] },
  { version: '21.1.265', mcVersions: ['1.21.1'] },
  { version: '21.0.167', mcVersions: ['1.21.0'] },
  { version: '20.6.119', mcVersions: ['1.20.6'] },
  { version: '20.4.237', mcVersions: ['1.20.4'] }
]

export const FALLBACK_FORGE: LoaderVersion[] = [
  { version: '52.0.2', mcVersions: ['1.21.1'] },
  { version: '51.0.33', mcVersions: ['1.21.0'] },
  { version: '47.3.0', mcVersions: ['1.20.1'] },
  { version: '43.3.5', mcVersions: ['1.19.2'] },
  { version: '40.2.17', mcVersions: ['1.18.2'] },
  { version: '36.2.39', mcVersions: ['1.16.5'] },
  { version: '14.23.5.2860', mcVersions: ['1.12.2'] },
  { version: '12.18.3.2511', mcVersions: ['1.10.2'] },
  { version: '11.15.1.2318', mcVersions: ['1.8.9'] },
  { version: '10.13.4.1614', mcVersions: ['1.7.10'] },
  { version: '9.11.1.1345', mcVersions: ['1.6.4'] },
  { version: '7.10.1.727', mcVersions: ['1.5.2'] },
  { version: '6.6.2.534', mcVersions: ['1.4.7'] },
  { version: '3.4.9.171', mcVersions: ['1.2.5'] }
]

export const FALLBACK_FABRIC: LoaderVersion[] = [
  {
    version: '0.16.9',
    mcVersions: ['1.21.4', '1.21.3', '1.21.1', '1.20.4', '1.20.1', '1.19.2', '1.18.2', '1.16.5', '1.15.2', '1.14.4']
  }
]

// ---------------------------------------------------------------- queries

export function loaderVersionsFor(catalog: Catalog, loader: Loader, mcVersion: string): LoaderVersion[] {
  return catalog.loaders[loader].filter((l) => l.mcVersions.includes(mcVersion))
}

/** Which loaders offer this Minecraft version at all. */
export function loadersFor(catalog: Catalog, mcVersion: string): Loader[] {
  const out: Loader[] = []
  for (const loader of ['neoforge', 'forge', 'fabric'] as Loader[]) {
    if (loaderVersionsFor(catalog, loader, mcVersion).length) out.push(loader)
  }
  return out
}

/** Compare dotted Minecraft versions numerically (1.21.10 > 1.21.9). */
export function compareMcVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number(x) || 0)
  const pb = b.split(/[.-]/).map((x) => Number(x) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

/** Releases from MIN_MC_VERSION up, newest first, with snapshots optional. */
export function selectableVersions(catalog: Catalog, opts: { snapshots?: boolean } = {}): McVersion[] {
  return catalog.minecraft
    .filter((v) => (opts.snapshots ? v.type === 'release' || v.type === 'snapshot' : v.type === 'release'))
    .filter((v) => compareMcVersions(v.id, MIN_MC_VERSION) >= 0)
    .sort((a, b) => compareMcVersions(b.id, a.id))
}
