import fs from 'node:fs'
import path from 'node:path'
import { assetLayout } from './assets'

/**
 * 3D models and animations.
 *
 * Minecraft's model format is JSON, and every resource pack and mod uses the
 * same one: Bedrock-style geometry (`format_version`, `minecraft:geometry`) for
 * entity models, and a block/item model for the older `models/block` files.
 * Both are structured data where a wrong field is a silent invisible model — no
 * error, no log line, just nothing on screen. So this generates them from
 * dimensions rather than asking a model to type coordinates, and validates the
 * result before it is written.
 *
 * What is genuinely hard here — and what no generator can do — is *looking
 * right*. A cube is a cube; a dragon is an arrangement of 40 bones that reads
 * as a dragon from the side. This produces structurally valid starting points
 * that launch, and the agent (or the user in Blockbench) does the art.
 */

export type ModelKind = 'block' | 'item' | 'entity'

export interface Box {
  /** Origin of the box, in model pixels (16 = one block). */
  origin: [number, number, number]
  size: [number, number, number]
  /** Pivot for the rotation. */
  pivot?: [number, number, number]
  /** Degrees, applied X then Y then Z. */
  rotation?: [number, number, number]
  /** Texture UV origin per face, when it matters. */
  uv?: [number, number] | Record<string, [number, number]>
  /** Per-box inflate, used by armour and layered skins. */
  inflate?: number
  name?: string
}

/* ------------------------------------------------------------ block models */

export interface BlockModelOptions {
  /** Parent to inherit from, e.g. 'minecraft:block/cube_all'. */
  parent?: string
  /** A single texture used for every face. */
  all?: string
  /** Per-face textures, overriding `all`. */
  textures?: Record<string, string>
  /** Elements, for a non-cube model. */
  elements?: Box[]
  /** Render type for translucent blocks. */
  renderType?: 'translucent' | 'cutout' | 'cutout_mipped'
}

/**
 * A block or item model.
 *
 * The default (`cube_all`) is what 95% of blocks want, and writing it by hand is
 * where most "my block is a purple checkerboard" bugs come from: the texture
 * reference has to be `modid:block/name`, and the file has to sit under
 * `assets/<modid>/models/block/`.
 */
export function blockModelJson(opts: BlockModelOptions): string {
  const model: Record<string, unknown> = {}
  if (opts.parent) model.parent = opts.parent
  if (opts.renderType) model.renderType = opts.renderType
  const textures: Record<string, string> = { ...(opts.textures ?? {}) }
  // Define `all` itself. Vanilla's cube/cube_all parents reference `#all` in
  // their face list, so writing down/up/north/... without an `all` key leaves
  // `#all` unresolved and the block renders as the missing-texture checkerboard
  // — with no error anywhere.
  if (opts.all) {
    textures.all ??= opts.all
    textures.particle ??= opts.all
  }
  if (Object.keys(textures).length) model.textures = textures
  if (opts.elements?.length) model.elements = opts.elements.map(elementJson)
  return JSON.stringify(model, null, 2) + '\n'
}

function elementJson(box: Box): Record<string, unknown> {
  const el: Record<string, unknown> = {
    from: box.origin,
    to: [box.origin[0] + box.size[0], box.origin[1] + box.size[1], box.origin[2] + box.size[2]]
  }
  if (box.rotation && box.rotation.some((r) => r !== 0)) {
    el.rotation = { origin: box.pivot ?? [8, 8, 8], angle: box.rotation, axis: dominantAxis(box.rotation) }
  }
  if (box.inflate) el.inflate = box.inflate
  if (box.name) el.name = box.name
  const faces = Object.fromEntries(
    ['north', 'east', 'south', 'west', 'up', 'down'].map((f) => [f, { uv: faceUv(box, f), texture: '#all' }])
  )
  el.faces = faces
  return el
}

