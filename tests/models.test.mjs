import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 3D model and animation checks.
 *
 * These test the things that make a model *invisible without an error*: an
 * identifier without its required prefix, a texture that is not namespaced, a
 * bone whose parent does not exist, a file in a folder the game never reads.
 * None of those throw in Minecraft, so they have to throw here.
 *
 * They also pin the version split, because the app handles projects from 1.7 to
 * 1.21 and the *correct* answer for a 1.12 project is "there is no JSON entity
 * model" — writing a .geo.json there is a file that nothing loads.
 */

const out = path.join(process.cwd(), 'out-test', 'main')
const { modelPaths, modelPathOrFallback, blockModelJson, entityModelJson, animationJson, QUADRUPED_BONES, quadrupedWalk, validateModel, writeModels } = await import(
  path.join(out, 'mod', 'models.js')
)
const { assetLayout, blockstateJson, modelGuidance, atLeast } = await import(path.join(out, 'mod', 'assets.js'))
const { textureRef, textureFile } = await import(path.join(out, 'mod', 'texture-ref.js'))

let passed = 0
function check(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (e) {
    console.log(`  FAIL ${name}`)
    console.log(`       ${e.message}`)
    process.exitCode = 1
  }
}

/* ------------------------------------------------------------- version rules */

check('atLeast handles major, minor and a missing minor', () => {
  assert.equal(atLeast('1.21.1', '1.13'), true)
  assert.equal(atLeast('1.12.2', '1.13'), false)
  assert.equal(atLeast('1.13', '1.13'), true)
  assert.equal(atLeast('1.9', '1.13'), false)
  // 1.21 vs 1.9 must not compare as strings: "1.21" < "1.9" lexically.
  assert.equal(atLeast('1.21', '1.9'), true)
})

check('an unknown version is treated as modern rather than crashing', () => {
  assert.equal(assetLayout({ mcVersion: '', modId: 'x' }).legacy, false)
})

check('1.12.2 is legacy: no geo, no animations folders', () => {
  const l = assetLayout({ mcVersion: '1.12.2', modId: 'icbm' })
  assert.equal(l.legacy, true)
  assert.equal(l.geo, null)
  assert.equal(l.animations, null)
  assert.equal(l.blockModels, 'src/main/resources/assets/icbm/models/block')
})

check('1.21.1 is modern and declares geo + animations', () => {
  const l = assetLayout({ mcVersion: '1.21.1', modId: 'ruby' })
  assert.equal(l.legacy, false)
  assert.equal(l.geo, 'src/main/resources/assets/ruby/geo')
  assert.equal(l.animations, 'src/main/resources/assets/ruby/animations')
})

check('modelPaths refuses an entity model on 1.12 instead of writing a dead file', () => {
  assert.throws(() => modelPaths({ modId: 'icbm', name: 'golem', kind: 'entity', mcVersion: '1.12.2' }), /no JSON entity models/)
  assert.throws(() => modelPaths({ modId: 'icbm', name: 'walk', kind: 'animation', mcVersion: '1.12.2' }), /no Bedrock animation/)
})

check('modelPathOrFallback returns the path plus the reason it is unusable', () => {
  const r = modelPathOrFallback({ modId: 'icbm', name: 'golem', kind: 'entity', mcVersion: '1.12.2' })
  assert.equal(r.usable, false)
  assert.match(r.note, /ModelBase|no JSON entity/)
  assert.match(r.path, /geo\/golem\.geo\.json$/)
  const ok = modelPathOrFallback({ modId: 'ruby', name: 'golem', kind: 'entity', mcVersion: '1.21.1' })
  assert.equal(ok.usable, true)
  assert.equal(ok.note, undefined)
})

check('blockstate shape differs by era', () => {
  const legacy = JSON.parse(blockstateJson({ mcVersion: '1.12.2', modelId: 'icbm:block/launcher' }))
  assert.ok(legacy.variants.normal, '1.12 needs a "normal" variant')
  assert.ok(legacy.variants.inventory, '1.12 needs an "inventory" variant')
  const modern = JSON.parse(blockstateJson({ mcVersion: '1.21.1', modelId: 'ruby:block/ruby_block' }))
  assert.deepEqual(modern, { variants: { '': { model: 'ruby:block/ruby_block' } } })
})

