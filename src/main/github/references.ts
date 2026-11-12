import AdmZip from 'adm-zip'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { userDataDir } from '../config'
import { resolveToolJava, run } from '../util/exec'
import { githubApi, repoInfo } from './oauth'

/**
 * Decompiling other people's mods so the agent (and the user) can read how they
 * work: reference sources for an API, a loader behaviour, a GUI, a data pack.
 *
 * Pipeline:
 *   GitHub release  ──▶ jar in cache/refs/<slug>/<version>/
 *                   ──▶ Vineflower (or a user-supplied decompiler jar)
 *                   ──▶ cache/refs/<slug>/<version>/sources/…​.java
 *                   ──▶ copied into <project>/reference/<slug>/ for the agent
 *                   ──▶ indexed in reference/index.json
 *
 * Only jars made by other people go through this path. Our own build is compiled
 * from source, so nothing here is a substitute for reading our own code.
 */

const VINEFLOWER_VERSION = '1.12.0'
const VINEFLOWER_SHA256 = '1dfcfe974395734fa467ce620661c7623d05ba83670de0529b1fbd63ff548b9d'
/**
 * Two sources for the same artifact. GitHub's release CDN is the canonical one;
 * Maven Central is the fallback for networks that block it (and vice versa).
 */
const VINEFLOWER_URLS = [
  `https://github.com/Vineflower/vineflower/releases/download/${VINEFLOWER_VERSION}/vineflower-${VINEFLOWER_VERSION}.jar`,
  `https://repo1.maven.org/maven2/org/vineflower/vineflower/${VINEFLOWER_VERSION}/vineflower-${VINEFLOWER_VERSION}.jar`
]

export type DecompilerKind = 'vineflower' | 'custom'

export interface ReferenceMod {
  /** Stable id: `owner__repo` (or a hash for direct jars). */
  id: string
  slug: string
  title: string
  /** Where the jar came from. */
  source: 'github-release' | 'modrinth' | 'local-file'
  /** Page to credit / open in the browser. */
  homepage?: string
  license?: string
  /** owner/repo when source is a GitHub release. */
  repo?: string
  /** Release tag the jar belongs to. */
  version: string
  jarPath: string
  jarName: string
  jarSize: number
  /** Folder holding the decompiled tree. */
  sourcesDir?: string
  decompiled: boolean
  decompiler?: string
  createdAt: number
  /** modId/loader from META-INF, when readable. */
  modId?: string
  loader?: string
  mcVersion?: string
  /** Set when decompilation failed; the jar is still usable at runtime. */
  error?: string
  /** Copied into the project's reference/ folder. */
  linked?: boolean
}

export interface ReferenceStore {
  mods: ReferenceMod[]
}

export interface ReleaseAsset {
  name: string
  size: number
  url: string
  downloads: number
}

export interface RepoRelease {
  tag: string
  name: string
  publishedAt?: string
  prerelease: boolean
  body?: string
  assets: ReleaseAsset[]
}

export interface DecompileOptions {
  javaPath?: string
  /** A decompiler jar the user supplied (CFR, procyon, another Vineflower). */
  decompilerJar?: string
  /** Extra arguments passed to the decompiler before the jar. */
  extraArgs?: string[]
  /** Custom decompiler jar (CFR, procyon, another Vineflower build). */
  customJar?: string
  /** Abort long decompiles. */
  signal?: AbortSignal
  onLine?: (line: string) => void
}