/**
 * The UV rectangle for one face of a block element.
 *
 * Two shapes are legal and they are not interchangeable: a nested `uv` is
 * `[u1, v1, u2, v2]` — a *rectangle* — while the old flat form is a single
 * `[u, v]` origin with the size implied. Writing two numbers where four are
 * expected produces a zero-area face: the block is there, it has a texture, and
 * nothing is drawn.
 *
 * So the default is always a rectangle of the right size for the face. A user
 * supplying `uv: {north: [u, v]}` means "start the texture here", and they get
 * the face-sized rectangle from that point; four numbers are passed through
 * untouched.
 */
function faceUv(box: Box, face: string): [number, number, number, number] {
  const auto = autoUv(box.size, face)
  if (typeof box.uv === 'object' && !Array.isArray(box.uv)) {
    const given = (box.uv as Record<string, number[]>)[face]
    if (Array.isArray(given)) {
      if (given.length >= 4) return [given[0], given[1], given[2], given[3]]
      if (given.length >= 2) {
        // Size, not end coordinate: auto[2]/auto[3] are the far edge of the
        // default rectangle, so using them directly doubled the sampled area.
        const w = auto[2] - auto[0]
        const h = auto[3] - auto[1]
        return [given[0], given[1], given[0] + w, given[1] + h]
      }
    }
  }
  if (Array.isArray(box.uv)) {
    // Explicit origin for the whole element: offset the auto layout from it.
    const [u, v] = box.uv as [number, number]
    return [u + auto[0], v + auto[1], u + auto[2], v + auto[3]]
  }
  return auto
}

/**
 * Blockbench's auto-UV layout for a box, as `[u1, v1, u2, v2]` per face: three
 * rows, sides in a strip, top and bottom above and below the north face.
 * Matching it means a texture painted in Blockbench lands on a generated model
 * correctly.
 */
function autoUv(
  [w, h, d]: [number, number, number],
  face_: string
): [number, number, number, number] {
  const width = Math.max(1, Math.round(w))
  const height = Math.max(1, Math.round(h))
  const depth = Math.max(1, Math.round(d))
  const d2 = depth + width
  const rects: Record<string, [number, number, number, number]> = {
    // Side faces: a strip one depth wide, one height tall, left to right.
    east: [0, depth, depth, depth + height],
    north: [depth, depth, d2, depth + height],
    west: [d2, depth, d2 + depth, depth + height],
    south: [d2 + depth, depth, d2 + depth + width, depth + height],
    // Top and bottom sit in the row below and the row above the sides.
    up: [depth, 0, d2, depth],
    down: [d2, 0, d2 + width, depth]
  }
  return rects[face_] ?? [0, 0, depth, depth]
}

function dominantAxis(rotation: [number, number, number]): 'x' | 'y' | 'z' {
  const [x, y, z] = rotation.map(Math.abs)
  if (x >= y && x >= z) return 'x'
  if (y >= z) return 'y'
  return 'z'
}

/* ---------------------------------------------------------- entity / bedrock */

export interface Bone {
  name: string
  /** Parent bone name, or omit for a root. */
  parent?: string
  /** Pivot point — the joint, in pixels. */
  pivot: [number, number, number]
  rotation?: [number, number, number]
  boxes?: Box[]
}

export interface EntityModelOptions {
  /** Must match the identifier referenced by the renderer. */
  identifier: string
  /** Texture width and height in pixels, used to validate UVs. */
  textureWidth?: number
  textureHeight?: number
  bones: Bone[]
  /** Visible bounds, used by the game for culling. */
  visibleBounds?: { width: number; height: number }
}

/**
 * A Bedrock-format entity model.
 *
 * This is the format Minecraft itself uses for entities, and it is what
 * Blockbench exports — so a generated model can be opened in Blockbench and
 * sculpted, which is the honest division of labour: the structure here, the art
 * there.
 */
