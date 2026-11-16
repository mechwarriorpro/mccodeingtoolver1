import fs from 'node:fs'
import path from 'node:path'
import AdmZip from 'adm-zip'

/**
 * Deciding what an outdated mod actually costs to bring forward.
 *
 * The complaint this answers is not "it will not update" — it is that an update
 * either does too much (rewrite the mod, lose a feature, change the design) or
 * too little (bump a version property and call it ported). Both are failures,
 * and both come from the same mistake: treating every crossed version boundary
 * as if it changed everything.
 *
 * It does not. A 1.20.1 → 1.21.1 port touches the build file and a handful of
 * renamed methods; the *features* are untouched, and so is most of the code. So
 * this module separates the two questions:
 *
 *   1. Which boundaries does this jump cross? That decides *what may need to
 *      change*. A boundary that is not crossed cannot justify an edit.
 *   2. What in these particular sources is actually affected? That decides what
 *      *has* to change, and is empty most of the time.
 *
 * The second is the important one. An `Edit` is justified by a symbol that is
 * genuinely gone, not by the version number having moved. That is what keeps a
 * feature intact: code that still compiles is code nobody has a reason to touch.
 */

export type BoundaryKind = 'version' | 'naming' | 'loader' | 'java'

export interface Boundary {
  id: string
  kind: BoundaryKind
  /** Human label, e.g. "1.20.4 → 1.20.5". */
  label: string
  /** What changes across it, in a sentence. */
  change: string
  /** `false` for an era that is crossed but usually costs nothing (e.g. metadata only). */
  breaksCompile: boolean
}

/**
 * Every boundary that can actually break a mod, in order.
 *
 * Deliberately a short list. A table with two hundred entries is a table an
 * agent will not read, and the point is to be *right* about the ones that matter
 * rather than complete about the ones that do not.
 */
export const BOUNDARIES: Boundary[] = [
  {
    id: 'legacy-to-flattening',
    kind: 'version',
    label: '1.12.2 → 1.13',
    change:
      'The flattening: numeric block/item ids become registered objects, recipes become JSON, and `GameRegistry.register`/`new Item()` are gone.',
    breaksCompile: true
  },
  {
    id: 'mcp-to-mojmap',
    kind: 'naming',
    label: '1.16.5 → 1.17 (MCP → Mojang official names)',
    change:
      'Every Minecraft class and method is renamed in one step: `World` → `Level`, `net.minecraft.block.Block` → `net.minecraft.world.level.block.Block`, `PlayerEntity` → `Player`. Imports break wholesale, but the logic under them is unchanged.',
    breaksCompile: true
  },
  {
    id: 'worldgen-1.18',
    kind: 'version',
    label: '1.17 → 1.18',
    change: 'World generation was rewritten around `NoiseBasedChunkGenerator` and the new biome source registry. Custom worldgen needs real work; everything else is untouched.',
    breaksCompile: true
  },
  {
    id: 'registry-events-1.19.3',
    kind: 'version',
    label: '1.19.2 → 1.19.3',
    change: '`RegistryEvent` was deleted. Registration moves to `DeferredRegister` + `RegisterEvent` (Forge) or the loader equivalent.',
    breaksCompile: true
  },
  {
    id: 'data-components-1.20.5',
    kind: 'version',
    label: '1.20.4 → 1.20.5',
    change:
      '`ItemStack` NBT is replaced by typed data components. `getOrCreateTag()`, `getTag()`, `hasTag()` and the `CompoundTag` on a stack are gone. This is the single largest compile-breaking change of the modern era and there is no mechanical translation for it — but a mod that never stored data on an item is unaffected.',
    breaksCompile: true
  },
  {
    id: 'java-21',
    kind: 'java',
    label: '1.20.5+ requires Java 21',
    change: 'The toolchain moves to Java 21. Source level and `build.gradle` both change; the code usually does not.',
    breaksCompile: false
  },
  {
    id: 'neoforge-split-1.20.2',
    kind: 'loader',
    label: 'Forge → NeoForge (1.20.2+)',
    change:
      '`net.minecraftforge.*` becomes `net.neoforged.neoforge.*`, `mods.toml` becomes `neoforge.mods.toml`, the network channel API changes, and `SimpleChannel` is removed in 1.20.6+.',
    breaksCompile: true
  },
  {
    id: 'loader-swap',
    kind: 'loader',
    label: 'Forge ↔ NeoForge ↔ Fabric',
    change:
      'The integration layer is different code, not a rename: DeferredRegister vs Registry.register, event buses vs Fabric callbacks, mods.toml vs fabric.mod.json. A mod that only adds blocks and items survives; a mod with deep integration does not.',
    breaksCompile: true
  }
]

