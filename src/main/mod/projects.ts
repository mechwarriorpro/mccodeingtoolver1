/**
 * Which projects this app knows about.
 *
 * "Switch" used to be a folder picker and nothing else, so the only project you
 * could get back to was one you could remember the path of. A mod maker normally
 * has a handful on the go — the one being written, a couple of forks being read,
 * a ported copy from an older version — and every one of them was invisible
 * unless you went looking in Explorer.
 *
 * Two sources, because either one alone is wrong:
 *
 *   - **Tracked** projects are ones this app has opened or created. They are
 *     authoritative: a fork lives under userData and no amount of scanning a
 *     projects folder will ever find it.
 *   - **Scanned** projects are found next to a tracked one — the folder a mod was
 *     scaffolded into is usually where the next project was scaffolded too. This
 *     is what makes a fresh install with an existing projects folder usable
 *     without opening each one by hand.
 *
 * Everything here is pure: it takes a directory reader so the merge can be
 * tested without a filesystem.
 */

export interface KnownProject {
  dir: string
  /** Shown in the dropdown: the mod's own name when known, else the folder name. */
  name: string
  /** `mod_name` from gradle.properties, when the project has one. */
  modName?: string
  modId?: string
  mcVersion?: string
  loader?: string
  /** Did this app open it, or was it found by looking? */
  source: 'tracked' | 'scanned' | 'both'
  /** False when the folder is gone — listed, but marked, never silently dropped. */
  exists: boolean
  /** Last time it was opened, when that is known. Sorts tracked projects. */
  lastOpenedAt?: number
  /** It is the project currently on screen. */
  active?: boolean
}

/**
 * Reduce a path for comparison.
 *
 * Windows paths arrive with either separator and are case-insensitive; two
 * entries for `C:\mods\Foo` and `c:/mods/foo` are the same project and must not
 * appear twice in a list the user is meant to choose from.
 */
export function projectKey(dir: string): string {
  const trimmed = (dir ?? '').trim().replace(/[\\/]+$/, '')
  if (!trimmed) return ''
  // A Windows path (drive letter or UNC) compares case-insensitively; a POSIX
  // path does not, since `~/Mods` and `~/mods` really are different there.
  const windows = /^[a-zA-Z]:/.test(trimmed) || trimmed.startsWith('\\\\')
  return windows ? trimmed.replace(/\//g, '\\').toLowerCase() : trimmed
}

/** The folder's own name, for when the project says nothing about itself. */
export function folderName(dir: string): string {
  const parts = (dir ?? '').trim().replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || dir
}

/**
 * Does this folder look like a mod project?
 *
 * Deliberately generous: `build.gradle` alone is a Gradle project, not
 * necessarily a mod, and `gradle.properties` alone is a config. Either one plus
 * a `src` folder is a mod project for the purposes of offering it in a list — the
 * user can see the path and decide, and refusing to show a project they just made
 * is the worse failure.
 */
export function looksLikeProject(dir: string, readdir: (d: string) => string[]): boolean {
  let entries: string[]
  try {
    entries = readdir(dir)
  } catch {
    return false
  }
  const has = (name: string): boolean => entries.some((e) => e.toLowerCase() === name)
  if (!has('build.gradle') && !has('build.gradle.kts') && !has('gradle.properties')) return false
  // A bare build.gradle with no sources is a scaffold that was never filled in;
  // it is still offered, because deleting it should be the user's decision.
  return has('gradle.properties') || has('src') || has('build.gradle') || has('build.gradle.kts')
}

/** Merge tracked and scanned projects into one list, with tracked data winning. */
export function mergeProjects(
  tracked: { dir: string; lastOpenedAt?: number }[],
  scanned: string[],
  opts: {
    activeDir?: string
    exists: (dir: string) => boolean
    /** Reads mod identity out of a project, or null when it cannot tell. */
    describe: (dir: string) => { name?: string; modId?: string; mcVersion?: string; loader?: string } | null
  }
): KnownProject[] {
  const byKey = new Map<string, { dir: string; tracked: boolean; scanned: boolean; lastOpenedAt?: number }>()

  for (const t of tracked) {
    const key = projectKey(t.dir)
    if (!key) continue
    const prev = byKey.get(key)
    byKey.set(key, {
      dir: prev?.dir ?? t.dir,
      tracked: true,
      scanned: prev?.scanned ?? false,
      lastOpenedAt: Math.max(prev?.lastOpenedAt ?? 0, t.lastOpenedAt ?? 0) || undefined
    })
  }
  for (const s of scanned) {
    const key = projectKey(s)
    if (!key) continue
    const prev = byKey.get(key)
    byKey.set(key, {
      dir: prev?.dir ?? s,
      tracked: prev?.tracked ?? false,
      scanned: true,
      lastOpenedAt: prev?.lastOpenedAt
    })
  }

  const activeKey = projectKey(opts.activeDir ?? '')
  const out: KnownProject[] = []
  for (const [key, entry] of byKey) {
    const exists = opts.exists(entry.dir)
    const described = exists ? opts.describe(entry.dir) : null
    out.push({
      dir: entry.dir,
      name: described?.name?.trim() || folderName(entry.dir),
      modName: described?.name?.trim() || undefined,
      modId: described?.modId,
      mcVersion: described?.mcVersion,
      loader: described?.loader,
      source: entry.tracked && entry.scanned ? 'both' : entry.tracked ? 'tracked' : 'scanned',
      exists,
      lastOpenedAt: entry.lastOpenedAt,
      active: !!activeKey && key === activeKey
    })
  }

  /*
   * Order for the person choosing.
   *
   * The active project first — it is the one they are looking at, and having to
   * scroll to find where they already are is jarring. Then most recently opened,
   * because that is what "the project I was working on" means. A missing folder
   * goes last: it is a footnote, not a candidate.
   */
  return out.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1
    if (a.exists !== b.exists) return a.exists ? -1 : 1
    const at = a.lastOpenedAt ?? 0
    const bt = b.lastOpenedAt ?? 0
    if (at !== bt) return bt - at
    return a.name.localeCompare(b.name)
  })
}

/**
 * Folders worth looking in for other projects.
 *
 * The parents of the known projects, plus the configured projects folder. Deep
 * scanning of a whole drive is not something to do on startup; one level down
 * from where the user already keeps projects finds the realistic cases without
 * turning the dropdown into a disk crawl.
 */
export function projectSearchRoots(dirs: string[], configuredRoot = ''): string[] {
  const roots = new Set<string>()
  const root = (configuredRoot ?? '').trim().replace(/[\\/]+$/, '')
  if (root) roots.add(root)
  for (const dir of dirs) {
    const trimmed = (dir ?? '').trim().replace(/[\\/]+$/, '')
    if (!trimmed) continue
    const parent = trimmed.replace(/[\\/][^\\/]+$/, '')
    if (parent && parent !== trimmed) roots.add(parent)
  }
  return [...roots]
}

/** Which of a folder's children look like projects. */
export function scanForProjects(root: string, readdir: (d: string) => string[], join: (a: string, b: string) => string): string[] {
  let entries: string[]
  try {
    entries = readdir(root)
  } catch {
    return []
  }
  const found: string[] = []
  for (const entry of entries) {
    if (entry.startsWith('.') || entry === 'node_modules') continue
    const full = join(root, entry)
    if (looksLikeProject(full, readdir)) found.push(full)
  }
  return found
}