export function entityModelJson(opts: EntityModelOptions): string {
  const model = {
    format_version: '1.12.0',
    'minecraft:geometry': [
      {
        description: {
          identifier: opts.identifier,
          texture_width: opts.textureWidth ?? 64,
          texture_height: opts.textureHeight ?? 64,
          visible_bounds_width: opts.visibleBounds?.width ?? 2,
          visible_bounds_height: opts.visibleBounds?.height ?? 3,
          visible_bounds_offset: [0, 1, 0]
        },
        bones: opts.bones.map((b) => ({
          name: b.name,
          ...(b.parent ? { parent: b.parent } : {}),
          pivot: b.pivot,
          ...(b.rotation ? { rotation: b.rotation } : {}),
          ...(b.boxes?.length
            ? {
                cubes: b.boxes.map((box) => ({
                  origin: box.origin,
                  size: box.size,
                  ...(box.pivot ? { pivot: box.pivot } : {}),
                  ...(box.rotation ? { rotation: box.rotation } : {}),
                  ...(box.inflate ? { inflate: box.inflate } : {}),
                  // A flat [u,v] is the box-UV shorthand every tool understands.
                  // Per-face UV is a nested {uv, uv_size} object; it is ignored
                  // here rather than written half-formed, because a malformed
                  // one makes the cube invisible without an error.
                  ...(Array.isArray(box.uv) ? { uv: box.uv } : {})
                }))
              }
            : {})
        }))
      }
    ]
  }
  return JSON.stringify(model, null, 2) + '\n'
}

/* ---------------------------------------------------------------- animation */

export interface Keyframe {
  /** Seconds. Bedrock's animation timeline is in seconds, not ticks. */
  time: number
  /** Value at that time. Length must match the channel (3 for rotation). */
  value: number[] | string
}

export interface AnimationChannel {
  /** e.g. `bone:head`, `bone:leg_front_left`. */
  target: string
  /** Position, rotation or scale. */
  type: 'rotation' | 'position' | 'scale'
  keys: Keyframe[]
  /** Interpolation between keys. Catmull-Rom is smoother, linear is snappier. */
  interpolation?: 'linear' | 'catmullrom'
}

export interface AnimationOptions {
  /** e.g. `animation.my_mod.walk` */
  identifier: string
  /** Loop or play once. */
  loop?: boolean
  /** Total length in seconds. */
  length?: number
  channels: AnimationChannel[]
}

/**
 * A Bedrock animation.
 *
 * Two details account for nearly every "my animation does nothing" report: the
 * identifier must be `animation.<modid>.<name>` and be referenced from the
 * entity's animation controller, and rotation values are **degrees in Bedrock
 * animations but degrees in the game's pose overrides**, so mixing the two is
 * the usual cause of a model that jumps to a pose and sticks.
 */
export function animationJson(opts: AnimationOptions): string {
  const animations: Record<string, unknown> = {}
  for (const ch of opts.channels) {
    const group = ch.type === 'rotation' ? 'rotation' : ch.type === 'position' ? 'position' : 'scale'
    const existing = (animations[ch.target] as Record<string, unknown>) ?? {}
    // Bedrock accepts either a bare value or {pre, post, lerp_mode} per key.
    // Interpolation is a property of the key, not of the timestamp.
    existing[group] = Object.fromEntries(
      ch.keys
        .slice()
        .sort((a, b) => a.time - b.time)
        .map((k) => [k.time.toFixed(3), ch.interpolation ? { pre: k.value, post: k.value, lerp_mode: ch.interpolation } : k.value])
    )
    animations[ch.target] = existing
  }
  const body = {
    format_version: '1.8.0',
    animations: {
      [opts.identifier]: {
        ...(opts.loop !== undefined ? { loop: opts.loop } : {}),
        ...(opts.length !== undefined ? { animation_length: opts.length } : {}),
        bones: animations
      }
    }
  }
  return JSON.stringify(body, null, 2) + '\n'
}

/* ------------------------------------------------------------------ the set */

/**
 * A quadruped skeleton, which is the useful starting point for most mobs.
 *
 * The layout is the one every animal mob uses: feet at y=0, legs `legLength`
 * tall, body stacked on top of them and `bodyHeight` deep, head at the front
 * (negative Z, Minecraft's "forward"). Both numbers are in model pixels, so
 * (8, 6) gives a mob 14 px tall to the shoulders — a little shorter than a
 * vanilla cow at 8 px legs and 10 px body.
 */
