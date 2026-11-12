import fs from 'node:fs'
import path from 'node:path'
import { getReference, type ReferenceMod } from '../github/references'
import { userDataDir } from '../config'
import { compareMcVersions, type Loader } from '../versions/catalog'
import { classNameFor, generateProject } from './generate'
import { templateRoot } from './scaffold'
import { resolveEra } from '../versions/eras'

/**
 * "Edit a reference mod".
 *
 * Reading decompiled code is useful; being able to change it and run it is much
 * more so. This turns a decompiled reference into a *fork workspace*: a real
 * Gradle project, in its own folder, containing the decompiled sources. The
 * agent can edit it, build it, install it and launch it exactly like the user's
 * own mod, without touching either the user's project or the read-only
 * `reference/` copy.
 *
 * Two deliberate choices:
 *  - a fork is **never** written inside the user's mod project, so it can never
 *    end up committed or compiled into their jar;
 *  - the original jar is kept, and the licence of the upstream mod is copied into
 *    the fork and into the prompt, so the user sees what they are editing.
 */

export interface ForkRecord {
  /** `<slug>` — one fork per reference mod. */
  id: string
  referenceId: string
  slug: string
  title: string
  license?: string
  homepage?: string
  repo?: string
  /** Absolute path of the fork project. */
  dir: string
  loader: Loader
  mcVersion: string
  loaderVersion: string
  /** Names of the top-level packages found in the decompiled tree. */
  packages: string[]
  /** Java files copied in. */
  files: number
  createdAt: number
  updatedAt: number
  /** Set the first time the user (or agent) edits something in the fork. */
  dirty?: boolean
  notes?: string
}

export interface ForkStore {
  forks: ForkRecord[]
}

const JAVA_SKIP = /(^|\/)(META-INF|\.git|build|\.gradle|run|logs|node_modules)(\/|$)/
const NON_JAVA_EXT = /\.(class|jar|zip|png|jpe?g|gif|ogg|wav|mp3|ttf|dds|bin|nbt|dat|json|mcmeta|toml|xml|properties|txt|md|lang|cfg|ini|yaml|yml|MF|so|dll|dylib)$/i

export function forkRoot(): string {
  const dir = path.join(userDataDir(), 'forks')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function forkStoreFile(): string {
  return path.join(userDataDir(), 'forks.json')
}

export function loadForks(): ForkStore {
  try {
    const raw = JSON.parse(fs.readFileSync(forkStoreFile(), 'utf8')) as ForkStore
    return { forks: Array.isArray(raw?.forks) ? raw.forks : [] }
  } catch {
    return { forks: [] }
  }
}

function saveForks(store: ForkStore): void {
  fs.mkdirSync(path.dirname(forkStoreFile()), { recursive: true })
  fs.writeFileSync(forkStoreFile(), JSON.stringify(store, null, 2), 'utf8')
}

export function getFork(id: string): ForkRecord | null {
  return loadForks().forks.find((f) => f.id === id || f.referenceId === id) ?? null
}

/**
 * The loader a decompiled jar was built for. `describeJar` already reads the
 * metadata files; this only normalises the answer.
 */
export function loaderOfReference(mod: ReferenceMod): Loader {
  const raw = (mod.loader ?? '').toLowerCase()
  if (raw.includes('fabric')) return 'fabric'
  if (raw.includes('neoforge')) return 'neoforge'
  if (raw.includes('forge')) return 'forge'
  // A jar with no loader metadata is almost always a plain Forge mod of its era.
  return 'forge'
}

/** Is this Minecraft version one the jar claims to support? */
export function referenceSupportsVersion(mod: ReferenceMod, mcVersion: string): boolean {
  if (!mod.mcVersion) return true
  const claimed = mod.mcVersion.split(/[,\s]+/).filter(Boolean)
  if (!claimed.length) return true
  return claimed.some((c) => {
    const range = c.match(/^\[?([\d.]+)/)
    return range ? compareMcVersions(mcVersion, range[1]) >= 0 : c === mcVersion
  })
}

/**
 * The fork picks the reference's own Minecraft version when the catalog can
 * build it, because that is the version the decompiled code was written
 * against. Guessing a newer version produces a project that cannot compile.
 */
export function suggestedTarget(mod: ReferenceMod): { loader: Loader; mcVersion: string; warning?: string } {
  const loader = loaderOfReference(mod)
  const mc = (mod.mcVersion ?? '').split(/[,\s]+/)[0] || '1.21.1'
  if (!resolveEra(loader, mc)) {
    return { loader, mcVersion: mc, warning: `No build toolchain is known for ${loader} ${mc}.` }
  }
  return { loader, mcVersion: mc }
}

/* ------------------------------------------------------------------ copying */

function copySources(from: string, to: string, limitFiles = 6000): { files: number; packages: string[] } {
  let files = 0
  const packages = new Set<string>()
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
      if (JAVA_SKIP.test(childRel)) continue
      if (e.isDirectory()) {
        walk(childRel)
        continue
      }
      if (!e.name.endsWith('.java') || NON_JAVA_EXT.test(e.name)) continue
      if (files >= limitFiles) return
      const dest = path.join(to, 'src/main/java', childRel)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      try {
        fs.copyFileSync(path.join(from, childRel), dest)
      } catch {
        continue
      }
      files++
      // Record the package directory (src/main/java/com/example/mod/...).
      const pkg = childRel.split('/').slice(0, -1).join('.')
      if (pkg) packages.add(pkg)
    }
  }
  walk('')
  return { files, packages: [...packages].sort(() => 0) }
}

