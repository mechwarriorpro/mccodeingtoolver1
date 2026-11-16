import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { app } from 'electron'
import { log } from '../diag'
import { GENOME_FILES, readGenome } from './genome'

const run = promisify(execFile)

/**
 * Loading a candidate's prompt as *code*, not as text.
 *
 * The obvious shortcut would be to regex the mutated `prompt.ts` and pull out a
 * template string. That would test a string that never runs: the real prompt is
 * assembled by a function with the project's loader, version, lessons and
 * autonomy mode baked in. A mutation that reorders that logic, adds a conditional
 * section, or changes how lessons are injected would be invisible to a regex and
 * would score as if it had not happened.
 *
 * So the candidate is compiled and imported. If it will not compile, it is not a
 * candidate — which is also the cheapest possible guard against a mutation that
 * would break the app.
 */

interface CacheEntry {
  key: string
  outDir: string
  /** The module's buildSystemPrompt, once loaded. */
  build?: (opts: Record<string, unknown>) => string
}

const cache = new Map<string, CacheEntry>()

function cacheKey(dir: string): string {
  return readGenome(dir)
    .map((f) => `${f.path}:${f.text.length}:${f.text.slice(0, 64)}`)
    .join('|')
}

/** Compile the candidate's src to JS in a folder beside it. */
async function compileCandidate(dir: string): Promise<{ ok: boolean; outDir: string; error?: string }> {
  const outDir = path.join(dir, '.agent-build')
  // Same rule as the loop's typecheck: the app's own toolchain, because a
  // generation folder has no node_modules of its own.
  const tscPath = path.join(app.getAppPath(), 'node_modules', 'typescript', 'bin', 'tsc')
  if (!fs.existsSync(tscPath)) return { ok: false, outDir, error: 'the TypeScript compiler is missing from the app install' }
  try {
    fs.rmSync(outDir, { recursive: true, force: true })
    await run(
      process.execPath,
      [
        tscPath,
        '--target',
        'es2022',
        '--module',
        'esnext',
        '--moduleResolution',
        'bundler',
        '--skipLibCheck',
        '--rootDir',
        path.join(dir, 'src'),
        '--outDir',
        outDir,
        ...GENOME_FILES.map((f) => path.join(dir, f))
      ],
      { cwd: dir, timeout: 180_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
    )
    return { ok: true, outDir }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, outDir, error: `${err.stdout ?? ''}${err.stderr ?? err.message ?? ''}`.slice(0, 2000) }
  }
}

/**
 * The system-prompt text a candidate would actually produce.
 *
 * Compiled once per genome version and reused: an evaluation asks the candidate
 * several times, and recompiling for each would dominate the runtime.
 */
export async function candidatePrompt(dir: string): Promise<string | undefined> {
  const key = cacheKey(dir)
  let entry = cache.get(dir)
  if (!entry || entry.key !== key) {
    const compiled = await compileCandidate(dir)
    if (!compiled.ok) {
      log('app', 'warn', 'candidate did not compile; no prompt to test', { dir, error: compiled.error }, 1)
      return undefined
    }
    entry = { key, outDir: compiled.outDir }
    cache.set(dir, entry)
  }
  if (entry.build) return entry.build({})

  const modulePath = path.join(entry.outDir, 'main', 'agent', 'prompt.js')
  if (!fs.existsSync(modulePath)) return undefined
  try {
    const mod = (await import(pathToFileURL(modulePath).href)) as { buildSystemPrompt?: (opts: Record<string, unknown>) => string }
    if (typeof mod.buildSystemPrompt !== 'function') return undefined
    entry.build = mod.buildSystemPrompt
    // A minimal but valid option set: enough for the template to render, and
    // the same shape every candidate gets, so the comparison is fair.
    return entry.build({
      references: [],
      githubSignedIn: false,
      modId: 'evolve_test',
      workspaceDir: dir,
      autonomy: 'review',
      loader: 'neoforge',
      mcVersion: '1.21.1'
    })
  } catch (e) {
    log('app', 'warn', 'could not import a candidate prompt', { dir, error: (e as Error).message }, 1)
    return undefined
  }
}

/** Drop a candidate's compiled output, for when its generation is retired. */
export function forgetCandidate(dir: string): void {
  cache.delete(dir)
  try {
    fs.rmSync(path.join(dir, '.agent-build'), { recursive: true, force: true })
  } catch {
    /* the folder may be gone already */
  }
}
