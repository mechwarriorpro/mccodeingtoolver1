/**
 * Moving mods from one pack to another.
 *
 * Two packs, both real, both on disk. One is where the mods are; the other is
 * where they need to end up. This is the operation people do by hand with two
 * Explorer windows open, and it goes wrong in ways that are invisible until the
 * game starts:
 *
 *   - **Two copies of the same mod.** Dragging `create-1.20.1.jar` into a pack
 *     that already has `create-1.21.1.jar` leaves both, and the launcher dies on
 *     a duplicate-mod error that never mentions either file.
 *   - **A mod that the target cannot run.** The 1.20.1 file goes in, the pack
 *     boots 1.21.1, and the crash report is fifteen screens of mixin noise.
 *   - **A stale copy.** The target already had a newer build of the same mod and
 *     the older one overwrites it.
 *
 * Every one of those is decided here, before a byte moves, and shown as a
 * sentence: what goes in, what is skipped and why. The comparison is against the
 * *target's* Minecraft and loader version — not the source's — because that is
 * the pack the mods have to run in.
 *
 * The two packs also have their own loader: each has a `bin/modpack.jar`, which
 * is normally a NeoForge installer. Reading the version out of each one is what
 * makes the report say "1.20.1 + NeoForge 20.4.1 → 1.21.1 + NeoForge 21.1.80"
 * instead of merely "different".
 */
import fs from 'node:fs'
import path from 'node:path'
import { compareVersions } from './update-plan'

export type TransferStatus =
  /** No copy in the target: the jar moves in. */
  | 'copy'
  /** The target has the same mod, older: its jar is replaced. */
  | 'upgrade'
  /** The target has this exact version already: nothing to move. */
  | 'same'
  /** The target has a *newer* build: the source copy is left behind. */
  | 'newer-there'
  /** The mod has no build for the target's Minecraft/loader version. */
  | 'incompatible'
  /** Could not be identified, so nothing can be promised about it. */
  | 'unidentified'

export interface TransferEntry {
  /** Path relative to the source pack, forward slashes. */
  file: string
  /** Absolute path in the source pack. */
  path: string
  modId?: string
  name?: string
  /** Version present in the source pack. */
  version?: string
  /** Version already in the target pack, when there is one. */
  targetVersion?: string
  /** The jar that will be replaced in the target, relative to it. */
  replaces?: string
  status: TransferStatus
  /** One sentence the user can act on. */
  reason: string
  /**
   * Ticked to begin with. `same` and `newer-there` start unticked because there
   * is nothing to gain; `incompatible` starts unticked because a wrong-loader jar
   * is what turns a tidy update into a launch crash; `unidentified` starts
   * unticked because it cannot be vouched for.
   */
  selected: boolean
  /** A build for the target's version, when one was resolved. */
  target?: { version?: string; url?: string; name: string }
}

export interface PackTransferPlan {
  from: { dir: string; label: string; mcVersion?: string; family?: string; loaderVersion?: string }
  to: { dir: string; label: string; mcVersion?: string; family?: string; loaderVersion?: string }
  entries: TransferEntry[]
  /** What changes between the two packs' own loader jars. */
  loader: {
    from: { rel: string; present: string; version?: string }
    to: { rel: string; present: string; version?: string }
    /** True when the two packs start from different loader builds. */
    differs: boolean
    /** The sentence describing the change, or why it cannot be described. */
    note: string
    /** Mods are being brought up to this build. */
    targetVersion?: string
  }
  /** Sentences, in the order they matter. */
  summary: string[]
  counts: Record<TransferStatus, number>
}

/** A mod as read from a pack, narrowed to what the transfer cares about. */
export interface TransferMod {
  file: string
  path: string
  modId?: string
  name?: string
  version?: string
  /** The result of asking the network for this mod's build for the target. */
  resolution?: {
    /** A file that suits the target's Minecraft and loader version. */
    found: boolean
    /** No build exists for the target at all. */
    incompatible?: boolean
    target?: { version?: string; url?: string; name: string }
  }
}

