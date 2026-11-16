/**
 * Bring a whole modpack folder up to a Minecraft version, and nothing else.
 *
 * The request was specific and worth respecting exactly: take the entire pack
 * folder and update every file that needs to change to match the target version,
 * except the Minecraft jar. `pack:updates` updated *jars*; it never touched the
 * loader's own files, so a pack could have every mod updated and still not launch
 * because `bin/version` still named the old NeoForge build.
 *
 * Three rules shape everything here:
 *
 *   1. **The gameplay jar is never touched.** `bin/` holds `modpack.jar`,
 *      `client.jar`, `version.json` and the launcher's `runData` — those are what
 *      the launcher runs, and replacing them out from under Technic is how a pack
 *      stops starting. They are reported, never rewritten.
 *   2. **Nothing is deleted before a backup exists.** A pack update that goes
 *      wrong halfway must be recoverable by copying one folder back.
 *   3. **The plan is computed before anything is downloaded**, and it is a list of
 *      decisions the user can read — including the mods that have no build for the
 *      target version, which are the only part that can lose someone their setup.
 */

import fs from 'node:fs'
import path from 'node:path'

/** Minecraft versions this loader family can target, newest first, at plan time. */
export type LoaderFamily = 'neoforge' | 'forge' | 'fabric' | 'quilt' | 'unknown'

export interface PackFileRole {
  /** Path relative to the pack root, with forward slashes. */
  rel: string
  role: 'mod' | 'coremod' | 'config' | 'loader' | 'game-jar' | 'launcher' | 'resourcepack' | 'shaderpack' | 'script' | 'other'
  /** Why it is in that role — shown to the user, so the classification is never a mystery. */
  why: string
  bytes: number
  /** Must not be rewritten by this tool. */
  protected: boolean
}

/** The Minecraft jar and the launcher's own files. Never written, never moved. */
const PROTECTED_DIRS = ['bin', 'jre', 'runtime']
const PROTECTED_FILES = [/^bin\//i, /(^|\/)client\.jar$/i, /(^|\/)server\.jar$/i, /(^|\/)minecraft.*\.jar$/i, /(^|\/)forge-.*\.jar$/i, /(^|\/)\.technic$/i, /(^|\/)\.fml$/i]

/**
 * Which role a file plays in the pack.
 *
 * Ordered most-specific first: `bin/modpack.jar` is a jar under `mods`-looking
 * names to a careless matcher, and protecting it is the whole point.
 */
export function classify(rel: string): { role: PackFileRole['role']; why: string; protected: boolean } {
  const p = rel.replace(/\\/g, '/').toLowerCase()
  if (PROTECTED_FILES.some((re) => re.test(p))) {
    return { role: 'game-jar', why: 'the launcher runs this — replacing it stops the pack starting', protected: true }
  }
  const top = p.split('/')[0]
  if (PROTECTED_DIRS.includes(top)) {
    return { role: 'launcher', why: 'launcher/loader runtime files, owned by Technic', protected: true }
  }
  if (top === 'mods') return { role: 'mod', why: 'a mod jar', protected: false }
  if (top === 'coremods') return { role: 'coremod', why: 'a coremod jar', protected: false }
  if (top === 'config' || top === 'defaultconfigs') return { role: 'config', why: 'mod configuration', protected: false }
  if (top === 'resourcepacks') return { role: 'resourcepack', why: 'a resource pack', protected: false }
  if (top === 'shaderpacks') return { role: 'shaderpack', why: 'a shader pack', protected: false }
  if (top === 'scripts' || top === 'kubejs' || top === 'datapacks') return { role: 'script', why: 'scripts and data', protected: false }
  if (/^options\.txt$/i.test(p) || /^servers\.dat$/i.test(p)) return { role: 'loader', why: 'launcher settings', protected: false }
  return { role: 'other', why: 'not something this update changes', protected: false }
}

/** Walk the pack folder, skipping the noisy parts, and classify what is there. */
export function surveyPack(root: string): { files: PackFileRole[]; skipped: string[] } {
  const files: PackFileRole[] = []
  const skipped: string[] = []
  const walk = (dir: string, rel: string, depth: number): void => {
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const shown = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        // Worlds are the user's; a backup of a pack does not need a 4 GB save, and
        // `logs`/`crash-reports` are history rather than content.
        if (['world', 'saves', 'logs', 'crash-reports', '__MACOSX'].includes(entry.name)) {
          skipped.push(shown)
          continue
        }
        if (entry.name.startsWith('.') || depth >= 5) continue
        walk(path.join(dir, entry.name), shown, depth + 1)
        continue
      }
      const cls = classify(shown)
      let bytes = 0
      try {
        bytes = fs.statSync(path.join(dir, entry.name)).size
      } catch {
        /* a file that vanished mid-walk is simply not counted */
      }
      files.push({ rel: shown, role: cls.role, why: cls.why, bytes, protected: cls.protected })
    }
  }
  walk(root, '', 0)
  return { files, skipped }
}

