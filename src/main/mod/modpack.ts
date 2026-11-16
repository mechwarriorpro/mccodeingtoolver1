import fs from 'node:fs'
import path from 'node:path'
import AdmZip from 'adm-zip'

/**
 * A modpack's `mods/` folder, read as a set of mods and the dependencies between
 * them.
 *
 * The rule this module is built around: **the folder is the answer**. Someone
 * updating one mod in a pack has a folder that already contains every library the
 * pack needs — that is what a working pack is. If an updated mod's dependency is
 * satisfied *by a jar sitting next to it*, nothing should be downloaded. Offering
 * a download first is how a pack ends up with two versions of the same library.
 *
 * So the order is always:
 *
 *  1. Read every jar and its declared dependencies.
 *  2. Ask whether the folder satisfies them — by mod id, and by version range.
 *  3. Only what is *missing* or *out of range* becomes a download candidate.
 *
 * The jar metadata is the authority, exactly as the loader reads it:
 *
 *  - NeoForge/Forge: `META-INF/neoforge.mods.toml` / `mods.toml`, with
 *    `[[dependencies.<modid>]]` blocks carrying `modId`, `type`, `versionRange`.
 *  - Fabric: `fabric.mod.json`, whose `depends` map is the same information.
 *
 * Only `required` dependencies count. A pack that "depends" on JEI at `optional`
 * works without it, and treating optional as required is how a scan invents work.
 */

export type ModLoader = 'neoforge' | 'forge' | 'fabric' | 'quilt' | 'unknown'

export interface ModDependency {
  /** Mod id the jar declares a dependency on, e.g. `create`, `minecraft`. */
  modId: string
  /** `[1.20.1,1.21)` — a maven-style range, or a single version. */
  versionRange?: string
  /** `required` unless the jar says otherwise. `optional`/`incompatible` are kept. */
  kind: 'required' | 'optional' | 'incompatible' | 'discouraged'
  /** False for `minecraft`, `neoforge`, `forge`, `fabricloader` — not downloadable mods. */
  isLoaderOrGame: boolean
}

export interface PackMod {
  /** Absolute path to the jar. */
  path: string
  /** File name, which is what the user recognises in their own folder. */
  file: string
  /** `create`, `jei` — the id the loader uses to resolve dependencies. */
  modId?: string
  name?: string
  version?: string
  loader: ModLoader
  /** Every dependency the jar declares. */
  depends: ModDependency[]
  /** True when the jar could not be read as a mod at all. */
  unreadable?: boolean
  /**
   * True when the id and version came from the file name because the jar's own
   * metadata could not be read. Every use of such a mod is a *claim*, and the
   * caller is told so rather than shown a confident lie.
   */
  inferred?: boolean
  /** How much the file name is trusted, when it is used at all. */
  confidence?: 'likely' | 'weak'
}

export interface MissingDependency {
  modId: string
  /** The range the dependent asked for, when it said. */
  versionRange?: string
  /** Files that need it, so the user knows what broke. */
  requiredBy: string[]
}

export interface PackScan {
  /** The `mods` folder that was read. */
  dir: string
  /** Every jar found, readable or not. */
  mods: PackMod[]
  /**
   * Dependencies the pack asks for that no jar in the folder provides. These — and
   * only these — are download candidates.
   */
  missing: MissingDependency[]
  /** Present but the wrong version for something that asks for it. */
  mismatched: { modId: string; have?: string; versionRange?: string; requiredBy: string[] }[]
  /** Non-jar files, kept visible rather than dropped. */
  ignored: string[]
  /**
   * Jars that are there but could not be read as a mod.
   *
   * Separate from `ignored` on purpose: a folder full of these is a bug in the
   * reader, not a folder full of junk, and it must never be reported as healthy.
   */
  unreadableJars: string[]
  /**
   * Mod ids guessed from file names for jars that could not be read.
   *
   * Kept apart from `mods`' readable entries so a guess is never used where a
   * fact is required without the caller seeing `inferred: true` as well.
   */
  inferred: (InferredIdentity & { path: string; file: string })[]
  /** Loader/version seen in the jars, for the UI to confirm it read the right pack. */
  loaders: ModLoader[]
  gameVersions: string[]
}

/** The ids that come from the loader or the game itself, never from a mod jar. */
const PLATFORM_IDS = new Set([
  'minecraft',
  'neoforge',
  'forge',
  'fabricloader',
  'fabric-loader',
  'fabric',
  'quilt_loader',
  'java',
  'javafml',
  'lowcodefml',
  'mixin',
  'mixinextras',
  'openloader'
])

export function isPlatformId(id: string): boolean {
  return PLATFORM_IDS.has(id.toLowerCase())
}

/**
 * Read one jar's mod metadata and dependencies.
 *
 * Tolerant by design: a pack folder holds odd things (a coremod, a resource pack
 * named .jar, a jar that fails to open). Those are reported as `unreadable` rather
 * than throwing, because a scan that dies on one bad file is useless.
 */