/** Split "1.20.4" into comparable parts. Non-numeric tails (`1.21.1-pre1`) are ignored. */
export function versionParts(v: string): number[] {
  return v
    .split(/[.\-+]/)
    .map((p) => parseInt(p, 10))
    .filter((n) => Number.isFinite(n))
}

/** -1, 0 or 1. Compares numerically, so 1.9 < 1.10 (string compare gets this wrong). */
export function compareVersions(a: string, b: string): number {
  const pa = versionParts(a)
  const pb = versionParts(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/**
 * Which boundaries does moving from `from` to `to` cross?
 *
 * Direction matters: a downgrade crosses the same boundaries in reverse, and
 * saying "1.21 → 1.20 removed `Level`" would be nonsense, so the caller is told
 * the direction separately and this returns the boundaries either way.
 */
export function crossedBoundaries(from: { mcVersion: string | null; loader: string }, to: { mcVersion: string; loader: string }): Boundary[] {
  const out: Boundary[] = []
  const fromVer = from.mcVersion
  const toVer = to.mcVersion
  const sameLoader = from.loader === to.loader

  if (!sameLoader && from.loader !== 'unknown') {
    out.push(BOUNDARIES.find((b) => b.id === 'loader-swap')!)
  } else if (sameLoader && from.loader === 'forge' && fromVer && compareVersions(fromVer, '1.20.2') < 0 && compareVersions(toVer, '1.20.2') >= 0) {
    // Forge and NeoForge are the same lineage split, not an unrelated loader.
    out.push(BOUNDARIES.find((b) => b.id === 'neoforge-split-1.20.2')!)
  }

  if (!fromVer) return out

  const forward = compareVersions(toVer, fromVer) > 0
  const lo = forward ? fromVer : toVer
  const hi = forward ? toVer : fromVer

  for (const b of BOUNDARIES) {
    if (b.kind !== 'version' && b.kind !== 'naming') continue
    // A boundary is crossed when the whole jump spans it end to end.
    const [bFrom, bToText] = b.label.split(' → ')
    const bTo = (bToText ?? '').split(' ')[0]
    if (!bFrom || !bTo) continue
    const fromNum = bFrom.replace(/[^0-9.]/g, '')
    const toNum = bTo.replace(/[^0-9.]/g, '')
    if (!/^[\d.]+$/.test(fromNum) || !/^[\d.]+$/.test(toNum)) continue
    const crosses = compareVersions(lo, toNum) <= 0 && compareVersions(hi, fromNum) > 0
    if (crosses) out.push(b)
  }

  // Java 21 is not a version boundary of its own; it is a consequence of 1.20.5.
  if (compareVersions(hi, '1.20.5') >= 0 && compareVersions(lo, '1.20.5') < 0) {
    const j = BOUNDARIES.find((b) => b.id === 'java-21')
    if (j && !out.some((b) => b.id === 'java-21')) out.push(j)
  }
  return out
}

/* ------------------------------------------------------------------ the sources */

export interface SourceFile {
  /** Path relative to the source root, forward slashes. */
  rel: string
  text: string
}

export interface SymbolUse {
  /** What the agent would have to change, in the form it appears. */
  symbol: string
  /** Why it is a problem, in one line. */
  why: string
  /** Boundary that caused it. */
  boundary: string
  files: { rel: string; lines: number[] }[]
  /** How many occurrences in total. */
  count: number
}

/**
 * A symbol that stopped existing, and what replaced it.
 *
 * `pattern` is matched against source text. Kept as plain strings rather than a
 * compiled grammar: the goal is a *list of things to look at*, not a refactor
 * engine, and a regex over real code is honest about being a heuristic.
 */
interface SymbolRule {
  boundary: string
  symbol: string
  why: string
  pattern: RegExp
  /** A file that only mentions the name in a comment or a string is not a use. */
  ignoreIn?: RegExp
}

const SYMBOL_RULES: SymbolRule[] = [
  // ---- 1.20.5: data components -------------------------------------------
  {
    boundary: 'data-components-1.20.5',
    symbol: 'ItemStack#getOrCreateTag()',
    why: 'Removed in 1.20.5. Item data is `DataComponents.CUSTOM_DATA` now; `stack.get(DataComponents.CUSTOM_DATA)` returns a `CustomData`.',
    pattern: /\.getOrCreateTag\s*\(/
  },
  {
    boundary: 'data-components-1.20.5',
    symbol: 'ItemStack#getTag() / hasTag()',
    why: 'Removed in 1.20.5 with the rest of item NBT. Read the component you actually stored instead of a raw tag.',
    pattern: /\.(getTag|hasTag)\s*\(\s*\)/
  },
  {
    boundary: 'data-components-1.20.5',
    symbol: 'ItemStack#setTag(...)',
    why: 'Removed in 1.20.5. `stack.set(DataComponents.CUSTOM_DATA, CustomData.of(tag))` is the replacement, and storing a plain `CompoundTag` there is usually the wrong shape.',
    pattern: /\.setTag\s*\(/
  },
  // ---- 1.19.3: registry events -------------------------------------------
  {
    boundary: 'registry-events-1.19.3',
    symbol: 'RegistryEvent',
    why: 'Deleted in 1.19.3. Use `DeferredRegister` and let the loader fire `RegisterEvent`; a `@SubscribeEvent` on `RegistryEvent.Register` no longer runs.',
    pattern: /\bRegistryEvent\b/
  },
  // ---- 1.17: MCP → mojmap ------------------------------------------------
  {
    boundary: 'mcp-to-mojmap',
    symbol: 'World',
    why: '`net.minecraft.world.World` is `net.minecraft.world.level.Level` from 1.17. The type name appears at every use site, not only in imports.',
    pattern: /\bWorld\b/
  },
  {
    boundary: 'mcp-to-mojmap',
    symbol: 'PlayerEntity',
    why: 'Became `net.minecraft.world.entity.player.Player` from 1.17.',
    pattern: /\bPlayerEntity\b/
  },
  {
    boundary: 'mcp-to-mojmap',
    symbol: 'ItemStack#getItem() on Block interactions',
    why: 'The MCP-era `ItemStack` accessors were renamed (`getItem` stays, but `getCount`/`setCount` replaced `stackSize`), so block-interaction code needs re-reading rather than a search-and-replace.',
    pattern: /\bgetItemStackSize\b|\bsetItemStackSize\b|\bstackSize\b/
  },
  // ---- 1.13: the flattening ----------------------------------------------
  {
    boundary: 'legacy-to-flattening',
    symbol: 'GameRegistry',
    why: 'Removed in 1.13. Registration is on the registry itself or through `DeferredRegister`.',
    pattern: /\bGameRegistry\b/
  },
  {
    boundary: 'legacy-to-flattening',
    symbol: 'Item#setUnlocalizedName',
    why: 'Removed in 1.13; the translation key is derived from the registry name instead.',
    pattern: /\.setUnlocalizedName\s*\(/
  },
  // ---- loader swap --------------------------------------------------------
  {
    boundary: 'neoforge-split-1.20.2',
    symbol: 'SimpleChannel',
    why: 'Removed in NeoForge 1.20.6. Use `RegisterPayloadHandlersEvent` and a `CustomPacketPayload` record.',
    pattern: /\bSimpleChannel\b/
  },
  {
    boundary: 'loader-swap',
    symbol: 'net.minecraftforge.*',
    why: 'This package does not exist on NeoForge or Fabric. Every import needs replacing with the loader it is being ported to.',
    pattern: /net\.minecraftforge\./
  },
  {
    boundary: 'loader-swap',
    symbol: 'DeferredRegister',
    why: 'Forge/NeoForge only. On Fabric the equivalent is `Registry.register` at mod initialisation.',
    pattern: /\bDeferredRegister\b/
  }
]

/**
 * Find the real work in a source tree, given the boundaries being crossed.
 *
 * Returns nothing when nothing is affected — which is the common case and the
 * whole point. An empty result is a licence to change only the build file.
 */
export function findBreakingUses(files: SourceFile[], boundaries: Boundary[]): SymbolUse[] {
  const active = new Set(boundaries.map((b) => b.id))
  if (!active.size) return []
  // Packed `git`-age heuristic: a synthetic `mods.toml` here is a build concern,
  // not a source one, so only Java and Kotlin are scanned.
  const scans = files.filter((f) => /\.(java|kt)$/.test(f.rel))
  const bySymbol = new Map<string, SymbolUse>()

  for (const rule of SYMBOL_RULES) {
    if (!active.has(rule.boundary)) continue
    for (const file of scans) {
      if (rule.ignoreIn?.test(file.rel)) continue
      const lines = file.text.split(/\r?\n/)
      const hits: number[] = []
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (!rule.pattern.test(line)) continue
        // Reset lastIndex in case a global flag is ever added.
        rule.pattern.lastIndex = 0
        hits.push(i + 1)
      }
      if (!hits.length) continue
      const existing = bySymbol.get(rule.symbol)
      if (existing) {
        existing.files.push({ rel: file.rel, lines: hits })
        existing.count += hits.length
      } else {
        bySymbol.set(rule.symbol, { symbol: rule.symbol, why: rule.why, boundary: rule.boundary, files: [{ rel: file.rel, lines: hits }], count: hits.length })
      }
    }
  }
  // Most widespread first: that is what decides the order of work.
  return [...bySymbol.values()].sort((a, b) => b.count - a.count)
}

/** Load every Java/Kotlin file under a project's source root. */
export function loadSources(workspaceDir: string, sourceRoot: string): SourceFile[] {
  const root = path.join(workspaceDir, sourceRoot)
  const out: SourceFile[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 40) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'build' || e.name === '.gradle' || e.name === 'node_modules') continue
        walk(p, depth + 1)
      } else if (/\.(java|kt)$/.test(e.name)) {
        try {
          out.push({ rel: path.relative(root, p).split(path.sep).join('/'), text: fs.readFileSync(p, 'utf8') })
        } catch {
          /* an unreadable file is not a reason to fail the analysis */
        }
      }
    }
  }
  walk(root, 0)
  return out
}

