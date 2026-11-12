import fs from 'node:fs'
import path from 'node:path'
import { userDataDir } from './config'

/**
 * Learning from past mistakes.
 *
 * Every failure this app sees — a javac error, a gradle resolve failure, a crash
 * on launch, a screenshot the model called broken — is a lesson, but only if it
 * comes back at the moment it would have helped. Two things are stored:
 *
 *  - **Lessons** (`learn.json`): a fingerprint of the error, the rule that fixed
 *    it, and how often it has been seen. Recall is by fingerprint and by text.
 *  - **Error index** (`errors.json`): every distinct failure with a pointer to the
 *    build log that contains it, so a repeat can be recognised instantly.
 *
 * Fingerprints strip the parts that vary between occurrences (line numbers, file
 * names, hashes) so the same mistake from a different file matches the same
 * lesson. That is the difference between "I have seen this" and "I have seen this
 * exact string".
 */

export interface Lesson {
  id: string
  /** Normalised error text used for matching. */
  fingerprint: string
  /** One-line description shown to the model. */
  rule: string
  /** What not to do again, in the imperative. */
  avoid?: string
  /** The fix that worked (diff summary, API name, property to set). */
  fix?: string
  /** Where it came from: local build, Actions, game crash, vision analysis. */
  source: 'local-build' | 'actions' | 'crash' | 'vision' | 'manual'
  loader?: string
  mcVersion?: string
  /** Full error text from the first occurrence. */
  sample: string
  /** Path to the build log that held the first occurrence. */
  logPath?: string
  seen: number
  firstSeen: number
  lastSeen: number
  /** Set when the user or the agent confirmed the lesson was actually right. */
  confirmed?: boolean
  /** Lessons the user deleted stay deleted: the fingerprint is remembered here. */
  retired?: boolean
}

export interface LearnStore {
  lessons: Lesson[]
}

const MAX_LESSONS = 300
/** Above this, fuzzy text matching gets slow and noisy. */
const MAX_FP = 400

function learnFile(): string {
  return path.join(userDataDir(), 'learn.json')
}

export function loadLessons(): LearnStore {
  try {
    const raw = JSON.parse(fs.readFileSync(learnFile(), 'utf8')) as LearnStore
    return { lessons: Array.isArray(raw?.lessons) ? raw.lessons : [] }
  } catch {
    return { lessons: [] }
  }
}

function saveLessons(store: LearnStore): void {
  fs.mkdirSync(path.dirname(learnFile()), { recursive: true })
  fs.writeFileSync(learnFile(), JSON.stringify(store, null, 2), 'utf8')
}

/* ---------------------------------------------------------- fingerprinting */

/**
 * Normalise an error into something comparable across runs.
 *
 * The substitutions are the ones that make the same mistake look different:
 * file paths, line:column numbers, hashes and timings. Order matters: file names
 * are removed before line numbers, so `Foo.java:42` collapses to one token
 * rather than leaving `Foo.java` behind to differ between runs.
 */
export function fingerprint(error: string): string {
  return error
    .toLowerCase()
    .replace(/[a-z]:\\[^\s:]+/g, '<file>')
    .replace(/[\w/.-]+\.(java|kt|gradle|json|toml|json5|xml|yml|yaml)/g, '<file>')
    .replace(/\(([^)]*)\)/g, (_m, inner) => '(' + inner.replace(/:-?\d+(:\d+)?/g, ':<line>') + ')')
    .replace(/:-?\d+(:-?\d+)?\b/g, ':<line>')
    .replace(/\b\d{4,}\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_FP)
}

/**
 * Fingerprints that are too generic to learn anything useful from. A lesson
 * keyed on "error: cannot find symbol" would fire on every unrelated typo.
 */
export function isLearnable(error: string): boolean {
  const fp = fingerprint(error)
  if (fp.length < 24) return false
  const generic = [
    /^error: cannot find symbol/,
    /^build failed$/,
    /^execution failed for task/,
    /^cancelled$/,
    /^\d+$/
  ]
  return !generic.some((g) => g.test(fp))
}

/** How similar two fingerprints are, 0..1 (token Jaccard). */
export function similarity(a: string, b: string): number {
  if (a === b) return 1
  const tokens = (s: string): Set<string> => new Set(s.split(/[^a-z0-9_.$]+/).filter((t) => t.length > 2))
  const ta = tokens(a)
  const tb = tokens(b)
  if (!ta.size || !tb.size) return 0
  let shared = 0
  for (const t of ta) if (tb.has(t)) shared++
  return shared / (ta.size + tb.size - shared)
}

export interface RecallOptions {
  /** How many lessons to return. */
  limit?: number
  /** Minimum token similarity for a fuzzy match (0.34 is deliberately loose). */
  minScore?: number
  loader?: string
  mcVersion?: string
}