check('modelGuidance says nothing for modern versions and is blunt for 1.12', () => {
  assert.equal(modelGuidance({ mcVersion: '1.21.1', modId: 'ruby' }), '')
  const g = modelGuidance({ mcVersion: '1.12.2', modId: 'icbm' })
  assert.match(g, /ModelBase/)
  assert.match(g, /Do not create a `geo\/`/)
})

/* ------------------------------------------------------------------ paths */

check('modelPaths puts each kind in the folder the game reads', () => {
  const m = '1.21.1'
  assert.equal(modelPaths({ modId: 'ruby', name: 'ore', kind: 'block', mcVersion: m }), 'src/main/resources/assets/ruby/models/block/ore.json')
  assert.equal(modelPaths({ modId: 'ruby', name: 'gem', kind: 'item', mcVersion: m }), 'src/main/resources/assets/ruby/models/item/gem.json')
  assert.equal(modelPaths({ modId: 'ruby', name: 'golem', kind: 'entity', mcVersion: m }), 'src/main/resources/assets/ruby/geo/golem.geo.json')
  assert.equal(
    modelPaths({ modId: 'ruby', name: 'golem.walk', kind: 'animation', mcVersion: m }),
    'src/main/resources/assets/ruby/animations/golem.walk.animation.json'
  )
})