function keyOf(modId: string | undefined, file: string): string {
  // The mod id is the identity the loader itself uses; the file name is only a
  // fallback, and only so that two copies of the same jar are still one entry.
  return modId ? `id:${modId.toLowerCase()}` : `file:${file.toLowerCase()}`
}

/**
 * The loader build named by an installer jar's file name, for when the jar itself
 * cannot be read.
 *
 * The two loaders spell this differently, and getting it wrong means reporting
 * the Minecraft version as if it were the loader:
 *   `neoforge-21.1.80-installer.jar`        → 21.1.80
 *   `forge-1.20.1-47.2.0-installer.jar`     → 47.2.0   (1.20.1 is the *game*)
 */
export function versionFromInstallerName(name: string): string | undefined {
  const neo = /neoforge[-_](\d+(?:\.\d+)+(?:-beta)?)[-_]installer/i.exec(name)
  if (neo) return neo[1]
  // Forge puts the Minecraft version first, then the loader build.
  const forge = /\bforge[-_]\d+(?:\.\d+)+[-_](\d+(?:\.\d+)+)[-_]installer/i.exec(name)
  if (forge) return forge[1]
  const fabric = /fabric[-_]installer[-_](\d+(?:\.\d+)+)/i.exec(name)
  return fabric?.[1]
}

/**
 * Decide, for each mod in the source pack, what should happen in the target.
 *
 * Pure: everything that needs the disk or the network is passed in, so the rules
 * can be tested without either.
 */