/* ------------------------------------------------------------------- the plan */

export interface UpdatePlan {
  from: { mcVersion: string | null; loader: string }
  to: { mcVersion: string; loader: string }
  /** Same version and loader: nothing to do. */
  upToDate: boolean
  /** True when the target is older than the source. */
  downgrade: boolean
  /** Boundaries the jump crosses — the *possible* scope of work. */
  boundaries: Boundary[]
  /** The *actual* work, found in the code. Often empty. */
  breaking: SymbolUse[]
  /** Files that need an edit, derived from `breaking`. */
  filesTouched: string[]
  /**
   * What must not be touched, stated plainly so the instruction has something
   * concrete to point at.
   */
  preserve: string[]
  /** Build-file work that is mechanical and safe. */
  mechanical: string[]
  /** One paragraph for the user. */
  summary: string
  /** True when only the toolchain changed. */
  buildOnly: boolean
}

/**
 * Build the plan from a source tree already in memory.
 *
 * Split out from the filesystem reader so it can be tested against fixed input,
 * which matters here: the interesting behaviour is "what does it decide to
 * leave alone", and that is invisible from a real project.
 */
export function planUpdate(opts: {
  from: { mcVersion: string | null; loader: string }
  to: { mcVersion: string; loader: string }
  files: SourceFile[]
}): UpdatePlan {
  const { from, to, files } = opts
  const upToDate = !!from.mcVersion && from.mcVersion === to.mcVersion && from.loader === to.loader
  const downgrade = !!from.mcVersion && compareVersions(to.mcVersion, from.mcVersion) < 0
  const boundaries = upToDate ? [] : crossedBoundaries(from, to)
  const breaking = upToDate ? [] : findBreakingUses(files, boundaries)

  const filesTouched = [...new Set(breaking.flatMap((b) => b.files.map((f) => f.rel)))].sort()
  const javaFiles = files.filter((f) => /\.(java|kt)$/.test(f.rel)).length
  const untouched = javaFiles - filesTouched.length

  const mechanical: string[] = []
  if (!upToDate && (from.loader !== to.loader || !from.mcVersion || compareVersions(to.mcVersion, from.mcVersion) !== 0)) {
    mechanical.push(
      `Set \`minecraft_version\` to ${to.mcVersion} and the loader version to a real one for it — an empty loader version resolves nothing and every source file fails with "package net.minecraft… does not exist".`,
      'Update `build.gradle` only where the toolchain requires it; leave custom repositories, dependencies and tasks exactly as they are.'
    )
    if (boundaries.some((b) => b.id === 'java-21')) mechanical.push('Set the Java source/target level to 21 in both `build.gradle` and `gradle.properties`.')
    if (boundaries.some((b) => b.id === 'neoforge-split-1.20.2' || b.id === 'loader-swap')) {
      mechanical.push('Rename the metadata file and its loader version range (`mods.toml` ↔ `neoforge.mods.toml` / `fabric.mod.json`).')
    }
  }

  const preserve = [
    'Every feature, block, item, entity, recipe, texture, model, sound and config that exists today. This is an update, not a redesign.',
    'The mod id, package root, class names, registration order and config keys — worlds and existing saves depend on them.',
    'Public method signatures on your own classes where they do not have to change, so add-on integrations do not break.',
    'Comments, javadoc and formatting outside the lines being edited. Do not reformat a file to fix one import.'
  ]

  const conflict = findGeneratedConflicts(files, breaking)
  if (conflict.length) {
    preserve.push(
      `\`src/main/resources\` holds generated data for the old version: ${conflict.join(', ')}. Regenerate it with \`runData\` after the code compiles rather than editing it by hand.`
    )
  }

  const summary = upToDate
    ? `Already on ${to.loader} ${to.mcVersion} — nothing to update.`
    : downgrade
      ? `The target ${to.loader} ${to.mcVersion} is older than ${from.mcVersion}. Boundaries are crossed in reverse and several APIs being removed do not come back; this is a real port, so treat the estimate as a floor.`
      : breaking.length === 0
        ? `Moving ${from.loader} ${from.mcVersion ?? '?'} → ${to.loader} ${to.mcVersion} crosses ${boundaries.length} boundar${boundaries.length === 1 ? 'y' : 'ies'}, but none of ${javaFiles} source files use anything those boundaries removed. The work is the build file, not the code — leave the mod alone.`
        : `Moving ${from.loader} ${from.mcVersion ?? '?'} → ${to.loader} ${to.mcVersion}. ${breaking.length} symbols break across ${filesTouched.length} of ${javaFiles} files; the other ${untouched} need no edit and should not be opened.`

  return {
    from,
    to,
    upToDate,
    downgrade,
    boundaries,
    breaking,
    filesTouched,
    preserve,
    mechanical,
    summary,
    buildOnly: !upToDate && breaking.length === 0 && !downgrade
  }
}