check('paths default to a modern version when none is given', () => {
  assert.match(modelPaths({ modId: 'ruby', name: 'golem', kind: 'entity' }), /\/geo\//)
})

/* ------------------------------------------------------------ block models */

check('a plain cube block model is a valid cube_all parent with a namespaced texture', () => {
  const json = blockModelJson({ parent: 'minecraft:block/cube_all', all: 'ruby:block/ruby_block' })
  const m = JSON.parse(json)
  assert.equal(m.parent, 'minecraft:block/cube_all')
  // `#all` is what the vanilla cube parents resolve, so it must be defined —
  // writing only down/up/north/... gives an unresolved reference and a
  // checkerboard block with no error in the log.
  assert.equal(m.textures.all, 'ruby:block/ruby_block')
  // No elements: the parent supplies the cube, and inventing one here would
  // override the texture mapping.
  assert.equal(m.elements, undefined)
  assert.deepEqual(validateModel(json, 'block'), [])
})

check('every face gets the texture, not just "all"', () => {
  const m = JSON.parse(blockModelJson({ parent: 'minecraft:block/cube_all', all: 'ruby:block/ore' }))
  for (const face of ['all', 'particle']) {
    assert.equal(m.textures[face], 'ruby:block/ore', `${face} missing its texture`)
  }
  assert.equal(Object.keys(m.textures).length, 2, 'unexpanded per-face keys are noise now that #all is defined')
})

check('a custom-size element gets four-number UV rectangles sized to the face', () => {
  const json = blockModelJson({
    textures: { all: 'ruby:block/slab' },
    elements: [{ origin: [0, 0, 0], size: [16, 8, 16], uv: [0, 0] }]
  })
  const el = JSON.parse(json).elements[0]
  assert.deepEqual(el.from, [0, 0, 0])
  assert.deepEqual(el.to, [16, 8, 16])
  // Nested `uv` is [u1,v1,u2,v2] — a rectangle. Two numbers is a zero-area
  // face, which renders nothing and logs nothing.
  for (const face of ['north', 'east', 'south', 'west', 'up', 'down']) {
    const uv = el.faces[face].uv
    assert.equal(uv.length, 4, `${face} uv is not a rectangle`)
    assert.ok(uv[2] > uv[0] && uv[3] > uv[1], `${face} uv has no area: ${uv}`)
  }
  // The side faces must be 8 tall (the element height), not 16.
  assert.equal(el.faces.north.uv[3] - el.faces.north.uv[1], 8)
  assert.deepEqual(validateModel(json, 'block'), [])
})

check('a user-supplied uv origin is honoured as the top-left of the rectangle', () => {
  const json = blockModelJson({
    textures: { all: 'ruby:block/x' },
    elements: [{ origin: [0, 0, 0], size: [4, 4, 4], uv: { north: [7, 9] } }]
  })
  const uv = JSON.parse(json).elements[0].faces.north.uv
  assert.deepEqual(uv, [7, 9, 11, 13])
})

check('an explicit four-number uv is passed through untouched', () => {
  const json = blockModelJson({
    textures: { all: 'ruby:block/x' },
    elements: [{ origin: [0, 0, 0], size: [4, 4, 4], uv: { up: [1, 2, 3, 4] } }]
  })
  assert.deepEqual(JSON.parse(json).elements[0].faces.up.uv, [1, 2, 3, 4])
})

check('a rotated element is given an axis and a rotation origin', () => {
  const json = blockModelJson({
    textures: { all: 'ruby:block/x' },
    elements: [{ origin: [0, 0, 0], size: [4, 4, 4], rotation: [0, 45, 0], pivot: [2, 2, 2] }]
  })
  const r = JSON.parse(json).elements[0].rotation
  assert.equal(r.axis, 'y')
  assert.equal(r.angle[1], 45)
  assert.deepEqual(r.origin, [2, 2, 2])
})

check('a bare texture path is rejected before it becomes a checkerboard', () => {
  const bad = JSON.stringify({ parent: 'minecraft:block/cube_all', textures: { all: 'block/stone' } })
  const issues = validateModel(bad, 'block')
  assert.equal(issues.length, 1)
  assert.equal(issues[0].severity, 'error')
  assert.match(issues[0].fix, /modid:block\/name/)
})

check('a texture that references another key (#all) is not a namespace error', () => {
  const ok = JSON.stringify({ parent: 'minecraft:block/cube', textures: { particle: '#all' } })
  assert.deepEqual(validateModel(ok, 'block'), [])
})

check('a model with neither parent nor elements is an error', () => {
  const issues = validateModel(JSON.stringify({ textures: {} }), 'block')
  assert.equal(issues.length, 1)
  assert.match(issues[0].message, /parent or its own elements/)
})

/* ----------------------------------------------------------- entity models */

check('a quadruped is a parented rig with feet on the floor and a head at the front', () => {
  const bones = QUADRUPED_BONES(8, 6)
  const names = bones.map((b) => b.name)
  for (const n of ['root', 'head', 'leg_front_left', 'leg_front_right', 'leg_back_left', 'leg_back_right']) {
    assert.ok(names.includes(n), `missing bone ${n}`)
  }
  assert.deepEqual(validateModel(entityModelJson({ identifier: 'geometry.ruby.golem', bones }), 'entity'), [])
  // Every leg starts at y=0: a leg that starts above the floor makes the mob hover.
  for (const leg of bones.filter((b) => b.name.startsWith('leg_'))) {
    assert.equal(leg.boxes[0].origin[1], 0, `${leg.name} does not reach the ground`)
  }
  const head = bones.find((b) => b.name === 'head')
  // Negative Z is forward in Minecraft; a head at positive Z faces backwards.
  assert.ok(head.boxes[0].origin[2] < 0, 'the head is behind the body')
})

check('legLength actually changes the leg height', () => {
  const short = QUADRUPED_BONES(4, 6).find((b) => b.name === 'leg_front_left').boxes[0].size[1]
  const tall = QUADRUPED_BONES(10, 6).find((b) => b.name === 'leg_front_left').boxes[0].size[1]
  assert.equal(short, 4)
  assert.equal(tall, 10)
  // Regression: legLength used to be accepted and ignored, so every mob had
  // identical legs no matter what was asked for.
  assert.notEqual(short, tall)
})

check('bodyHeight moves the body and the head, not the feet', () => {
  const low = QUADRUPED_BONES(8, 4)
  const high = QUADRUPED_BONES(8, 10)
  const bodyOf = (bones) => bones.find((b) => b.name === 'root')
  assert.equal(bodyOf(low).boxes[0].size[1], 4)
  assert.equal(bodyOf(high).boxes[0].size[1], 10)
  assert.equal(bodyOf(high).pivot[1], 8, 'body pivot should sit at the shoulder')
  assert.ok(high.find((b) => b.name === 'head').boxes[0].origin[1] > low.find((b) => b.name === 'head').boxes[0].origin[1])
})

check('an entity model uses Bedrock format with texture size and visible bounds', () => {
  const m = JSON.parse(entityModelJson({ identifier: 'geometry.ruby.golem', bones: QUADRUPED_BONES(8, 6), textureWidth: 128, textureHeight: 64 }))
  assert.equal(m.format_version, '1.12.0')
  const geo = m['minecraft:geometry'][0]
  assert.equal(geo.description.identifier, 'geometry.ruby.golem')
  assert.equal(geo.description.texture_width, 128)
  assert.equal(geo.description.texture_height, 64)
  assert.ok(Array.isArray(geo.description.visible_bounds_offset))
  assert.ok(geo.bones.length >= 6)
})

check('an identifier without the geometry. prefix is caught', () => {
  const json = entityModelJson({ identifier: 'ruby.golem', bones: QUADRUPED_BONES(8, 6) })
  const issues = validateModel(json, 'entity')
  assert.equal(issues.length, 1)
  assert.match(issues[0].message, /geometry\./)
})

check('a bone whose parent does not exist is caught, by name', () => {
  const json = entityModelJson({
    identifier: 'geometry.ruby.golem',
    bones: [{ name: 'root', pivot: [0, 0, 0] }, { name: 'tail', parent: 'hips', pivot: [0, 4, 4] }]
  })
  const issues = validateModel(json, 'entity')
  assert.equal(issues.length, 1)
  assert.match(issues[0].message, /"tail" has parent "hips"/)
  assert.match(issues[0].fix, /parent name/)
})

check('a model with no bones is an error rather than an empty mob', () => {
  const json = JSON.stringify({ format_version: '1.12.0', 'minecraft:geometry': [{ description: { identifier: 'geometry.x.y' }, bones: [] }] })
  assert.ok(validateModel(json, 'entity').some((i) => /no bones/.test(i.message)))
})

check('missing texture size is a warning, not an error: the model still loads', () => {
  const json = JSON.stringify({ format_version: '1.12.0', 'minecraft:geometry': [{ description: { identifier: 'geometry.x.y' }, bones: [{ name: 'root' }] }] })
  const issues = validateModel(json, 'entity')
  assert.equal(issues.length, 1)
  assert.equal(issues[0].severity, 'warning')
})

check('a geometry file without the minecraft:geometry array is caught', () => {
  const issues = validateModel(JSON.stringify({ format_version: '1.12.0' }), 'entity')
  assert.ok(issues.some((i) => /no minecraft:geometry/.test(i.message)))
})

/* -------------------------------------------------------------- animations */

check('a walk cycle is in seconds and loops', () => {
  const a = quadrupedWalk('animation.ruby.golem.walk')
  assert.equal(a.length, 1.2)
  assert.equal(a.loop, true)
  // 1.2 seconds, not 24 ticks: a tick-based length plays in the wrong time.
  assert.equal(Math.max(...a.channels.flatMap((c) => c.keys.map((k) => k.time))), 1.2)
})

check('the diagonal legs are in phase and the opposite pair is reversed', () => {
  const a = quadrupedWalk('animation.ruby.golem.walk', 1)
  const start = (name) => a.channels.find((c) => c.target === `bone:${name}`).keys[0].value[0]
  assert.equal(start('leg_front_left'), start('leg_back_right'))
  assert.equal(start('leg_front_right'), start('leg_back_left'))
  assert.ok(start('leg_front_left') > 0)
  assert.ok(start('leg_front_right') < 0)
})

check('walk speed changes the cycle length and the midpoint', () => {
  const slow = quadrupedWalk('animation.x.y.walk', 2)
  const leg = slow.channels.find((c) => c.target === 'bone:leg_front_left')
  assert.deepEqual(leg.keys.map((k) => k.time), [0, 1, 2])
})

check('an animation keyframes each bone channel, not a flat list', () => {
  const json = animationJson(quadrupedWalk('animation.ruby.golem.walk'))
  const a = JSON.parse(json).animations['animation.ruby.golem.walk']
  assert.equal(a.loop, true)
  assert.equal(a.animation_length, 1.2)
  assert.deepEqual(Object.keys(a.bones.rotation ? {} : a.bones['bone:head']), ['rotation'])
  assert.equal(a.bones['bone:leg_front_left'].rotation['0.000'].length, 3)
})

check('animation keys are sorted by time regardless of input order', () => {
  const json = animationJson({
    identifier: 'animation.ruby.test',
    channels: [
      {
        target: 'bone:head',
        type: 'rotation',
        keys: [
          { time: 1, value: [10, 0, 0] },
          { time: 0, value: [0, 0, 0] },
          { time: 0.5, value: [5, 0, 0] }
        ]
      }
    ]
  })
  assert.deepEqual(Object.keys(JSON.parse(json).animations['animation.ruby.test'].bones['bone:head'].rotation), ['0.000', '0.500', '1.000'])
})

check('interpolation is written per key, not as a timestamp-keyed sibling', () => {
  const json = animationJson({
    identifier: 'animation.ruby.test',
    channels: [{ target: 'bone:head', type: 'rotation', keys: [{ time: 0, value: [0, 0, 0] }, { time: 1, value: [90, 0, 0] }], interpolation: 'catmullrom' }]
  })
  const rot = JSON.parse(json).animations['animation.ruby.test'].bones['bone:head'].rotation
  assert.equal(rot['0.000'].lerp_mode, 'catmullrom')
  assert.deepEqual(rot['1.000'].pre, [90, 0, 0])
  // The old shape keyed by time produced an entry the game ignores and a
  // duplicate key that silently overwrote a real frame.
  assert.equal(Object.keys(rot).length, 2)
})

check('two channels on the same bone merge into one bone entry', () => {
  const json = animationJson({
    identifier: 'animation.ruby.test',
    channels: [
      { target: 'bone:head', type: 'rotation', keys: [{ time: 0, value: [0, 0, 0] }] },
      { target: 'bone:head', type: 'position', keys: [{ time: 0, value: [0, 1, 0] }] }
    ]
  })
  const head = JSON.parse(json).animations['animation.ruby.test'].bones['bone:head']
  assert.ok(head.rotation)
  assert.ok(head.position)
})

check('an animation identifier without the animation. prefix is caught', () => {
  const json = animationJson({ identifier: 'ruby.walk', channels: [{ target: 'bone:head', type: 'rotation', keys: [{ time: 0, value: [0, 0, 0] }] }] })
  const issues = validateModel(json, 'animation')
  assert.equal(issues.length, 1)
  assert.match(issues[0].message, /not prefixed with animation\./)
})

check('an animation that animates no bones is a warning', () => {
  const issues = validateModel(JSON.stringify({ format_version: '1.8.0', animations: { 'animation.a.b': {} } }), 'animation')
  assert.equal(issues.length, 1)
  assert.equal(issues[0].severity, 'warning')
})

check('a target that is not bone:<name> is flagged, because it silently does nothing', () => {
  const issues = validateModel(
    JSON.stringify({ format_version: '1.8.0', animations: { 'animation.a.b': { bones: { head: { rotation: {} } } } } }),
    'animation'
  )
  assert.equal(issues.length, 1)
  assert.match(issues[0].message, /not a bone reference/)
})

check('unparseable JSON is one clear error, not a stack trace', () => {
  const issues = validateModel('{ "parent": "minecraft:block/cube_all", }', 'block')
  assert.equal(issues.length, 1)
  assert.match(issues[0].message, /not valid JSON/)
  assert.match(issues[0].fix, /trailing comma/)
})

/* --------------------------------------------------------------- textures */

check('a bare name becomes a namespaced block texture', () => {
  // No folder in the input, so the caller's fallback folder is used: a texture
  // with no folder is conventionally wrong and easy to mislay.
  assert.equal(textureRef('ruby', 'ruby_block', 'block/ruby_block'), 'ruby:block/ruby_block')
  assert.equal(textureRef('ruby', undefined, 'block/ruby_block'), 'ruby:block/ruby_block')
  assert.equal(textureRef('ruby', 'my_block', 'block/other'), 'ruby:block/my_block')
  // An explicit folder is respected even when it differs from the fallback.
  assert.equal(textureRef('ruby', 'items/ruby', 'block/x'), 'ruby:items/ruby')
})

check('a path, a namespaced id and a full assets path all normalise to the same id', () => {
  const want = 'ruby:block/ruby_block'
  assert.equal(textureRef('ruby', 'block/ruby_block', 'x'), want)
  assert.equal(textureRef('ruby', 'ruby:block/ruby_block', 'x'), want)
  assert.equal(textureRef('ruby', 'assets/ruby/textures/block/ruby_block.png', 'x'), want)
  // Windows separators: people paste from Explorer.
  assert.equal(textureRef('ruby', 'assets\\ruby\\textures\\block\\ruby_block.png', 'x'), want)
})

check('a doubled namespace does not survive', () => {
  // ruby:ruby:block/x is what a copy of a full id into the mod-id field produces.
  assert.equal(textureRef('ruby', 'ruby:ruby:block/x', 'fallback'), 'ruby:block/x')
})

check('a different namespace is kept: vanilla textures are legitimate', () => {
  assert.equal(textureRef('ruby', 'minecraft:block/stone', 'x'), 'minecraft:block/stone')
})

check('the expected png path follows the texture id', () => {
  assert.equal(textureFile('ruby', 'ruby:block/ruby_block'), 'src/main/resources/assets/ruby/textures/block/ruby_block.png')
  assert.equal(textureFile('ruby', 'minecraft:block/stone'), 'src/main/resources/assets/minecraft/textures/block/stone.png')
  // A face reference to another key is not a file.
  assert.equal(textureFile('ruby', '#all'), '')
})

/* ---------------------------------------------------------------- writing */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcf-models-'))
try {
  check('writeModels creates the folders and reports what it wrote', () => {
    const p = modelPaths({ modId: 'ruby', name: 'golem', kind: 'entity' })
    const res = writeModels(tmp, [{ path: p, kind: 'entity', text: entityModelJson({ identifier: 'geometry.ruby.golem', bones: QUADRUPED_BONES(8, 6) }) }])
    assert.equal(res.ok, true)
    assert.deepEqual(res.written, [p])
    assert.ok(fs.existsSync(path.join(tmp, p)))
    assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, p), 'utf8'))['minecraft:geometry'][0].description.identifier, 'geometry.ruby.golem')
  })

  check('writeModels refuses to write a file that failed validation', () => {
    const res = writeModels(tmp, [{ path: 'bad/one.json', kind: 'block', text: JSON.stringify({ textures: { all: 'nope' } }) }])
    assert.equal(res.ok, false)
    assert.deepEqual(res.written, [])
    assert.equal(fs.existsSync(path.join(tmp, 'bad', 'one.json')), false)
    assert.ok(res.issues.some((i) => /not a namespaced id/.test(i.message)))
  })

  check('writeModels keeps the good files when one of several fails', () => {
    const res = writeModels(tmp, [
      { path: 'models/block/good.json', kind: 'block', text: blockModelJson({ parent: 'minecraft:block/cube_all', all: 'ruby:block/good' }) },
      { path: 'models/block/gone.json', kind: 'block', text: JSON.stringify({}) }
    ])
    assert.equal(res.ok, false)
    assert.deepEqual(res.written, ['models/block/good.json'])
    assert.ok(fs.existsSync(path.join(tmp, 'models/block/good.json')))
    assert.equal(fs.existsSync(path.join(tmp, 'models/block/gone.json')), false)
  })

  check('validation issues are prefixed with the file they belong to', () => {
    const res = writeModels(tmp, [{ path: 'a/b.json', kind: 'block', text: JSON.stringify({}) }])
    assert.match(res.issues[0].message, /^a\/b\.json: /)
  })

  check('the whole quadruped + walk set writes as a coherent project', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcf-set-'))
    const mc = '1.21.1'
    const bones = QUADRUPED_BONES(8, 6)
    const res = writeModels(dir, [
      { path: modelPaths({ modId: 'ruby', name: 'ruby_block', kind: 'block', mcVersion: mc }), kind: 'block', text: blockModelJson({ parent: 'minecraft:block/cube_all', all: 'ruby:block/ruby_block' }) },
      { path: `src/main/resources/assets/ruby/blockstates/ruby_block.json`, kind: 'blockstate', text: blockstateJson({ mcVersion: mc, modelId: 'ruby:block/ruby_block' }) },
      { path: modelPaths({ modId: 'ruby', name: 'golem', kind: 'entity', mcVersion: mc }), kind: 'entity', text: entityModelJson({ identifier: 'geometry.ruby.golem', bones }) },
      {
        path: modelPaths({ modId: 'ruby', name: 'golem.walk', kind: 'animation', mcVersion: mc }),
        kind: 'animation',
        text: animationJson(quadrupedWalk('animation.ruby.golem.walk'))
      }
    ])
    assert.equal(res.ok, true, JSON.stringify(res.issues))
    assert.equal(res.written.length, 4)
    fs.rmSync(dir, { recursive: true, force: true })
  })
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${passed} model checks passed`)
