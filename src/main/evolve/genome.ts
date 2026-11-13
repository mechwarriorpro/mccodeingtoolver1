import fs from 'node:fs'
import path from 'node:path'
import { userDataDir } from '../config'
import { log } from '../diag'
import { DEFAULT_RULES, type Rules } from './metrics'

/**
 * The agent's own genome: the files that decide how it behaves.
 *
 * This is deliberately a *narrow* set. Evolving the whole program would mean a
 * generation could break the app that is supposed to evaluate it, and every
 * crash would be unrecoverable. These three files change how the agent thinks
 * and writes code without touching the machinery that builds, measures and
 * promotes it:
 *
 *  - `src/main/agent/prompt.ts`      — the system prompt and its rules
 *  - `src/main/agent/orchestrator.ts`— the subagents and their instructions
 *  - `src/main/agent/tools.ts`       — the tool descriptions the model reads
 *
 * Anything outside this list is rejected, and the rejection is reported rather
 * than silently ignored.
 */

export const GENOME_FILES = [
  'src/main/agent/prompt.ts',
  'src/main/agent/orchestrator.ts',
  'src/main/agent/tools.ts'
] as const

/** Never evolved, whatever a generation tries: these run the evaluation. */
export const PROTECTED = [
  'src/main/evolve/',
  'src/main/build/',
  'src/main/agent/engine.ts',
  'src/main/agent/autoswitch.ts',
  'src/main/ipc/',
  'src/main/diag.ts'
]

export interface GenomeIdentity {
  name: string
  /** What the generation is trying to do differently, in one line. */
  thesis: string
  rules: Rules
}

export interface Generation {
  /** 0 for the baseline installed with the app. */
  id: number
  createdAt: number
  identity: GenomeIdentity
  /** Where this generation's copy of the app lives. */
  dir: string
  /** The generation this came from, if any. */
  parent: number | null
  /** What the mutator changed, in its own words. */
  mutation?: string
  /** Filled in once it has been evaluated. */
  score?: number
  /** Per-rule scores, so a rule-driven loss can be seen for what it is. */
  parts?: Record<string, number>
  metrics?: {
    builds: boolean
    errorCount: number
    classBytes: number
    classCount: number
    sourceBytes: number
    sourceFiles: number
    buildMs: number
    minHeapMb: number | null
    note: string
  }
  status: 'candidate' | 'active' | 'retired' | 'failed'
  /** Why it was retired or failed. Kept: a dead end is a lesson. */
  outcome?: string
}

export interface EvolutionStore {
  /** The generation currently in use. 0 always exists. */
  active: number
  generations: Generation[]
  /** Set when the user has paused the loop. */
  paused: boolean
  /** Hard stop: how many generations before the loop stops on its own. */
  maxGenerations: number
  rules: Rules
  /** Where the evolving copies live. */
  root: string
  /** A snapshot of the app as installed, taken once, so generation 0 is never lost. */
  baselineDir?: string
}

function storeFile(): string {
  return path.join(userDataDir(), 'evolve.json')
}

export function evolveRoot(): string {
  return path.join(userDataDir(), 'evolve')
}

export function loadStore(): EvolutionStore {
  const root = evolveRoot()
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile(), 'utf8')) as EvolutionStore
    if (!Array.isArray(raw.generations) || !raw.generations.length) throw new Error('empty store')
    return { ...raw, root, rules: raw.rules ?? DEFAULT_RULES }
  } catch {
    return { active: 0, generations: [], paused: false, maxGenerations: 20, rules: DEFAULT_RULES, root }
  }
}

export function saveStore(store: EvolutionStore): void {
  fs.mkdirSync(path.dirname(storeFile()), { recursive: true })
  fs.writeFileSync(storeFile(), JSON.stringify(store, null, 2), 'utf8')
}

export function activeGeneration(store = loadStore()): Generation | null {
  return store.generations.find((g) => g.id === store.active) ?? null
}

/* --------------------------------------------------------------- copying */

const COPY_SKIP = new Set(['node_modules', 'out', 'out-test', 'dist', 'release', '.git', '.test-tmp', 'evolve'])

/**
 * Copy the app's sources into a generation folder.
 *
 * `node_modules` is skipped on purpose: a generation reuses the installed
 * dependencies and only its own `src` and `template` differ. Copying 400 MB of
 * packages per generation would make the loop unusable and change nothing.
 */
export function copyApp(from: string, to: string): { ok: boolean; files: number; error?: string } {
  let files = 0
  try {
    fs.rmSync(to, { recursive: true, force: true })
    const walk = (rel: string): void => {
      const src = path.join(from, rel)
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(src, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (COPY_SKIP.has(e.name)) continue
        const childRel = rel ? path.join(rel, e.name) : e.name
        if (e.isDirectory()) {
          fs.mkdirSync(path.join(to, childRel), { recursive: true })
          walk(childRel)
        } else if (e.isFile()) {
          fs.mkdirSync(path.dirname(path.join(to, childRel)), { recursive: true })
          fs.copyFileSync(path.join(from, childRel), path.join(to, childRel))
          files++
        }
      }
    }
    walk('')
    return { ok: true, files }
  } catch (e) {
    return { ok: false, files, error: (e as Error).message }
  }
}