/**
 * Data files that the old version generated and the new one would generate
 * differently. Naming them stops the agent hand-editing a JSON file that a
 * datagen run will overwrite.
 */
function findGeneratedConflicts(files: SourceFile[], breaking: SymbolUse[]): string[] {
  if (!breaking.length) return []
  const out: string[] = []
  if (breaking.some((b) => b.boundary === 'legacy-to-flattening')) out.push('recipes (JSON after 1.13)')
  if (breaking.some((b) => b.boundary === 'data-components-1.20.5')) out.push('item data components (NBT before 1.20.5)')
  if (breaking.some((b) => b.boundary === 'worldgen-1.18')) out.push('worldgen JSON (rewritten in 1.18)')
  return out
}

/* --------------------------------------------------------- what a jar must be */

export interface JarCheck {
  name: string
  ok: boolean
  detail: string
}

/**
 * Is this update finished?
 *
 * "Finished" is a claim, and a claim needs evidence. Each check is something
 * that has genuinely gone wrong in a port before, so the list is short on
 * purpose — every entry has to be worth blocking on.
 */
export function checkUpdatedJar(
  jarPath: string | null,
  target: { mcVersion: string; loader: string },
  opts: { expectedModId?: string | null } = {}
): { ok: boolean; checks: JarCheck[]; summary: string } {
  const checks: JarCheck[] = []
  checks.push({
    name: 'a jar was produced',
    ok: !!jarPath && fs.existsSync(jarPath),
    detail: jarPath ? path.basename(jarPath) : 'build/libs has no jar — the build reported success without producing one, or it was cleaned'
  })

  if (!jarPath || !fs.existsSync(jarPath)) {
    return { ok: false, checks, summary: 'No jar, so nothing can be checked. Re-run the build and look at the log rather than assuming it worked.' }
  }

  let zip: AdmZip | null = null
  try {
    zip = new AdmZip(jarPath)
  } catch (e) {
    checks.push({ name: 'the jar opens', ok: false, detail: (e as Error).message })
    return { ok: false, checks, summary: `${path.basename(jarPath)} is not a readable zip.` }
  }

  const names = zip.getEntries().map((e) => e.entryName)
  const classes = names.filter((n) => n.endsWith('.class'))
  checks.push({
    name: 'the jar contains compiled classes',
    ok: classes.length > 0,
    detail: `${classes.length} class file(s)`
  })

  // Metadata the loader will read. A jar without it installs and then does nothing.
  const toml = names.includes('META-INF/neoforge.mods.toml') ? 'META-INF/neoforge.mods.toml' : names.includes('META-INF/mods.toml') ? 'META-INF/mods.toml' : null
  const fabric = names.includes('fabric.mod.json') ? 'fabric.mod.json' : null
  const meta = fabric ?? toml
  const metaMatchesLoader = target.loader === 'fabric' ? !!fabric : target.loader === 'neoforge' ? !!names.includes('META-INF/neoforge.mods.toml') : !!toml
  checks.push({
    name: `metadata matches ${target.loader}`,
    ok: metaMatchesLoader,
    detail: meta ? `found ${meta}` : 'no mods.toml / neoforge.mods.toml / fabric.mod.json in the jar — it will install and never load'
  })

  // The declared Minecraft version has to be the target, or the loader refuses it.
  let declaredMc: string | null = null
  let declaredId: string | null = null
  if (toml) {
    try {
      const text = zip.readAsText(toml)
      declaredId = text.match(/^\s*modId\s*=\s*"([^"]+)"/m)?.[1] ?? null
      // The minecraft dependency's versionRange is the authoritative claim.
      const dep = text.match(/modId\s*=\s*"minecraft"[\s\S]{0,300}?versionRange\s*=\s*"([^"]+)"/)?.[1]
      declaredMc = dep?.match(/\d+\.\d+(?:\.\d+)?/)?.[0] ?? null
    } catch {
      /* an unreadable toml is reported by the metadata check */
    }
  } else if (fabric) {
    try {
      const body = JSON.parse(zip.readAsText(fabric)) as { id?: string; depends?: Record<string, string> }
      declaredId = body.id ?? null
      const mc = body.depends?.minecraft
      declaredMc = typeof mc === 'string' ? (mc.match(/\d+\.\d+(?:\.\d+)?/)?.[0] ?? null) : null
    } catch {
      /* same */
    }
  }
  checks.push({
    name: 'declares the target Minecraft version',
    ok: !!declaredMc && declaredMc === target.mcVersion,
    detail: declaredMc ? `declares ${declaredMc}, target is ${target.mcVersion}` : 'no Minecraft dependency declared'
  })

  if (opts.expectedModId) {
    checks.push({
      name: 'mod id is unchanged',
      ok: declaredId === opts.expectedModId,
      detail: declaredId ? `id is ${declaredId}, expected ${opts.expectedModId}` : 'no mod id in the metadata'
    })
  }

  // A jar full of mixins that do not match the target is a crash at load time.
  const mixins = names.filter((n) => /\.mixins?\.json$/.test(n) || n.endsWith('mixins.json'))
  if (mixins.length) {
    checks.push({
      name: 'mixin configs are present and parse',
      ok: mixins.every((m) => {
        try {
          JSON.parse(zip!.readAsText(m))
          return true
        } catch {
          return false
        }
      }),
      detail: mixins.length ? mixins.join(', ') : 'none'
    })
  }

  const ok = checks.every((c) => c.ok)
  const failed = checks.filter((c) => !c.ok)
  return {
    ok,
    checks,
    summary: ok
      ? `${path.basename(jarPath)} meets every check: classes, ${target.loader} metadata, Minecraft ${target.mcVersion}${opts.expectedModId ? `, mod id ${opts.expectedModId}` : ''}.`
      : `${path.basename(jarPath)} is not a finished update: ${failed.map((f) => f.name).join('; ')}.`
  }
}