export const QUADRUPED_BONES = (legLength: number, bodyHeight: number): Bone[] => {
  const legs = Math.max(1, Math.round(legLength))
  const body = Math.max(1, Math.round(bodyHeight))
  const shoulder = legs
  const back = legs + body
  const leg = (name: string, x: number, z: number): Bone => ({
    name,
    parent: 'root',
    pivot: [x < 0 ? -3 : 3, shoulder, z < 0 ? -6 : 6],
    boxes: [{ origin: [x - 1.5, 0, z - 1.5], size: [3, legs, 3], uv: [0, 28], name: 'leg' }]
  })
  return [
    {
      name: 'root',
      // The pivot is the shoulder joint, not the floor: that is where the game
      // expects to attach a mount and where the body rotates from.
      pivot: [0, shoulder, 0],
      boxes: [{ origin: [-4, shoulder, -8], size: [8, body, 16], uv: [0, 0], name: 'body' }]
    },
    {
      name: 'head',
      parent: 'root',
      pivot: [0, back, -8],
      boxes: [
        { origin: [-3, back - 2, -14], size: [6, 6, 6], uv: [0, 16], name: 'head' },
        { origin: [-2, back - 1, -16], size: [4, 3, 2], uv: [24, 16], name: 'snout' }
      ]
    },
    leg('leg_front_left', -3, -6),
    leg('leg_front_right', 3, -6),
    leg('leg_back_left', -3, 6),
    leg('leg_back_right', 3, 6)
  ]
}

/** A walk cycle where the diagonal pair moves together, as a real quadruped's does. */
export function quadrupedWalk(identifier: string, speed = 1.2): AnimationOptions {
  const swing = 26
  const mid = speed / 2
  return {
    identifier,
    loop: true,
    length: speed,
    channels: [
      {
        target: 'bone:leg_front_left',
        type: 'rotation',
        keys: [
          { time: 0, value: [swing, 0, 0] },
          { time: mid, value: [-swing, 0, 0] },
          { time: speed, value: [swing, 0, 0] }
        ]
      },
      {
        target: 'bone:leg_back_right',
        type: 'rotation',
        keys: [
          { time: 0, value: [swing, 0, 0] },
          { time: mid, value: [-swing, 0, 0] },
          { time: speed, value: [swing, 0, 0] }
        ]
      },
      {
        target: 'bone:leg_front_right',
        type: 'rotation',
        keys: [
          { time: 0, value: [-swing, 0, 0] },
          { time: mid, value: [swing, 0, 0] },
          { time: speed, value: [-swing, 0, 0] }
        ]
      },
      {
        target: 'bone:leg_back_left',
        type: 'rotation',
        keys: [
          { time: 0, value: [-swing, 0, 0] },
          { time: mid, value: [swing, 0, 0] },
          { time: speed, value: [-swing, 0, 0] }
        ]
      },
      {
        target: 'bone:head',
        type: 'rotation',
        keys: [
          { time: 0, value: [0, 0, 0] },
          { time: mid, value: [4, 0, 0] },
          { time: speed, value: [0, 0, 0] }
        ]
      }
    ]
  }
}

/* -------------------------------------------------------------- validation */

export interface ModelIssue {
  severity: 'error' | 'warning'
  message: string
  /** What to do about it, in the imperative. */
  fix: string
}

/**
 * Check a generated model before it is written.
 *
 * The failure mode this exists for is the silent one: a model with an
 * unparseable JSON file, a missing `textures` entry, or a bone whose parent does
 * not exist produces an invisible entity and a single vague log line. Catching
 * it here turns that into a sentence.
 */
