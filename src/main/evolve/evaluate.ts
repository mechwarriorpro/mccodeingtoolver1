import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { log } from '../diag'
import { measureJar, measureSources, probeMinHeap, scoreGeneration, type Baseline, type Metrics, type Rules } from './metrics'

const run = promisify(execFile)

/**
 * Testing a genome without letting it near the real app.
 *
 * The honest way to find out whether a mutated agent writes better code is to
 * make it write code and then compile that code. So each evaluation runs a
 * **fixed task** — the same one for every generation, which is what makes the
 * scores comparable — with the mutated prompt, then builds whatever it produced.
 *
 * Two things make this safe:
 *
 *  - the task runs in a throwaway project, never in the user's mod;
 *  - the agent under test is *not* given tools. It produces files, the evaluator
 *    writes them, and the compiler is the judge. A mutated prompt cannot reach
 *    the real workspace, run a command, or delete anything.
 */

export interface EvalTask {
  id: string
  /** One line the UI shows. */
  title: string
  /** The prompt sent to the agent under test. */
  prompt: string
  /** Files that must exist for the result to count as an attempt. */
  expects: string[]
}

/**
 * The default task.
 *
 * Chosen because it is small enough to run in a minute on a local model, and
 * because it has a *compiler-checkable* answer: a NeoForge 1.21.1 item
 * registration. A prompt that produces code which does not compile — wrong
 * import, missing annotation, old API — scores zero on quality without anyone
 * having to judge taste.
 */
export const DEFAULT_TASK: EvalTask = {
  id: 'item-registration',
  title: 'Register two items and a creative tab (NeoForge 1.21.1)',
  prompt: [
    'Write the Java source for a NeoForge 1.21.1 mod with mod id `evolve_test`.',
    '',
    'It must contain exactly one file, `src/main/java/com/evolve/test/EvolveTest.java`, with:',
    '- a `@Mod("evolve_test")` class that registers two items (`ruby`, `raw_ruby`) with `DeferredRegister.Items`,',
    '- one creative tab that contains both items,',
    '- correct imports for NeoForge 1.21.1.',
    '',
    'Reply with the file content in one fenced ```java block and nothing else. Do not explain.'
  ].join('\n'),
  expects: ['src/main/java/com/evolve/test/EvolveTest.java']
}

export interface EvalResult {
  ok: boolean
  error?: string
  metrics: Metrics
  score: number
  parts: Record<string, number>
  note: string
  /** What the agent actually produced, so a bad generation can be read. */
  artifactPath?: string
}

/** Pull the first fenced java block out of a reply. */
export function extractJava(text: string): string | null {
  const fenced = text.match(/```(?:java)?\s*\n([\s\S]*?)```/i)
  if (fenced) return fenced[1].trim() + '\n'
  // Some models answer with the code and no fence; take the first `package`.
  const idx = text.indexOf('package ')
  if (idx !== -1) return text.slice(idx).trim() + '\n'
  return null
}

/**
 * Compile a NeoForge 1.21.1 source against the real Minecraft/NeoForge jars.
 *
 * The classpath comes from the app's own dev workspace, which already has them
 * after any local build. When it is missing, the probe says so instead of
 * pretending the code was fine — an unverifiable generation is not a win, and
 * silently scoring it 1.0 would corrupt the whole lineage.
 */
export async function compileJava(opts: {
  workDir: string
  sources: string[]
  classpath?: string
  javaPath?: string
  timeoutMs?: number
}): Promise<{ ok: boolean; errorCount: number; errors: string[]; ms: number }> {
  const started = Date.now()
  const javac = opts.javaPath
  if (!javac) return { ok: false, errorCount: 1, errors: ['no javac available to verify the result'], ms: 0 }
  const out = path.join(opts.workDir, 'build', 'classes')
  fs.mkdirSync(out, { recursive: true })
  try {
    await run(javac, ['-d', out, ...(opts.classpath ? ['-cp', opts.classpath] : []), ...opts.sources], {
      cwd: opts.workDir,
      timeout: opts.timeoutMs ?? 120_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    })
    return { ok: true, errorCount: 0, errors: [], ms: Date.now() - started }
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message?: string }
    const text = `${err.stderr ?? ''}${err.stdout ?? ''}${err.message ?? ''}`
    const errors = text
      .split(/\r?\n/)
      .filter((l) => /error:/.test(l))
      .slice(0, 20)
    return { ok: false, errorCount: Math.max(1, errors.length), errors, ms: Date.now() - started }
  }
}

