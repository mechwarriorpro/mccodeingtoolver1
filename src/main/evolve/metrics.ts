import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

/**
 * Measuring what a generation actually did.
 *
 * Evolution is only meaningful if the four rules can be checked against
 * something. A model claiming "this is 40% smaller" is worth nothing; a smaller
 * jar with fewer classes is worth a number. So every metric here comes from a
 * file that exists, not from the model's own description of its work.
 *
 * What can be measured honestly:
 *
 *  - **quality** — does it compile, and does the build produce a jar. This is a
 *    floor, not a ceiling: compiling is not the same as working, which is why
 *    `verify` exists as an optional extra step rather than a claim.
 *  - **size** — bytes of compiled classes and of source.
 *  - **ram** — the peak heap the JVM needs to build it (`javac -J-Xmx` probing),
 *    which is a real, reproducible proxy for how heavy the code is to work on.
 *  - **speed** — how long that build took.
 *
 * What cannot be measured here, and is not invented: runtime RAM inside the game,
 * FPS, or whether the mod is fun. Those need a launched game session, and a
 * number guessed for them would poison every generation after it.
 */

export interface Metrics {
  /** Compiled successfully and produced a jar. */
  builds: boolean
  /** Compiler errors on the final attempt. */
  errorCount: number
  /** Bytes of .class files (0 when the build failed). */
  classBytes: number
  classCount: number
  /** Bytes of .java files. */
  sourceBytes: number
  sourceFiles: number
  /** Wall-clock milliseconds for the build. */
  buildMs: number
  /** The smallest JVM heap (MB) that still compiled it. */
  minHeapMb: number | null
  /** Where these numbers came from, so a bad generation can be explained. */
  note: string
}

export interface Rules {
  /** 0-100 weights. They are normalized, so they need not sum to 100. */
  quality: number
  speed: number
  size: number
  ram: number
}

export const DEFAULT_RULES: Rules = { quality: 70, speed: 10, size: 10, ram: 10 }

/**
 * Instructions derived from the weights.
 *
 * The weights have to become *words*, because a model cannot optimize for a
 * number it never sees. Two things make this more than a template: the highest
 * weight produces an explicit priority, and any weight set to zero produces an
 * explicit permission to trade it away — otherwise every model optimizes
 * everything a little and nothing much.
 */
export function rulesToInstructions(rules: Rules, limits: { maxHeapMb?: number | null; targetHeapMb?: number | null } = {}): string {
  const total = rules.quality + rules.speed + rules.size + rules.ram || 1
  const pct = (n: number): number => Math.round((n / total) * 100)
  const ranked = [
    { key: 'quality', label: 'Quality of code', value: pct(rules.quality) },
    { key: 'speed', label: 'Speed to build', value: pct(rules.speed) },
    { key: 'size', label: 'Size of the result', value: pct(rules.size) },
    { key: 'ram', label: 'RAM used', value: pct(rules.ram) }
  ].sort((a, b) => b.value - a.value)

  const [first, ...rest] = ranked
  const lines: string[] = []
  lines.push(`Your priorities, in order (weights as percentages):`)
  for (const r of ranked) lines.push(`- ${r.label}: ${r.value}%`)
  lines.push('')
  lines.push(
    `**${first.label} is the priority.** Optimise it first; the others are tie-breakers unless improving one is free. ` +
      `A change that improves ${first.label.toLowerCase()} at the cost of ${rest.map((r) => r.label.toLowerCase()).join(' or ')} is a good change.`
  )

  const traded = ranked.filter((r) => r.value === 0)
  if (traded.length) {
    lines.push(
      `You may sacrifice ${traded.map((r) => r.label.toLowerCase()).join(' and ')} freely — they are weighted at zero for this generation.`
    )
  }

  const best = ranked.reduce((a, b) => (a.value >= b.value ? a : b))
  if (best.key === 'ram') {
    lines.push(
      `Keep it **light to compile and run**: fewer classes, less static initialisation, no data structures built at class-load time, ` +
        `avoid generated combinatorics, and prefer loops over large in-memory tables.`
    )
  }
  if (best.key === 'size') {
    lines.push(
      `Keep it **small**: no dead code, no unused imports or assets, no duplicate helpers, and do not add a dependency where twenty lines will do.`
    )
  }
  if (best.key === 'speed') {
    lines.push(
      `Keep it **fast to build and run**: avoid heavy annotation processing, watch out for codegen that costs compile time, and keep the hot path free of reflection.`
    )
  }
  if (best.key === 'quality') {
    lines.push(
      `Keep it **correct and readable**: small focused classes, no clever tricks, and comment only where the reason is not obvious.`
    )
  }

  if (limits.maxHeapMb) {
    lines.push(
      ``
    )
    lines.push(
      `The machine building this has at most **${limits.maxHeapMb} MB** for the JVM. Do not write code that needs more than that to compile.`
    )
  }
  if (limits.targetHeapMb) {
    lines.push(`The goal is to compile within **${limits.targetHeapMb} MB**.`)
  }
  return lines.join('\n')
}