function refsDir(): string {
  const dir = path.join(userDataDir(), 'refs')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function indexFile(): string {
  return path.join(refsDir(), 'index.json')
}

export function loadStore(): ReferenceStore {
  try {
    const raw = JSON.parse(fs.readFileSync(indexFile(), 'utf8')) as ReferenceStore
    return { mods: Array.isArray(raw.mods) ? raw.mods : [] }
  } catch {
    return { mods: [] }
  }
}

function saveStore(store: ReferenceStore): void {
  fs.mkdirSync(path.dirname(indexFile()), { recursive: true })
  fs.writeFileSync(indexFile(), JSON.stringify(store, null, 2), 'utf8')
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    // ".." is a legal slug character-wise but not a legal path segment: it would
    // let a crafted release tag escape the cache folder.
    .replace(/\.{2,}/g, '.')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return slug && slug !== '.' ? slug : 'mod'
}

/** `owner/repo` -> `owner__repo`, so one flat cache folder per project. */
export function repoSlug(owner: string, repo: string): string {
  return slugify(`${owner}__${repo}`)
}

export function modsCacheDir(slug: string, version: string): string {
  return path.join(refsDir(), slug, slugify(version) || 'unknown')
}

// ---------------------------------------------------------------- GitHub side

/** Parse the many shapes people paste: URL, owner/repo, with .git or /tree/x. */
export function parseRepoRef(input: string): { owner: string; repo: string } | null {
  const text = input.trim()
  const fromUrl = text.match(/github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#]|$)/i)
  if (fromUrl) return { owner: fromUrl[1], repo: fromUrl[2] }
  const bare = text.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/)
  if (bare) return { owner: bare[1], repo: bare[2] }
  return null
}

export async function listReleases(owner: string, repo: string): Promise<RepoRelease[]> {
  const { data } = await githubApi<
    { tag_name: string; name?: string | null; published_at?: string; prerelease?: boolean; body?: string | null; assets: { name: string; size: number; browser_download_url: string; download_count: number }[] }[]
  >(`/repos/${owner}/${repo}/releases?per_page=20`)
  return data.map((r) => ({
    tag: r.tag_name,
    name: r.name ?? r.tag_name,
    publishedAt: r.published_at,
    prerelease: !!r.prerelease,
    body: r.body ?? undefined,
    assets: r.assets.map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url, downloads: a.download_count }))
  }))
}

/**
 * Pick the jar that is the mod itself. Release pages are full of
 * `-sources`, `-api`, `-javadoc`, `-dev` and installer jars, and picking the
 * wrong one wastes a minute of decompilation on an empty artifact.
 */
export function pickModJar(assets: ReleaseAsset[]): ReleaseAsset | null {
  const jars = assets.filter((a) => /\.jar$/i.test(a.name))
  if (!jars.length) return null
  const score = (a: ReleaseAsset): number => {
    const n = a.name.toLowerCase()
    let s = 0
    if (/\b(fabric|forge|neoforge|quilt)\b/.test(n)) s += 6
    if (/universal|full|all/.test(n)) s += 3
    if (/-sources|-javadoc|-api|-dev|-slim|-min/.test(n)) s -= 30
    if (/installer|install/.test(n)) s -= 20
    // Prefer the biggest reasonable jar: the mod is usually the largest asset that
    // is not an installer, and size beats guessing from the name.
    s += Math.min(6, Math.log10(Math.max(1, a.size)) - 3)
    return s
  }
  return [...jars].sort((a, b) => score(b) - score(a) || b.size - a.size)[0]
}

export async function downloadTo(url: string, target: string, onLine?: (line: string) => void): Promise<{ ok: boolean; size?: number; error?: string }> {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  try {
    const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'MC-Forge-Agent' } })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} from ${url}` }
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length) return { ok: false, error: 'The download was empty.' }
    fs.writeFileSync(target, buf)
    onLine?.(`downloaded ${(buf.length / 1024 / 1024).toFixed(1)} MB -> ${target}`)
    return { ok: true, size: buf.length }
  } catch (e) {
    return { ok: false, error: `download failed: ${(e as Error).message}` }
  }
}

/** Read META-INF/neoforge.mods.toml (or mods.toml / fabric.mod.json) for display. */
export function describeJar(jarPath: string): { modId?: string; loader?: string; mcVersion?: string; displayName?: string; version?: string } {
  try {
    const zip = new AdmZip(jarPath)
    const toml = zip.getEntry('META-INF/neoforge.mods.toml') ?? zip.getEntry('META-INF/mods.toml')
    if (toml) {
      const text = toml.getData().toString('utf8')
      const pick = (k: string): string | undefined => text.match(new RegExp(`^\\s*${k}\\s*=\\s*"([^"]*)"`, 'm'))?.[1]
      const mc = text.match(/modId\s*=\s*"minecraft"[\s\S]{0,240}?versionRange\s*=\s*"([^"]+)"/)?.[1]
      // The toml rarely says "neoforge": javafml is the loader class, and the
      // NeoForge dependency lives in the [[dependencies]] block.
      // NeoForge took over from Forge at 1.20.2, so javafml + a modern MC range is
      // NeoForge even when the toml omits the explicit dependency.
      const declaredNeo = /modId\s*=\s*"neoforge"/i.test(text)
      const modernMc = /versionRange\s*=\s*"\[?1\.(2[0-9]|[3-9][0-9])/.test(text)
      const neo = declaredNeo || modernMc
      return {
        modId: pick('modId'),
        loader: !text.includes('javafml') ? 'unknown' : neo ? 'neoforge' : 'forge',
        mcVersion: mc,
        displayName: pick('displayName'),
        version: pick('version')
      }
    }
    const fabric = zip.getEntry('fabric.mod.json')
    if (fabric) {
      const body = JSON.parse(fabric.getData().toString('utf8')) as { id?: string; name?: string; version?: string; depends?: Record<string, string> }
      return { modId: body.id, loader: 'fabric', displayName: body.name, version: body.version, mcVersion: body.depends?.minecraft }
    }
    const manifest = zip.getEntry('META-INF/MANIFEST.MF')
    if (manifest) {
      const text = manifest.getData().toString('utf8')
      const version = text.match(/Implementation-Version:\s*(\S+)/)?.[1]
      return { version }
    }
  } catch {
    /* not a readable zip */
  }
  return {}
}

