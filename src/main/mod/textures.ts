import { encodePng, type Rgba } from './png'

/**
 * Texture generation.
 *
 * Minecraft's art is 16×16 PNGs, and the style is specific: a flat mid-tone, a
 * slightly lighter top-left and darker bottom-right suggesting a light source,
 * and a few pixels of noise so the surface does not look like plastic. That is
 * arithmetic, not artistry — the same reason the block models are generated —
 * and it means a generated model can arrive with a texture that actually exists
 * instead of a checkerboard.
 *
 * What this is honest about: it makes *serviceable* textures in a coherent
 * palette. It does not make a convincing ore, a face, or a logo. Those are one
 * click away in an image editor, and the file it writes is a normal PNG, so it
 * opens in anything.
 */

export interface Rgb {
  r: number
  g: number
  b: number
}

/** A small set of palettes, so the default output does not need a colour picker. */
export const PALETTES: Record<string, { label: string; base: Rgb; note: string }> = {
  stone: { label: 'Stone', base: { r: 128, g: 128, b: 128 }, note: 'Neutral grey, the safe default for anything mineral.' },
  wood: { label: 'Wood', base: { r: 128, g: 92, b: 56 }, note: 'Planks and logs; brown with visible grain.' },
  metal: { label: 'Metal', base: { r: 176, g: 180, b: 186 }, note: 'Cold, light, low saturation — iron and steel.' },
  gem: { label: 'Gem', base: { r: 176, g: 56, b: 72 }, note: 'Saturated red; recolour for ruby, emerald, sapphire.' },
  organic: { label: 'Organic', base: { r: 96, g: 128, b: 64 }, note: 'Foliage and plant matter.' },
  dark: { label: 'Dark', base: { r: 52, g: 56, b: 64 }, note: 'Obsidian, deepslate, machine casings.' }
}

export type TexturePattern = 'flat' | 'noise' | 'grain' | 'brick' | 'ore' | 'metal' | 'planks' | 'frame'

export const PATTERNS: Record<TexturePattern, string> = {
  flat: 'One tone with a subtle light/dark gradient. The base for everything else.',
  noise: 'Random per-pixel variation. Reads as stone, gravel or concrete.',
  grain: 'Vertical streaks. Logs and planks, viewed end-on.',
  brick: 'Offset courses with mortar lines.',
  ore: 'Stone with clusters of bright mineral, for ores.',
  metal: 'Brushed horizontal streaks and a highlight along the top edge.',
  planks: 'Horizontal boards with dark gaps between them.',
  frame: 'A dark border around a lighter panel — machine casings and GUIs.'
}

/** Clamp and round, because every colour operation ends here. */
function px(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)))
}

/** Multiply a colour's brightness, keeping it in range. */
function shade(c: Rgb, factor: number): Rgb {
  return { r: px(c.r * factor), g: px(c.g * factor), b: px(c.b * factor) }
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return { r: px(a.r + (b.r - a.r) * t), g: px(a.g + (b.g - a.g) * t), b: px(a.b + (b.b - a.b) * t) }
}

/**
 * A deterministic pseudo-random number per pixel.
 *
 * Seeded from the texture name so regenerating "ruby_ore" twice gives the same
 * file. Random noise that changes on every run would make every generated
 * texture a diff in git, and the agent re-running a step would churn the repo.
 */
function hash(x: number, y: number, seed: number): number {
  let h = x * 374761393 + y * 668265263 + seed * 2246822519
  h = (h ^ (h >>> 13)) * 1274126177
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}

function seedOf(name: string): number {
  let s = 2166136261
  for (let i = 0; i < name.length; i++) {
    s ^= name.charCodeAt(i)
    s = Math.imul(s, 16777619)
  }
  return s >>> 0
}

export interface TextureOptions {
  /** Texture name, used as the noise seed so output is reproducible. */
  name: string
  /** Palette key, or an explicit base colour. */
  palette?: keyof typeof PALETTES
  base?: Rgb
  pattern?: TexturePattern
  /** Edge length in pixels. Minecraft's default is 16. */
  size?: number
  /** Draw nothing outside this shape (a sprite with transparent background). */
  transparentBackground?: boolean
}

/**
 * Generate one texture.
 *
 * The gradient is deliberately weak (about 6% top-to-bottom): Minecraft's own
 * textures are nearly flat, and a strong gradient makes an obvious repeating
 * tile when blocks are placed side by side. The edge lightening is the
 * convention that reads as "lit from above-left".
 */