/* ------------------------------------------------------------------ the jar */

/**
 * Bytes and class count from a jar, read directly — no JVM needed.
 *
 * This is the size metric, and it is deliberately measured on the *compiled*
 * output rather than the source: a generation that replaces three clever classes
 * with one is smaller, and counting source lines would have called that a
 * regression.
 */
export function measureJar(jarPath: string): { classBytes: number; classCount: number } {
  try {
    const buf = fs.readFileSync(jarPath)
    // Minimal central-directory walk: entries are 46 bytes plus name, extra and
    // comment lengths. Enough to sum .class sizes without a zip dependency here.
    let classBytes = 0
    let classCount = 0
    let offset = 0
    const sig = Buffer.from([0x50, 0x4b, 0x01, 0x02]) // PK\x01\x02
    while ((offset = buf.indexOf(sig, offset)) !== -1) {
      try {
        const compressed = buf.readUInt32LE(offset + 20)
        const nameLen = buf.readUInt16LE(offset + 28)
        const extraLen = buf.readUInt16LE(offset + 30)
        const commentLen = buf.readUInt16LE(offset + 32)
        const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8')
        if (name.endsWith('.class')) {
          classCount++
          classBytes += compressed
        }
        offset += 46 + nameLen + extraLen + commentLen
      } catch {
        break
      }
    }
    return { classBytes, classCount }
  } catch {
    return { classBytes: 0, classCount: 0 }
  }
}

/** Bytes and file count of the Java sources, which catches growth before a build does. */
export function measureSources(dir: string): { sourceBytes: number; sourceFiles: number } {
  let sourceBytes = 0
  let sourceFiles = 0
  const walk = (rel: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name === 'build' || e.name === '.gradle' || e.name === '.git') continue
      const childRel = rel ? path.join(rel, e.name) : e.name
      if (e.isDirectory()) walk(childRel)
      else if (/\.(java|kt|scala)$/.test(e.name)) {
        sourceFiles++
        try {
          sourceBytes += fs.statSync(path.join(dir, childRel)).size
        } catch {
          /* vanished mid-walk */
        }
      }
    }
  }
  walk('')
  return { sourceBytes, sourceFiles }
}

/* -------------------------------------------------------------- the heap probe */

/**
 * The smallest heap the build survives on.
 *
 * `javac` is run with a deliberately small `-J-Xmx`; if it dies of
 * OutOfMemoryError the heap was too small and the next step doubles it. Several
 * steps give a real floor, which is the number a "use less RAM" rule can improve
 * over generations. This is the only honest RAM signal available without running
 * the game — and it is labelled as compile-time heap, not gameplay RAM, because
 * claiming otherwise would make the metric a lie.
 */