export function readModJar(jarPath: string): PackMod {
  const base: PackMod = { path: jarPath, file: path.basename(jarPath), loader: 'unknown', depends: [] }
  let zip: AdmZip
  try {
    zip = new AdmZip(jarPath)
  } catch {
    return { ...base, unreadable: true }
  }

  // ---- NeoForge / Forge ------------------------------------------------
  const neoEntry = zip.getEntry('META-INF/neoforge.mods.toml')
  const toml = neoEntry ?? zip.getEntry('META-INF/mods.toml')
  if (toml) {
    let text = ''
    try {
      text = toml.getData().toString('utf8')
    } catch {
      return { ...base, unreadable: true }
    }
    const modId = firstMatch(text, /^\s*modId\s*=\s*"([^"]+)"/m)
    const version = tomlString(text, 'version')
    const name = firstMatch(text, /^\s*displayName\s*=\s*"([^"]+)"/m)
    // NeoForge split from Forge at 1.20.2 and renamed the metadata file. The file
    // name alone is decisive: a jar carrying `neoforge.mods.toml` is a NeoForge
    // mod. Reading only the dependency block missed every mod that does not
    // declare a `neoforge` dependency explicitly — most of them — and reported a
    // NeoForge pack as a Forge one.
    const loader: ModLoader = neoEntry || /modId\s*=\s*"neoforge"/i.test(text) ? 'neoforge' : 'forge'
    return {
      ...base,
      modId,
      name,
      version,
      loader,
      depends: parseTomlDependencies(text)
    }
  }

  // ---- Fabric / Quilt -------------------------------------------------
  const fabric = zip.getEntry('fabric.mod.json')
  if (fabric) {
    try {
      const body = JSON.parse(fabric.getData().toString('utf8')) as {
        id?: string
        name?: string
        version?: string
        depends?: Record<string, string | string[]>
      }
      const depends: ModDependency[] = Object.entries(body.depends ?? {}).map(([id, range]) => ({
        modId: id,
        versionRange: Array.isArray(range) ? range.join(' || ') : range,
        kind: 'required' as const,
        isLoaderOrGame: isPlatformId(id)
      }))
      return {
        ...base,
        modId: body.id,
        name: body.name,
        version: typeof body.version === 'string' ? body.version : undefined,
        loader: 'fabric',
        depends
      }
    } catch {
      return { ...base, unreadable: true }
    }
  }

  // ---- Forge before 1.13 ----------------------------------------------
  // Old packs are a large share of the ones people update, and those jars have
  // no mods.toml at all: the metadata is `mcmod.info`, a JSON array whose
  // `dependencies` are *bare mod ids with no version range*. Reading only
  // `mods.toml` is why such a folder could scan as "0 mods".
  const legacy = zip.getEntry('mcmod.info')
  if (legacy) {
    try {
      const raw = JSON.parse(legacy.getData().toString('utf8')) as
        | { modid?: string; name?: string; version?: string; dependencies?: string[] }[]
        | { modList: { modid?: string; name?: string; version?: string; dependencies?: string[] }[] }
      const list = Array.isArray(raw) ? raw : (raw.modList ?? [])
      const first = list[0]
      if (first?.modid) {
        const depends: ModDependency[] = (first.dependencies ?? [])
          .filter((id) => typeof id === 'string' && id && id !== 'forge' && id !== 'FML' && id !== 'minecraft')
          .map((id) => ({ modId: id, kind: 'required' as const, isLoaderOrGame: isPlatformId(id) }))
        return {
          ...base,
          modId: first.modid,
          name: first.name && first.name !== first.modid ? first.name : undefined,
          version: first.version,
          loader: 'forge',
          depends
        }
      }
    } catch {
      // fall through to the manifest below
    }
  }

  // ---- the manifest, as the last resort --------------------------------
  // Some jars (and every plain library) carry only a MANIFEST.MF. A jar with an
  // Implementation-Title is a real thing in the folder even when it declares no
  // dependencies, and reporting it beats calling the folder empty.
  const manifest = zip.getEntry('META-INF/MANIFEST.MF')
  if (manifest) {
    try {
      const text = manifest.getData().toString('utf8')
      const title = firstMatch(text, /^Implementation-Title:\s*(.+)$/m)?.trim()
      const version = firstMatch(text, /^Implementation-Version:\s*(.+)$/m)?.trim()
      if (title || version) {
        return { ...base, name: title, version, loader: 'unknown', depends: [] }
      }
    } catch {
      // nothing readable
    }
  }

  return { ...base, unreadable: true }
}

/**
 * `[[dependencies.<owner>]]` blocks from a mods.toml.
 *
 * A single toml can hold several blocks for several mods; every one is read,
 * because the loader merges them. `type` decides whether the dependency matters:
 * an `optional` one must not become a download prompt.
 */
export function parseTomlDependencies(text: string): ModDependency[] {
  const out: ModDependency[] = []
  // Split on the block headers, keeping each block's own body.
  const blocks = text.split(/^\s*\[\[dependencies\./m)
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i]
    const body = block.slice(block.indexOf(']]') + 2)
    const modId = firstMatch(body, /^\s*modId\s*=\s*"([^"]+)"/m)
    if (!modId) continue
    const range = firstMatch(body, /^\s*versionRange\s*=\s*"([^"]*)"/m)
    const type = (firstMatch(body, /^\s*type\s*=\s*"([^"]+)"/m) ?? 'required').toLowerCase()
    const kind: ModDependency['kind'] =
      type === 'optional' ? 'optional' : type === 'incompatible' ? 'incompatible' : type === 'discouraged' ? 'discouraged' : 'required'
    out.push({ modId, versionRange: range, kind, isLoaderOrGame: isPlatformId(modId) })
  }
  return out
}

function firstMatch(text: string, re: RegExp): string | undefined {
  return text.match(re)?.[1]
}

