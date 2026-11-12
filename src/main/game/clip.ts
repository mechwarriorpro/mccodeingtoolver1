import fs from 'node:fs'
import path from 'node:path'
import { userDataDir } from '../config'

/**
 * Gameplay clip capture.
 *
 * "Capture video" here means a timed sequence of frames from the game window,
 * not an encoded .mp4: there is no ffmpeg on a fresh Windows install, and
 * shipping a video encoder to grab 30 seconds of game footage would add ~80 MB
 * to an app whose whole point is being one .exe.
 *
 * Frames are what the analysis actually needs. Vision models reason about a
 * handful of stills far better than about a low-bitrate clip, and a frame
 * sequence can be inspected by the user afterwards, one picture at a time.
 * A clip is capped at 30 seconds by MAX_CLIP_MS and by the recorder itself, so
 * the cap holds even if a caller asks for longer.
 */

export const MAX_CLIP_MS = 30_000
export const MIN_CLIP_MS = 1_000
/** Frames per second, kept low: the model sees a sample, not a movie. */
export const DEFAULT_FPS = 2
/** Hard ceiling on frames stored for one clip (30 s at 4 fps). */
const MAX_FRAMES = 120

export interface ClipFrame {
  /** Absolute path of the PNG. */
  path: string
  /** Milliseconds from the start of the clip. */
  t: number
  /** Best-effort window title / label. */
  label?: string
}

export interface ClipRecord {
  id: string
  /** Where the frames live. */
  dir: string
  startedAt: number
  /** Actual duration, ms. Never above MAX_CLIP_MS. */
  durationMs: number
  fps: number
  frames: ClipFrame[]
  /** Why recording stopped: 'duration' | 'stopped' | 'error'. */
  ended: 'duration' | 'stopped' | 'error'
  error?: string
  /** The model's analysis, once it has been run. */
  analysis?: { at: number; model: string; text: string; frames: number }
  /** Optional note the user typed before capturing. */
  note?: string
}

export interface ClipStore {
  clips: ClipRecord[]
}

/** Clamp a requested duration into the allowed window. */
export function clampDuration(ms: number | undefined): number {
  if (!Number.isFinite(ms ?? NaN)) return 15_000
  return Math.min(MAX_CLIP_MS, Math.max(MIN_CLIP_MS, Math.round(ms as number)))
}

export function clampFps(fps: number | undefined): number {
  if (!Number.isFinite(fps ?? NaN)) return DEFAULT_FPS
  return Math.min(4, Math.max(1, Math.round(fps as number)))
}

/** How many frames a clip will contain, at or below MAX_FRAMES. */
export function frameCountFor(durationMs: number, fps: number): number {
  const requested = Math.ceil((durationMs / 1000) * fps)
  return Math.max(1, Math.min(MAX_FRAMES, requested))
}

/** Evenly spaced timestamps, used both for capture and for picking frames to analyse. */
export function frameTimes(durationMs: number, fps: number): number[] {
  const n = frameCountFor(durationMs, fps)
  const step = durationMs / n
  return Array.from({ length: n }, (_, i) => Math.round(i * step))
}