export function probeMinHeap(opts: {
  workspaceDir: string
  javaPath?: string
  sources: string[]
  classpath?: string
  steps?: number
  signal?: AbortSignal
}): { minHeapMb: number | null; note: string } {
  if (!opts.javaPath || !opts.sources.length) return { minHeapMb: null, note: 'no javac to probe with' }
  const steps = opts.steps ?? 5
  let mb = 128
  for (let i = 0; i < steps; i++) {
    if (opts.signal?.aborted) return { minHeapMb: null, note: 'cancelled' }
    try {
      execFileSync(
        opts.javaPath,
        [
          `-J-Xmx${mb}m`,
          '-d',
          path.join(opts.workspaceDir, 'build', 'probe'),
          ...(opts.classpath ? ['-cp', opts.classpath] : []),
          ...opts.sources.slice(0, 200)
        ],
        { cwd: opts.workspaceDir, stdio: 'pipe', timeout: 120_000, windowsHide: true }
      )
      return { minHeapMb: mb, note: `compiled with a ${mb} MB heap` }
    } catch (e) {
      const text = `${(e as { stderr?: Buffer }).stderr?.toString() ?? ''}${(e as Error).message}`
      if (/OutOfMemoryError|GC overhead limit/i.test(text)) {
        mb *= 2
        continue
      }
      // A compile error is not a heap result: the jar came from a successful
      // build, so this probe's inputs are wrong, and saying so beats a number.
      return { minHeapMb: null, note: 'probe compile failed for a reason other than memory' }
    }
  }
  return { minHeapMb: null, note: `needed more than ${mb} MB` }
}

/* ------------------------------------------------------------------- scoring */

export interface Baseline {
  classBytes: number
  sourceBytes: number
  buildMs: number
  minHeapMb: number | null
  errorCount: number
}

/**
 * A single number for a generation, so "better" is not an opinion.
 *
 * Each rule is scored against the parent's baseline: 1.0 means no change, 1.2
 * means 20% better. Quality is the odd one out — it is a pass/fail floor plus an
 * error penalty, because "40% fewer compiler errors" is not a thing anyone wants
 * to optimize towards. A generation that does not compile cannot score well no
 * matter how small it is, which is the one weighting that is not configurable.
 */
export function scoreGeneration(metrics: Metrics, baseline: Baseline | null, rules: Rules): { score: number; parts: Record<string, number>; note: string } {
  const total = rules.quality + rules.speed + rules.size + rules.ram || 1
  const w = (n: number): number => n / total

  // Quality: compile or fail. 1.0 for a clean build, scaled down per error.
  const quality = metrics.builds ? Math.max(0, 1 - Math.min(metrics.errorCount, 10) / 20) : 0

  if (!baseline) {
    return {
      score: quality,
      parts: { quality, speed: 1, size: 1, ram: 1 },
      note: 'first generation — nothing to compare against, so only quality counts'
    }
  }

  // Speed and size: ratio against the parent, capped so one freak result cannot
  // dominate (a build that happens to be 90% faster is not 90% better code).
  const ratio = (now: number, before: number): number => {
    if (!before || !now) return 1
    const r = before / now
    return Math.max(0.5, Math.min(1.5, r))
  }
  const speed = ratio(metrics.buildMs, baseline.buildMs)
  const sizeNow = metrics.classBytes + metrics.sourceBytes
  const sizeBefore = baseline.classBytes + baseline.sourceBytes
  const size = ratio(sizeNow, sizeBefore)
  // RAM only scores when both sides have a real number, so an unprobeable
  // generation does not get a free 1.0 that looks like an improvement.
  const ram =
    metrics.minHeapMb && baseline.minHeapMb ? Math.max(0.5, Math.min(1.5, baseline.minHeapMb / metrics.minHeapMb)) : 1

  const weighted = quality * w(rules.quality) + speed * w(rules.speed) + size * w(rules.size) + ram * w(rules.ram)

  // A generation that does not compile is not a candidate at all. Without this
  // gate a broken mutation that happens to be tiny and fast scored 0.4 — and a
  // user who set size and speed high would have watched the loop evolve towards
  // code that does not build, which is the exact failure this loop must never
  // have. Quality is the one weight that is not negotiable.
  const score = metrics.builds ? weighted : 0
  return {
    score: Math.round(score * 1000) / 1000,
    parts: { quality, speed, size, ram },
    note: metrics.builds ? 'compiled' : 'did not compile'
  }
}