export function validateModel(text: string, kind: 'block' | 'entity' | 'animation'): ModelIssue[] {
  const issues: ModelIssue[] = []
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch (e) {
    return [{ severity: 'error', message: `not valid JSON: ${(e as Error).message}`, fix: 'Regenerate the file; a trailing comma is the usual cause.' }]
  }

  if (kind === 'block') {
    if (!parsed.parent && !parsed.elements) {
      issues.push({
        severity: 'error',
        message: 'a block model needs either a parent or its own elements',
        fix: "Set parent to 'minecraft:block/cube_all' and give it a textures entry, or provide elements."
      })
    }
    if (parsed.textures) {
      for (const [face, value] of Object.entries(parsed.textures as Record<string, string>)) {
        if (typeof value === 'string' && !value.startsWith('#') && !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/i.test(value)) {
          issues.push({
            severity: 'error',
            message: `texture "${face}" is "${value}", which is not a namespaced id`,
            fix: 'Use the form modid:block/name — a bare path silently renders as the missing-texture checkerboard.'
          })
        }
      }
    }
  }

  if (kind === 'entity') {
    const geo = (parsed['minecraft:geometry'] as Record<string, unknown>[] | undefined)?.[0]
    if (!geo) {
      issues.push({ severity: 'error', message: 'no minecraft:geometry array', fix: 'Wrap the bones in a "minecraft:geometry": [ { description, bones } ] array.' })
    } else {
      const desc = geo.description as { identifier?: string; texture_width?: number; texture_height?: number } | undefined
      if (!desc?.identifier) {
        issues.push({ severity: 'error', message: 'the geometry has no identifier', fix: 'Add description.identifier, e.g. geometry.my_mod.mob.' })
      } else if (!desc.identifier.startsWith('geometry.')) {
        issues.push({
          severity: 'error',
          message: `identifier "${desc.identifier}" does not start with "geometry."`,
          fix: 'Bedrock identifiers must start with geometry. — the renderer will not find the model otherwise.'
        })
      }
      if (!desc?.texture_width || !desc?.texture_height) {
        issues.push({ severity: 'warning', message: 'no texture size declared', fix: 'Set texture_width and texture_height to the size of the entity texture.' })
      }
      const bones = (geo.bones as { name: string; parent?: string }[] | undefined) ?? []
      if (!bones.length) issues.push({ severity: 'error', message: 'the model has no bones', fix: 'Add at least a root bone.' })
      const names = new Set(bones.map((b) => b.name))
      for (const bone of bones) {
        if (bone.parent && !names.has(bone.parent)) {
          issues.push({
            severity: 'error',
            message: `bone "${bone.name}" has parent "${bone.parent}", which does not exist`,
            fix: 'Fix the parent name, or remove it to make the bone a root.'
          })
        }
      }
    }
  }

  if (kind === 'animation') {
    const anims = parsed.animations as Record<string, { bones?: Record<string, unknown> }> | undefined
    if (!anims || !Object.keys(anims).length) {
      issues.push({ severity: 'error', message: 'no animations', fix: 'Add an animations object keyed by identifier.' })
    } else {
      for (const [id, body] of Object.entries(anims)) {
        if (!id.startsWith('animation.')) {
          issues.push({
            severity: 'error',
            message: `"${id}" is not prefixed with animation.`,
            fix: 'Identifiers must start with animation., e.g. animation.my_mod.walk.'
          })
        }
        if (!body.bones) {
          issues.push({ severity: 'warning', message: `"${id}" animates no bones`, fix: 'Add a bones map with bone:name entries.' })
        }
        for (const [target, channels] of Object.entries(body.bones ?? {})) {
          if (!target.includes(':') && !target.includes('.')) {
            issues.push({
              severity: 'warning',
              message: `target "${target}" is not a bone reference`,
              fix: 'Use bone:<name> so the animation lands on a bone rather than being ignored.'
            })
          }
          void channels
        }
      }
    }
  }

  return issues
}

/* ------------------------------------------------------------------ writing */

