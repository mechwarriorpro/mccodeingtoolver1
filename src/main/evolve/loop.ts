import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../config'
import { log } from '../diag'
import { lessonsForPrompt } from '../learn'
import { activeGeneration, addGeneration, bestGeneration, loadStore, nextId, promote, readGenome, saveStore, writeGenome, type EvolutionStore, type Generation } from './genome'
import { DEFAULT_RULES, rulesToInstructions, type Baseline, type Rules } from './metrics'
import { DEFAULT_TASK, evaluateGenome } from './evaluate'

/**
 * The evolution loop.
 *
 * One generation:
 *
 *  1. fork the *active* generation's sources into a new folder;
 *  2. ask a model to mutate the genome — the prompt, the subagent instructions,
 *     the tool descriptions — with the four weighted rules and the lessons as
 *     its input;
 *  3. write the mutation, rejecting anything outside the genome;
 *  4. run the fixed evaluation task with the *mutated* prompt;
 *  5. compile the result and score it against the parent;
 *  6. promote it only if it beats the parent, otherwise retire it with the reason.
 *
 * The loop never promotes on a failed evaluation, never runs a mutation that did
 * not compile as a program, and keeps every dead end — a generation that lost is
 * evidence about what does not work, which is the whole point of iterating.
 */

export interface LoopDeps {
  /** Run a prompt through the *real* app agent (the mutator). No tools are needed. */
  askMutator: (prompt: string) => Promise<string>
  /** Run a prompt through the *candidate* agent, for evaluation. */
  askCandidate: (genomeDir: string, prompt: string) => Promise<string>
  /** Where the app's own sources live, to seed generation 0. */
  appDir: string
  /** Classpath for compiling the evaluation task, when known. */
  classpath?: string
  javaPath?: string
  /** Called for each step so the UI can show progress. */
  onStep?: (step: { phase: string; generation?: number; detail?: string }) => void
  signal?: AbortSignal
}

export interface StepResult {
  ok: boolean
  error?: string
  generation?: Generation
  promoted?: boolean
  /** Why it did or did not win. */
  verdict: string
}

/** What the mutator is told to do. Deliberately constrained to the genome. */
function mutationPrompt(opts: {
  parent: Generation | null
  rules: Rules
  lessons: string
  limits: { maxHeapMb?: number | null }
}): string {
  const { parent, rules, lessons } = opts
  return `You are improving the **system prompt and tool descriptions** of a coding agent, not writing a mod.

## Your job

Produce a new version of one or more of these files, changed so the agent scores better on the weighted rules
below. Change as little as is needed to matter — a focused improvement beats a rewrite, and every sentence you add is
paid for on every future run.

Evolvable files (nothing else will be accepted):
- \`src/main/agent/prompt.ts\` — the system prompt, per-loader rules, style
- \`src/main/agent/orchestrator.ts\` — subagent instructions
- \`src/main/agent/tools.ts\` — the descriptions the model reads before choosing a tool

## The rules

${rulesToInstructions(rules, opts.limits)}

## What the previous generation looked like

${parent ? `Generation ${parent.id}: "${parent.identity.thesis}"\nscore ${parent.score ?? 'unscored'}${parent.metrics ? ` — ${parent.metrics.note}` : ''}` : 'This is generation 1: the starting prompt has no mutation yet.'}

## Lessons from real work

${lessons || '(none recorded yet)'}

## Rules of the craft

- **Do not remove a capability to save a token.** Deleting the build instructions makes the number go up and the agent
  worse; that is the failure mode this whole loop has to avoid.
- **A rule must be actionable.** "Write better code" changes nothing. "Never use a static initialiser for a registry
  block; build it in the constructor" changes behaviour.
- **Respect the format.** These are TypeScript files exporting template strings. Keep every export name, every function
  signature, and the template-string structure intact, or the app will not compile and the generation scores zero.
- **Short wins.** A line that prevents a whole class of mistake is worth ten that describe good practice.

## Output

Reply with one fenced block per file you are changing, each preceded by the exact path:

\`\`\`file src/main/agent/prompt.ts
<the complete new file>
\`\`\`

Include the **complete** file, not a diff — a diff that applies wrongly produces code nobody wrote.

Then, after the blocks, one line: \`THESIS: <what you changed and why, in under 20 words>\``
}