// ---------------------------------------------------------------- decompiler

async function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(file)
    stream.on('data', (c) => hash.update(c))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

export function decompilerCacheDir(): string {
  const dir = path.join(userDataDir(), 'tools')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Fetch Vineflower once into userData/tools. It needs Java 11+, which any
 * NeoForge 1.21.1 developer already has (JDK 21). The download is verified
 * against a pinned SHA-256 so a hijacked mirror cannot inject code.
 */
export async function ensureVineflower(javaPath?: string, onLine?: (line: string) => void): Promise<{ ok: boolean; path?: string; error?: string }> {
  const target = path.join(decompilerCacheDir(), `vineflower-${VINEFLOWER_VERSION}.jar`)
  if (fs.existsSync(target) && (await sha256(target)) === VINEFLOWER_SHA256) {
    onLine?.(`using cached Vineflower ${VINEFLOWER_VERSION}`)
    return { ok: true, path: target }
  }
  const errors: string[] = []
  for (const url of VINEFLOWER_URLS) {
    onLine?.(`downloading Vineflower ${VINEFLOWER_VERSION} from ${new URL(url).host}`)
    const res = await downloadTo(url, `${target}.part`, onLine)
    if (!res.ok || !res.size) {
      errors.push(`${new URL(url).host}: ${res.error}`)
      continue
    }
    const got = await sha256(`${target}.part`)
    if (got !== VINEFLOWER_SHA256) {
      fs.rmSync(`${target}.part`, { force: true })
      errors.push(`${new URL(url).host}: checksum mismatch (expected ${VINEFLOWER_SHA256.slice(0, 12)}…, got ${got.slice(0, 12)}…)`)
      continue
    }
    fs.renameSync(`${target}.part`, target)
    onLine?.(`Vineflower ready at ${target}`)
    return { ok: true, path: target }
  }
  return {
    ok: false,
    error: `Could not download the decompiler. ${errors.join('; ')}. Download vineflower-${VINEFLOWER_VERSION}.jar yourself and place it in ${decompilerCacheDir()}, or point Settings at a custom decompiler jar.`
  }
}

export interface DecompileResult {
  ok: boolean
  sourcesDir?: string
  javaFiles?: number
  log: string
  error?: string
  durationMs: number
}

/**
 * Run a decompiler over one jar. Vineflower's CLI is
 *   java -jar vineflower.jar <args> <jar> <destDir>
 * and CFR's is `java -jar cfr.jar <jar> --outputdir <destDir>`; `customJar`
 * therefore gets the CFR shape, which most jars accept.
 */
export async function decompileJar(jarPath: string, destDir: string, opts: DecompileOptions = {}): Promise<DecompileResult> {
  const started = Date.now()
  const lines: string[] = []
  const push = (line: string): void => {
    lines.push(line)
    opts.onLine?.(line)
  }
  // Vineflower needs Java 17+ (its classes are class file 61). A Java 8 runtime on
  // PATH loads the jar far enough to fail with UnsupportedClassVersionError, so the
  // version is checked before the jar is ever handed to java.
  const javaPick = resolveToolJava(opts.javaPath)
  if (!javaPick.path) {
    return { ok: false, log: '', error: javaPick.error ?? 'No Java 17+ found for the decompiler.', durationMs: Date.now() - started }
  }
  const java = javaPick.path
  push(`[decompile] using Java ${javaPick.version} at ${java}`)
  fs.rmSync(destDir, { recursive: true, force: true })
  fs.mkdirSync(destDir, { recursive: true })

  /**
   * Two CLI families are in use:
   *   Vineflower / ForgeFlower:  java -jar x.jar <args> <jar> <destDir>
   *   CFR / Procyon-ish:         java -jar x.jar <jar> --outputdir <destDir>
   * A custom jar can be either, so try the positional form first and fall back
   * to `--outputdir` when it produces nothing.
   */
  const attempts: { jar: string; args: string[] }[] = []

  const custom = opts.customJar ?? opts.decompilerJar
  if (custom) {
    if (!fs.existsSync(custom)) {
      return { ok: false, log: '', error: `The configured decompiler jar does not exist: ${custom}`, durationMs: Date.now() - started }
    }
    attempts.push({ jar: custom, args: ['-jar', custom, ...(opts.extraArgs ?? []), jarPath, destDir] })
    attempts.push({ jar: custom, args: ['-jar', custom, ...(opts.extraArgs ?? []), jarPath, '--outputdir', destDir] })
  } else {
    const vf = await ensureVineflower(opts.javaPath, push)
    if (!vf.ok || !vf.path) return { ok: false, log: lines.join('\n'), error: vf.error, durationMs: Date.now() - started }
    attempts.push({
      jar: vf.path,
      args: ['-jar', vf.path, ...(opts.extraArgs ?? ['-dgs=1', '-asc=1', '-rsy=1']), jarPath, destDir]
    })
  }

  let lastCode: number | null = 1
  let lastOutput = ''
  let javaFiles = 0
  for (const attempt of attempts) {
    push(`[decompile] ${path.basename(attempt.jar)} -> ${destDir}`)
    fs.rmSync(destDir, { recursive: true, force: true })
    fs.mkdirSync(destDir, { recursive: true })
    const res = await run(java, attempt.args, {
      timeoutMs: 20 * 60 * 1000,
      signal: opts.signal,
      onLine: (line) => push(line)
    })
    lastCode = res.code
    lastOutput = `${res.stderr || ''}${res.stdout || ''}`
    javaFiles = countJava(destDir)
    if (javaFiles) break
    if (attempts.length > 1) push('[decompile] that produced no sources; trying the other CLI shape')
  }

  if (lastCode !== 0) {
    // Translate the JVM's version error instead of showing a stack trace: it means
    // java chose for the game was too old for the decompiler jar.
    const unsupported = lastOutput.match(/class file version (\d+).*?up to (\d+)/s)
    const versionError = unsupported
      ? `The decompiler needs a newer Java than the one used here (${path.basename(java)} is too old: it supports class file ` +
        `${unsupported[2]} but the jar is ${unsupported[1]}). Set a JDK 17+ in Settings → Model → Java, or let the app auto-detect one.`
      : null
    return {
      ok: false,
      sourcesDir: javaFiles ? destDir : undefined,
      javaFiles,
      log: lines.join('\n'),
      error: versionError
        ? versionError
        : javaFiles
          ? `The decompiler exited with code ${lastCode} but wrote ${javaFiles} file(s); some classes failed.`
          : `The decompiler exited with code ${lastCode}. ${lastOutput.split(/\r?\n/).slice(-6).join(' ')}`,
      durationMs: Date.now() - started
    }
  }
  if (!javaFiles) {
    return {
      ok: false,
      log: lines.join('\n'),
      error: `The decompiler produced no .java files. ${lastOutput.split(/\r?\n/).filter(Boolean).slice(-3).join(' ') || 'The jar may have no classes.'}`,
      durationMs: Date.now() - started
    }
  }
  return { ok: true, sourcesDir: destDir, javaFiles, log: lines.join('\n'), durationMs: Date.now() - started }
}

export function countJava(dir: string): number {
  let n = 0
  const walk = (cur: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(cur, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.java')) n++
    }
  }
  walk(dir)
  return n
}

// ---------------------------------------------------------------- library

export function listReferences(): ReferenceMod[] {
  return loadStore().mods.sort((a, b) => b.createdAt - a.createdAt)
}

export function getReference(id: string): ReferenceMod | null {
  return loadStore().mods.find((m) => m.id === id) ?? null
}

export function removeReference(id: string): ReferenceMod[] {
  const store = loadStore()
  const mod = store.mods.find((m) => m.id === id)
  if (mod) {
    fs.rmSync(path.dirname(mod.jarPath), { recursive: true, force: true })
    store.mods = store.mods.filter((m) => m.id !== id)
    saveStore(store)
  }
  return store.mods.sort((a, b) => b.createdAt - a.createdAt)
}

function upsert(mod: ReferenceMod): ReferenceMod {
  const store = loadStore()
  store.mods = [...store.mods.filter((m) => m.id !== mod.id), mod]
  saveStore(store)
  return mod
}

/**
 * Add a jar from a GitHub release, decompile it, and register it.
 * `release` may be omitted, in which case the latest non-prerelease tag is used.
 */
export async function addFromGithub(opts: {
  owner: string
  repo: string
  releaseTag?: string
  assetName?: string
  javaPath?: string
  customJar?: string
  onLine?: (line: string) => void
  signal?: AbortSignal
}): Promise<{ ok: boolean; mod?: ReferenceMod; error?: string }> {
  const { owner, repo } = opts
  const onLine = opts.onLine ?? (() => undefined)
  const slug = repoSlug(owner, repo)
  let release: RepoRelease
  if (opts.releaseTag) {
    const { data } = await githubApi<{
      tag_name: string
      name?: string | null
      published_at?: string
      prerelease?: boolean
      body?: string | null
      assets: { name: string; size: number; browser_download_url: string; download_count: number }[]
    }>(`/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(opts.releaseTag)}`)
    release = {
      tag: data.tag_name,
      name: data.name ?? data.tag_name,
      publishedAt: data.published_at,
      prerelease: !!data.prerelease,
      body: data.body ?? undefined,
      assets: data.assets.map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url, downloads: a.download_count }))
    }
  } else {
    const releases = await listReleases(owner, repo)
    const stable = releases.find((r) => !r.prerelease) ?? releases[0]
    if (!stable) return { ok: false, error: `${owner}/${repo} has no releases. Pick a jar file instead.` }
    release = stable
  }

  const asset = opts.assetName ? release.assets.find((a) => a.name === opts.assetName) ?? null : pickModJar(release.assets)
  if (!asset) return { ok: false, error: `No usable .jar asset in ${owner}/${repo} ${release.tag}.` }

  const dir = modsCacheDir(slug, release.tag)
  const jarPath = path.join(dir, asset.name)
  if (!fs.existsSync(jarPath) || fs.statSync(jarPath).size !== asset.size) {
    onLine(`downloading ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)`)
    const dl = await downloadTo(asset.url, jarPath, onLine)
    if (!dl.ok) return { ok: false, error: dl.error }
  } else {
    onLine(`using cached ${jarPath}`)
  }

  const info = describeJar(jarPath)
  let repoMeta: { defaultBranch: string; private: boolean; htmlUrl: string } | undefined
  try {
    repoMeta = await repoInfo(owner, repo)
  } catch {
    /* metadata is optional */
  }

  const id = slug
  const mod: ReferenceMod = {
    id,
    slug,
    title: info.displayName ?? repo,
    source: 'github-release',
    homepage: repoMeta?.htmlUrl ?? `https://github.com/${owner}/${repo}`,
    repo: `${owner}/${repo}`,
    version: release.tag,
    jarPath,
    jarName: asset.name,
    jarSize: fs.statSync(jarPath).size,
    decompiled: false,
    createdAt: Date.now(),
    modId: info.modId,
    loader: info.loader,
    mcVersion: info.mcVersion,
    license: await fetchLicense(owner, repo, release.tag).catch(() => undefined)
  }

  const existing = getReference(id)
  if (existing?.decompiled && existing.version === release.tag && fs.existsSync(existing.sourcesDir ?? '')) {
    onLine(`${repo} ${release.tag} is already decompiled`)
    return { ok: true, mod: existing }
  }

  const job = await decompileJar(jarPath, path.join(dir, 'sources'), {
    javaPath: opts.javaPath,
    customJar: opts.customJar,
    signal: opts.signal,
    onLine
  })
  return { ok: true, mod: upsert({ ...mod, decompiled: job.ok, sourcesDir: job.sourcesDir, decompiler: job.ok ? 'vineflower' : undefined, error: job.error }) }
}