/** Resources are part of the mod: assets, textures, lang files, mixins json. */
function copyResources(from: string, to: string): number {
  const roots = ['assets', 'data', 'META-INF']
  const destRoot = path.join(to, 'src/main/resources')
  let copied = 0
  const copy = (src: string, rel: string): void => {
    let stat: fs.Stats
    try {
      stat = fs.statSync(src)
    } catch {
      return
    }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(src)) copy(path.join(src, name), `${rel}/${name}`)
      return
    }
    // Decompiled output has a run/ and a META-INF/ with the old metadata; that
    // metadata is regenerated by the generated project, so skip those manifests.
    if (/\/?META-INF\/(MANIFEST\.MF|.*\.SF|.*\.RSA|maven|.*\.kotlin_module)$/i.test(rel)) return
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return
    const dest = path.join(destRoot, rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    try {
      fs.copyFileSync(src, dest)
      copied++
    } catch {
      /* a locked file is not worth failing the fork for */
    }
  }
  // Vineflower puts resources next to the sources only when asked; check the
  // reference tree too, since some layouts put them at the top level.
  for (const root of roots) {
    for (const base of [path.join(from, root), path.join(from, 'src/main/resources', root)]) {
      if (fs.existsSync(base)) copy(base, root)
    }
  }
  return copied
}

/** Read the pom-like metadata out of a decompiled `fabric.mod.json` / toml. */
function readMetadataHints(dir: string): { license?: string; modName?: string } {
  const hints: { license?: string; modName?: string } = {}
  for (const rel of ['fabric.mod.json', 'META-INF/mods.toml', 'META-INF/neoforge.mods.toml']) {
    const file = path.join(dir, rel)
    if (!fs.existsSync(file)) continue
    try {
      const text = fs.readFileSync(file, 'utf8')
      if (rel.endsWith('.json')) {
        const j = JSON.parse(text) as { license?: string; name?: string; id?: string }
        hints.license = hints.license ?? j.license
        hints.modName = hints.modName ?? j.name
      } else {
        hints.license = hints.license ?? text.match(/^\s*license\s*=\s*"([^"]+)"/m)?.[1]
        hints.modName = hints.modName ?? text.match(/^\s*displayName\s*=\s*"([^"]+)"/m)?.[1]
      }
    } catch {
      /* unreadable metadata is fine */
    }
  }
  return hints
}

export interface CreateForkOptions {
  referenceId: string
  /** Where the fork project lives. Defaults to <userData>/forks/<slug>. */
  parentDir?: string
  loader?: Loader
  mcVersion?: string
  loaderVersion?: string
  /** Copy the upstream licence into the fork. Default true. */
  keepLicense?: boolean
}