/** Parse the file blocks and thesis out of a mutator reply. */
export function parseMutation(reply: string): { edits: { path: string; text: string }[]; thesis: string } {
  const edits: { path: string; text: string }[] = []
  const re = /```file\s+([^\s`]+)\s*\n([\s\S]*?)```/g
  let m: RegExpExecArray | null
  while ((m = re.exec(reply))) {
    edits.push({ path: m[1].trim(), text: m[2] })
  }
  const thesis = reply.match(/THESIS:\s*(.+)/i)?.[1]?.trim() ?? 'no thesis given'
  return { edits, thesis }
}

/**
 * Generation 0: the app as installed, copied once so it can always be restored.
 *
 * Doing this on first use rather than at install keeps the installer unchanged,
 * and means an existing install can start evolving without reinstalling.
 */
export function ensureBaseline(appDir: string): EvolutionStore {
  const store = loadStore()
  if (store.generations.some((g) => g.id === 0)) {
    if (!store.baselineDir) {
      // Repair an older store that predates the baseline copy.
      const dir = path.join(store.root, 'g0-baseline')
      const copied = copyBaseline(appDir, dir)
      if (copied) saveStore({ ...store, baselineDir: dir })
    }
    return loadStore()
  }
  const dir = path.join(store.root, 'g0-baseline')
  const copied = copyBaseline(appDir, dir)
  const gen: Generation = {
    id: 0,
    createdAt: Date.now(),
    identity: {
      name: 'baseline',
      thesis: 'the agent as shipped',
      rules: store.rules ?? DEFAULT_RULES
    },
    dir: copied ? dir : appDir,
    parent: null,
    status: 'active'
  }
  const next: EvolutionStore = {
    ...store,
    active: 0,
    generations: [gen],
    baselineDir: copied ? dir : undefined
  } as EvolutionStore
  saveStore(next)
  return next
}

function copyBaseline(appDir: string, dir: string): boolean {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    const skip = new Set(['node_modules', 'out', 'out-test', 'dist', 'release', '.git', '.test-tmp'])
    const walk = (rel: string): void => {
      for (const e of fs.readdirSync(path.join(appDir, rel), { withFileTypes: true })) {
        if (skip.has(e.name)) continue
        const childRel = rel ? path.join(rel, e.name) : e.name
        if (e.isDirectory()) {
          fs.mkdirSync(path.join(dir, childRel), { recursive: true })
          walk(childRel)
        } else if (e.isFile()) {
          fs.mkdirSync(path.dirname(path.join(dir, childRel)), { recursive: true })
          fs.copyFileSync(path.join(appDir, childRel), path.join(dir, childRel))
        }
      }
    }
    walk('')
    return true
  } catch (e) {
    log('app', 'warn', 'could not copy the baseline', { error: (e as Error).message }, 1)
    return false
  }
}

/**
 * Run exactly one generation.
 *
 * Deliberately one at a time: two mutations evaluated at once would both be
 * scored against the same parent and both promoted, and the result would be a
 * lineage that never actually existed on disk.
 */
export async function evolveOnce(deps: LoopDeps): Promise<StepResult> {
  const store = ensureBaseline(deps.appDir)
  const parent = activeGeneration(store)
  if (!parent) return { ok: false, error: 'no active generation to evolve from', verdict: 'no baseline' }
  if (store.paused) return { ok: false, error: 'the evolution loop is paused', verdict: 'paused' }
  if (store.generations.length >= store.maxGenerations + 1) {
    return { ok: false, error: `reached the ${store.maxGenerations}-generation limit`, verdict: 'at the limit' }
  }

  const id = nextId(store)
  const dir = path.join(store.root, `g${id}`)
  deps.onStep?.({ phase: 'fork', generation: id, detail: `copying generation ${parent.id}` })

  // 1. Fork the parent's sources.
  const copied = copyFrom(deps.appDir, parent.dir, dir)
  if (!copied) return { ok: false, error: 'could not fork the parent sources', verdict: 'fork failed' }

  // 2. Ask the mutator.
  const rules = store.rules ?? DEFAULT_RULES
  const lessons = lessonsForPrompt({ limit: 8 })
  deps.onStep?.({ phase: 'mutate', generation: id, detail: 'asking the mutator' })
  let reply: string
  try {
    reply = await deps.askMutator(
      mutationPrompt({ parent, rules, lessons, limits: { maxHeapMb: loadConfig().evolveMaxHeapMb ?? null } })
    )
  } catch (e) {
    return { ok: false, error: `the mutator failed: ${(e as Error).message}`, verdict: 'no mutation' }
  }

  // 3. Apply it, refusing anything outside the genome.
  const { edits, thesis } = parseMutation(reply)
  if (!edits.length) {
    return { ok: false, error: 'the mutator produced no file blocks', verdict: 'empty mutation' }
  }
  const applied = writeGenome({ dir, edits })
  if (!applied.ok) {
    return { ok: false, error: `nothing usable was written: ${applied.rejected.map((r) => `${r.path} (${r.reason})`).join(', ')}`, verdict: 'rejected mutation' }
  }
  deps.onStep?.({ phase: 'mutate', generation: id, detail: applied.written.join(', ') })

  // 4. A genome is TypeScript; a generation that does not typecheck is not a
  //    candidate. This is checked before it is ever asked to write code, so a
  //    broken mutation cannot poison the evaluation with nonsense.
  deps.onStep?.({ phase: 'typecheck', generation: id })
  const typeOk = await typecheckGenome(dir)
  if (!typeOk.ok) {
    const failed: Generation = {
      id,
      createdAt: Date.now(),
      identity: { name: `g${id}`, thesis, rules },
      dir,
      parent: parent.id,
      mutation: applied.written.join(', '),
      status: 'failed',
      outcome: `did not typecheck: ${typeOk.error?.slice(0, 300)}`
    }
    addGeneration(store, failed)
    return { ok: false, error: failed.outcome, generation: failed, verdict: 'failed to typecheck' }
  }

  // 5. Evaluate with the mutated prompt.
  deps.onStep?.({ phase: 'evaluate', generation: id, detail: DEFAULT_TASK.title })
  const evalDir = path.join(store.root, `g${id}-eval`)
  const result = await evaluateGenome({
    ask: (prompt) => deps.askCandidate(dir, prompt),
    workDir: evalDir,
    baseline: baselineOf(store, parent),
    rules,
    classpath: deps.classpath,
    javaPath: deps.javaPath,
    maxHeapMb: loadConfig().evolveMaxHeapMb ?? null,
    signal: deps.signal
  })

  // 6. Promote only on a win.
  const parentScore = parent.score ?? null
  const wins = result.metrics.builds && (parentScore === null || result.score > parentScore)
  const gen: Generation = {
    id,
    createdAt: Date.now(),
    identity: { name: `g${id}`, thesis, rules },
    dir,
    parent: parent.id,
    mutation: applied.written.join(', '),
    score: result.score,
    parts: result.parts,
    metrics: result.metrics,
    status: wins ? 'active' : 'candidate',
    outcome: wins
      ? undefined
      : !result.metrics.builds
        ? `did not compile the evaluation task (${result.note})`
        : `scored ${result.score} against the parent's ${parentScore}`
  }
  addGeneration(store, gen)
  if (wins) promote(loadStore(), id)

  deps.onStep?.({ phase: wins ? 'promoted' : 'rejected', generation: id, detail: gen.outcome ?? 'promoted' })
  return {
    ok: true,
    generation: gen,
    promoted: wins,
    verdict: wins
      ? `generation ${id} promoted — scored ${result.score}${parentScore !== null ? ` against ${parentScore}` : ''}`
      : `generation ${id} kept but not promoted — ${gen.outcome}`
  }
}