/** SPDX-ish licence name from the repo's LICENSE, for the attribution note. */
async function fetchLicense(owner: string, repo: string, ref: string): Promise<string | undefined> {
  try {
    const { data } = await githubApi<{ license?: { spdx_id?: string; name?: string } }>(`/repos/${owner}/${repo}/license?ref=${encodeURIComponent(ref)}`)
    return data.license?.spdx_id ?? data.license?.name
  } catch {
    return undefined
  }
}

/** Add a jar the user already has on disk (a downloaded mod, a local reference build). */
export async function addFromFile(opts: {
  jarPath: string
  title?: string
  licence?: string
  javaPath?: string
  customJar?: string
  onLine?: (line: string) => void
  signal?: AbortSignal
}): Promise<{ ok: boolean; mod?: ReferenceMod; error?: string }> {
  if (!fs.existsSync(opts.jarPath)) return { ok: false, error: `No such file: ${opts.jarPath}` }
  const original = path.basename(opts.jarPath, path.extname(opts.jarPath))
  const slug = slugify(original)
  const dir = modsCacheDir(slug, 'local')
  const jarPath = path.join(dir, path.basename(opts.jarPath))
  fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(opts.jarPath, jarPath)
  const info = describeJar(jarPath)
  const job = await decompileJar(jarPath, path.join(dir, 'sources'), {
    javaPath: opts.javaPath,
    customJar: opts.customJar,
    onLine: opts.onLine,
    signal: opts.signal
  })
  const mod: ReferenceMod = {
    id: slug,
    slug,
    title: opts.title || info.displayName || original,
    source: 'local-file',
    version: info.version ?? 'local',
    jarPath,
    jarName: path.basename(opts.jarPath),
    jarSize: fs.statSync(jarPath).size,
    decompiled: job.ok,
    sourcesDir: job.sourcesDir,
    decompiler: job.ok ? 'vineflower' : undefined,
    createdAt: Date.now(),
    modId: info.modId,
    loader: info.loader,
    mcVersion: info.mcVersion,
    license: opts.licence,
    error: job.error
  }
  return { ok: true, mod: upsert(mod) }
}