export interface ModelWrite {
  /** Path relative to the project root. */
  path: string
  text: string
  /**
   * What the file is. `blockstate` exists because a blockstate is not a block
   * model: it has no parent and no elements, so validating it as one rejected a
   * perfectly good file. For it, only JSON validity is checked.
   */
  kind: ModelKind | 'animation' | 'blockstate'
}

/**
 * Where each kind of file belongs, which is the other half of "it does not
 * show up". The game looks in exactly these directories and nowhere else — and
 * the directories depend on the Minecraft version, so a path is only correct
 * together with the version it was computed for.
 *
 * `entity` and `animation` throw for pre-1.13 projects: there is no such folder
 * there, and silently writing one would produce files that never load.
 */
export function modelPaths(opts: { modId: string; name: string; kind: ModelKind | 'animation'; mcVersion?: string }): string {
  const layout = assetLayout({ mcVersion: opts.mcVersion ?? '1.21.1', modId: opts.modId })
  switch (opts.kind) {
    case 'block':
      return `${layout.blockModels}/${opts.name}.json`
    case 'item':
      return `${layout.itemModels}/${opts.name}.json`
    case 'entity':
      if (!layout.geo) {
        throw new Error(
          `Minecraft ${layout.mcVersion} has no JSON entity models — write a Java ModelBase class instead of a geo file.`
        )
      }
      return `${layout.geo}/${opts.name}.geo.json`
    case 'animation':
      if (!layout.animations) {
        throw new Error(`Minecraft ${layout.mcVersion} has no Bedrock animation files — animate in Java (ModelRenderer rotations).`)
      }
      return `${layout.animations}/${opts.name}.animation.json`
  }
}

/**
 * A blockstate has to be valid JSON and nothing else is structurally required:
 * a block with no properties uses `{"variants": {"": {...}}}`, a property-bearing
 * block uses a variant map, and 1.12 uses stateless or normal/inventory keys.
 * All of those are correct, so the only question worth asking is whether it
 * parses.
 */
function validateJsonOnly(text: string): ModelIssue[] {
  try {
    JSON.parse(text)
    return []
  } catch (e) {
    return [
      {
        severity: 'error',
        message: `not valid JSON: ${(e as Error).message}`,
        fix: 'Regenerate the blockstate; a trailing comma is the usual cause.'
      }
    ]
  }
}

/**
 * `modelPaths` for callers that cannot handle a throw — a UI listing folders
 * should not crash because the project is 1.12. Returns the modern path plus a
 * note saying it is not used by this version.
 */
export function modelPathOrFallback(opts: {
  modId: string
  name: string
  kind: ModelKind | 'animation'
  mcVersion?: string
}): { path: string; usable: boolean; note?: string } {
  try {
    return { path: modelPaths(opts), usable: true }
  } catch (e) {
    const layout = assetLayout({ mcVersion: opts.mcVersion ?? '1.21.1', modId: opts.modId })
    const path =
      opts.kind === 'animation'
        ? `${layout.assetRoot}/animations/${opts.name}.animation.json`
        : `${layout.assetRoot}/geo/${opts.name}.geo.json`
    return { path, usable: false, note: (e as Error).message }
  }
}

export function writeModels(projectDir: string, writes: ModelWrite[]): { ok: boolean; written: string[]; issues: ModelIssue[] } {
  const written: string[] = []
  const issues: ModelIssue[] = []
  for (const w of writes) {
    if (!w.path) {
      issues.push({ severity: 'error', message: 'a write had no path', fix: 'Regenerate the model; this is a bug in the caller.' })
      continue
    }
    const kind = w.kind === 'animation' ? 'animation' : w.kind === 'entity' ? 'entity' : 'block'
    const found = w.kind === 'blockstate' ? validateJsonOnly(w.text) : validateModel(w.text, kind)
    issues.push(...found.map((i) => ({ ...i, message: `${w.path}: ${i.message}` })))
    if (found.some((i) => i.severity === 'error')) continue
    const full = path.join(projectDir, w.path)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, w.text, 'utf8')
    written.push(w.path)
  }
  return { ok: written.length === writes.length, written, issues }
}
