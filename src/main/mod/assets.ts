/**
 * Where a model lives depends on the Minecraft version, and the change is a
 * cliff, not a slope.
 *
 * 1.12 and earlier: one `models/block/foo.json` for every block *and* every
 * metadata variant, one `blockstates/foo.json` that may hold stateless JSON or
 * a variant map, item models in `models/item/`, and entity models are **Java
 * class code** (`ModelBase` + `ModelRenderer`) or a Techne/Tabula `.tcn`, not
 * JSON at all. There is no `geo/` folder and no animation JSON.
 *
 * 1.13 and later: models are still `models/block` and `models/item`, but the
 * blockstate file must map every property combination to a `{model}` object,
 * and item models usually inherit from `item/generated`. Bedrock geometry and
 * animations become available to mods via loaders that read `geo/` and
 * `animations/`.
 *
 * Telling an agent "put it in models/block" without the version is how a 1.12
 * mod ends up with folders the game never reads, so this module answers the
 * question instead of leaving it to the prompt.
 */

export interface AssetLayout {
  /** Version this layout describes, as the project declared it. */
  mcVersion: string
  /** True when paths are the pre-1.13 ("legacy") layout. */
  legacy: boolean
  /** Folder for block models, relative to the mod's asset root. */
  blockModels: string
  itemModels: string
  blockstates: string
  /** Entity geometry folder, or null when the version has no JSON entity models. */
  geo: string | null
  /** Animation folder, or null when the version has no Bedrock animations. */
  animations: string | null
  /** Container for the mod's assets within a Gradle project. */
  assetRoot: string
  /** One line the agent can act on. */
  note: string
}

/** Compare "1.21.1" style versions, tolerating missing or trailing parts. */
function versionParts(v: string): number[] {
  const m = v.match(/\d+(?:\.\d+)*/)
  if (!m) return []
  return m[0].split('.').map((p) => Number(p) || 0)
}

/** True when `mcVersion` is at least `min`. Unknown versions are treated as modern. */
export function atLeast(mcVersion: string, min: string): boolean {
  const a = versionParts(mcVersion)
  const b = versionParts(min)
  if (!a.length) return true
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    if (av !== bv) return av > bv
  }
  return true
}

/**
 * The asset layout for a project's Minecraft version.
 *
 * `assetRoot` is for a Gradle project (`src/main/resources/assets/<modid>`);
 * a legacy project that keeps resources outside Gradle passes its own root via
 * `sourceRoot`.
 */
export function assetLayout(opts: { mcVersion: string; modId: string; sourceRoot?: string }): AssetLayout {
  const mc = opts.mcVersion || '1.21.1'
  const legacy = !atLeast(mc, '1.13')
  const root = opts.sourceRoot ?? 'src/main/resources'
  const assetRoot = `${root}/assets/${opts.modId || 'modid'}`
  if (legacy) {
    return {
      mcVersion: mc,
      legacy,
      blockModels: `${assetRoot}/models/block`,
      itemModels: `${assetRoot}/models/item`,
      blockstates: `${assetRoot}/blockstates`,
      // Not an omission: 1.12 entity models are Java classes extending
      // ModelBase, registered with RenderingRegistry. A .json here is ignored.
      geo: null,
      animations: null,
      assetRoot,
      note:
        `Minecraft ${mc} has no JSON entity models and no Bedrock animations. ` +
        'Blocks and items use the same models/block and models/item folders as modern versions, ' +
        'but a blockstate file is either stateless JSON or a variant map with "normal"/"inventory" keys, ' +
        'and entity models must be Java (ModelBase + ModelRenderer registered in a client proxy). ' +
        'If the user wants a mob model here, write the Java model class — a .geo.json will be ignored.'
    }
  }
  return {
    mcVersion: mc,
    legacy,
    blockModels: `${assetRoot}/models/block`,
    itemModels: `${assetRoot}/models/item`,
    blockstates: `${assetRoot}/blockstates`,
    geo: `${assetRoot}/geo`,
    animations: `${assetRoot}/animations`,
    assetRoot,
    note:
      `Minecraft ${mc} uses modern asset paths. Blockstates must map each property combination ` +
      'to a model object; item models usually inherit from item/generated. Bedrock-style ' +
      'geometry in geo/ and animations in animations/ are readable when the loader supports them.'
  }
}

/**
 * The blockstate JSON a block needs for its model to be visible at all.
 *
 * The two eras want different shapes, and writing the modern one into a 1.12
 * project produces a block with no texture and no error.
 */
export function blockstateJson(opts: { mcVersion: string; modelId: string; legacyVariant?: string }): string {
  const legacy = !atLeast(opts.mcVersion, '1.13')
  if (legacy) {
    // 1.12: either {"model": ...} or {"variants": {"normal": {...}, "inventory": {...}}}.
    const body = {
      variants: {
        [opts.legacyVariant ?? 'normal']: { model: opts.modelId },
        inventory: { model: opts.modelId }
      }
    }
    return JSON.stringify(body, null, 2) + '\n'
  }
  return JSON.stringify({ variants: { '': { model: opts.modelId } } }, null, 2) + '\n'
}

/**
 * What the agent should be told about models for this specific project. Empty
 * string when the version is modern and the general guidance already covers it,
 * because a repeated paragraph is a paragraph the model learns to skip.
 */
export function modelGuidance(opts: { mcVersion: string; modId: string; sourceRoot?: string }): string {
  const layout = assetLayout(opts)
  if (!layout.legacy) return ''
  return `- This project is **Minecraft ${opts.mcVersion}**, so asset paths are the pre-1.13 layout: ${layout.blockModels} and ${layout.itemModels}, and the blockstate goes in ${layout.blockstates} with "normal"/"inventory" variant keys, not a single "" variant.
- **There is no JSON entity model here.** A 1.12 mob model is a Java class extending \`net.minecraft.client.model.ModelBase\` with \`ModelRenderer\` parts, registered in \`ClientProxy\` via \`RenderingRegistry.registerEntityRenderingHandler\`. Do not write a .geo.json and do not promise a Bedrock animation — the game ignores both. Write the Java model class instead.
- Do not create a \`geo/\` or \`animations/\` folder in this project. Those only mean something from 1.13 onward with a loader that reads them.
- \`make_model\` refuses entity and animation output for this version on purpose (see its error) — use it for blocks and items only.`
}