export function planPackTransfer(args: {
  from: { dir: string; label: string; mcVersion?: string; family?: string; loaderVersion?: string }
  to: { dir: string; label: string; mcVersion?: string; family?: string; loaderVersion?: string }
  sourceMods: TransferMod[]
  /** Mods already in the target, keyed the same way the source is read. */
  targetMods: TransferMod[]
  /** What each pack's own loader jar claims to be. */
  loader: {
    from: { rel: string; present: string; version?: string }
    to: { rel: string; present: string; version?: string }
  }
}): PackTransferPlan {
  const { from, to } = args

  // Index the target by mod id, and by file name, so a jar with no readable
  // metadata can still be matched to a copy already there.
  const byKey = new Map<string, TransferMod>()
  const byFile = new Map<string, TransferMod>()
  for (const m of args.targetMods) {
    if (m.modId) byKey.set(keyOf(m.modId, m.file), m)
    byFile.set(m.file.toLowerCase(), m)
  }

  const entries: TransferEntry[] = []
  for (const m of args.sourceMods) {
    const existing = byKey.get(keyOf(m.modId, m.file)) ?? byFile.get(m.file.toLowerCase())
    const base = {
      file: m.file,
      path: m.path,
      modId: m.modId,
      name: m.name,
      version: m.version,
      targetVersion: existing?.version,
      replaces: existing?.file
    }

    // Unidentifiable: it cannot be matched against the target, so it cannot be
    // promised to be safe. Listed, unticked, and the user decides.
    if (!m.modId) {
      entries.push({
        ...base,
        status: 'unidentified',
        reason: 'no mod id in the jar — it cannot be matched against the target pack, so it is listed but not moved',
        selected: false
      })
      continue
    }

    // The network says there is no build for the target version. Moving the
    // source jar in would boot the wrong loader for it.
    if (m.resolution && (m.resolution.incompatible || (!m.resolution.found && !m.resolution.target))) {
      entries.push({
        ...base,
        status: 'incompatible',
        reason: `no build of this mod supports ${to.mcVersion ?? 'the target version'}${to.family ? ` ${to.family}` : ''} — moving it in would break the target pack`,
        selected: false
      })
      continue
    }

    // Same mod already in the target: compare the versions that are actually
    // there, so "newer" is decided numerically (1.9 < 1.10) and not by string.
    if (existing) {
      const a = m.version ?? ''
      const b = existing.version ?? ''
      if (a && b) {
        const cmp = compareVersions(a, b)
        if (cmp === 0) {
          entries.push({
            ...base,
            status: 'same',
            reason: `the target already has the same version (${b})`,
            selected: false
          })
          continue
        }
        if (cmp < 0) {
          entries.push({
            ...base,
            status: 'newer-there',
            reason: `the target already has a newer build (${b}, the source has ${a}) — skipping keeps the newer one`,
            selected: false
          })
          continue
        }
        entries.push({
          ...base,
          status: 'upgrade',
          reason: `replaces ${b} in the target with ${a}`,
          selected: true,
          target: m.resolution?.target
        })
        continue
      }
      // One of the two does not state a version. Replacing is the safer
      // assumption than keeping, because the source jar is the one being
      // deliberately carried across — but say that it is a guess.
      entries.push({
        ...base,
        status: 'upgrade',
        reason: `the target has this mod${b ? ` at ${b}` : ''} and the source at ${a || 'an unstated version'} — replacing, since a version could not be compared`,
        selected: true,
        target: m.resolution?.target
      })
      continue
    }

    // Not in the target at all.
    entries.push({
      ...base,
      status: 'copy',
      reason: m.resolution?.target?.version && m.resolution.target.version !== m.version
        ? `new to the target; ${m.resolution.target.version} is the build for its version`
        : 'new to the target',
      selected: true,
      target: m.resolution?.target
    })
  }

  const counts: Record<TransferStatus, number> = {
    copy: 0,
    upgrade: 0,
    same: 0,
    'newer-there': 0,
    incompatible: 0,
    unidentified: 0
  }
  for (const e of entries) counts[e.status]++

  // ---- the two packs' own loader jars --------------------------------
  const loaderFrom = args.loader.from
  const loaderTo = args.loader.to
  const differs = !!loaderFrom.version && !!loaderTo.version && loaderFrom.version !== loaderTo.version
  let note: string
  if (!loaderFrom.version || !loaderTo.version) {
    note = !loaderFrom.version && !loaderTo.version
      ? 'Neither pack states its loader version, so the two cannot be compared. The target pack keeps its own loader.'
      : `Only ${loaderFrom.version ? 'the source' : 'the target'} pack states a loader version (${loaderFrom.version ?? loaderTo.version}), so the two cannot be compared. The target pack keeps its own loader.`
  } else if (!differs) {
    note = `Both packs are on ${loaderTo.present === loaderFrom.present ? 'the same' : 'the same version of the'} loader (${loaderTo.version}), so nothing has to change on the target.`
  } else {
    note = `The source pack starts ${loaderFrom.present} (${loaderFrom.version}); the target starts ${loaderTo.present} (${loaderTo.version}). The mods are chosen for the **target's** ${loaderTo.version} — the target keeps its own loader.`
  }

  const summary: string[] = []
  const moveCount = counts.copy + counts.upgrade
  summary.push(
    moveCount === 0
      ? 'Nothing to move: every mod the source pack has is either already in the target at the same or a newer version, or cannot be carried across.'
      : `${moveCount} mod${moveCount === 1 ? '' : 's'} to bring across into ${to.label}: ${counts.copy} new, ${counts.upgrade} replacing an older copy.`
  )
  if (counts.same) summary.push(`${counts.same} already there at the same version — skipped.`)
  if (counts['newer-there']) summary.push(`${counts['newer-there']} already there at a newer version — the target's copy is kept.`)
  if (counts.incompatible) summary.push(`${counts.incompatible} have no build for ${to.mcVersion ?? 'the target version'} and are not moved.`)
  if (counts.unidentified) summary.push(`${counts.unidentified} could not be identified and are listed only.`)
  summary.push(note)
  summary.push('Only the target pack is written to. The source pack is read, never changed.')

  return {
    from,
    to,
    entries,
    loader: { from: loaderFrom, to: loaderTo, differs, note, targetVersion: loaderTo.version },
    summary,
    counts
  }
}