/** A toml string value, ignoring `${version}` placeholders the loader expands. */
function tomlString(text: string, key: string): string | undefined {
  const raw = firstMatch(text, new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'))
  if (!raw) return undefined
  return raw.includes('${') ? undefined : raw
}

/* ---------------------------------------------------------------- version ranges */

/**
 * Does `version` satisfy `range`?
 *
 * Handles the two forms packs actually use:
 *
 *  - maven ranges: `[1.20.1,1.21)`, `[1.20,1.21]`, `[1.20.1,)`, `(,1.21]`
 *  - plain prefixes: `1.20.1`, `1.20.x`, `1.20.*`
 *
 * Anything unparsable returns `true` — an unknown range must not turn a working
 * pack into a list of false alarms. A pack that already runs is the best evidence
 * that its own ranges are satisfied.
 */
export function satisfiesRange(version: string | undefined, range: string | undefined): boolean {
  if (!range) return true
  if (!version) return true
  const trimmed = range.trim()
  if (!trimmed) return true

  const v = numericParts(version)
  if (!v.length) return true

  if (trimmed.startsWith('[') || trimmed.startsWith('(')) {
    const lowerInclusive = trimmed.startsWith('[')
    const upperInclusive = trimmed.endsWith(']')
    const inner = trimmed.replace(/^[[(]/, '').replace(/[)\]]$/, '')
    const [rawLow, rawHigh] = inner.split(',').map((s) => s.trim())
    if (rawLow) {
      const low = numericParts(rawLow)
      if (low.length && compareNumeric(v, low) < 0) return false
      if (low.length && !lowerInclusive && compareNumeric(v, low) === 0) return false
    }
    if (rawHigh) {
      const high = numericParts(rawHigh)
      if (high.length && compareNumeric(v, high) > 0) return false
      if (high.length && !upperInclusive && compareNumeric(v, high) === 0) return false
    }
    return true
  }

  if (trimmed.includes('||')) return trimmed.split('||').some((part) => satisfiesRange(version, part.trim()))

  // Comparison ranges: ">=1.20 <1.22", "^1.20.1", "~1.20", ">=1.21-".
  // Fabric metadata uses these heavily. Falling through to the prefix rule below
  // would read "<1.22 >1.20" as the version 1.22.1.20 and answer confidently and
  // wrongly, so they are handled explicitly.
  if (/[<>^~]/.test(trimmed)) return satisfiesComparators(v, trimmed)

  // A prefix: 1.20 matches 1.20.1, 1.20.x matches 1.20.4.
  const want = numericParts(trimmed)
  if (!want.length) return true
  for (let i = 0; i < want.length; i++) {
    if (v[i] === undefined) return false
    if (v[i] !== want[i]) return false
  }
  return true
}

/**
 * `>=1.20 <1.22` style constraints, all of which must hold.
 *
 * `^` and `~` follow the usual meanings packs inherit from their tooling:
 * `^1.2.3` is `>=1.2.3 <2.0.0`, `~1.2.3` is `>=1.2.3 <1.3.0`. A trailing `-`
 * (Fabric writes `>=1.21-`) is noise, not a version.
 */
function satisfiesComparators(version: number[], range: string): boolean {
  // Split before removing the trailing dash, so ">=1.21- <1.22" becomes two tokens.
  const tokens = range
    .replace(/\s*-\s*(?=(<|>|$))/g, ' ')
    .split(/[,\s]+/)
    .map((t) => t.trim().replace(/-$/, ''))
    .filter(Boolean)
  let sawConstraint = false
  for (const token of tokens) {
    const m = token.match(/^(>=|<=|>|<|\^|~)?\s*(.+)$/)
    if (!m) continue
    const op = m[1] ?? ''
    const raw = m[2]
    const target = numericParts(raw)
    if (!target.length) continue
    sawConstraint = true
    const cmp = compareNumeric(version, target)
    if (op === '>=' && cmp < 0) return false
    if (op === '<=' && cmp > 0) return false
    if (op === '>' && cmp <= 0) return false
    if (op === '<' && cmp >= 0) return false
    if (op === '^') {
      if (cmp < 0) return false
      const ceiling = [target[0] + 1, 0, 0]
      if (compareNumeric(version, ceiling) >= 0) return false
    }
    if (op === '~') {
      if (cmp < 0) return false
      const ceiling = target.length >= 2 ? [target[0], target[1] + 1, 0] : [target[0] + 1, 0, 0]
      if (compareNumeric(version, ceiling) >= 0) return false
    }
  }
  // Nothing we understood: do not invent a mismatch.
  return sawConstraint || true
}

function numericParts(value: string): number[] {
  return (value.match(/\d+/g) ?? []).map(Number)
}

function compareNumeric(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d) return d
  }
  return 0
}

/* ---------------------------------------------------------------------- scanning */

/** Is this path a directory that looks like a mods folder? */
/**
 * The game version and loader a pack is built for, read from the mods themselves.
 *
 * A pack has no manifest here — only jars. But nearly every mod declares a
 * `minecraft` dependency with a range like `[1.21.1,1.22)`, and the loader is
 * whatever metadata the jars carry. The most common answer across the folder is
 * the pack's, which is what an update has to be looked up against.
 */