export function generateTexture(opts: TextureOptions): Rgba {
  const size = opts.size ?? 16
  const base = opts.base ?? PALETTES[opts.palette ?? 'stone'].base
  const pattern = opts.pattern ?? 'noise'
  const seed = seedOf(opts.name)
  const data = Buffer.alloc(size * size * 4)
  const put = (x: number, y: number, c: Rgb, alpha = 255): void => {
    const i = (y * size + x) * 4
    data[i] = c.r
    data[i + 1] = c.g
    data[i + 2] = c.b
    data[i + 3] = alpha
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // A light source at the top-left, expressed as a brightness ramp.
      const t = (x + y) / (2 * (size - 1 || 1))
      const lit = 1.06 - t * 0.12
      let colour = shade(base, lit)

      switch (pattern) {
        case 'flat':
          break

        case 'noise': {
          const n = hash(x, y, seed) - 0.5
          colour = shade(colour, 1 + n * 0.16)
          break
        }

        case 'grain': {
          // Vertical streaks: one random value per column, plus a little dust.
          const column = hash(x, 0, seed) - 0.5
          const dust = hash(x, y, seed) - 0.5
          colour = shade(colour, 1 + column * 0.22 + dust * 0.06)
          // Ring lines every four pixels read as growth rings.
          if (x % 4 === 0) colour = shade(colour, 0.9)
          break
        }

        case 'brick': {
          const course = Math.floor(y / 4)
          // Offset alternate courses by half a brick, as brickwork is laid.
          const shifted = (x + (course % 2 ? 4 : 0)) % 8
          const mortar = y % 4 === 3 || shifted === 7
          colour = mortar ? shade(base, 0.62) : shade(colour, 1 + (hash(x, y, seed) - 0.5) * 0.1)
          break
        }

        case 'ore': {
          // Cluster the mineral so it looks embedded: a coarse cell decides
          // whether this pixel is mineral at all, and the fine noise trims it.
          const cell = hash(Math.floor(x / 2), Math.floor(y / 2), seed)
          const speck = hash(x, y, seed)
          const mineral = cell > 0.82 && speck > 0.3
          if (mineral) {
            const bright = mix(base, { r: 255, g: 255, b: 255 }, 0.25 + speck * 0.35)
            colour = shade(bright, 1.1)
          } else {
            // The surrounding stone must not share the mineral's palette, or the
            // ore reads as a flat colour swatch instead of something embedded.
            colour = shade({ r: 122, g: 122, b: 126 }, 1 + (hash(x, y, seed + 7) - 0.5) * 0.14)
          }
          break
        }

        case 'metal': {
          const brush = hash(0, y, seed) - 0.5
          colour = shade(colour, 1 + brush * 0.14)
          // A specular line along the top, and a shadow at the bottom.
          if (y === 0) colour = mix(colour, { r: 255, g: 255, b: 255 }, 0.45)
          if (y === size - 1) colour = shade(colour, 0.78)
          break
        }

        case 'planks': {
          const board = Math.floor(y / 4)
          const gap = y % 4 === 3
          colour = gap ? shade(base, 0.6) : shade(colour, 1 + (hash(x, y, seed + board) - 0.5) * 0.1)
          // Stagger the board ends so it does not read as a grid.
          const end = (board % 2 === 0 ? 5 : 11)
          if (!gap && x % size === end) colour = shade(colour, 0.85)
          break
        }

        case 'frame': {
          const border = x === 0 || y === 0 || x === size - 1 || y === size - 1
          const inner = x === 1 || y === 1 || x === size - 2 || y === size - 2
          if (border) colour = shade(base, 0.55)
          else if (inner) colour = shade(base, 1.15)
          else colour = shade(colour, 1 + (hash(x, y, seed) - 0.5) * 0.08)
          break
        }
      }

      put(x, y, colour, 255)
    }
  }

  if (opts.transparentBackground) return withItemSilhouette({ width: size, height: size, data }, base, seed)
  return { width: size, height: size, data }
}

/**
 * Clear the corners so an item texture has a silhouette instead of a square.
 *
 * `item/generated` models draw the texture as-is, so a fully opaque texture is a
 * square sprite. Minecraft's own items are cut-out shapes. This rounds the
 * corners and hollows the middle margin enough to read as an object rather than
 * a card, which is the difference between "generated" and "obviously generated".
 */
function withItemSilhouette(image: Rgba, base: Rgb, seed: number): Rgba {
  const { width, height, data } = image
  const cx = (width - 1) / 2
  const cy = (height - 1) / 2
  const radius = width / 2 - 0.5
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - cx
      const dy = y - cy
      // A soft radial cut: inside ~70% of the radius is solid, then a dithered
      // edge so the sprite does not look like a circle drawn with a ruler.
      const d = Math.sqrt(dx * dx + dy * dy) / radius
      const keep = d < 0.72 || (d < 0.95 && hash(x, y, seed + 31) > (d - 0.72) / 0.23)
      if (!keep) {
        const i = (y * width + x) * 4
        data[i + 3] = 0
      } else if (d < 0.78) {
        // A rim of lighter colour where the object turns away from the light.
        const i = (y * width + x) * 4
        const rim = shade(base, 1.25)
        data[i] = rim.r
        data[i + 1] = rim.g
        data[i + 2] = rim.b
      }
    }
  }
  return image
}

/** Encode a generated texture as the PNG that goes in the mod's assets. */
export function texturePng(opts: TextureOptions): Buffer {
  return encodePng(generateTexture(opts))
}

/**
 * The texture path for a block or item, without the assets prefix.
 *
 * A block texture is `block/<name>`, an item `item/<name>`; both are then
 * referenced as `<modid>:block/<name>`. Kept here so the panel, the agent tool
 * and the tests agree on the convention instead of each spelling it slightly
 * differently.
 */
export function texturePathFor(kind: 'block' | 'item', name: string): string {
  return `${kind}/${name}`
}
