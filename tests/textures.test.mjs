import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import zlib from 'node:zlib'

/**
 * The PNG encoder and the texture generator, at the byte level.
 *
 * Encoding without decoding proves only that *some* bytes came out. These checks
 * parse what was written the way a PNG reader does — signature, chunk CRCs,
 * inflate the IDAT, undo the scanline filter — because a texture with a bad CRC
 * or a wrong colour type is rejected by the game, and the error is a blank
 * texture with nothing in the log.
 */

const out = path.join(process.cwd(), 'out-test', 'main')
const load = (file) => import(pathToFileURL(path.join(out, file)).href)
const { encodePng, decodePng, pngSize } = await load('mod/png.js')
const { generateTexture, texturePng, texturePathFor, PATTERNS, PALETTES } = await load('mod/textures.js')

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

/** Parse a PNG independently of the decoder under test. */
function parsePng(buf) {
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'bad signature')
  const chunks = []
  let off = 8
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const body = buf.subarray(off + 8, off + 8 + len)
    // The CRC covers the type and the body, and a reader checks it.
    const crc = buf.readUInt32BE(off + 8 + len)
    assert.equal(crc, zlib.crc32(buf.subarray(off + 4, off + 8 + len)), `CRC mismatch in ${type}`)
    chunks.push({ type, body })
    off += 12 + len
  }
  return chunks
}

function solid(w, h, r, g, b, a = 255) {
  const data = Buffer.alloc(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = r
    data[i * 4 + 1] = g
    data[i * 4 + 2] = b
    data[i * 4 + 3] = a
  }
  return { width: w, height: h, data }
}

/* --------------------------------------------------------------------- PNG */

check('the encoder writes a structurally valid PNG', () => {
  const chunks = parsePng(encodePng(solid(16, 16, 200, 30, 30)))
  assert.deepEqual(
    chunks.map((c) => c.type),
    ['IHDR', 'IDAT', 'IEND'],
    'a minimal PNG is exactly IHDR, IDAT, IEND'
  )
  const ihdr = chunks[0].body
  assert.equal(ihdr.readUInt32BE(0), 16)
  assert.equal(ihdr.readUInt32BE(4), 16)
  assert.equal(ihdr[8], 8, 'bit depth')
  assert.equal(ihdr[9], 6, 'colour type 6 = truecolour + alpha')
  assert.equal(ihdr[12], 0, 'not interlaced')
})

check('every scanline carries the filter byte the format requires', () => {
  const png = encodePng(solid(8, 4, 1, 2, 3))
  const idat = parsePng(png)[1].body
  const raw = zlib.inflateSync(idat)
  // 4 rows of (8*4 + 1) bytes: one filter byte plus RGBA per pixel.
  assert.equal(raw.length, 4 * (8 * 4 + 1))
  for (let y = 0; y < 4; y++) assert.equal(raw[y * 33], 0, `row ${y} has no filter byte`)
})

check('pixels round-trip exactly', () => {
  const img = solid(16, 16, 12, 200, 99, 128)
  // Break the uniformity so a positional bug cannot pass.
  img.data[0] = 1
  img.data[16 * 4 + 4] = 250
  const back = decodePng(encodePng(img))
  assert.equal(back.width, 16)
  assert.equal(back.height, 16)
  assert.equal(Buffer.compare(back.data, img.data), 0)
})

check('the header reports the size without decoding', () => {
  assert.deepEqual(pngSize(encodePng(solid(16, 16, 0, 0, 0))), { width: 16, height: 16 })
  assert.deepEqual(pngSize(encodePng(solid(64, 64, 0, 0, 0))), { width: 64, height: 64 })
})

check('a malformed image is refused rather than written', () => {
  // Wrong byte count is the shape of the bug that produces a corrupt file.
  assert.throws(() => encodePng({ width: 16, height: 16, data: Buffer.alloc(10) }), /expected 1024 bytes/)
  assert.throws(() => encodePng({ width: 0, height: 16, data: Buffer.alloc(0) }), /positive size/)
})