function copyFrom(appDir: string, parentDir: string, to: string): boolean {
  // The parent's own genome may differ from the app's; take the parent's version
  // of the evolvable files and the app's copy of everything else.
  try {
    fs.rmSync(to, { recursive: true, force: true })
    const skip = new Set(['node_modules', 'out', 'out-test', 'dist', 'release', '.git', '.test-tmp', 'evolve'])
    const walk = (rel: string): void => {
      for (const e of fs.readdirSync(path.join(appDir, rel), { withFileTypes: true })) {
        if (skip.has(e.name)) continue
        const childRel = rel ? path.join(rel, e.name) : e.name
        if (e.isDirectory()) {
          fs.mkdirSync(path.join(to, childRel), { recursive: true })
          walk(childRel)
        } else if (e.isFile()) {
          fs.mkdirSync(path.dirname(path.join(to, childRel)), { recursive: true })
          fs.copyFileSync(path.join(appDir, childRel), path.join(to, childRel))
        }
      }
    }
    walk('')
    // Overlay the parent's genome.
    for (const file of readGenome(parentDir)) {
      fs.mkdirSync(path.dirname(path.join(to, file.path)), { recursive: true })
      fs.writeFileSync(path.join(to, file.path), file.text, 'utf8')
    }
    return true
  } catch (e) {
    log('app', 'warn', 'fork failed', { error: (e as Error).message }, 1)
    return false
  }
}

