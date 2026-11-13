import fs from 'node:fs'
import path from 'node:path'

/**
 * Three levels of diagnostic output.
 *
 * The levels are about *who the reader is*, not how much noise is acceptable:
 *
 * - `errors` — only things that went wrong. For someone who just wants the app
 *   to work.
 * - `verbose` — every step the agent takes: tool calls with their arguments,
 *   results, status changes, retries. For working out what it did.
 * - `trace` — the full transcript: raw SDK messages, provider responses, token
 *   counts, timings, and anything the model emitted that is not user-facing.
 *   For working out *why* it did it.
 *
 * Everything at `verbose` and above also goes to a rolling log file, because a
 * user reporting "it just said 0" needs to be able to hand over evidence after
 * the fact — the on-screen view is gone by then.
 */
export type DiagLevel = 0 | 1 | 2 | 3

export const LEVELS = ['off', 'errors', 'verbose', 'trace'] as const
export const MAX_LEVEL: DiagLevel = 3

export function levelName(level: DiagLevel): (typeof LEVELS)[number] {
  return LEVELS[level] ?? 'off'
}

export function parseLevel(value: unknown): DiagLevel {
  if (typeof value === 'number' && value >= 0 && value <= MAX_LEVEL) return value as DiagLevel
  if (typeof value === 'string') {
    const n = Number(value)
    if (!Number.isNaN(n) && n >= 0 && n <= MAX_LEVEL) return n as DiagLevel
    const idx = LEVELS.indexOf(value as (typeof LEVELS)[number])
    if (idx >= 0) return idx as DiagLevel
  }
  return 0
}

export type DiagSource =
  | 'agent'
  | 'sdk'
  | 'tool'
  | 'provider'
  | 'stream'
  | 'build'
  | 'game'
  | 'ipc'
  | 'app'

export interface DiagEntry {
  id: string
  at: number
  level: DiagLevel
  source: DiagSource
  label: string
  /** Structured payload: tool input, raw SDK message, error object. */
  detail?: unknown
  /** Extra fields for the UI to show inline without expanding. */
  note?: string
}

export interface DiagSink {
  /** Called for every entry the current level allows. */
  onEntry: (entry: DiagEntry) => void
  /** Where the rolling log lives, for the "open log" button. */
  logPath: () => string
}

let currentLevel: DiagLevel = 0
let sink: DiagSink | null = null
let seq = 0
/** Entries kept for the panel when it opens mid-session. */
const recent: DiagEntry[] = []
const RECENT_MAX = 3000

export function setDiagLevel(level: DiagLevel): void {
  currentLevel = level
  if (level > 0) log('app', 'info', `diagnostics at level ${level} (${levelName(level)})`, undefined, level)
}

export function getDiagLevel(): DiagLevel {
  return currentLevel
}

export function attachDiagSink(next: DiagSink | null): void {
  sink = next
}

export function diagHistory(): DiagEntry[] {
  return recent.slice()
}

export function clearDiagHistory(): void {
  recent.length = 0
}

/**
 * Record something.
 *
 * `level` is the minimum diagnostic level at which this is interesting: a build
 * failure is worth showing at `errors`, a tool call at `verbose`, a raw SSE
 * frame at `trace`. Anything below the current level is dropped entirely — that
 * is what keeps `trace` from filling the panel with noise when the user only
 * asked for `errors`.
 */
export function log(
  source: DiagSource,
  kind: 'info' | 'warn' | 'error' | 'debug' | 'raw',
  label: string,
  detail?: unknown,
  level: DiagLevel = kind === 'error' ? 1 : kind === 'warn' ? 1 : kind === 'raw' ? 3 : 2,
  note?: string
): void {
  if (currentLevel === 0 || level > currentLevel) return
  const entry: DiagEntry = {
    id: `d${++seq}-${Date.now().toString(36)}`,
    at: Date.now(),
    level,
    source,
    label,
    detail,
    note
  }
  recent.push(entry)
  if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX)
  try {
    sink?.onEntry(entry)
  } catch {
    /* a broken listener must not break the agent */
  }
  appendToFile(entry, kind)
}

/* ------------------------------------------------------------ the log file */

let filePath = ''
let fileBroken = false

export function setDiagLogPath(p: string): void {
  filePath = p
  fileBroken = false
}

export function diagLogPath(): string {
  return filePath
}

function appendToFile(entry: DiagEntry, kind: string): void {
  if (!filePath || fileBroken) return
  // The file is written for `verbose` and above whatever the current level is,
  // so that turning the level down does not mean losing the record of a run the
  // user is about to report. `errors`-only sessions still log their errors.
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const time = new Date(entry.at).toISOString()
    let body = `[${time}] ${kind.toUpperCase().padEnd(5)} ${entry.source.padEnd(8)} ${entry.label}`
    if (entry.note) body += ` (${entry.note})`
    if (entry.detail !== undefined) body += `\n    ${safeJson(entry.detail)}`
    fs.appendFileSync(filePath, `${body}\n`, 'utf8')
    rotateIfHuge()
  } catch {
    // A read-only profile or a locked file must not take the app down.
    fileBroken = true
  }
}

function rotateIfHuge(): void {
  try {
    const st = fs.statSync(filePath)
    if (st.size < 8 * 1024 * 1024) return
    const old = `${filePath}.1`
    fs.rmSync(old, { force: true })
    fs.renameSync(filePath, old)
  } catch {
    /* ignore */
  }
}

/** JSON with cycles, big buffers and errors rendered sanely. */
export function safeJson(value: unknown, max = 4000): string {
  const seen = new WeakSet<object>()
  try {
    const text = JSON.stringify(
      value,
      (_k, v) => {
        if (typeof v === 'bigint') return v.toString()
        if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack }
        if (v instanceof Uint8Array) return `<${v.length} bytes>`
        if (typeof v === 'object' && v !== null) {
          if (seen.has(v)) return '[circular]'
          seen.add(v)
        }
        return v
      },
      2
    )
    return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text
  } catch (e) {
    return `<unserialisable: ${(e as Error).message}>`
  }
}