check('a non-PNG is rejected by the decoder', () => {
  assert.throws(() => decodePng(Buffer.from('this is not a png at all')), /not a PNG/)
})

check('a real editor PNG with per-scanline filters decodes correctly', () => {
  // Hand-build a 2x2 PNG using Sub (1) and Up (2) filters, which is what
  // encoders pick in practice. If the decoder ignored the filter byte, the
  // second row would be wrong by exactly the first row's values.
  const rows = [
    // Sub (1): the first pixel of a row is raw, later ones are the delta from
    // the previous pixel — including alpha, which stays 255 because the delta
    // is +0.
    [1, 10, 20, 30, 255, 5, 5, 5, 0],
    // Up (2): every byte is the delta from the row above. Alpha above is 255,
    // so a delta of +1 gives 0 (256 wraps to 0) and a delta of 0 keeps 255.
    [2, 1, 1, 1, 1, 1, 1, 1, 0]
  ]
  const raw = Buffer.from(rows.flat())
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(2, 0)
  ihdr.writeUInt32BE(2, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const chunk = (type, body) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(body.length, 0)
    const tb = Buffer.from(type, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([tb, body])) >>> 0, 0)
    return Buffer.concat([len, tb, body, crc])
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
  const img = decodePng(png)
  // Row 0: (10,20,30), then (10+5, 20+5, 30+5)
  assert.deepEqual([...img.data.subarray(0, 4)], [10, 20, 30, 255])
  assert.deepEqual([...img.data.subarray(4, 8)], [15, 25, 35, 255], 'alpha must carry through a Sub-filtered row')
  // Row 1: previous row plus the delta.
  assert.deepEqual([...img.data.subarray(8, 12)], [11, 21, 31, 0], 'alpha wraps: 255 + 1')
  assert.deepEqual([...img.data.subarray(12, 16)], [16, 26, 36, 255], 'alpha is unchanged by a zero delta')
})

/* ---------------------------------------------------------------- textures */

check('a texture is the size asked for, and 16x16 by default', () => {
  assert.deepEqual(pngSize(texturePng({ name: 'x' })), { width: 16, height: 16 })
  assert.deepEqual(pngSize(texturePng({ name: 'x', size: 32 })), { width: 32, height: 32 })
})

check('every pattern produces fully opaque pixels with no transparent holes', () => {
  for (const pattern of Object.keys(PATTERNS)) {
    const img = generateTexture({ name: `t_${pattern}`, pattern, palette: 'stone' })
    assert.equal(img.data.length, 16 * 16 * 4, `${pattern} has the wrong byte count`)
    for (let i = 3; i < img.data.length; i += 4) {
      assert.equal(img.data[i], 255, `${pattern} has a transparent pixel`)
    }
  }
})

check('a texture is deterministic, so regenerating does not churn the repo', () => {
  const a = generateTexture({ name: 'ruby_ore', pattern: 'ore', palette: 'gem' })
  const b = generateTexture({ name: 'ruby_ore', pattern: 'ore', palette: 'gem' })
  assert.equal(Buffer.compare(a.data, b.data), 0)
  // Different names must differ, or every ore would be identical.
  const c = generateTexture({ name: 'sapphire_ore', pattern: 'ore', palette: 'gem' })
  assert.notEqual(Buffer.compare(a.data, c.data), 0)
})

check('the palette actually changes the colour', () => {
  const gem = generateTexture({ name: 'x', pattern: 'flat', palette: 'gem' })
  const stone = generateTexture({ name: 'x', pattern: 'flat', palette: 'stone' })
  assert.notEqual(gem.data[0], stone.data[0], 'red channel should differ between gem and stone')
  assert.ok(gem.data[0] > gem.data[2], 'gem should be red-dominant')
  assert.equal(stone.data[0], stone.data[1], 'stone should be grey: r == g')
})

