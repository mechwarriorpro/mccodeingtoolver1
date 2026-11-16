/**
 * Texture references for generated models.
 *
 * A model is a set of quads pointing at a texture *id*. Every failure here is
 * silent: an unnamespaced id, a doubled prefix or a missing extension produces
 * the black-and-pink checkerboard and nothing in the log. So the normalisation
 * is in one place and tested, rather than repeated in each caller.
 */

/**
 * Turn what a user typed into a legal texture id.
 *
 * Accepts `ruby_block`, `block/ruby_block`, `ruby:block/ruby_block`,
 * `assets/ruby/textures/block/ruby_block.png` and the Windows variant with
 * backslashes, because people paste whichever they have in front of them.
 */
export function textureRef(modId: string, input: string | undefined | null, fallback: string): string {
  const folder = fallback.includes('/') ? fallback.slice(0, fallback.lastIndexOf('/') + 1) : ''
  let raw = (input ?? '').trim() || fallback
  raw = raw.replace(/\\/g, '/').replace(/^\/+/, '')
  // A full path is a path, not an id: keep what follows textures/.
  const afterTextures = raw.match(/textures\/(.+)$/)
  if (afterTextures) raw = afterTextures[1]
  // The model refers to a texture, not to a file.
  raw = raw.replace(/\.(png|tga|jpg|jpeg)$/i, '')
  // assets/<namespace>/ is a filesystem path; the namespace is the only useful part.
  const assets = raw.match(/^assets\/([^/]+)\//)
  if (assets) raw = `${assets[1]}:${raw.slice(assets[0].length)}`

  // An explicit namespace is a deliberate choice — vanilla blocks are
  // legitimate on a modded model — so it is preserved. What is not deliberate
  // is a namespace repeated by pasting a full id into an id field.
  let namespace = modId
  let rest = raw
  const colon = raw.indexOf(':')
  if (colon >= 0) {
    namespace = raw.slice(0, colon)
    rest = raw.slice(colon + 1)
    while (rest.startsWith(`${namespace}:`)) rest = rest.slice(namespace.length + 1)
  }
  // A bare name has no folder, and textures without one are conventionally
  // wrong (and easy to mislay), so the caller's fallback folder supplies it.
  if (!rest.includes('/') && folder) rest = `${folder}${rest}`
  return `${namespace}:${rest}`
}

/**
 * The file a texture id points at, for the "add a texture here" instruction.
 * Empty when the id has no texture (an `#all` reference to another key).
 */
export function textureFile(modId: string, ref: string): string {
  if (ref.startsWith('#')) return ''
  const [ns, p] = ref.includes(':') ? [ref.slice(0, ref.indexOf(':')), ref.slice(ref.indexOf(':') + 1)] : [modId, ref]
  return `src/main/resources/assets/${ns}/textures/${p}.png`
}