/**
 * Reference sources are read-only context, not part of the build: they go into
 * `<project>/reference/` (git-ignored by the scaffold) so the agent can Read and
 * Grep them with its normal tools and so `git status` stays clean.
 */
export function linkToProject(id: string, workspaceDir: string): { ok: boolean; dir?: string; files?: number; error?: string } {
  const mod = getReference(id)
  if (!mod) return { ok: false, error: 'Unknown reference mod.' }
  if (!mod.decompiled || !mod.sourcesDir || !fs.existsSync(mod.sourcesDir)) {
    return { ok: false, error: 'That mod has not been decompiled yet. Decompile it first (or pick a jar that contains classes).' }
  }
  const target = path.join(workspaceDir, 'reference', mod.slug)
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(target, { recursive: true })
  copyTree(mod.sourcesDir, target)
  fs.mkdirSync(path.join(workspaceDir, 'reference'), { recursive: true })
  fs.writeFileSync(
    path.join(workspaceDir, 'reference', `README.md`),
    [
      '# Reference sources',
      '',
      'Decompiled third-party mods, kept for reading only. They are **not** compiled into your mod.',
      '',
      ...listReferences()
        .filter((m) => m.decompiled)
        .map((m) => `- \`${m.slug}\` — ${m.title} ${m.version}${m.license ? ` (${m.license})` : ''}${m.repo ? ` — https://github.com/${m.repo}` : ''}`),
      '',
      'Decompiled code is derived from someone else\'s jar. Follow that project\'s licence before copying',
      'anything more than an API shape or a pattern.',
      ''
    ].join('\n'),
    'utf8'
  )
  const store = loadStore()
  const updated = store.mods.map((m) => (m.id === id ? { ...m, linked: true } : m))
  saveStore({ mods: updated })
  return { ok: true, dir: target, files: countFiles(target) }
}

/** Search the decompiled tree, so the agent can jump straight to a symbol. */
export function searchReference(query: string, opts: { id?: string; limit?: number; regex?: boolean } = {}): { hits: { id: string; file: string; line: number; text: string }[] } {
  const mods = listReferences().filter((m) => m.decompiled && m.sourcesDir && fs.existsSync(m.sourcesDir))
  const selected = opts.id ? mods.filter((m) => m.id === opts.id) : mods
  const limit = opts.limit ?? 60
  const hits: { id: string; file: string; line: number; text: string }[] = []
  let test: (line: string) => boolean
  if (opts.regex) {
    const re = new RegExp(query, 'i')
    test = (line) => re.test(line)
  } else {
    const needle = query.toLowerCase()
    test = (line) => line.toLowerCase().includes(needle)
  }
  for (const mod of selected) {
    walkFiles(mod.sourcesDir!, (file) => {
      if (hits.length >= limit || !file.endsWith('.java')) return
      let text: string
      try {
        text = fs.readFileSync(file, 'utf8')
      } catch {
        return
      }
      const lines = text.split(/\r?\n/)
      for (let i = 0; i < lines.length && hits.length < limit; i++) {
        if (test(lines[i])) {
          hits.push({ id: mod.id, file: path.relative(mod.sourcesDir!, file).split(path.sep).join('/'), line: i + 1, text: lines[i].trim().slice(0, 220) })
        }
      }
    })
  }
  return { hits }
}

function walkFiles(dir: string, fn: (file: string) => void): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walkFiles(p, fn)
    else fn(p)
  }
}