export function clipsRoot(): string {
  const dir = path.join(userDataDir(), 'clips')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function clipStoreFile(): string {
  return path.join(userDataDir(), 'clips.json')
}

export function loadClips(): ClipStore {
  try {
    const raw = JSON.parse(fs.readFileSync(clipStoreFile(), 'utf8')) as ClipStore
    return { clips: Array.isArray(raw?.clips) ? raw.clips : [] }
  } catch {
    return { clips: [] }
  }
}

function saveClips(store: ClipStore): void {
  fs.mkdirSync(path.dirname(clipStoreFile()), { recursive: true })
  fs.writeFileSync(clipStoreFile(), JSON.stringify(store, null, 2), 'utf8')
}

export function listClips(): ClipRecord[] {
  return loadClips()
    .clips.filter((c) => fs.existsSync(c.dir))
    .sort((a, b) => b.startedAt - a.startedAt)
}

export function getClip(id: string): ClipRecord | null {
  return loadClips().clips.find((c) => c.id === id) ?? null
}

export function saveClip(clip: ClipRecord): ClipRecord {
  const store = loadClips()
  const clips = [clip, ...store.clips.filter((c) => c.id !== clip.id)]
  // Keep the last 20 clips; frames are large and nobody needs a year of them.
  const kept = clips.slice(0, 20)
  saveClips({ clips: kept })
  return clip
}

export function deleteClip(id: string): ClipRecord[] {
  const store = loadClips()
  const clip = store.clips.find((c) => c.id === id)
  const rest = store.clips.filter((c) => c.id !== id)
  saveClips({ clips: rest })
  if (clip) {
    try {
      fs.rmSync(clip.dir, { recursive: true, force: true })
    } catch {
      /* locked frame stays behind; the record is gone either way */
    }
  }
  return listClips()
}

/** `2026-11-12T14-03-22` — sortable and Windows-safe (no colons). */
export function clipDirName(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-').replace('T', 'T').slice(0, 19)
}

/**
 * Which frames to send to the model for a clip: evenly spaced, first and last
 * always included, capped so a 30 s clip does not become a 60-image request.
 */
export function framesForAnalysis(frames: ClipFrame[], max = 12): ClipFrame[] {
  if (frames.length <= max) return [...frames]
  const picked: ClipFrame[] = []
  const step = (frames.length - 1) / (max - 1)
  for (let i = 0; i < max; i++) {
    const f = frames[Math.round(i * step)]
    if (f && !picked.includes(f)) picked.push(f)
  }
  return picked
}

/* ------------------------------------------------------------------- recorder */

interface RecorderState {
  id: string
  dir: string
  startedAt: number
  durationMs: number
  fps: number
  frames: ClipFrame[]
  timer: NodeJS.Timeout | null
  stopRequested: boolean
  finished: boolean
  note?: string
}

let active: RecorderState | null = null

export interface StartClipOptions {
  durationMs?: number
  fps?: number
  note?: string
  /** Injected by the IPC layer; returns a PNG buffer or null when capture fails. */
  grab: () => Promise<{ png: Buffer; label?: string } | null>
  /** Called as frames land, so the UI can show progress. */
  onFrame?: (frame: ClipFrame, index: number, total: number) => void
  onDone?: (clip: ClipRecord) => void
}

export function isRecording(): boolean {
  return !!active && !active.finished
}

/** Stop the clip that is running, keeping the frames captured so far. */
export function stopClip(): { ok: boolean; error?: string } {
  if (!active || active.finished) return { ok: false, error: 'No clip is being recorded.' }
  active.stopRequested = true
  return { ok: true }
}

/**
 * Capture frames for `durationMs` (clamped to 30 s). Resolves when the clip is
 * complete; frames are written as they arrive so a crash keeps what it got.
 */
export async function startClip(opts: StartClipOptions): Promise<ClipRecord> {
  if (isRecording()) throw new Error('A clip is already being recorded. Stop it first.')

  const durationMs = clampDuration(opts.durationMs)
  const fps = clampFps(opts.fps)
  const startedAt = Date.now()
  const dir = path.join(clipsRoot(), clipDirName(new Date(startedAt)))
  fs.mkdirSync(dir, { recursive: true })
  const id = path.basename(dir)

  const state: RecorderState = {
    id,
    dir,
    startedAt,
    durationMs,
    fps,
    frames: [],
    timer: null,
    stopRequested: false,
    finished: false,
    note: opts.note
  }
  active = state

  const times = frameTimes(durationMs, fps)
  const total = times.length
  const interval = Math.max(120, Math.round(1000 / fps))

  try {
    for (let i = 0; i < total; i++) {
      if (state.stopRequested) break
      const t = times[i]
      // Sleep until this frame's slot, unless we are already behind.
      const wait = startedAt + t - Date.now()
      if (wait > 0) await sleep(wait)
      if (state.stopRequested) break
      const shot = await opts.grab().catch(() => null)
      if (!shot?.png?.length) continue
      const file = path.join(dir, `frame-${String(i).padStart(3, '0')}.png`)
      fs.writeFileSync(file, shot.png)
      const frame: ClipFrame = { path: file, t: Date.now() - startedAt, label: shot.label }
      state.frames.push(frame)
      opts.onFrame?.(frame, state.frames.length, total)
      // Never exceed the cap, even if capture was slow to start.
      if (Date.now() - startedAt >= MAX_CLIP_MS) break
    }
  } catch (e) {
    state.finished = true
    active = null
    const failed: ClipRecord = {
      id,
      dir,
      startedAt,
      durationMs: Date.now() - startedAt,
      fps,
      frames: state.frames,
      ended: 'error',
      error: (e as Error).message,
      note: state.note
    }
    saveClip(failed)
    opts.onDone?.(failed)
    return failed
  }

  state.finished = true
  active = null
  const clip: ClipRecord = {
    id,
    dir,
    startedAt,
    durationMs: Math.min(MAX_CLIP_MS, Math.max(0, Date.now() - startedAt)),
    fps,
    frames: state.frames,
    ended: state.stopRequested ? 'stopped' : 'duration',
    note: state.note
  }
  saveClip(clip)
  opts.onDone?.(clip)
  if (interval <= 0) throw new Error('unreachable')
  return clip
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/* ------------------------------------------------------------------ analysis */

export interface AnalysisRequest {
  clip: ClipRecord
  /** What the user was testing, if they said. */
  goal?: string
  apiKey: string
  baseUrl?: string
  model?: string
  maxFrames?: number
}

export interface AnalysisResult {
  ok: boolean
  text?: string
  model?: string
  frames?: number
  error?: string
}

/** Default model for the vision pass; overridable from Settings. */
export const DEFAULT_VISION_MODEL = 'claude-sonnet-4-5-20250929'

/**
 * The instruction the model gets alongside the frames. Kept specific to the
 * domain: "analyse this video" invites a film review, which is useless here.
 * What the developer needs is "what happened, what broke, what should change".
 */
export function analysisPrompt(opts: { goal?: string; durationMs: number; frameTimes: number[]; fps: number }): string {
  const times = opts.frameTimes.map((t) => `${(t / 1000).toFixed(1)}s`).join(', ')
  return [
    `You are analysing a short Minecraft gameplay recording (${(opts.durationMs / 1000).toFixed(1)} seconds, captured at ${opts.fps} fps).`,
    `The images are frames ${times} into the clip, in order.`,
    opts.goal ? `\nThe developer was testing: ${opts.goal}\n` : '',
    'Report only what the frames actually show. If something is ambiguous, say what would be needed to tell. Use these headings:',
    '',
    '1. **What happened** — scene by scene, in order. Name the screens, GUIs, items, mobs or blocks you can see.',
    '2. **Problems** — missing textures (pink/black checkers), missing item names or raw translation keys like `item.modid.thing`,',
    '   invisible or mis-scaled models, chat errors, crash screens, wrong creative tab, items that fail to place, log warnings on screen.',
    '3. **For mod development** — the specific code or resource most likely responsible for each problem, named as precisely as',
    '   you can (e.g. "`assets/<modid>/textures/item/foo.png` is missing", "the item was registered without a `model` json",',
    '   "`FoodProperties` nutrition is set but no `Item.Properties#food` call was made"), plus the smallest fix worth trying next.',
    '4. **Next test** — one concrete thing the developer should capture next to confirm the fix.',
    '',
    'Do not describe ordinary gameplay as a bug. A mob walking around, or the sun moving, is not a problem.'
  ]
    .filter((line) => line !== undefined)
    .join('\n')
}

/** Real Claude Messages API call with the frames as image blocks. */
export async function analyseClip(req: AnalysisRequest): Promise<AnalysisResult> {
  const model = req.model || DEFAULT_VISION_MODEL
  const frames = framesForAnalysis(req.clip.frames, req.maxFrames ?? 12)
  if (!frames.length) return { ok: false, error: 'That clip has no frames to analyse.' }
  if (!req.apiKey) return { ok: false, error: 'Add an Anthropic API key in Settings first.' }

  const prompt = analysisPrompt({
    goal: req.goal ?? req.clip.note,
    durationMs: req.clip.durationMs,
    frameTimes: frames.map((f) => f.t),
    fps: req.clip.fps
  })

  const images = frames
    .map((f) => {
      try {
        const png = fs.readFileSync(f.path)
        // Guard the request size: a 4K frame is ~2-6 MB, and 12 of those blow past
        // any sane body limit. Frames are captured at the window size, so this is
        // a last-resort skip rather than the normal path.
        if (png.length > 3.5 * 1024 * 1024) return null
        return { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: png.toString('base64') } }
      } catch {
        return null
      }
    })
    .filter((x): x is NonNullable<typeof x> => !!x)

  if (!images.length) return { ok: false, error: 'Every frame was too large to send. Capture at a smaller window size.' }

  const base = (req.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '')
  try {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': req.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: 2000,
        messages: [
          {
            role: 'user',
            content: [...images, { type: 'text', text: prompt }]
          }
        ]
      })
    })
    if (!res.ok) {
      const body = await res.text()
      return { ok: false, error: translateAnalysisError(res.status, body) }
    }
    const json = (await res.json()) as { content?: { type: string; text?: string }[] }
    const text = (json.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n')
      .trim()
    if (!text) return { ok: false, error: 'The model returned no text for this clip.' }
    return { ok: true, text, model, frames: images.length }
  } catch (e) {
    const msg = (e as Error).message
    return { ok: false, error: /fetch failed|ENOTFOUND|ECONN/i.test(msg) ? 'Could not reach the Anthropic API. Check the connection and base URL.' : msg }
  }
}