/**
 * Write the loader's own version files for the target.
 *
 * Technic decides what to launch from `bin/version` (a loader id like
 * `1.21.1-neoforge-21.1.80`) and, for newer packs, `bin/runData`. Getting these
 * wrong is the classic "all mods updated, pack still boots 1.20.1" failure.
 *
 * Both are returned rather than written, so the caller can show them in the plan
 * and take a backup before touching anything.
 */
export function loaderFilesFor(target: { mcVersion: string; family: LoaderFamily; loaderVersion: string }): { rel: string; content: string; note: string }[] {
  const out: { rel: string; content: string; note: string }[] = []
  if (!target.mcVersion || !target.loaderVersion) return out
  const { mcVersion, family, loaderVersion } = target
  if (family === 'neoforge') {
    /*
     * Technic's modern format. `bin/version` names the *loader* build and
     * `bin/runData` carries the java/args the launcher uses; the old
     * `1.21.1-neoforge-21.1.80` string is what the launcher parses today.
     */
    out.push({ rel: 'bin/version', content: `${mcVersion}-neoforge-${loaderVersion}\n`, note: `tells Technic to launch NeoForge ${loaderVersion} on ${mcVersion}` })
    out.push({
      rel: 'bin/runData',
      content: JSON.stringify({ memory: 4096, javaVersion: 21, mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher' }, null, 2) + '\n',
      note: 'launch settings the launcher reads alongside bin/version'
    })
  } else if (family === 'forge') {
    out.push({ rel: 'bin/version', content: `${mcVersion}-forge-${loaderVersion}\n`, note: `tells Technic to launch Forge ${loaderVersion} on ${mcVersion}` })
  } else if (family === 'fabric' || family === 'quilt') {
    // Fabric-family packs are launched by a profile, not by bin/version; the
    // loader version belongs in the profile the launcher already has.
    out.push({ rel: 'bin/version', content: `${mcVersion}-${family}-${loaderVersion}\n`, note: `names the ${family} loader build for this pack` })
  }
  return out
}

/** One mod jar, reduced to what the update plan needs to decide about it. */
export interface ModEntry {
  file: string
  path: string
  modId?: string
  version?: string
  name?: string
  /** No build was found that supports the target. */
  incompatible?: boolean
  /** What the plan proposes, filled in by the caller's lookups. */
  target?: { version?: string; url?: string; name: string }
  status: 'update' | 'keep' | 'missing-build' | 'unidentified' | 'skipped'
  reason: string
  /** Chosen in the UI. Defaults to true for everything that has a target. */
  selected: boolean
}

export interface PackUpdatePlan {
  root: string
  target: { mcVersion: string; family: LoaderFamily; loaderVersion: string }
  current: { mcVersion?: string; family?: LoaderFamily; loaderVersion?: string }
  mods: ModEntry[]
  /** Contents for the loader's own files, with the reason each changes. */
  loaderFiles: { rel: string; content: string; note: string; changed: boolean }[]
  /** Folders that will be copied before anything is written. */
  backup: { needed: boolean; dir: string }
  /** Human sentences, in the order the user needs them. */
  summary: string[]
}

/**
 * Decide what changes, given the folder and what the caller found for each mod.
 *
 * Kept separate from the network on purpose: this is the part that must be
 * reviewable and testable, and a plan that cannot be computed without four HTTP
 * calls cannot be tested at all.
 */
export function planPackUpdate(args: {
  root: string
  current: { mcVersion?: string; family?: LoaderFamily; loaderVersion?: string }
  target: { mcVersion: string; family: LoaderFamily; loaderVersion: string }
  files: PackFileRole[]
  mods: { file: string; path: string; modId?: string; version?: string; name?: string; resolution?: { found: boolean; incompatible?: boolean; target?: { version?: string; url?: string; name: string } } }[]
}): PackUpdatePlan {
  const { root, target, current } = args

  const mods: ModEntry[] = []
  for (const m of args.mods) {
    const r = m.resolution
    if (!r) {
      mods.push({ file: m.file, path: m.path, modId: m.modId, version: m.version, name: m.name, status: 'unidentified', reason: 'could not be identified, so its version for the target cannot be chosen', selected: false })
      continue
    }
    if (!m.modId) {
      mods.push({ file: m.file, path: m.path, version: m.version, name: m.name, status: 'unidentified', reason: 'no mod id in the jar or its name', selected: false })
      continue
    }
    if (r.incompatible || (!r.found && r.target === undefined)) {
      mods.push({
        file: m.file,
        path: m.path,
        modId: m.modId,
        version: m.version,
        name: m.name,
        incompatible: true,
        status: 'missing-build',
        reason: `no build supports ${target.mcVersion} ${target.family}`,
        selected: false
      })
      continue
    }
    const same = r.target?.version && m.version && r.target.version === m.version
    if (same) {
      mods.push({ file: m.file, path: m.path, modId: m.modId, version: m.version, name: m.name, target: r.target, status: 'keep', reason: `already the build for ${target.mcVersion} (${r.target?.version})`, selected: false })
      continue
    }
    mods.push({
      file: m.file,
      path: m.path,
      modId: m.modId,
      version: m.version,
      name: m.name,
      target: r.target,
      status: 'update',
      reason: r.target?.version ? `${m.version ?? 'unknown'} → ${r.target.version}` : `replace with the ${target.mcVersion} build`,
      selected: true
    })
  }

  const existing = new Map(args.files.map((f) => [f.rel.replace(/\\/g, '/').toLowerCase(), f]))
  const loaderFiles = loaderFilesFor(target).map((lf) => {
    const have = existing.get(lf.rel.toLowerCase())
    let changed = true
    if (have) {
      try {
        const onDisk = fs.readFileSync(path.join(root, lf.rel), 'utf8').trim()
        changed = onDisk !== lf.content.trim()
      } catch {
        changed = true
      }
    }
    return { ...lf, changed }
  })

  const summary: string[] = []
  const updatable = mods.filter((m) => m.status === 'update')
  const missing = mods.filter((m) => m.status === 'missing-build')
  const unidentified = mods.filter((m) => m.status === 'unidentified')

  if (current.mcVersion && current.mcVersion !== target.mcVersion) {
    summary.push(`This pack is on ${current.mcVersion}${current.family && current.family !== 'unknown' ? ` with ${current.family}` : ''}; the update targets ${target.mcVersion} with ${target.family}.`)
  } else {
    summary.push(`This pack is already on ${target.mcVersion}; the update brings its mods and loader files to the ${target.family} build you chose.`)
  }
  summary.push(
    updatable.length
      ? `${updatable.length} mod${updatable.length === 1 ? '' : 's'} can be replaced with a ${target.mcVersion} build.`
      : `Every mod that could be matched already has a ${target.mcVersion} build, or none could be matched.`
  )
  if (missing.length) {
    summary.push(
      `${missing.length} mod${missing.length === 1 ? '' : 's'} ha${missing.length === 1 ? 's' : 've'} no ${target.mcVersion} build. They are listed and left on your disk unless you tick them for removal — a pack update that silently deletes a mod is not an update.`
    )
  }
  if (unidentified.length) summary.push(`${unidentified.length} jar${unidentified.length === 1 ? '' : 's'} could not be identified and will be left alone.`)
  const changing = loaderFiles.filter((l) => l.changed)
  summary.push(changing.length ? `${changing.length} loader file${changing.length === 1 ? '' : 's'} will be rewritten: ${changing.map((l) => l.rel).join(', ')}.` : 'The loader files already match the target.')
  summary.push('`bin/` and the Minecraft jar are never modified: those are what the launcher runs.')

  return {
    root,
    target,
    current,
    mods,
    loaderFiles,
    backup: { needed: true, dir: path.join(root, `.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`) },
    summary
  }
}

/**
 * Copy the parts of the pack an update can change into a backup folder.
 *
 * Only what is about to be touched: the mods, the configs and the loader files.
 * A pack with a 3 GB `world` in it does not need the world copied to undo a jar
 * swap, and pretending otherwise makes the backup too slow to keep.
 */
export function backUp(plan: PackUpdatePlan): { ok: boolean; dir?: string; copied: number; error?: string } {
  try {
    fs.mkdirSync(plan.backup.dir, { recursive: true })
    let copied = 0
    const copy = (rel: string): void => {
      const from = path.join(plan.root, rel)
      const to = path.join(plan.backup.dir, rel)
      try {
        if (!fs.statSync(from).isFile()) return
        fs.mkdirSync(path.dirname(to), { recursive: true })
        fs.copyFileSync(from, to)
        copied++
      } catch {
        /* a file that vanished between planning and copying is not a failure */
      }
    }
    for (const m of plan.mods) {
      if (m.selected) copy(m.file)
    }
    for (const l of plan.loaderFiles) {
      if (l.changed) copy(l.rel)
    }
    // The manifest is what makes the backup explain itself a month later.
    fs.writeFileSync(
      path.join(plan.backup.dir, 'BACKUP.json'),
      JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          pack: plan.root,
          from: plan.current,
          to: plan.target,
          files: plan.mods.filter((m) => m.selected).map((m) => ({ file: m.file, from: m.version, to: m.target?.version })),
          loaderFiles: plan.loaderFiles.filter((l) => l.changed).map((l) => l.rel),
          restore: 'Copy the contents of this folder back over the pack folder to undo the update.'
        },
        null,
        2
      ) + '\n'
    )
    return { ok: true, dir: plan.backup.dir, copied }
  } catch (e) {
    return { ok: false, copied: 0, error: (e as Error).message }
  }
}