export function packVersions(scan: PackScan): { mcVersion?: string; loader?: ModLoader } {
  const counts = new Map<string, number>()
  for (const mod of scan.mods) {
    for (const dep of mod.depends) {
      if (dep.modId !== 'minecraft') continue
      const parts = numericParts(dep.versionRange ?? '')
      if (parts.length < 2) continue
      // `[1.21.1,1.22)` and `1.21.1` describe the same version; key on the
      // concrete one so ranges and pins vote together instead of splitting.
      const key = parts.length >= 3 ? `${parts[0]}.${parts[1]}.${parts[2]}` : `${parts[0]}.${parts[1]}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  const mcVersion = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  const loader =
    scan.loaders.includes('neoforge') ? 'neoforge'
    : scan.loaders.includes('forge') ? 'forge'
    : scan.loaders.includes('fabric') ? 'fabric'
    : scan.loaders.includes('quilt') ? 'quilt'
    : undefined
  return { mcVersion, loader }
}

export function looksLikeModsFolder(dir: string): boolean {
  try {
    if (!fs.statSync(dir).isDirectory()) return false
  } catch {
    return false
  }
  try {
    return fs.readdirSync(dir).some((f) => f.endsWith('.jar'))
  } catch {
    return false
  }
}

/**
 * Accept either a `mods` folder or the pack folder that contains one.
 *
 * People paste whichever they have open in Explorer. Asking again because the path
 * was one level up is a worse experience than looking.
 */
export function resolveModsDir(chosen: string): { dir: string; adjusted: boolean } {
  if (fs.existsSync(path.join(chosen, 'mods'))) return { dir: path.join(chosen, 'mods'), adjusted: true }
  return { dir: chosen, adjusted: false }
}

/**
 * Read a mods folder as a dependency graph.
 *
 * The output answers one question first: **is this folder already complete?**
 * `missing` is empty for a working pack, and that is the expected answer — not a
 * list of things to download.
 */
export function scanModsFolder(inputDir: string): PackScan {
  const { dir } = resolveModsDir(inputDir)
  const mods: PackMod[] = []
  const ignored: string[] = []
  const unreadableJars: string[] = []
  /** IDs read from file names, kept separately so nothing mistakes them for facts. */
  const inferred: (InferredIdentity & { path: string; file: string })[] = []

  /**
   * Walk the folder, not just its top level.
   *
   * Some packs keep `mods/1.21.1/`, `mods/client/` or unpacked mods in
   * subfolders, and a launcher that flattens them still has to be able to read
   * them. Depth is capped so a symlink loop cannot hang the scan.
   */
  const walk = (current: string, depth: number, rel: string): void => {
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name)
      const shown = rel ? path.join(rel, entry.name) : entry.name
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === '__MACOSX' || depth >= 4) continue
        walk(full, depth + 1, shown)
        continue
      }
      if (!/\.jar$/i.test(entry.name)) {
        // Counted, but not one by one: a pack folder holds dozens of configs,
        // and 200 names in a message is noise, not information.
        ignored.push(shown)
        continue
      }
      const mod = readModJar(full)
      if (mod.unreadable) {
        // A jar that cannot be read is a *jar*, not junk. Its name is still
        // evidence: packs are full of jars this app cannot parse, and dropping
        // them made the folder look more complete than it was.
        unreadableJars.push(shown)
        const guess = inferFromFileName(entry.name)
        if (guess) inferred.push({ ...guess, path: full, file: shown })
        continue
      }
      mods.push({ ...mod, file: shown })
    }
  }
  try {
    if (!fs.statSync(dir).isDirectory()) {
      return { dir, mods: [], missing: [], mismatched: [], ignored: [], unreadableJars: [], inferred: [], loaders: [], gameVersions: [] }
    }
  } catch {
    return { dir, mods: [], missing: [], mismatched: [], ignored: [], unreadableJars: [], inferred: [], loaders: [], gameVersions: [] }
  }
  walk(dir, 0, '')

  // What the folder provides, by mod id. A mod id can legitimately appear twice
  // (two builds of the same mod mid-update); the newest-looking version wins and
  // the duplicate is left for the report rather than silently picked.
  const provided = new Map<string, PackMod>()
  for (const mod of mods) {
    if (!mod.modId) continue
    const prev = provided.get(mod.modId)
    if (!prev || compareNumeric(numericParts(mod.version ?? ''), numericParts(prev.version ?? '')) > 0) {
      provided.set(mod.modId, mod)
    }
  }

  /**
   * A file-name guess that answers for this mod id.
   *
   * Deliberately strict: the whole id must match after normalising, so a file
   * called `createaddition-…` never stands in for `create`.
   */
  const scanGuess = (modId: string): (typeof inferred)[number] | undefined => {
    const want = normalizeModId(modId)
    if (!want) return undefined
    return inferred.find((g) => {
      const have = normalizeModId(g.modId)
      return have === want || have.replace(/mod$/, '') === want
    })
  }

  const missing = new Map<string, MissingDependency>()
  const mismatched: PackScan['mismatched'] = []
  for (const mod of mods) {
    for (const dep of mod.depends) {
      if (dep.isLoaderOrGame) continue
      if (dep.kind !== 'required') continue
      const have = provided.get(dep.modId)
      if (!have) {
        // A jar nobody could parse but whose *name* matches is still evidence the
        // dependency is there. Reporting it as missing would send the user to
        // download a mod they already have — under a different name, into the
        // same folder. It is matched, and the scan says the id is a guess.
        const guess = scanGuess(dep.modId)
        if (guess) continue
        const entry = missing.get(dep.modId) ?? { modId: dep.modId, versionRange: dep.versionRange, requiredBy: [] }
        if (dep.versionRange && !entry.versionRange) entry.versionRange = dep.versionRange
        if (!entry.requiredBy.includes(mod.file)) entry.requiredBy.push(mod.file)
        missing.set(dep.modId, entry)
        continue
      }
      if (dep.versionRange && !satisfiesRange(have.version, dep.versionRange)) {
        mismatched.push({ modId: dep.modId, have: have.version, versionRange: dep.versionRange, requiredBy: [mod.file] })
      }
    }
  }

  const loaders = [...new Set(mods.map((m) => m.loader))].filter((l) => l !== 'unknown')
  const gameVersions = [
    ...new Set(
      mods
        .flatMap((m) => m.depends.filter((d) => d.modId === 'minecraft' || d.modId === 'minecraft').map((d) => d.versionRange ?? ''))
        .filter(Boolean)
    )
  ].slice(0, 6)

  return {
    dir,
    mods,
    missing: [...missing.values()].sort((a, b) => a.modId.localeCompare(b.modId)),
    mismatched,
    ignored,
    unreadableJars,
    inferred,
    loaders: loaders as ModLoader[],
    gameVersions
  }
}

/**
 * Copy a jar from elsewhere in the folder into the folder.
 *
 * Used when the user has a newer build already downloaded — a jar in the pack root,
 * in a `mods-1.21.1` sibling, or in Downloads — and the app would otherwise fetch
 * the same thing over the network.
 */
export function adoptJar(from: string, modsDir: string, replace = false): { ok: boolean; path?: string; error?: string } {
  if (!fs.existsSync(from)) return { ok: false, error: `No such file: ${from}` }
  if (!/\.jar$/i.test(from)) return { ok: false, error: 'Only jar files can be added to a mods folder.' }
  try {
    fs.mkdirSync(modsDir, { recursive: true })
    const target = path.join(modsDir, path.basename(from))
    if (!replace && fs.existsSync(target)) {
      return { ok: true, path: target }
    }
    fs.copyFileSync(from, target)
    return { ok: true, path: target }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/**
 * Remove an older jar of the same mod, so the folder holds one version.
 *
 * Deliberately explicit: called for a jar the user just replaced, never for
 * anything the scan merely suspects. Deleting someone's mods is not a guess.
 */
export function removeJar(file: string): { ok: boolean; error?: string } {
  try {
    fs.rmSync(file, { force: true })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/* ------------------------------------------------------------- update planning */

/**
 * What an update of one mod in a pack would need, decided *before* any download.
 *
 * The order of the four outcomes below is the point. Any dependency the folder
 * already satisfies is reported as covered, and never becomes an offer:
 *
 *  1. `already-present` — a jar in the folder provides it, in a version that
 *     satisfies the range. Nothing to do. This is the expected answer in a
 *     working pack, and the one the old behaviour got wrong by offering to
 *     download a library that was two files away.
 *  2. `present-wrong-version` — a jar provides it but outside the range. The fix
 *     is a newer jar of *that* mod, not a second copy.
 *  3. `missing` — nothing provides it. This is the only case a download can help.
 *  4. `needs-confirmation` — nothing provides it, but other mods in the folder
 *     were only read partially, so the answer may be incomplete.
 */
export type DependencyOutcome = 'already-present' | 'present-wrong-version' | 'missing' | 'needs-confirmation'

export interface PlannedDependency {
  modId: string
  outcome: DependencyOutcome
  /** The file that provides it, when the folder does. */
  providedBy?: string
  /** The version that file is, when it could be read. */
  haveVersion?: string
  /** What the updated mod asks for. */
  versionRange?: string
  /** Files in the folder that need it. */
  requiredBy: string[]
  /** Files that declare it, so the user can see where the requirement came from. */
  declaredBy: string[]
}

export interface UpdatePlan {
  /** The mod being updated, by id, when it could be identified. */
  modId?: string
  /** Everything it asks for, decided against the folder as it is now. */
  dependencies: PlannedDependency[]
  /** The subset that a download could actually fix. Usually empty. */
  toDownload: PlannedDependency[]
  /** A sentence for the UI, with the folder-first answer already in it. */
  summary: string
}

/**
 * Decide what an update needs, against a folder that already works.
 *
 * `incoming` is the dependency list of the *new* build of the mod, which is read
 * from the downloaded jar when one has been chosen. Without it, the plan uses the
 * dependencies of the copy already in the folder — which is right for "what does
 * this mod need" and cannot know about a requirement the new version added.
 */
export function planUpdate(scan: PackScan, opts: { modId?: string; incoming?: ModDependency[] } = {}): UpdatePlan {
  const provided = new Map<string, PackMod>()
  for (const mod of scan.mods) {
    if (!mod.modId) continue
    const prev = provided.get(mod.modId)
    const cmp = compareNumeric(numericParts(mod.version ?? ''), numericParts(prev?.version ?? ''))
    if (!prev || cmp > 0) provided.set(mod.modId, mod)
  }

  const required = (opts.incoming ?? scan.mods.find((m) => m.modId === opts.modId)?.depends ?? []).filter(
    (d) => d.kind === 'required' && !d.isLoaderOrGame
  )

  const dependencies: PlannedDependency[] = required.map((dep) => {
    const have = provided.get(dep.modId)
    const declaredBy = scan.mods.filter((m) => m.depends.some((d) => d.modId === dep.modId && d.kind === 'required')).map((m) => m.file)
    if (!have) {
      return {
        modId: dep.modId,
        outcome: 'missing' as const,
        versionRange: dep.versionRange,
        requiredBy: [opts.modId ?? 'the updated mod'],
        declaredBy
      }
    }
    if (dep.versionRange && !satisfiesRange(have.version, dep.versionRange)) {
      return {
        modId: dep.modId,
        outcome: 'present-wrong-version' as const,
        providedBy: have.file,
        haveVersion: have.version,
        versionRange: dep.versionRange,
        requiredBy: [opts.modId ?? 'the updated mod'],
        declaredBy
      }
    }
    return {
      modId: dep.modId,
      outcome: 'already-present' as const,
      providedBy: have.file,
      haveVersion: have.version,
      versionRange: dep.versionRange,
      requiredBy: [opts.modId ?? 'the updated mod'],
      declaredBy
    }
  })

  const toDownload = dependencies.filter((d) => d.outcome === 'missing' || d.outcome === 'present-wrong-version')
  const covered = dependencies.filter((d) => d.outcome === 'already-present')
  const summary =
    dependencies.length === 0
      ? 'This mod declares no dependencies outside the loader, so nothing else is needed.'
      : toDownload.length === 0
        ? `This mod needs ${dependencies.length} dependent${dependencies.length === 1 ? '' : 's'}, and this mods folder already provides ${covered.length === dependencies.length ? 'all of them' : 'them'} — nothing to download.`
        : `${covered.length} of ${dependencies.length} dependencies are already in this folder. ${toDownload.length} ${toDownload.length === 1 ? 'is' : 'are'} not: ${toDownload.map((d) => d.modId).join(', ')}.`

  return { modId: opts.modId, dependencies, toDownload, summary }
}

/**
 * What a folder scan means for the whole pack, in the words a user needs.
 *
 * A scan returns facts; this turns them into the one sentence that decides
 * whether the user does anything at all. The important case is the boring one:
 * a pack that already works should be told so, loudly and without a button.
 */
export function describeScan(scan: PackScan): { headline: string; detail: string; healthy: boolean } {
  const n = scan.mods.length
  const modWord = `${n} mod${n === 1 ? '' : 's'}`
  const ignored = scan.ignored.length
    ? ` ${scan.ignored.length} other file${scan.ignored.length === 1 ? ' was' : 's were'} not mods and ${scan.ignored.length === 1 ? 'was' : 'were'} left alone.`
    : ''

  /**
   * Nothing read is not the same as nothing needed.
   *
   * The first version of this answered "0 mods, every dependency present" for a
   * folder whose jars it had all failed to parse — the most confidently wrong
   * thing an update tool can say. An empty result is a failure to look, and is
   * reported as one, with the count of jars that were actually there.
   */
  if (n === 0) {
    if (scan.unreadableJars.length > 0) {
      const named = scan.inferred.length
      return {
        headline: `No mod could be read from ${scan.unreadableJars.length} jar${scan.unreadableJars.length === 1 ? '' : 's'}`,
        detail:
          `The jars are there, but none of them could be read as a mod — so this is a problem reading them, not an empty folder. ` +
          (named
            ? `${named} ${named === 1 ? 'is' : 'are'} known only by ${named === 1 ? 'its' : 'their'} file name, which is a guess until the code is decompiled. `
            : '') +
          `First three: ${scan.unreadableJars.slice(0, 3).join(', ')}.${ignored}`,
        healthy: false
      }
    }
    return {
      headline: 'No mods found in this folder',
      detail: `There are no jar files at all in ${scan.dir}${ignored} Check that this is the mods folder — it is the one the launcher loads.`,
      healthy: false
    }
  }

  if (scan.unreadableJars.length > 0) {
    const named = scan.inferred.length
    return {
      headline: `${modWord} read, ${scan.unreadableJars.length} jar${scan.unreadableJars.length === 1 ? '' : 's'} could not be`,
      detail:
        (named
          ? `${named} of those ${named === 1 ? 'is' : 'are'} known only by ${named === 1 ? 'its' : 'their'} file name${named === 1 ? '' : 's'}, so ${named === 1 ? 'its id is a guess and its' : 'their ids are guesses and their'} own dependencies are unknown. `
          : '') +
        `An unreadable jar's own requirements are invisible to this scan. First: ${scan.unreadableJars.slice(0, 3).join(', ')}.${ignored}`,
      healthy: false
    }
  }

  if (scan.missing.length === 0 && scan.mismatched.length === 0) {
    return {
      headline: `${modWord}, every dependency present`,
      detail: `This folder already contains what its mods declare. Updating a mod here should need nothing downloaded.${ignored}`,
      healthy: true
    }
  }

  const parts: string[] = []
  if (scan.missing.length) {
    parts.push(
      `${scan.missing.length} dependenc${scan.missing.length === 1 ? 'y is' : 'ies are'} not in this folder (${scan.missing
        .slice(0, 4)
        .map((m) => m.modId)
        .join(', ')}${scan.missing.length > 4 ? ', …' : ''})`
    )
  }
  if (scan.mismatched.length) {
    const k = scan.mismatched.length
    parts.push(k === 1 ? '1 is present but the wrong version' : `${k} are present but the wrong version`)
  }
  return {
    headline: `${modWord}, ${parts.join(' and ')}`,
    detail: `Start from the missing list: those are the only things a download can fix. Everything else in this folder is already covered.${ignored}`,
    healthy: false
  }
}

