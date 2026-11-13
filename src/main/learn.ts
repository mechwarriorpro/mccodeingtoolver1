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
  /**
   * A fact learned by study or research rather than from a failure. These are the
   * ones a weak model "cheats" with: Deep Research writes them with the strongest
   * model, and whatever codes next gets them for free.
   */
  kind?: 'failure' | 'topic' | 'research'
  /** Where the fact came from, in words — a reference mod, a URL, a doc. */
  sourceNote?: string
  /** Topic or research slug it belongs to, for grouping. */
  topic?: string
  /** Reference mods and URLs that back it up. */
  sources?: string[]
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

/**
 * Store a *fact*, not a failure.
 *
 * `recordFailure` insists on an error fingerprint, which is right for a build
 * error and useless for "this is how you register an item in 1.21.1". Study has
 * no error text, so it gets its own door into the same store — which is the
 * whole point: a lesson written by Deep Research is recalled by whatever model
 * codes next, through exactly the path a learned build fix takes.
 *
 * Deduplication is by normalised rule text rather than by fingerprint, because
 * two study runs on the same topic should strengthen a lesson, not multiply it.
 */
export function saveKnowledge(opts: SaveKnowledgeOptions): { added: boolean; lesson: Lesson; duplicate: boolean } {
  const rule = opts.rule.trim()
  if (!rule) throw new Error('A lesson needs a rule — one sentence the next model can act on.')
  const store = loadLessons()
  const norm = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const key = norm(rule)
  const now = Date.now()
  const existing = store.lessons.find((l) => !l.retired && norm(l.rule) === key)
  if (existing) {
    // Seen again: keep it near the top and fill in anything this run knows that
    // the first one did not.
    existing.seen += 1
    existing.lastSeen = now
    existing.fix = opts.fix?.trim() || existing.fix
    existing.avoid = opts.avoid?.trim() || existing.avoid
    existing.loader = opts.loader || existing.loader
    existing.mcVersion = opts.mcVersion || existing.mcVersion
    if (opts.sources?.length) {
      existing.sources = [...new Set([...(existing.sources ?? []), ...opts.sources])].slice(0, 12)
    }
    existing.confirmed = existing.confirmed || opts.confirmed
    saveLessons({ lessons: store.lessons })
    return { added: false, lesson: existing, duplicate: true }
  }
  const lesson: Lesson = {
    id: `lsn_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    fingerprint: `topic:${key.slice(0, MAX_FP)}`,
    rule,
    fix: opts.fix?.trim(),
    avoid: opts.avoid?.trim(),
    // 'manual' is the closest existing source; `kind` carries the real story.
    source: opts.kind === 'research' ? 'manual' : 'manual',
    kind: opts.kind,
    topic: opts.topic,
    sourceNote: opts.sourceNote,
    sources: opts.sources?.slice(0, 12),
    loader: opts.loader,
    mcVersion: opts.mcVersion,
    sample: opts.detail?.slice(0, 2000) ?? rule,
    seen: 1,
    firstSeen: now,
    lastSeen: now,
    confirmed: opts.confirmed
  }
  const lessons = [lesson, ...store.lessons]
    .sort((a, b) => Number(!!b.confirmed) - Number(!!a.confirmed) || b.seen - a.seen || b.lastSeen - a.lastSeen)
    .slice(0, MAX_LESSONS)
  saveLessons({ lessons })
  return { added: true, lesson, duplicate: false }
}

export interface SaveKnowledgeOptions {
  rule: string
  fix?: string
  avoid?: string
  /** Extra context, stored but not shown in the prompt block. */
  detail?: string
  kind?: 'topic' | 'research'
  topic?: string
  sourceNote?: string
  sources?: string[]
  loader?: string
  mcVersion?: string
  confirmed?: boolean
}

/** Everything studied on one topic, for the panel. */
export function knowledgeOn(topic: string): Lesson[] {
  const t = topic.trim().toLowerCase()
  if (!t) return []
  return loadLessons().lessons.filter((l) => !l.retired && (l.topic ?? '').toLowerCase() === t)
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
  const usable = all.filter((l) => !opts.loader || !l.loader || l.loader === opts.loader)

  // Two stores in one file, and they answer different questions. A failure
  // ("do not use new Item()") is a warning; a studied fact ("register with
  // DeferredRegister.createItems") is a recipe. Mixing them buries the recipes
  // under the warnings, so they get separate blocks and the failure list keeps
  // the top slot it earned.
  const rank = (l: Lesson): number => Number(!!l.confirmed) - 0 || 0
  const byUse = (a: Lesson, b: Lesson): number =>
    rank(b) - rank(a) || b.seen - a.seen || b.lastSeen - a.lastSeen

  const failures = usable.filter((l) => !l.kind || l.kind === 'failure').sort(byUse)
  const knowledge = usable.filter((l) => l.kind === 'topic' || l.kind === 'research').sort(byUse)

  const limit = opts.limit ?? 5
  const blocks: string[] = []

  const failLines = failures.slice(0, limit).map((l) => {
    const meta = [l.loader, l.mcVersion, l.seen > 1 ? `seen ${l.seen}×` : '', l.source].filter(Boolean).join(', ')
    return `- **${l.rule}**${l.fix ? ` Fix: ${l.fix}.` : ''}${l.avoid ? ` Avoid: ${l.avoid}.` : ''} (${meta})`
  })
  if (failLines.length) {
    blocks.push(
      `# Mistakes already made on this project\n\nThese failures have happened in this app before. Do not repeat them; if you hit one, apply the known fix first.\n\n${failLines.join('\n')}`
    )
  }

  // Knowledge gets a bigger budget than the five failures: this is the block
  // written by deep research specifically so a limited model does not have to
  // rediscover it, and truncating it wastes the run that produced it.
  const knowLines = knowledge.slice(0, Math.max(limit, 12)).map((l) => {
    const meta = [l.loader, l.mcVersion, l.seen > 1 ? `used ${l.seen}×` : '', l.kind === 'research' ? 'researched' : 'studied']
      .filter(Boolean)
      .join(', ')
    return `- **${l.rule}**${l.fix ? `\n  Do this: ${l.fix}` : ''}${l.avoid ? `\n  Trap: ${l.avoid}` : ''}${meta ? `\n  (${meta})` : ''}`
  })
  if (knowLines.length) {
    blocks.push(
      `# What has already been worked out here\n\nFacts established by reading real mods and documentation, then written down so you do not have to rediscover them. Follow them; they beat guessing.\n\n${knowLines.join('\n')}`
    )
  }

  return blocks.join('\n\n')
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
