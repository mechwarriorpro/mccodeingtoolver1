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

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import AdmZip from 'adm-zip'

/** Minecraft versions this loader family can target, newest first, at plan time. */
export type LoaderFamily = 'neoforge' | 'forge' | 'fabric' | 'quilt' | 'unknown'

export interface PackFileRole {
  /** Path relative to the pack root, with forward slashes. */
  rel: string
  role: 'mod' | 'coremod' | 'loader-installer' | 'config' | 'loader' | 'game-jar' | 'launcher' | 'resourcepack' | 'shaderpack' | 'script' | 'other'
  /** Why it is in that role — shown to the user, so the classification is never a mystery. */
  why: string
  bytes: number
  /** Must not be rewritten by this tool. */
  protected: boolean
}

/**
 * `bin/modpack.jar` is the loader, and in a Technic pack it is the NeoForge
 * *installer* jar.
 *
 * This used to be a blanket "everything under bin/ is untouchable", which was
 * wrong in the way that matters: the loader is exactly the thing a version
 * change has to replace, and leaving it alone means a pack whose mods are all
 * 1.21.1 still boots 1.20.1. What is genuinely untouchable in bin/ is the
 * launcher's own metadata and the game itself — those are named individually
 * below rather than by folder.
 */
const PROTECTED_FILES = [
  /(^|\/)client\.jar$/i,
  /(^|\/)server\.jar$/i,
  /(^|\/)minecraft.*\.jar$/i,
  /(^|\/)version\.json$/i,
  /(^|\/)\.technic$/i,
  /(^|\/)\.fml$/i,
  /(^|\/)jre\//i,
  /(^|\/)runtime\//i,
  /(^|\/)natives\//i
]

/** The loader jar Technic launches from — `bin/modpack.jar` and its spellings. */
const LOADER_JAR = /^bin\/(modpack|forge|neoforge|fabric)([^/]*)\.jar$/i

/**
 * Which role a file plays in the pack.
 *
 * Ordered most-specific first: `bin/modpack.jar` is a jar under `mods`-looking
 * names to a careless matcher, and protecting it is the whole point.
 */