/**
 * Would updating one mod break the pack?
 *
 * An update can tighten a dependency's range past the version the folder holds —
 * the single most common way a pack stops launching after a mod update. This
 * answers that before the jar is fetched, using the *incoming* build's own
 * metadata, and names the file to upgrade if so.
 */
export function previewAdoption(
  scan: PackScan,
  incomingJar: string
): { ok: boolean; error?: string; replaces?: string; plan?: UpdatePlan } {
  const incoming = readModJar(incomingJar)
  if (incoming.unreadable) return { ok: false, error: `${path.basename(incomingJar)} is not a readable mod jar.` }
  const sameMod = incoming.modId ? scan.mods.filter((m) => m.modId === incoming.modId) : []
  // Two builds of one mod id is the exact mess this feature exists to prevent.
  const replaces = sameMod.filter((m) => path.resolve(m.path) !== path.resolve(incomingJar))[0]?.file
  const duplicates = sameMod.length > 1 ? sameMod.map((m) => m.file) : undefined
  const plan = planUpdate(scan, { modId: incoming.modId, incoming: incoming.depends })
  return {
    ok: true,
    replaces,
    plan: duplicates ? { ...plan, summary: `${plan.summary} This folder already holds ${duplicates.join(' and ')}; adding this would leave two copies.` } : plan
  }
}