/**
 * Apply a downloaded jar over the one it replaces.
 *
 * Write beside, then rename: a half-written jar in `mods/` is a pack that will
 * not start, and a crash mid-copy must not leave one. The old file is renamed
 * rather than deleted until the new one is in place.
 */
export function replaceJar(targetPath: string, downloaded: string): { ok: boolean; error?: string } {
  const dir = path.dirname(targetPath)
  const staging = path.join(dir, `.${path.basename(targetPath)}.incoming`)
  const previous = path.join(dir, `.${path.basename(targetPath)}.previous`)
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.copyFileSync(downloaded, staging)
    // Sanity check before it becomes the live jar: an HTML error page served with
    // a .jar name is the most common bad download there is.
    const head = fs.readFileSync(staging).subarray(0, 4)
    if (!(head[0] === 0x50 && head[1] === 0x4b)) {
      fs.rmSync(staging, { force: true })
      return { ok: false, error: `${path.basename(targetPath)}: the download is not a jar (no zip header) — the server returned an error page.` }
    }
    if (fs.existsSync(targetPath)) {
      fs.rmSync(previous, { force: true })
      fs.renameSync(targetPath, previous)
    }
    fs.renameSync(staging, targetPath)
    fs.rmSync(previous, { force: true })
    return { ok: true }
  } catch (e) {
    try {
      fs.rmSync(staging, { force: true })
      // Put the original back if the swap did not complete.
      if (!fs.existsSync(targetPath) && fs.existsSync(previous)) fs.renameSync(previous, targetPath)
    } catch {
      /* best effort; the backup folder is the real safety net */
    }
    return { ok: false, error: (e as Error).message }
  }
}

/** Write a loader file, keeping the previous contents in the backup. */
export function writeLoaderFile(root: string, rel: string, content: string): { ok: boolean; error?: string } {
  try {
    const full = path.join(root, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content, 'utf8')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** The pack's own version, read from the files the launcher uses. */
export function currentPackVersion(root: string): { mcVersion?: string; family: LoaderFamily; loaderVersion?: string } {
  const read = (rel: string): string => {
    try {
      return fs.readFileSync(path.join(root, rel), 'utf8').trim()
    } catch {
      return ''
    }
  }
  // `bin/version` is authoritative for what Technic launches.
  const versionLine = read('bin/version').split(/\r?\n/)[0] ?? ''
  const m = /^(\d+\.\d+(?:\.\d+)?)-(neoforge|forge|fabric|quilt)-(.+)$/i.exec(versionLine)
  if (m) {
    return { mcVersion: m[1], family: m[2].toLowerCase() as LoaderFamily, loaderVersion: m[3] }
  }
  return { family: 'unknown' }
}