function copyTree(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true })
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name)
    const dst = path.join(to, e.name)
    if (e.isDirectory()) copyTree(src, dst)
    else fs.copyFileSync(src, dst)
  }
}

function countFiles(dir: string): number {
  let n = 0
  walkFiles(dir, () => {
    n++
  })
  return n
}

/** First N java files of a reference, for the UI's file list. */
export function referenceTree(id: string, limit = 400): { path: string; dir: boolean; size?: number }[] {
  const mod = getReference(id)
  if (!mod?.sourcesDir || !fs.existsSync(mod.sourcesDir)) return []
  const out: { path: string; dir: boolean; size?: number }[] = []
  const walk = (dir: string): void => {
    if (out.length >= limit) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
      if (out.length >= limit) return
      const full = path.join(dir, e.name)
      out.push({
        path: path.relative(mod.sourcesDir!, full).split(path.sep).join('/'),
        dir: e.isDirectory(),
        size: e.isDirectory() ? undefined : fs.statSync(full).size
      })
      if (e.isDirectory()) walk(full)
    }
  }
  walk(mod.sourcesDir)
  return out
}

export function readReferenceFile(id: string, rel: string, maxBytes = 400_000): { ok: boolean; text?: string; error?: string } {
  const mod = getReference(id)
  if (!mod?.sourcesDir) return { ok: false, error: 'Unknown reference mod.' }
  const target = path.resolve(mod.sourcesDir, rel)
  if (!target.startsWith(path.resolve(mod.sourcesDir) + path.sep)) return { ok: false, error: 'Path escapes the reference folder.' }
  try {
    const stat = fs.statSync(target)
    if (stat.size > maxBytes) {
      return { ok: true, text: fs.readFileSync(target, 'utf8').slice(0, maxBytes) + `\n… truncated (${stat.size} bytes)` }
    }
    return { ok: true, text: fs.readFileSync(target, 'utf8') }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** Ensure the project ignores reference/ so a decompiled tree never lands in a commit. */
export function ensureReferenceIgnored(workspaceDir: string): void {
  const file = path.join(workspaceDir, '.gitignore')
  const line = 'reference/'
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    /* none yet */
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim())
  if (lines.includes(line) || lines.includes('/reference')) return
  const next = `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`
  fs.writeFileSync(file, next, 'utf8')
}