/* ------------------------------------------- updating one mod, with its needs */

/**
 * A dependency that belongs to the mod being updated, found in the folder.
 *
 * This is the shape the *real* workflow needs: the user picks one mod to update,
 * and the pack's own copies of that mod's dependencies come along with it —
 * decompiled, so the agent can read them, and updated to the version the new
 * build of the chosen mod actually asks for.
 *
 * `problems` is filled instead of throwing: a jar that is present but which the
 * new build will not accept is still listed, with the reason, because "your
 * Create build wants Flywheel 2.x and you have 1.0.4" is the answer the user
 * needs, not a silent skip.
 */
export interface DependencyToUpdate {
  modId: string
  /** The range the updated mod asks for. */
  versionRange?: string
  /** The jar in the folder that provides it, when one does. */
  path?: string
  file?: string
  version?: string
  /** True when the folder's copy does not satisfy the requested range. */
  needsNewer: boolean
  /** Something worth saying about it — missing, wrong version, unreadable. */
  problem?: string
  /** True when this was recognised only from the jar's file name. */
  inferred?: boolean
}

export interface ModUpdatePreview {
  modId?: string
  name?: string
  version?: string
  /** The jar in the folder that this update replaces, when it is already there. */
  replaces?: string
  /** Every required dependency of the incoming build, decided against the folder. */
  dependencies: DependencyToUpdate[]
  /** Those that need a newer jar before the updated mod will load. */
  needNewer: DependencyToUpdate[]
  summary: string
}

/**
 * Read the dependencies of a downloaded jar and find each of them in the pack.
 *
 * Runs entirely against the folder: the answer is which jars already in it belong
 * with the new build, and which of those are too old. Downloading is what happens
 * to the ones that are missing — after this, not before it.
 */
