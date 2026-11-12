import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

/**
 * Vanilla 1.21.1 metadata. Needed to launch a NeoForge client without a launcher:
 * the game jar, the asset index, and the bootstrap libraries all come from here.
 */
const VERSION_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'

export interface VersionJson {
  id: string
  type: string
  mainClass: string
  assets: string
  assetIndex?: { id: string; sha1: string; size: number; totalSize: number; url: string }
  downloads: { client?: { sha1: string; size: number; url: string } }
  libraries: {
    name: string
    downloads?: { artifact?: { path: string; sha1: string; size: number; url: string } }
    rules?: { action: 'allow' | 'disallow'; os?: { name?: string } }[]
    natives?: Record<string, string>
  }[]
  javaVersion?: { component: string; majorVersion: number }
  arguments?: { game?: (string | { rules?: unknown[]; value: string | string[] })[]; jvm?: (string | { rules?: { action: string; os?: { name?: string } }[]; value: string | string[] })[] }
  minecraftArguments?: string
}

export interface AssetIndex {
  objects: Record<string, { hash: string; size: number }>
}

export function mcDir(): string {
  const dir = path.join(app.getPath('userData'), 'minecraft')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function versionJsonPath(version = '1.21.1'): string {
  return path.join(mcDir(), 'versions', version, `${version}.json`)
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return (await res.json()) as T
}

export async function download(url: string, target: string, sha1?: string, onLine?: (l: string) => void): Promise<void> {
  if (fs.existsSync(target)) {
    if (!sha1) return
    const crypto = await import('node:crypto')
    const hash = crypto.createHash('sha1').update(fs.readFileSync(target)).digest('hex')
    if (hash === sha1) return
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (sha1) {
    const crypto = await import('node:crypto')
    const hash = crypto.createHash('sha1').update(buf).digest('hex')
    if (hash !== sha1) throw new Error(`checksum mismatch for ${path.basename(target)}`)
  }
  fs.writeFileSync(target, buf)
  onLine?.(`[mojang] ${path.basename(target)} (${(buf.length / 1024).toFixed(0)} KB)`)
}

export async function ensureVersionJson(version = '1.21.1', onLine?: (l: string) => void): Promise<VersionJson> {
  const target = versionJsonPath(version)
  if (fs.existsSync(target)) return JSON.parse(fs.readFileSync(target, 'utf8')) as VersionJson
  onLine?.(`[mojang] fetching version manifest for ${version}`)
  const manifest = await fetchJson<{ versions: { id: string; url: string }[] }>(VERSION_MANIFEST)
  const entry = manifest.versions.find((v) => v.id === version)
  if (!entry) throw new Error(`Minecraft ${version} not found in the version manifest`)
  const json = await fetchJson<VersionJson>(entry.url)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify(json, null, 2))
  return json
}

export function libraryAllowed(entry: VersionJson['libraries'][number]): boolean {
  if (!entry.rules || !entry.rules.length) return true
  const osName = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'
  let allowed = false
  for (const rule of entry.rules) {
    const matchesOs = !rule.os?.name || rule.os.name === osName
    if (!matchesOs) continue
    allowed = rule.action === 'allow'
  }
  return allowed
}

/** downloads/libraries/<artifact path> per the version json */
export function libraryTarget(relPath: string): string {
  return path.join(mcDir(), 'libraries', ...relPath.split('/'))
}

export async function ensureAssets(versionJson: VersionJson, onLine?: (l: string) => void): Promise<string> {
  const index = versionJson.assetIndex
  if (!index) throw new Error('version json has no asset index')
  const indexPath = path.join(mcDir(), 'assets', 'indexes', `${index.id}.json`)
  await download(index.url, indexPath, index.sha1, onLine)
  const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as AssetIndex
  onLine?.(`[mojang] asset index ${index.id}: ${Object.keys(parsed.objects).length} objects`)
  return indexPath
}

export async function ensureClientJar(versionJson: VersionJson, onLine?: (l: string) => void): Promise<string> {
  const client = versionJson.downloads.client
  if (!client) throw new Error('no client download in version json')
  const target = path.join(mcDir(), 'versions', versionJson.id, `${versionJson.id}.jar`)
  await download(client.url, target, client.sha1, onLine)
  return target
}