/** Turn the API's error body into something a mod developer can act on. */
export function translateAnalysisError(status: number, body: string): string {
  if (status === 401) return 'The Anthropic API key was rejected. Check it in Settings.'
  if (status === 403) return 'This API key is not allowed to use that model.'
  if (status === 404) return 'The vision model was not found. Pick a different model in Settings.'
  if (status === 413) return 'The frames were too large to send. Capture at a smaller window size.'
  if (status === 429) return 'Rate limited by the Anthropic API. Try again in a minute.'
  if (status >= 500) return 'The Anthropic API had a server error. Try again.'
  const short = body.replace(/\s+/g, ' ').slice(0, 300)
  return `Vision analysis failed (HTTP ${status}): ${short}`
}

/** Persist an analysis onto its clip. */
export function attachAnalysis(id: string, analysis: { model: string; text: string; frames: number }): ClipRecord | null {
  const store = loadClips()
  let updated: ClipRecord | null = null
  const clips = store.clips.map((c) => {
    if (c.id !== id) return c
    updated = { ...c, analysis: { at: Date.now(), ...analysis } }
    return updated
  })
  if (updated) saveClips({ clips })
  return updated
}

/**
 * A compact text digest of a clip for the agent prompt. Text only: the agent
 * already has the frames as images when it calls the tool itself.
 */
export function clipDigest(clip: ClipRecord): string {
  const facts = [
    `Clip ${clip.id}: ${(clip.durationMs / 1000).toFixed(1)}s at ${clip.fps} fps, ${clip.frames.length} frames.`,
    clip.note ? `The developer was testing: ${clip.note}` : '',
    clip.analysis ? `Analysis (${clip.analysis.model}):\n${clip.analysis.text}` : 'Not analysed yet.'
  ]
  return facts.filter(Boolean).join('\n')
}