export function createFork(opts: CreateForkOptions): { ok: boolean; fork?: ForkRecord; error?: string; warning?: string } {
  const mod = getReference(opts.referenceId)
  if (!mod) return { ok: false, error: 'Unknown reference mod.' }
  if (!mod.decompiled || !mod.sourcesDir || !fs.existsSync(mod.sourcesDir)) {
    return { ok: false, error: 'That mod has not been decompiled yet, so there are no sources to edit.' }
  }
  const existing = getFork(mod.id)
  if (existing && fs.existsSync(existing.dir)) {
    return { ok: false, error: `“${existing.title}” already has a fork at ${existing.dir}. Open that one instead.` }
  }

  const suggested = suggestedTarget(mod)
  const loader = opts.loader ?? suggested.loader
  const mcVersion = opts.mcVersion ?? suggested.mcVersion
  const era = resolveEra(loader, mcVersion)
  if (!era) return { ok: false, error: `No build toolchain for ${loader} ${mcVersion}.` }

  // Loader versions are not in the reference jar; the fork starts from the
  // newest one the era knows and the user can change it in gradle.properties.
  const loaderVersion = opts.loaderVersion ?? defaultLoaderVersion(loader, mcVersion)
  const parent = opts.parentDir ?? forkRoot()
  const slug = mod.slug
  const target = path.join(parent, slug)

  const hints = readMetadataHints(mod.sourcesDir)
  const modName = hints.modName ?? mod.title
  const className = classNameFor(slug.replace(/[^a-z0-9_]/g, '_') || 'reference')
  // A decompiled class already exists, so the generated starter class would be a
  // duplicate. `generateProject` gets a name that cannot collide.
  const gen = generateProject({
    targetDir: target,
    modId: sanitiseModId(slug),
    modName,
    group: inferGroup(mod.sourcesDir) ?? `com.edit.${sanitiseModId(slug)}`,
    modVersion: mod.version || '1.0.0',
    author: 'forked from ' + mod.title,
    license: opts.keepLicense === false ? 'ARR' : (mod.license ?? hints.license ?? 'see upstream'),
    loader,
    mcVersion,
    loaderVersion,
    templateRoot: templateRoot(),
    overwrite: false
  })
  if (!gen.ok) return { ok: false, error: gen.error ?? 'Could not create the fork project.' }

  // The generated starter class is a placeholder; a fork already has real code.
  removeGeneratedStarter(target)

  const copied = copySources(mod.sourcesDir, target)
  const resources = copyResources(mod.sourcesDir, target)

  fs.writeFileSync(
    path.join(target, 'FORK.md'),
    [
      `# ${modName} — editable fork`,
      '',
      `Forked from **${mod.title}** \`${mod.version}\` (${mod.loader ?? 'unknown loader'} ${mod.mcVersion ?? ''}).`,
      mod.repo ? `Upstream: https://github.com/${mod.repo}` : mod.homepage ? `Upstream: ${mod.homepage}` : '',
      mod.license ? `Licence: **${mod.license}**` : 'Licence: not declared by the jar — assume all rights reserved.',
      '',
      'This folder contains **decompiled** sources. They were produced by Vineflower, so they are',
      'not the original source: names may be renamed, comments were lost, and some code patterns',
      '(lambdas, generics, switch-on-string) are reconstructed approximations.',
      '',
      'What that means in practice:',
      '',
      '- Redistribution still follows the upstream licence, even though the code now builds.',
      '- Decompiled internals of *other* mods (not yours) can behave subtly differently from the original.',
      '- Use this to learn, patch and experiment. Publish only what the licence allows.',
      '',
      `Loader: ${loader} · Minecraft ${mcVersion} · ${era.label}`,
      '',
      resources ? `${copied.files} java files and ${resources} resources copied from \`${mod.sourcesDir}\`.` : `${copied.files} java files copied from \`${mod.sourcesDir}\`.`,
      ''
    ]
      .filter(Boolean)
      .join('\n'),
    'utf8'
  )

  const now = Date.now()
  const record: ForkRecord = {
    id: slug,
    referenceId: mod.id,
    slug,
    title: modName,
    license: mod.license ?? hints.license,
    homepage: mod.homepage,
    repo: mod.repo,
    dir: target,
    loader,
    mcVersion,
    loaderVersion,
    packages: copied.packages.slice(0, 40),
    files: copied.files,
    createdAt: now,
    updatedAt: now
  }
  const store = loadForks()
  saveForks({ forks: [record, ...store.forks.filter((f) => f.id !== record.id)] })

  const warning =
    suggested.warning ??
    (referenceSupportsVersion(mod, mcVersion)
      ? undefined
      : `The jar declares Minecraft ${mod.mcVersion}, so a ${mcVersion} build may not compile against it.`)
  return { ok: true, fork: record, warning }
}