export function planModUpdate(scan: PackScan, incomingJar: string): { ok: boolean; error?: string; preview?: ModUpdatePreview } {
  if (!fs.existsSync(incomingJar)) return { ok: false, error: `No such file: ${incomingJar}` }
  const incoming = readModJar(incomingJar)
  if (incoming.unreadable) {
    return { ok: false, error: `${path.basename(incomingJar)} could not be read as a mod — no ${incomingJar.endsWith('.jar') ? 'mods.toml, mcmod.info' : 'metadata'} found in it.` }
  }

  const byModId = new Map<string, PackMod>()
  for (const mod of scan.mods) {
    if (!mod.modId) continue
    const prev = byModId.get(mod.modId)
    if (!prev || compareNumeric(numericParts(mod.version ?? ''), numericParts(prev.version ?? '')) > 0) byModId.set(mod.modId, mod)
  }
  /** The same search, but also accepting a name guess for an unreadable jar. */
  const findProvider = (modId: string): { mod?: PackMod; guessed: boolean } => {
    const exact = byModId.get(modId)
    if (exact) return { mod: exact, guessed: !!exact.inferred }
    const want = normalizeModId(modId)
    for (const g of scan.inferred) {
      const have = normalizeModId(g.modId)
      if (have !== want && have.replace(/mod$/, '') !== want) continue
      // Shaped like a PackMod so the caller does not need a second code path; the
      // `inferred` flag is what stops it being reported as a fact.
      return {
        mod: {
          path: g.path,
          file: g.file,
          modId: g.modId,
          name: g.name,
          version: g.version,
          loader: 'unknown',
          depends: [],
          unreadable: true,
          inferred: true,
          confidence: g.confidence
        },
        guessed: true
      }
    }
    return { guessed: false }
  }

  const dependencies: DependencyToUpdate[] = []
  for (const dep of incoming.depends) {
    if (dep.isLoaderOrGame || dep.kind !== 'required') continue
    const { mod: have, guessed } = findProvider(dep.modId)
    if (!have) {
      dependencies.push({
        modId: dep.modId,
        versionRange: dep.versionRange,
        needsNewer: true,
        problem: 'not in this folder — this one has to be downloaded'
      })
      continue
    }
    // A version that came from a file name cannot be trusted against a range. The
    // jar is treated as *possibly* right: it is offered, with the caveat, rather
    // than silently upgraded over a working install or silently skipped.
    const rangeCheckedAgainstGuess = guessed && dep.versionRange
    const inRange = rangeCheckedAgainstGuess ? false : !dep.versionRange || satisfiesRange(have.version, dep.versionRange)
    const caveat = guessed
      ? `${have.file} could not be read, so its id and version are read from the file name — decompiling it will confirm or disprove that`
      : undefined
    dependencies.push({
      modId: dep.modId,
      versionRange: dep.versionRange,
      path: have.path,
      file: have.file,
      version: have.version,
      needsNewer: !inRange && !guessed,
      inferred: guessed || undefined,
      problem: caveat ?? (inRange ? undefined : `the folder has ${have.version ?? 'an older build'}, but this mod needs ${dep.versionRange}`)
    })
  }

  const needNewer = dependencies.filter((d) => d.needsNewer)
  const covered = dependencies.length - needNewer.length
  const sameMod = incoming.modId ? scan.mods.filter((m) => m.modId === incoming.modId) : []
  const replaces = sameMod[0]?.file

  const summary =
    dependencies.length === 0
      ? `${incoming.modId ?? 'This mod'} declares no dependencies outside the loader, so nothing else has to come with it.`
      : needNewer.length === 0
        ? `${incoming.modId ?? 'This mod'} needs ${dependencies.length} dependenc${dependencies.length === 1 ? 'y' : 'ies'}, and this folder provides ${covered === dependencies.length ? 'all of them' : 'them'} at compatible versions. They can be decompiled and updated alongside it, or left as they are.`
        : `${covered} of ${dependencies.length} dependencies are already here and compatible. ${needNewer.length} ${needNewer.length === 1 ? 'needs' : 'need'} a newer build: ${needNewer.map((d) => d.modId).join(', ')}.`

  return { ok: true, preview: { modId: incoming.modId, name: incoming.name, version: incoming.version, replaces, dependencies, needNewer, summary } }
}

/** Names the pack already uses for each mod id, so a report says "Create" not "create". */
export function displayNames(scan: PackScan): Record<string, string> {
  const out: Record<string, string> = {}
  for (const mod of scan.mods) {
    if (!mod.modId) continue
    if (!out[mod.modId] && mod.name) out[mod.modId] = mod.name
  }
  return out
}

/* ------------------------------------------------- reading a jar by its name */

/**
 * A mod identified from its file name, because nothing inside it could be read.
 *
 * Real packs contain jars this app cannot parse: obfuscated metadata, unusual
 * formats, jars whose toml is inside a nested archive. Ignoring them makes a
 * folder look emptier and more complete than it is, so the name is used instead —
 * and everything derived from it is marked as a guess, never as a fact.
 */
export interface InferredIdentity {
  /** Best guess at the mod id, lowercased with dashes kept (`icbm-classic`). */
  modId: string
  /** The human name the file name suggests. */
  name: string
  version?: string
  /** The Minecraft version the name mentions, when it mentions one. */
  mcVersion?: string
  /** Always true: this came from the name, not from the jar. */
  inferred: true
  /** How sure the guess is. `weak` means no version token was found at all. */
  confidence: 'likely' | 'weak'
}

/** Loader words that appear in file names but are not part of a mod id. */
const NAME_LOADERS = new Set(['forge', 'neoforge', 'fabric', 'quilt', 'common', 'universal', 'api', 'mc', 'mod'])

/**
 * `1.20.1`, and `mc1.20.1` — a Minecraft version written in a file name.
 *
 * Every Minecraft release so far is 1.x, which is what makes this decidable at
 * all; a mod's own version is almost never `1.x.y` and is never `mc1.x`.
 */