/* --------------------------------------------------------------- the genome */

export interface GenomeFile {
  path: string
  text: string
}

/** Read the evolvable files from a generation directory. */
export function readGenome(dir: string): GenomeFile[] {
  const out: GenomeFile[] = []
  for (const rel of GENOME_FILES) {
    try {
      out.push({ path: rel, text: fs.readFileSync(path.join(dir, rel), 'utf8') })
    } catch {
      /* a generation missing a genome file is incomplete; the caller checks count */
    }
  }
  return out
}

/**
 * Write a generation's changes back.
 *
 * `edits` is path → full file text, not a diff. A model producing a diff would
 * have to be trusted to apply it, and one bad hunk would leave a generation that
 * compiles to something nobody wrote. A full file is verifiable: either it is
 * syntactically valid TypeScript or the generation fails before it is used.
 */
export function writeGenome(opts: {
  dir: string
  edits: { path: string; text: string }[]
}): { ok: boolean; written: string[]; rejected: { path: string; reason: string }[] } {
  const written: string[] = []
  const rejected: { path: string; reason: string }[] = []
  for (const edit of opts.edits) {
    const rel = edit.path.replace(/\\/g, '/').replace(/^\.\//, '')
    // Protected is checked first, and on purpose: these are the files that build,
    // measure and promote, so the reason a mutation is refused must name that and
    // not merely "not on the list" — the distinction is the security property.
    if (PROTECTED.some((p) => rel.startsWith(p))) {
      rejected.push({ path: rel, reason: 'protected: it would change how generations are evaluated' })
      continue
    }
    if (!(GENOME_FILES as readonly string[]).includes(rel)) {
      rejected.push({ path: rel, reason: 'not one of the evolvable files' })
      continue
    }
    // A size guard: a "mutation" that triples the prompt is not an improvement
    // in any rule, and is usually a model padding rather than thinking.
    if (edit.text.length > 400_000) {
      rejected.push({ path: rel, reason: 'implausibly large' })
      continue
    }
    if (!edit.text.trim()) {
      rejected.push({ path: rel, reason: 'empty file' })
      continue
    }
    try {
      fs.mkdirSync(path.dirname(path.join(opts.dir, rel)), { recursive: true })
      fs.writeFileSync(path.join(opts.dir, rel), edit.text, 'utf8')
      written.push(rel)
    } catch (e) {
      rejected.push({ path: rel, reason: (e as Error).message })
    }
  }
  log('app', 'info', 'genome written', { written, rejected }, 2)
  return { ok: written.length > 0, written, rejected }
}

/* ---------------------------------------------------------------- versioning */

/**
 * Promote a generation.
 *
 * The old one is retired rather than deleted: its score and its outcome are the
 * record of what was tried. Deleting it would make the loop amnesiac, and every
 * later generation would rediscover the same dead ends.
 */
export function promote(store: EvolutionStore, id: number): EvolutionStore {
  const gen = store.generations.find((g) => g.id === id)
  if (!gen) return store
  for (const g of store.generations) {
    if (g.status === 'active') {
      g.status = 'retired'
      g.outcome = g.outcome ?? `superseded by generation ${id}`
    }
  }
  gen.status = 'active'
  gen.outcome = undefined
  store.active = id
  saveStore(store)
  log('app', 'info', `generation ${id} is now active`, { score: gen.score }, 1)
  return store
}

export function addGeneration(store: EvolutionStore, gen: Generation): EvolutionStore {
  store.generations = [...store.generations.filter((g) => g.id !== gen.id), gen].sort((a, b) => a.id - b.id)
  saveStore(store)
  return store
}

export function nextId(store: EvolutionStore): number {
  return store.generations.reduce((max, g) => Math.max(max, g.id), 0) + 1
}

/** The best-scoring generation so far, which is what a user usually wants to run. */
export function bestGeneration(store: EvolutionStore): Generation | null {
  const scored = store.generations.filter((g) => typeof g.score === 'number' && g.status !== 'failed')
  if (!scored.length) return activeGeneration(store)
  return scored.reduce((a, b) => ((a.score ?? 0) >= (b.score ?? 0) ? a : b))
}

/** A short history, newest last, for the UI. */
export function lineage(store: EvolutionStore): { id: number; score?: number; status: string; thesis: string }[] {
  return store.generations.map((g) => ({ id: g.id, score: g.score, status: g.status, thesis: g.identity.thesis }))
}