/**
 * Score one generation's behaviour.
 *
 * `ask` runs the agent under test with a prompt and returns its text. Passing it
 * in rather than importing the engine keeps this testable without a provider,
 * and keeps the evaluator free of the code it is evaluating.
 */
export async function evaluateGenome(opts: {
  ask: (prompt: string) => Promise<string>
  workDir: string
  baseline: Baseline | null
  rules: Rules
  task?: EvalTask
  classpath?: string
  javaPath?: string
  maxHeapMb?: number | null
  signal?: AbortSignal
}): Promise<EvalResult> {
  const task = opts.task ?? DEFAULT_TASK
  const started = Date.now()
  fs.mkdirSync(opts.workDir, { recursive: true })

  let reply = ''
  try {
    reply = await opts.ask(task.prompt)
  } catch (e) {
    return {
      ok: false,
      error: `the agent under test failed to answer: ${(e as Error).message}`,
      metrics: emptyMetrics(Date.now() - started),
      score: 0,
      parts: { quality: 0, speed: 0, size: 0, ram: 0 },
      note: 'no answer'
    }
  }

  const code = extractJava(reply)
  if (!code) {
    return {
      ok: false,
      error: 'the reply contained no Java code block',
      metrics: emptyMetrics(Date.now() - started),
      score: 0,
      parts: { quality: 0, speed: 0, size: 0, ram: 0 },
      note: 'unusable answer'
    }
  }

  const target = path.join(opts.workDir, task.expects[0])
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, code, 'utf8')

  // A generation could emit something enormous; measure it before compiling.
  const src = measureSources(opts.workDir)
  if (src.sourceBytes > 2_000_000) {
    return {
      ok: false,
      error: 'the answer was implausibly large',
      metrics: emptyMetrics(Date.now() - started),
      score: 0,
      parts: { quality: 0, speed: 0, size: 0, ram: 0 },
      note: 'rejected: size'
    }
  }

  const compiled = await compileJava({
    workDir: opts.workDir,
    sources: [target],
    classpath: opts.classpath,
    javaPath: opts.javaPath,
    timeoutMs: 120_000
  })

  const classes = path.join(opts.workDir, 'build', 'classes')
  const jarLike = measureJarDir(classes)
  const heap = compiled.ok
    ? probeMinHeap({ workspaceDir: opts.workDir, javaPath: opts.javaPath, sources: [target], classpath: opts.classpath })
    : { minHeapMb: null, note: 'not compiled' }

  const metrics: Metrics = {
    builds: compiled.ok,
    errorCount: compiled.errorCount,
    classBytes: jarLike.classBytes,
    classCount: jarLike.classCount,
    sourceBytes: src.sourceBytes,
    sourceFiles: src.sourceFiles,
    buildMs: Date.now() - started,
    minHeapMb: heap.minHeapMb,
    note: [compiled.ok ? 'compiled' : 'compile failed', heap.note].filter(Boolean).join('; ')
  }
  // Warn rather than silently scoring an unverifiable result as good.
  const capped = opts.maxHeapMb && metrics.minHeapMb && metrics.minHeapMb > opts.maxHeapMb
  if (capped) metrics.builds = false

  const scored = scoreGeneration(metrics, opts.baseline, opts.rules)
  log('app', 'info', 'evaluated a generation', { metrics, ...scored, task: task.id }, 2)
  return { ok: compiled.ok, metrics, score: scored.score, parts: scored.parts, note: scored.note, artifactPath: target }
}

function emptyMetrics(ms: number): Metrics {
  return {
    builds: false,
    errorCount: 1,
    classBytes: 0,
    classCount: 0,
    sourceBytes: 0,
    sourceFiles: 0,
    buildMs: ms,
    minHeapMb: null,
    note: 'not evaluated'
  }
}

/** Class sizes from a directory of .class files, matching `measureJar`'s meaning. */
function measureJarDir(dir: string): { classBytes: number; classCount: number } {
  let classBytes = 0
  let classCount = 0
  const walk = (rel: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const childRel = rel ? path.join(rel, e.name) : e.name
      if (e.isDirectory()) walk(childRel)
      else if (e.name.endsWith('.class')) {
        classCount++
        try {
          classBytes += fs.statSync(path.join(dir, childRel)).size
        } catch {
          /* ignore */
        }
      }
    }
  }
  walk('')
  return { classBytes, classCount }
}

export { measureJar, measureSources }
