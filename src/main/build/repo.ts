import fs from 'node:fs'
import path from 'node:path'

/**
 * Which folder a GitHub build should actually use, and whether it is ready.
 *
 * The failure this module exists to prevent, verbatim from a user's log:
 *
 *   Not a git repository. Create one first (Settings > GitHub).
 *
 * They had just clicked **Build on GitHub** on a project they had made by
 * decompiling a mod. The project existed and built; it simply was not a git
 * repository yet. Telling them to go to Settings was wrong twice over: the app
 * can create the repository itself, and Settings is where you *sign in*, not
 * where a git directory is made.
 *
 * Two things made that message reachable at all:
 *
 *  1. `runActionsBuild` demanded `.git` and gave up. Creating an empty repo and a
 *     first commit is a `git init` — no reason to involve the user.
 *  2. The build read `cfg.workspaceDir`, which is not necessarily the project the
 *     Build tab is showing. A fork made from a decompiled mod lives in its own
 *     folder, so "build on GitHub" could act on a different directory entirely.
 *
 * So the decision is three-value, not boolean: no `.git` (create one), `.git`
 * with no `origin` (add one), or ready. Keeping it here — no Electron, no
 * network, no spawn — means the interesting cases are testable.
 */

export type RepoState =
  /** No `.git` at all. A `git init` plus a first commit is all that is missing. */
  | 'no-repo'
  /** A repository, but no `origin` remote — the GitHub side is what is missing. */
  | 'no-origin'
  /** A repository with an `origin`. Whether it can be pushed to is a network question. */
  | 'ready'

/** What the build needs before it can push: the folder, and what is missing in it. */
export interface RepoCheck {
  dir: string
  state: RepoState
  /** True when this needs git writes before a push can work. */
  needsInit: boolean
  /** One sentence the user can act on, or null when nothing is wrong. */
  message: string | null
}

/** Does this folder hold a git repository (a `.git` file or directory)? */
export function hasGitDir(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, '.git'))
  } catch {
    return false
  }
}

/**
 * Decide the repo state of a project folder.
 *
 * `remotes` is the output of `git remote`, passed in rather than run here so the
 * decision is testable without spawning git or owning a repository.
 */
export function repoState(dir: string, remotes: string[] | null): RepoCheck {
  if (!hasGitDir(dir)) {
    return {
      dir,
      state: 'no-repo',
      needsInit: true,
      message: 'This project is not a git repository yet. A repository will be created before pushing.'
    }
  }
  const list = remotes ?? []
  if (!list.includes('origin')) {
    return {
      dir,
      state: 'no-origin',
      needsInit: true,
      message: 'This repository has no origin remote. One will be added from your GitHub settings.'
    }
  }
  return { dir, state: 'ready', needsInit: false, message: null }
}

/**
 * The `.gitignore` a decompiled-mod project needs before its first commit.
 *
 * A fork of a decompiled mod is a large tree — sources, resources, a gradle
 * cache, and often `reference/` with the original jar inside. Committing all of
 * it on a first push is the failure mode: a multi-hundred-megabyte push that
 * GitHub rejects, or one that succeeds and puts a decompiled mod somewhere its
 * licence does not allow. So the ignore rules are not politeness, they are what
 * makes the first commit a sane size.
 *
 * Existing rules are preserved; this only appends what is missing.
 */
export const FORK_GITIGNORE = [
  '# gradle',
  '.gradle/',
  'build/',
  'out/',
  '',
  '# ide',
  '.idea/',
  '*.iml',
  '.vscode/',
  '',
  '# minecraft run dirs',
  'run/',
  'logs/',
  '*.log',
  '',
  '# agent',
  '.agent/',
  '',
  '# decompiled reference trees and the jars they came from',
  'reference/',
  '*.jar',
  '*.zip'
]

/** Append the rules a project is missing, keeping the user's own. Returns true if written. */
export function ensureForkGitignore(dir: string): boolean {
  const file = path.join(dir, '.gitignore')
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    /* none yet */
  }
  const present = new Set(text.split(/\r?\n/).map((l) => l.trim()))
  const missing = FORK_GITIGNORE.filter((l) => l && !present.has(l))
  // `*.jar` would ignore a gradle-wrapper.jar that must be committed. The
  // wrapper lives at gradle/wrapper/gradle-wrapper.jar, and excluding it breaks
  // every clone of the repo. Allow it explicitly after the rule that hides it.
  if (missing.includes('*.jar') && !present.has('!gradle/wrapper/gradle-wrapper.jar')) {
    missing.push('!gradle/wrapper/gradle-wrapper.jar')
  }
  if (!missing.length) return false
  const next = `${text}${text && !text.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`
  try {
    fs.writeFileSync(file, next, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * A default repository name for a project that has never been pushed.
 *
 * The mod id is usually already a valid repo name; it just needs the characters
 * GitHub rejects removed. `thaumcraft_v4_2_3_5` is a fine name; a jar's display
 * name often is not.
 */
export function suggestRepoName(modId: string): string {
  const cleaned = modId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+/, '')
    .replace(/[-._]+$/, '')
    .slice(0, 100)
  return cleaned || 'minecraft-mod'
}