function isMinecraftish(token: string): boolean {
  const t = token.replace(/^mc/i, '')
  return /^1\.\d+(\.\d+)?$/.test(t) && (token.toLowerCase().startsWith('mc') || /^1\.\d+(\.\d+)?$/.test(token))
}

/** `6.0.4`, `15.2.0.27`, `0.5.0+mc1.20.1` — a version of the mod itself. */
function isVersionish(token: string): boolean {
  return /\d+\.\d+/.test(token) || /^\d+$/.test(token)
}

/** Compare mod ids without caring about case, dashes or underscores. */
export function normalizeModId(id: string): string {
  return (id ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Whether a name we guessed really is the mod id a dependency asked for.
 *
 * Equality after normalising, deliberately not "contains": a dependency on
 * `create` must never be satisfied by `createaddition-1.2.0.jar`, or the folder
 * would claim to have Create when it does not. A trailing `mod`/`-mod` is the one
 * exception, because file names add it constantly.
 */
export function fileNameMatchesMod(fileName: string, modId: string): boolean {
  const inferred = inferFromFileName(fileName)
  if (!inferred) return false
  const want = normalizeModId(modId)
  if (!want) return false
  const have = normalizeModId(inferred.modId)
  if (have === want) return true
  return have.replace(/mod$/, '') === want
}

/**
 * Read a mod id and version out of a jar's file name.
 *
 * The patterns that actually occur:
 *
 *   create-1.21.1-6.0.4.jar          id, minecraft version, mod version
 *   flywheel-1.0.4.jar               id, mod version
 *   ICBM-Classic-1.12.2-4.2.0.jar    multi-word id, minecraft, version
 *   sodium-fabric-mc1.20.1-0.5.0.jar id, loader, minecraft, version
 *   jei-1.20.1-forge-15.2.0.27.jar    id, minecraft, loader, version
 *
 * Returns null when the name carries nothing id-like, which is better than
 * inventing an id that could then be matched against a real dependency.
 */
export function inferFromFileName(file: string): InferredIdentity | null {
  const base = path.basename(file).replace(/\.jar$/i, '')
  if (!base) return null
  // `-sources`/`-dev` jars describe a mod but are not the mod's runtime jar.
  const cleaned = base.replace(/-(sources|dev|javadoc|api)$/i, '')
  const tokens = cleaned.split(/[-_+\s]+/).filter(Boolean)
  if (!tokens.length) return null

  const idTokens: string[] = []
  const versions: string[] = []
  let mcVersion: string | undefined

  let mcIndex = -1
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (isVersionish(token)) {
      if (isMinecraftish(token) && mcIndex < 0) {
        mcVersion = token.replace(/^mc/i, '')
        mcIndex = i
        continue
      }
      // `1.0.4` follows the minecraft version in `flywheel-1.21.1-1.0.4`; the
      // first version-ish token after it is the mod's own.
      versions.push(token)
      continue
    }
    // Words after the first version belong to the version or the loader, not the id.
    if (versions.length || mcVersion) {
      if (NAME_LOADERS.has(token.toLowerCase())) continue
      versions.push(token)
      continue
    }
    // Loader words are noise wherever they appear (`jei-forge-...`). The rest of
    // NAME_LOADERS stays: `some-mod` and `icbm-api` are real ids, and cutting the
    // second word off would invent a mod that is not in the folder.
    const word = token.toLowerCase()
    if (word === 'forge' || word === 'neoforge' || word === 'fabric' || word === 'quilt' || word === 'mc') continue
    if (word === 'common' || word === 'universal') continue
    idTokens.push(token)
  }

  if (!idTokens.length) return null
  // `some-mod` is an id called `some-mod`; the word `mod` there is part of the
  // name, not a suffix to strip. Only a bare "mod" token is noise.
  const modId = idTokens.join('-').toLowerCase()
  // No version and no Minecraft version means the name is all there is —
  // `backup.jar`, `mod.jar`, `old.jar`. Nothing about that is a mod id worth
  // matching a real dependency against, so nothing is claimed.
  if (!versions.length && !mcVersion) return null
  // `mod`/`api` alone is a category word, not a name.
  if (NAME_LOADERS.has(modId)) return null

  return {
    modId,
    name: idTokens.join(' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    version: versions[0],
    mcVersion,
    inferred: true,
    confidence: versions.length ? 'likely' : 'weak'
  }
}

/**
 * Confirm a file-name guess against the code it turned out to contain.
 *
 * Decompiling is the only way to *check* an unreadable jar, and it usually says
 * so plainly: every Forge-family mod carries `@Mod("id")` and every Fabric one a
 * `fabric.mod.json`-shaped class. Finding the id is proof; finding a different
 * `@Mod` id is disproof, which is more valuable than either.
 */
export function verifyInferredId(sourcesDir: string, expectedModId: string): { verdict: 'confirmed' | 'contradicted' | 'unknown'; found?: string; checked: number } {
  const want = normalizeModId(expectedModId)
  let checked = 0
  const seen: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      if (!entry.name.endsWith('.java')) continue
      checked++
      // The annotation is in the main class; reading every file of a large mod is
      // wasted work, and the first few thousand are enough to prove the point.
      if (checked > 4000) return
      let text: string
      try {
        text = fs.readFileSync(full, 'utf8')
      } catch {
        continue
      }
      for (const m of text.matchAll(/@Mod\s*\(\s*(?:value\s*=\s*|modid\s*=\s*)?["']([\w.-]+)["']/g)) seen.push(m[1])
      for (const m of text.matchAll(/@Mod\s*\(\s*modid\s*=\s*["']([\w.-]+)["']/g)) seen.push(m[1])
    }
  }
  walk(sourcesDir, 0)
  if (!seen.length) return { verdict: 'unknown', checked }
  if (seen.some((id) => normalizeModId(id) === want)) return { verdict: 'confirmed', found: seen[0], checked }
  return { verdict: 'contradicted', found: seen[0], checked }
}