/**
 * Lessons worth showing for a new error: exact fingerprint first, then similar
 * ones. A lesson for another loader is only a hint, so it is scored lower rather
 * than dropped — the same mistake often exists in all three loaders.
 */
export function recall(error: string, opts: RecallOptions = {}): { lesson: Lesson; score: number; exact: boolean }[] {
  const fp = fingerprint(error)
  const minScore = opts.minScore ?? 0.34
  const out: { lesson: Lesson; score: number; exact: boolean }[] = []
  for (const lesson of loadLessons().lessons) {
    if (lesson.retired) continue
    // Same-platform lessons are more trustworthy than cross-platform ones, so the
    // penalty applies to an exact match too: an identical javac error under
    // Forge usually needs a different fix under Fabric.
    const sameLoader = !opts.loader || !lesson.loader || lesson.loader === opts.loader
    const sameMc = !opts.mcVersion || !lesson.mcVersion || lesson.mcVersion === opts.mcVersion
    if (lesson.fingerprint === fp) {
      const score = sameLoader ? 1 : 0.6
      out.push({ lesson, score, exact: sameLoader })
      continue
    }
    let score = similarity(fp, lesson.fingerprint)
    if (score < minScore) continue
    if (!sameLoader) score *= 0.6
    if (!sameMc) score *= 0.85
    if (lesson.confirmed) score = Math.min(1, score * 1.15)
    out.push({ lesson, score, exact: false })
  }
  return out.sort((a, b) => b.score - a.score || b.lesson.seen - a.lesson.seen).slice(0, opts.limit ?? 5)
}

/* --------------------------------------------------------------- recording */

export interface RecordOptions {
  error: string
  source?: Lesson['source']
  loader?: string
  mcVersion?: string
  logPath?: string
  /** The fix, when it is already known (the agent usually supplies it later). */
  fix?: string
  rule?: string
}

/**
 * Store a failure. A repeat increments `seen` instead of adding a row, which is
 * what makes "this has bitten you four times" possible.
 */
