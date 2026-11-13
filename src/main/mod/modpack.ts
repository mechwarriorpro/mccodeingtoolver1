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
  /** Non-jar files, and jars that are not mods, kept visible rather than dropped. */
  ignored: string[]
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
  let names: string[] = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return { dir, mods: [], missing: [], mismatched: [], ignored: [], loaders: [], gameVersions: [] }
  }
  for (const name of names.sort()) {
    const full = path.join(dir, name)
    if (!/\.jar$/i.test(name)) {
      ignored.push(name)
      continue
    }
    let stat: fs.Stats
    try {
      stat = fs.statSync(full)
    } catch {
      ignored.push(name)
      continue
    }
    if (!stat.isFile()) {
      ignored.push(name)
      continue
    }
    const mod = readModJar(full)
    if (mod.unreadable) {
      ignored.push(name)
      continue
    }
    mods.push(mod)
  }

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

  const missing = new Map<string, MissingDependency>()
  const mismatched: PackScan['mismatched'] = []
  for (const mod of mods) {
    for (const dep of mod.depends) {
      if (dep.isLoaderOrGame) continue
      if (dep.kind !== 'required') continue
      const have = provided.get(dep.modId)
      if (!have) {
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
  const ignored = scan.ignored.length ? ` ${scan.ignored.length} file${scan.ignored.length === 1 ? '' : 's'} were not mods and were left alone.` : ''

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
    const n = scan.mismatched.length
    parts.push(n === 1 ? '1 is present but the wrong version' : `${n} are present but the wrong version`)
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