check('the gradient is subtle, not a visible ramp', () => {
  // A strong gradient tiles visibly when blocks are placed side by side.
  const img = generateTexture({ name: 'x', pattern: 'flat', palette: 'stone' })
  const topLeft = img.data[0]
  const bottomRight = img.data[(15 * 16 + 15) * 4]
  const delta = topLeft - bottomRight
  assert.ok(delta > 0, 'the top-left should be lighter than the bottom-right')
  assert.ok(delta < 40, `the gradient is too strong: ${delta} levels across 16 pixels`)
})

check('ore has two clearly distinct materials, not one flat colour', () => {
  const img = generateTexture({ name: 'ruby_ore', pattern: 'ore', palette: 'gem' })
  const colours = new Set()
  for (let i = 0; i < img.data.length; i += 4) colours.add(`${img.data[i]},${img.data[i + 1]},${img.data[i + 2]}`)
  assert.ok(colours.size > 20, `an ore needs mineral and stone; found only ${colours.size} colours`)
  // The mineral should be markedly more saturated than the stone around it.
  const reds = []
  for (let i = 0; i < img.data.length; i += 4) reds.push(img.data[i] - img.data[i + 1])
  assert.ok(Math.max(...reds) > 60, 'no strongly red mineral pixels found')
})

check('brick has mortar lines that are darker than the bricks', () => {
  const img = generateTexture({ name: 'b', pattern: 'brick', palette: 'stone' })
  const at = (x, y) => img.data[(y * 16 + x) * 4]
  // y=3 is a mortar course by construction.
  assert.ok(at(5, 3) < at(5, 1), 'the mortar course should be darker than the brick above it')
})

check('planks have horizontal gaps', () => {
  const img = generateTexture({ name: 'p', pattern: 'planks', palette: 'wood' })
  const at = (x, y) => img.data[(y * 16 + x) * 4]
  assert.ok(at(8, 3) < at(8, 1), 'the gap between boards should be darker')
})

check('an item silhouette clears the corners but keeps the middle', () => {
  const square = generateTexture({ name: 'gem', pattern: 'flat', palette: 'gem', transparentBackground: false })
  const cut = generateTexture({ name: 'gem', pattern: 'flat', palette: 'gem', transparentBackground: true })
  assert.equal(square.data[3], 255, 'a plain texture is opaque at the corner')
  assert.equal(cut.data[3], 0, 'the silhouette should clear the corner')
  // The centre must survive or the item is invisible.
  const centre = (7 * 16 + 7) * 4 + 3
  assert.equal(cut.data[centre], 255, 'the silhouette removed the middle of the sprite')
})

check('texturePathFor is the convention the models use', () => {
  assert.equal(texturePathFor('block', 'ruby_block'), 'block/ruby_block')
  assert.equal(texturePathFor('item', 'ruby_gem'), 'item/ruby_gem')
})

check('every palette is a usable base colour', () => {
  for (const [key, def] of Object.entries(PALETTES)) {
    for (const ch of ['r', 'g', 'b']) {
      assert.ok(def.base[ch] >= 0 && def.base[ch] <= 255, `${key} has an out-of-range ${ch}`)
    }
    assert.ok(def.note.length > 10, `${key} has no explanation`)
  }
})

/* ------------------------------------------------------------------ files */

check('a written texture is a readable PNG on disk', () => {
  const dir = path.join(process.cwd(), 'out-test', 'textures-scratch')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'ruby_block.png')
  fs.writeFileSync(file, texturePng({ name: 'ruby_block', pattern: 'ore', palette: 'gem' }))
  const back = decodePng(fs.readFileSync(file))
  assert.equal(back.width, 16)
  assert.equal(back.height, 16)
  parsePng(fs.readFileSync(file))
  fs.rmSync(dir, { recursive: true, force: true })
})

console.log(`\n${passed} texture checks passed`)