function removeGeneratedStarter(dir: string): void {
  const javaRoot = path.join(dir, 'src', 'main', 'java')
  if (!fs.existsSync(javaRoot)) return
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) {
        walk(full)
        continue
      }
      if (!e.name.endsWith('.java')) continue
      const text = fs.readFileSync(full, 'utf8')
      // The generated starter is the only file carrying this marker.
      if (text.includes('Generated by MC Forge Agent')) fs.rmSync(full, { force: true })
    }
  }
  walk(javaRoot)
}

/** `Cool_Mod` -> `coolmod` (loaders reject capitals and underscores in newer formats). */
function sanitiseModId(value: string): string {
  const id = value.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+/, '')
  return /^[a-z]/.test(id) ? id.slice(0, 48) : `fork_${id}`.slice(0, 48)
}

/** The package most of the decompiled classes live in. */
export function inferGroup(sourcesDir: string): string | null {
  const counts = new Map<string, number>()
  const walk = (rel: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(path.join(sourcesDir, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        walk(childRel)
        continue
      }
      if (!e.name.endsWith('.java')) continue
      const parts = childRel.split('/')
      if (parts.length < 3) continue
      const pkg = parts.slice(0, -1).join('.')
      counts.set(pkg, (counts.get(pkg) ?? 0) + 1)
    }
  }
  walk('')
  let best: string | null = null
  let bestCount = 0
  for (const [pkg, n] of counts) {
    // Prefer package roots with at least two segments (com.example), not the
    // decompiler's per-file single-segment output.
    const depth = pkg.split('.').length
    const score = n * (depth >= 2 ? 2 : 1)
    if (score > bestCount) {
      best = pkg
      bestCount = score
    }
  }
  return best
}

/** Newest loader build the era can be expected to build against. */
function defaultLoaderVersion(loader: Loader, mcVersion: string): string {
  if (loader === 'neoforge') {
    const m = mcVersion.split('.')
    return `${m[1] ?? '21'}.${m[2] ?? '1'}.0`
  }
  if (loader === 'forge') {
    // Forge's version is tied to the game version; a 0 placeholder resolves to a
    // real build in gradle.properties and is editable there.
    return '1.0.0'
  }
  return '0.16.0'
}

/* ------------------------------------------------------------- fork listing */

export function listForks(): ForkRecord[] {
  const { forks } = loadForks()
  return forks.filter((f) => fs.existsSync(f.dir))
}

export function removeFork(id: string): ForkRecord[] {
  const store = loadForks()
  const fork = store.forks.find((f) => f.id === id || f.referenceId === id)
  const rest = store.forks.filter((f) => f !== fork)
  if (fork) {
    // Only delete inside our own forks folder; a fork placed next to the user's
    // project is theirs to delete.
    try {
      if (path.resolve(fork.dir).startsWith(path.resolve(forkRoot()))) {
        fs.rmSync(fork.dir, { recursive: true, force: true })
      }
    } catch {
      /* a locked file leaves the folder behind; the record still goes */
    }
  }
  saveForks({ forks: rest })
  return rest.filter((f) => fs.existsSync(f.dir))
}

/** Mark a fork as modified (called after a write through the app or the agent). */
export function touchFork(dir: string): void {
  const store = loadForks()
  let changed = false
  const forks = store.forks.map((f) => {
    if (path.resolve(f.dir) !== path.resolve(dir)) return f
    changed = true
    return { ...f, dirty: true, updatedAt: Date.now() }
  })
  if (changed) saveForks({ forks })
}

/** Java files in a fork, for the UI's file count. */
export function countForkSources(dir: string): number {
  let n = 0
  const walk = (d: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(d, e.name))
      else if (e.name.endsWith('.java')) n++
    }
  }
  walk(path.join(dir, 'src', 'main', 'java'))
  return n
}
