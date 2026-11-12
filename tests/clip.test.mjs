/**
 * Gameplay-clip logic tests.
 *
 * The recorder needs Electron's desktopCapturer and the analysis needs network
 * and an API key, so neither is exercised here. What *is* tested is the part that
 * decides how long a clip may be, how many frames it gets, which frames are sent
 * to the model, and how API failures are explained — all pure functions, and all
 * of them places where an off-by-one would show up as a 40-second clip or a 60-image
 * request.
 */
import { check, section, finish } from './helpers.mjs'

process.on('uncaughtException', (err) => {
  const msg = `${err && err.stack ? err.stack : err}`.replace(/%/g, '%25').replace(/\r?\n/g, ' | ').slice(0, 600)
  console.log(`::error title=clip.test.mjs crash::${msg}`)
  process.exit(1)
})

const clips = await import('../out-test/main/game/clip.js')

section('the 30 second cap is enforced, not requested')
check('30 s is allowed', clips.clampDuration(30_000) === 30_000)
check('a longer request is cut to 30 s', clips.clampDuration(120_000) === clips.MAX_CLIP_MS)
check('exactly one frame over the cap is cut', clips.clampDuration(clips.MAX_CLIP_MS + 1) === clips.MAX_CLIP_MS)
check('a tiny request is raised to 1 s', clips.clampDuration(10) === clips.MIN_CLIP_MS)
check('undefined means a sensible default', clips.clampDuration(undefined) === 15_000)
check('NaN does not produce a zero-second clip', clips.clampDuration(Number.NaN) > 0)
check('the cap constant is 30 000 ms', clips.MAX_CLIP_MS === 30_000)

section('frame scheduling never overruns the clip')
const times = clips.frameTimes(30_000, 2)
check('30 s at 2 fps is 60 frames', times.length === 60, `got ${times.length}`)
check('first frame is at zero', times[0] === 0)
check('last frame is before the cap', times[times.length - 1] < 30_000, `got ${times[times.length - 1]}`)
check('timestamps only increase', times.every((t, i) => i === 0 || t > times[i - 1]))
check('a 30 s clip at 4 fps stays under the frame ceiling', clips.frameCountFor(30_000, 4) <= 120)
check('at least one frame is always produced', clips.frameCountFor(1_000, 1) >= 1)

section('fps is clamped to something the recorder can keep up with')
check('0 fps becomes 1', clips.clampFps(0) === 1)
check('60 fps becomes 4', clips.clampFps(60) === 4)
check('undefined becomes the default', clips.clampFps(undefined) === clips.DEFAULT_FPS)

section('which frames the model sees')
const frames = Array.from({ length: 60 }, (_, i) => ({ path: `/tmp/f${i}.png`, t: i * 500 }))
const picked = clips.framesForAnalysis(frames, 12)
check('a long clip is sampled down', picked.length === 12, `got ${picked.length}`)
check('sampling keeps the first frame', picked[0] === frames[0])
check('sampling keeps the last frame', picked[picked.length - 1] === frames[frames.length - 1])
check('sampling does not duplicate frames', new Set(picked.map((f) => f.t)).size === picked.length)
check('sampling preserves order', picked.every((f, i) => i === 0 || f.t > picked[i - 1].t))
check('a short clip is sent whole', clips.framesForAnalysis(frames.slice(0, 5), 12).length === 5)

section('the analysis prompt says what this video is')
const prompt = clips.analysisPrompt({ goal: 'check the ruby sword swing', durationMs: 30_000, frameTimes: [0, 500, 1000], fps: 2 })
check('it states the clip length', prompt.includes('30.0 seconds'))
check('it names the frames', prompt.includes('0.0s') && prompt.includes('1.0s'))
check(
  'it asks for Minecraft-specific problems',
  /pink|missing texture/i.test(prompt) && /translation key|lang/i.test(prompt)
)
check('it includes the developer goal', prompt.includes('ruby sword swing'))
check('it asks where in the code to fix', /code or resource/i.test(prompt))
check('it warns against calling ordinary gameplay a bug', /not a problem/i.test(prompt))

section('API failures are explained in the user’s terms')
check('401 mentions the key', /key/i.test(clips.translateAnalysisError(401, 'unauthorized')))
check('429 mentions rate limiting', /rate limit/i.test(clips.translateAnalysisError(429, '')))
check('413 mentions the frame size', /too large|smaller/i.test(clips.translateAnalysisError(413, '')))
check('500 says to retry', /try again/i.test(clips.translateAnalysisError(500, '')))
check(
  'an unknown status keeps the body but shortens it',
  clips.translateAnalysisError(418, 'x'.repeat(2000)).length < 500
)

section('a digest is readable without the images')
const digest = clips.clipDigest({
  id: 'clip-1',
  dir: '/tmp/c',
  startedAt: 0,
  durationMs: 12_000,
  fps: 2,
  frames: [],
  ended: 'duration',
  note: 'test the furnace GUI',
  analysis: { at: 1, model: 'vision-model', text: 'Block sprite is pink.' }
})
check('it names the duration', digest.includes('12.0s'))
check('it carries the note', digest.includes('test the furnace GUI'))
check('it carries the analysis', digest.includes('Block sprite is pink'))
check('an unanalysed clip says so', clips.clipDigest({ id: 'x', dir: '', startedAt: 0, durationMs: 1000, fps: 2, frames: [], ended: 'duration' }).includes('Not analysed'))

finish('gameplay clips')