/** A TypeScript check of just the evolvable files, so a bad mutation is caught cheaply. */
async function typecheckGenome(dir: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = promisify(execFile)
    // `--noEmit` with the project's own tsconfig would pull in the whole app; a
    // targeted check of the three files catches the realistic failure (a broken
    // template literal or export) without needing a full build.
    // The generation folder deliberately has no node_modules — copying 400 MB
    // per generation would make the loop unusable — so the checker has to come
    // from the running app's own install.
    // `process.cwd()` is wherever the exe was launched from, which is not the
    // app folder in a packaged build; app.getAppPath() is.
    const tsc = path.join(app.getAppPath(), 'node_modules', 'typescript', 'bin', 'tsc')
    if (!fs.existsSync(tsc)) return { ok: false, error: 'the TypeScript compiler is missing from the app install' }
    await run(
      process.execPath,
      [
        tsc,
        '--noEmit',
        '--skipLibCheck',
        '--target',
        'es2022',
        '--module',
        'esnext',
        '--moduleResolution',
        'bundler',
        ...readGenome(dir).map((f) => path.join(dir, f.path))
      ],
      { cwd: dir, timeout: 120_000, windowsHide: true }
    )
    return { ok: true }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, error: `${err.stdout ?? ''}${err.stderr ?? err.message ?? ''}`.slice(0, 2000) }
  }
}

function baselineOf(store: EvolutionStore, parent: Generation): Baseline | null {
  if (!parent.metrics) return null
  return {
    classBytes: parent.metrics.classBytes,
    sourceBytes: parent.metrics.sourceBytes,
    buildMs: parent.metrics.buildMs,
    minHeapMb: parent.metrics.minHeapMb,
    errorCount: parent.metrics.errorCount
  }
}

/** Run `count` generations, stopping on error or a pause. */
export async function evolveMany(count: number, deps: LoopDeps): Promise<StepResult[]> {
  const out: StepResult[] = []
  for (let i = 0; i < count; i++) {
    if (deps.signal?.aborted) break
    const res = await evolveOnce(deps)
    out.push(res)
    if (!res.ok) break
  }
  return out
}

export { bestGeneration, loadStore, saveStore }