/**
 * Re-scan the sources to see which planned breakages are genuinely gone.
 *
 * The plan's count is a snapshot from before the edits. Trusting it would mean
 * either resuming forever because nobody decremented it, or finishing because
 * nobody incremented it — both wrong, in opposite directions. Cheap: it is the
 * same regex pass over files already on disk.
 */
export function countRemainingBreakages(workspaceDir: string, sourceRoot: string, from: { mcVersion: string | null; loader: string }, to: { mcVersion: string; loader: string }): number {
  const boundaries = crossedBoundaries(from, to)
  if (!boundaries.length) return 0
  const files = loadSources(workspaceDir, sourceRoot)
  return findBreakingUses(files, boundaries).reduce((n, b) => n + b.count, 0)
}

/**
 * Has the agent finished, or just gone quiet?
 *
 * A run ends for two very different reasons: the work is done, or the model
 * stopped talking. In automode the second must not end the turn — that is the
 * behaviour the user is asking to be rid of. This decides from the state on
 * disk, not from the model's prose, because the prose is what gave up.
 */
export function completionVerdict(opts: {
  /** Did the last build succeed? */
  buildOk: boolean | null
  jar: ReturnType<typeof checkUpdatedJar> | null
  /** Symbols the plan said would break and which are still present. */
  remainingBreakages: number
  /** How many times the turn has already been resumed for this reason. */
  resumes: number
  maxResumes: number
}): { done: boolean; reason: string; resumePrompt?: string } {
  if (opts.buildOk === false) {
    return {
      done: false,
      reason: 'the build is failing',
      resumePrompt:
        'The build is still failing. Read the actual compiler error, fix that one thing, and build again. Do not rewrite working code to work around an error you have not read.'
    }
  }
  if (opts.jar && !opts.jar.ok) {
    return {
      done: false,
      reason: 'the jar does not meet the criteria',
      resumePrompt: `The jar is built but fails its checks: ${opts.jar.checks
        .filter((c) => !c.ok)
        .map((c) => `${c.name} (${c.detail})`)
        .join('; ')}. Fix those specifically and build again.`
    }
  }
  if (opts.remainingBreakages > 0) {
    return {
      done: false,
      reason: `${opts.remainingBreakages} known breakage(s) are still in the code`,
      resumePrompt:
        'The update plan still lists symbols that do not exist on the target version. Find each one, replace it with the target-version equivalent, and build. Leave everything else alone.'
    }
  }
  if (opts.buildOk === null) {
    return {
      done: false,
      reason: 'nothing has been built yet',
      resumePrompt: 'Nothing has been built yet. Run the build and fix what it reports before reporting back.'
    }
  }
  return { done: true, reason: 'the build is green and the jar passes every check' }
}