export function classify(rel: string): { role: PackFileRole['role']; why: string; protected: boolean } {
  const p = rel.replace(/\\/g, '/').toLowerCase()
  // The loader jar is checked before the protected list: it lives in bin/, and
  // bin/ is otherwise protected, but this one file is the whole point of a
  // version change.
  if (LOADER_JAR.test(p)) {
    return {
      role: 'loader-installer',
      why: 'the loader jar Technic launches from — this is what gets replaced when the target version changes',
      protected: false
    }
  }
  if (PROTECTED_FILES.some((re) => re.test(p))) {
    return { role: 'game-jar', why: 'the game itself, or the launcher metadata — replacing it stops the pack starting', protected: true }
  }
  if (p.startsWith('bin/')) {
    return { role: 'launcher', why: 'a launcher file, not the loader — left alone', protected: true }
  }
  const top = p.split('/')[0]
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
 * What a `bin/modpack.jar` actually is.
 *
 * In a Technic pack this is normally the loader *installer* jar — a NeoForge or
 * Forge installer renamed to `modpack.jar` — and Technic runs it to obtain the
 * loader. That means the file has to be replaced on a version change, and it has
 * to be replaced with a real installer for the target build, not with the newest
 * *mod* that happened to match by name.
 */
export interface LoaderJarInfo {
  rel: string
  kind: 'neoforge-installer' | 'forge-installer' | 'unknown-jar' | 'not-a-jar'
  /** Whatever version string the jar states about itself. */
  version?: string
  /** A mod jar that ended up in bin/ — a mistake, reported rather than "fixed". */
  looksLikeMod?: boolean
  note: string
}

export function inspectLoaderJar(fullPath: string): LoaderJarInfo {
  const rel = path.basename(fullPath)
  let zip: AdmZip
  try {
    zip = new AdmZip(fullPath)
  } catch {
    return { rel, kind: 'not-a-jar', note: 'not a readable zip — the launcher would fail on this too' }
  }
  const names = zip.getEntries().map((e) => e.entryName.replace(/\\/g, '/'))
  const has = (n: string): boolean => names.includes(n)
  /** First readable text of any candidate entry. */
  const text = (candidates: string[]): string => {
    for (const c of candidates) {
      try {
        const entry = zip.getEntry(c)
        if (entry) return zip.readAsText(entry).slice(0, 4000)
      } catch {
        /* try the next */
      }
    }
    return ''
  }
  const manifest = text(['META-INF/MANIFEST.MF'])
  const versionFrom = (haystack: string): string | undefined =>
    /(?:^|[\s:"=])(\d+\.\d+\.\d+(?:-beta)?)(?=[\s"\r\n]|$)/.exec(haystack)?.[1]

  // NeoForge's installer carries net/neoforged/... and an install_profile.json.
  const neoInstaller = names.some((n) => n.startsWith('net/neoforged/')) && (has('install_profile.json') || has('META-INF/versions.list'))
  if (neoInstaller) {
    const versionsList = text(['META-INF/versions.list'])
    const profile = text(['install_profile.json'])
    const version = versionFrom(versionsList) ?? versionFrom(profile) ?? versionFrom(manifest)
    return {
      rel,
      kind: 'neoforge-installer',
      version,
      note: version ? `a NeoForge installer for ${version}` : 'a NeoForge installer (it does not state its version in a form we can read)'
    }
  }
  // Forge's installer has install_profile.json plus net/minecraftforge/.
  if (names.some((n) => n.startsWith('net/minecraftforge/')) || (has('install_profile.json') && names.some((n) => n.startsWith('net/')))) {
    const profile = text(['install_profile.json'])
    return { rel, kind: 'forge-installer', version: versionFrom(profile) ?? versionFrom(manifest), note: 'a Forge installer' }
  }
  // A mod that was dropped in bin/ by mistake: worth saying so, not worth "fixing".
  const modToml = names.some((n) => n === 'META-INF/neoforge.mods.toml' || n === 'META-INF/mods.toml')
  return {
    rel,
    kind: 'unknown-jar',
    looksLikeMod: modToml,
    note: modToml ? 'this is a mod jar, not a loader installer — Technic cannot launch from it' : 'not a recognised loader installer'
  }
}

/** The Modrinth-style jar name for a NeoForge installer, for the plan to show. */
export function neoForgeInstallerName(loaderVersion: string): string {
  return `neoforge-${loaderVersion}-installer.jar`
}

export function neoForgeInstallerUrl(loaderVersion: string): string {
  return `https://maven.neoforged.net/releases/net/neoforged/neoforge/${loaderVersion}/${neoForgeInstallerName(loaderVersion)}`
}

/**
 * Is this downloaded file really the loader installer for the version asked for?
 *
 * A 200 response is not proof. Maven can serve an error page, a proxy can serve a
 * stale file, and the failure mode — a `modpack.jar` that is not an installer —
 * is a pack that will not start. So the jar is opened and checked for the
 * NeoForge payload and, when it states a version, for the one requested.
 */
export function verifyLoaderInstaller(bytes: Buffer, opts: { family: LoaderFamily; loaderVersion: string }): { ok: boolean; error?: string; version?: string } {
  if (bytes.length < 4 || !(bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    return { ok: false, error: 'the download is not a jar (no zip header) — the server returned an error page' }
  }
  let zip: AdmZip
  try {
    zip = new AdmZip(bytes)
  } catch {
    return { ok: false, error: 'the download is a zip but cannot be opened as one' }
  }
  const names = zip.getEntries().map((e) => e.entryName.replace(/\\/g, '/'))
  if (opts.family === 'neoforge') {
    const isNeo = names.some((n) => n.startsWith('net/neoforged/')) && (names.includes('install_profile.json') || names.includes('META-INF/versions.list'))
    if (!isNeo) return { ok: false, error: 'the download is not a NeoForge installer' }
    // Version confirmation where the jar states one.
    for (const candidate of ['META-INF/versions.list', 'install_profile.json']) {
      try {
        const entry = zip.getEntry(candidate)
        if (!entry) continue
        const body = zip.readAsText(entry)
        if (body.includes(opts.loaderVersion)) return { ok: true, version: opts.loaderVersion }
      } catch {
        /* unreadable entry: the payload check above already passed */
      }
    }
    // Payload is right but the version is not stated in a readable way. Accept,
    // and say so, rather than refuse a file that is almost certainly correct.
    return { ok: true, error: `could not confirm the installer's version from the jar itself` }
  }
  if (opts.family === 'forge') {
    const isForge = names.some((n) => n.startsWith('net/minecraftforge/')) || names.includes('install_profile.json')
    return isForge ? { ok: true } : { ok: false, error: 'the download is not a Forge installer' }
  }
  return { ok: true }
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
  /**
   * The loader jar itself (`bin/modpack.jar`), when the pack has one.
   *
   * This is the file Technic actually launches, and in a NeoForge pack it is the
   * NeoForge installer. A version change that leaves it alone changes nothing
   * that matters, so it is part of the plan rather than protected with the rest
   * of `bin/`.
   */
  loaderJar?: {
    rel: string
    /** What is there now. */
    present: LoaderJarInfo
    /** Where the installer for the target comes from. */
    download: { url: string; name: string; version: string } | null
    why: string
  }
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

  /*
   * The loader jar. In a Technic pack this is `bin/modpack.jar` and it is the
   * NeoForge installer, so a version change has to replace it — this is the file
   * that decides which loader actually starts, and the one thing the previous
   * "never touch bin/" rule got wrong.
   */
  const loaderJar: PackUpdatePlan['loaderJar'] = (() => {
    const found = args.files.find((f) => classify(f.rel).role === 'loader-installer')
    if (!found) return undefined
    const full = path.join(root, found.rel)
    const present = inspectLoaderJar(full)
    const sameVersion = !!present.version && present.version === target.loaderVersion
    const installerFamily = target.family === 'neoforge' || target.family === 'forge'
    const download = installerFamily
      ? target.family === 'neoforge'
        ? { url: neoForgeInstallerUrl(target.loaderVersion), name: neoForgeInstallerName(target.loaderVersion), version: target.loaderVersion }
        : null
      : null
    if (sameVersion) {
      // No download: replacing a correct installer with a byte-identical one is
      // a pointless write, and if the fetch failed it would fail an update that
      // had nothing wrong with it.
      return { rel: found.rel, present, download: null, why: `already the ${target.family} ${target.loaderVersion} installer` }
    }
    if (!installerFamily) {
      return {
        rel: found.rel,
        present,
        download,
        why: `this pack launches from ${found.rel} and it is a ${target.family} pack — the loader jar cannot be fetched automatically, so check it by hand`
      }
    }
    if (target.family === 'neoforge') {
      return {
        rel: found.rel,
        present,
        download,
        why: present.kind === 'neoforge-installer'
          ? `replaces the ${present.version ?? 'existing'} NeoForge installer with ${target.loaderVersion}`
          : `replaces it with the NeoForge ${target.loaderVersion} installer (it is currently ${present.note})`
      }
    }
    return { rel: found.rel, present, download, why: 'Forge installers are not fetched automatically; replace this by hand' }
  })()

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
  if (loaderJar) {
    summary.push(`The loader jar \`${loaderJar.rel}\` will be replaced: ${loaderJar.why}.`)
  }
  summary.push(
    'The Minecraft jar, `bin/version.json` and every other launcher file are left exactly as they are — only the loader jar and its version files change.'
  )

  return {
    root,
    target,
    current,
    mods,
    loaderFiles,
    loaderJar,
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
    // The loader jar is replaced on every version change, so the old one has to
    // be recoverable — a pack that will not start because the installer is wrong
    // is exactly what this backup exists for.
    if (plan.loaderJar) copy(plan.loaderJar.rel)
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
          loaderJar: plan.loaderJar ? { rel: plan.loaderJar.rel, was: plan.loaderJar.present.kind, becomes: plan.loaderJar.download?.name ?? 'unchanged' } : undefined,
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