export function recordFailure(opts: RecordOptions): { added: boolean; lesson?: Lesson; ignored?: string } {
  if (!isLearnable(opts.error)) return { added: false, ignored: 'not specific enough to learn from' }
  const fp = fingerprint(opts.error)
  const store = loadLessons()
  const existing = store.lessons.find((l) => l.fingerprint === fp)
  const now = Date.now()
  if (existing) {
    existing.seen += 1
    existing.lastSeen = now
    if (opts.fix && !existing.fix) existing.fix = opts.fix
    if (opts.rule && !existing.rule) existing.rule = opts.rule
    existing.retired = false
    saveLessons(store)
    return { added: false, lesson: existing }
  }

  const lesson: Lesson = {
    id: `lsn_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    fingerprint: fp,
    rule: opts.rule ?? defaultRule(opts.error),
    fix: opts.fix,
    source: opts.source ?? 'local-build',
    loader: opts.loader,
    mcVersion: opts.mcVersion,
    sample: opts.error.slice(0, 2000),
    logPath: opts.logPath,
    seen: 1,
    firstSeen: now,
    lastSeen: now
  }
  const lessons = [lesson, ...store.lessons]
    // Keep the most-seen and most-recent: a one-off that never recurred is not a lesson.
    .sort((a, b) => Number(b.seen > 1) - Number(a.seen > 1) || b.lastSeen - a.lastSeen)
    .slice(0, MAX_LESSONS)
  saveLessons({ lessons })
  return { added: true, lesson }
}

/** A first-pass rule from the error text; the agent or the user refines it. */
export function defaultRule(error: string): string {
  const e = error.toLowerCase()
  if (/cannot find symbol/.test(e)) return 'A symbol does not exist under those names for this loader/version; check the mappings the project uses.'
  if (/package .* does not exist/.test(e)) return 'That package is not on this version’s classpath; the import belongs to a different Minecraft/loader version.'
  if (/incompatible types|no suitable method/.test(e)) return 'The API signature changed; match the exact signature in this version instead of the one from memory.'
  if (/unreported exception/.test(e)) return 'The call throws a checked exception that must be handled.'
  if (/duplicate class/.test(e)) return 'The same class is being generated twice; remove the duplicate source or the starter class.'
  if (/mods\.toml|neoforge\.mods\.toml|fabric\.mod\.json|mcmod\.info/.test(e)) return 'The metadata file does not match the loader/version format.'
  if (/could not resolve|failed to resolve/.test(e)) return 'A dependency or plugin version does not exist for this Minecraft version.'
  if (/unsupported class file|class file version/.test(e)) return 'The build is compiled for a newer Java than the one running it.'
  if (/outofmemory|metaspace/.test(e)) return 'Gradle ran out of memory; raise the heap in gradle.properties.'
  if (/lang|translation|missing key/.test(e)) return 'A language or resource key is missing from the resources.'
  if (/nullpointerexception/.test(e)) return 'Something was null at runtime; check the object is initialised before it is used.'
  return 'This exact failure happened before; see the sample and the fix that worked.'
}

export function confirmLesson(id: string, patch: { rule?: string; fix?: string; avoid?: string }): Lesson | null {
  const store = loadLessons()
  const lesson = store.lessons.find((l) => l.id === id)
  if (!lesson) return null
  if (patch.rule) lesson.rule = patch.rule
  if (patch.fix) lesson.fix = patch.fix
  if (patch.avoid) lesson.avoid = patch.avoid
  lesson.confirmed = true
  saveLessons(store)
  return lesson
}

/** Delete a lesson. The fingerprint is remembered so it does not come straight back. */
export function retireLesson(id: string): Lesson[] {
  const store = loadLessons()
  const lesson = store.lessons.find((l) => l.id === id)
  if (lesson) lesson.retired = true
  saveLessons({ lessons: store.lessons.filter((l) => !l.retired) })
  return store.lessons.filter((l) => !l.retired)
}

export function clearLessons(): void {
  saveLessons({ lessons: [] })
}

/* ------------------------------------------------------------------- prompt */

/**
 * The block injected into the agent's prompt. Deliberately short: the five most
 * recent confirmed lessons are worth their tokens, the whole store is not.
 */
export function lessonsForPrompt(opts: { loader?: string; mcVersion?: string; limit?: number } = {}): string {
  const all = loadLessons().lessons.filter((l) => !l.retired)
  if (!all.length) return ''
  const ranked = all
    .slice()
    .sort((a, b) => Number(!!b.confirmed) - Number(!!a.confirmed) || b.seen - a.seen || b.lastSeen - a.lastSeen)
    .filter((l) => !opts.loader || !l.loader || l.loader === opts.loader)
    .slice(0, opts.limit ?? 5)
  if (!ranked.length) return ''
  const lines = ranked.map((l) => {
    const meta = [l.loader, l.mcVersion, l.seen > 1 ? `seen ${l.seen}×` : '', l.source].filter(Boolean).join(', ')
    return `- **${l.rule}**${l.fix ? ` Fix: ${l.fix}.` : ''}${l.avoid ? ` Avoid: ${l.avoid}.` : ''} (${meta})`
  })
  return `# Mistakes already made on this project\n\nThese failures have happened in this app before. Do not repeat them; if you hit one, apply the known fix first.\n\n${lines.join('\n')}`
}

/** Compact list for the UI and the agent's `list_lessons` tool. */
export function listLessons(): Lesson[] {
  return loadLessons()
    .lessons.filter((l) => !l.retired)
    .sort((a, b) => Number(!!b.confirmed) - Number(!!a.confirmed) || b.seen - a.seen || b.lastSeen - a.lastSeen)
}

/* -------------------------------------------------------------- error index */

export interface ErrorEntry {
  fingerprint: string
  message: string
  count: number
  firstSeen: number
  lastSeen: number
  logPaths: string[]
}

export function errorsFile(): string {
  return path.join(userDataDir(), 'errors.json')
}

export function loadErrors(): ErrorEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(errorsFile(), 'utf8')) as ErrorEntry[]
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

/** Index a batch of fresh errors from one build, then learn the learnable ones. */
export function indexErrors(
  errors: string[],
  opts: { logPath?: string; source?: Lesson['source']; loader?: string; mcVersion?: string } = {}
): { indexed: number; learned: number; repeats: number } {
  const store = loadErrors()
  const now = Date.now()
  let learned = 0
  let repeats = 0
  for (const error of errors) {
    const fp = fingerprint(error)
    const existing = store.find((e) => e.fingerprint === fp)
    if (existing) {
      existing.count += 1
      existing.lastSeen = now
      if (opts.logPath && !existing.logPaths.includes(opts.logPath)) {
        existing.logPaths = [opts.logPath, ...existing.logPaths].slice(0, 5)
      }
    } else {
      store.push({
        fingerprint: fp,
        message: error.slice(0, 1000),
        count: 1,
        firstSeen: now,
        lastSeen: now,
        logPaths: opts.logPath ? [opts.logPath] : []
      })
    }
    const res = recordFailure({ error, source: opts.source, loader: opts.loader, mcVersion: opts.mcVersion, logPath: opts.logPath })
    if (res.added) learned++
    else if (res.lesson && res.lesson.seen > 1) repeats++
  }
  try {
    fs.mkdirSync(path.dirname(errorsFile()), { recursive: true })
    fs.writeFileSync(errorsFile(), JSON.stringify(store.slice(-500), null, 2), 'utf8')
  } catch {
    /* the index is a convenience; losing it must not break a build */
  }
  return { indexed: errors.length, learned, repeats }
}
