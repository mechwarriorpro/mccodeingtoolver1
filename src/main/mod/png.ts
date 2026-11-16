import zlib from 'node:zlib'

/**
 * PNG encoding, by hand.
 *
 * Minecraft's textures are 16×16 PNGs (and the occasional animated strip), and
 * the app has to be able to *write* one: a generated model that points at a
 * texture which does not exist renders as the black-and-pink checkerboard, and
 * telling the user to go draw it in an external editor is not a feature.
 *
 * A PNG is small enough to write directly — signature, IHDR, one IDAT of
 * deflated scanlines, IEND, each chunk CRC32'd — so there is no image library
 * in the dependency tree for this. `zlib` is in Node already.
 *
 * Only what is needed is implemented: 8-bit RGBA, no interlacing, no palette,
 * no gamma chunks. That is what a texture is.
 */

/** CRC32, as the PNG specification requires it (not zlib's variant). */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

export interface Rgba {
  /** Width and height in pixels. Textures are almost always square and 16. */
  width: number
  height: number
  /** RGBA bytes, `width * height * 4`, row-major from the top-left. */
  data: Buffer
}

/**
 * Encode RGBA pixels as a PNG.
 *
 * Every scanline is prefixed with filter type 0 ("none"). Filtering exists to
 * help compression on photographs; on flat texture art it changes little and
 * costs a pass over the data, so it is deliberately not implemented.
 */
export function encodePng(image: Rgba): Buffer {
  const { width, height, data } = image
  if (width <= 0 || height <= 0) throw new Error(`a PNG needs a positive size, got ${width}x${height}`)
  if (data.length !== width * height * 4) {
    throw new Error(`expected ${width * height * 4} bytes of RGBA for ${width}x${height}, got ${data.length}`)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: truecolour with alpha
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace

  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    data.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    // Level 9: a 16x16 texture is a few hundred bytes either way, and the extra
    // time is microseconds against a texture that gets shipped in a jar.
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/**
 * Decode a PNG's header and, for the formats this app writes, its pixels.
 *
 * This exists to make the round trip testable: encoding without decoding proves
 * only that bytes were produced, not that they are a PNG. It handles 8-bit
 * truecolour with and without alpha, and rejects the rest by name so a failure
 * says which format it hit rather than "invalid PNG".
 */
export function decodePng(png: Buffer): Rgba {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < 8; i++) if (png[i] !== sig[i]) throw new Error('not a PNG: bad signature')

  let offset = 8
  let width = 0
  let height = 0
  let colourType = 0
  let bitDepth = 0
  const idat: Buffer[] = []

  while (offset < png.length) {
    const len = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    const body = png.subarray(offset + 8, offset + 8 + len)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      bitDepth = body[8]
      colourType = body[9]
      if (body[12] !== 0) throw new Error('interlaced PNGs are not supported')
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(body))
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + len
  }

  if (bitDepth !== 8) throw new Error(`only 8-bit PNGs are supported, this is ${bitDepth}-bit`)
  if (colourType !== 6 && colourType !== 2) {
    throw new Error(`only RGBA (6) and RGB (2) PNGs are supported, this is colour type ${colourType}`)
  }

  const channels = colourType === 6 ? 4 : 3
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(width * height * 4)
  const prior = Buffer.alloc(stride)
  const line = Buffer.alloc(stride)

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    raw.copy(line, 0, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    // Undo the per-scanline filter. Only "none" is written by encodePng, but a
    // real file from an editor will use the others, and a decoder that cannot
    // read those is not a check on anything.
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0
      const b = prior[x]
      const c = x >= channels ? prior[x - channels] : 0
      switch (filter) {
        case 1:
          line[x] = (line[x] + a) & 0xff
          break
        case 2:
          line[x] = (line[x] + b) & 0xff
          break
        case 3:
          line[x] = (line[x] + ((a + b) >> 1)) & 0xff
          break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
          break
        }
        default:
          break
      }
    }
    for (let x = 0; x < width; x++) {
      out[(y * width + x) * 4] = line[x * channels]
      out[(y * width + x) * 4 + 1] = line[x * channels + 1]
      out[(y * width + x) * 4 + 2] = line[x * channels + 2]
      out[(y * width + x) * 4 + 3] = channels === 4 ? line[x * channels + 3] : 255
    }
    line.copy(prior)
  }

  return { width, height, data: out }
}

/** Width and height from the header alone, without decoding the pixels. */
export function pngSize(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || png.toString('ascii', 12, 16) !== 'IHDR') throw new Error('not a PNG: no IHDR')
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}
