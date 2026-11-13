import { atLeast } from './assets'

/**
 * Shader packs, rendering engines, and which one to use for what.
 *
 * Two categories, and conflating them is the mistake this module exists to
 * prevent:
 *
 *  - **Shader packs** are what a *player* installs. They change how the world
 *    looks. A mod cannot ship one, and cannot depend on one.
 *  - **Rendering engines and APIs** are what a *mod developer* builds on. They
 *    give code framebuffers, custom pipelines and instancing.
 *
 * Flywheel is in the second group, not the first — it is an instancing engine,
 * not a shader. Sodium is in the second group too, and has no shader API at all.
 * Iris is a pack loader. The popular packs (Complementary, BSL, Photon, SEUS)
 * are all first-group: art, not code.
 *
 * Everything here is data so the UI can list it and the agent can recommend from
 * it, and so a wrong claim is a wrong value in one place rather than prose
 * scattered through a prompt.
 */

/* --------------------------------------------------------------- shader packs */

export interface ShaderPack {
  id: string
  name: string
  author: string
  /** What it looks like, in a few words. */
  style: 'vanilla-plus' | 'realistic' | 'fantasy' | 'cinematic' | 'performance'
  /** Rough cost. `performance` packs are the only ones safe on integrated GPUs. */
  weight: 'light' | 'medium' | 'heavy' | 'extreme'
  /** Which pack loaders will run it. */
  runsOn: ('iris' | 'optifine')[]
  /** Approximate floor, as the pack's own pages describe it. */
  minGpu: string
  /** Why someone picks this one. */
  bestFor: string
  /** What it costs. */
  caveat: string
  url: string
  /**
   * Relative popularity: a download-order rank from Modrinth/CurseForge figures,
   * not an exact count. Kept only for ordering suggestions.
   */
  popularity: number
}

/**
 * The packs people actually install, ordered by rough download volume.
 *
 * Every one of these is a *user* install: it goes in `shaderpacks/` next to a
 * pack loader, not in the mod's jar. The agent should never offer to "add
 * Complementary to the mod".
 */
export const SHADER_PACKS: ShaderPack[] = [
  {
    id: 'complementary-reimagined',
    name: 'Complementary Reimagined',
    author: 'EminGT',
    style: 'vanilla-plus',
    weight: 'medium',
    runsOn: ['iris', 'optifine'],
    minGpu: 'GTX 960 / RX 560 class',
    bestFor:
      'The default recommendation. Reworked vanilla look with coloured light, shadows and reflections, and profiles from Potato to Ultra so it scales.',
    caveat: 'Not the most "realistic" and not trying to be; if you want photographic, look at Photon or SEUS.',
    url: 'https://modrinth.com/shader/complementary-reimagined',
    popularity: 1
  },
  {
    id: 'complementary-unbound',
    name: 'Complementary Unbound',
    author: 'EminGT',
    style: 'realistic',
    weight: 'heavy',
    runsOn: ['iris', 'optifine'],
    minGpu: 'GTX 1060 / RX 580 class',
    bestFor: 'The same codebase tuned more neutral and realistic, for people who find Reimagined too stylised.',
    caveat: 'Costs more than Reimagined for a subtler change; most people are happy with Reimagined.',
    url: 'https://modrinth.com/shader/complementary-unbound',
    popularity: 2
  },
  {
    id: 'bsl',
    name: 'BSL Shaders',
    author: 'CaptTatsu',
    style: 'fantasy',
    weight: 'medium',
    runsOn: ['iris', 'optifine'],
    minGpu: 'GTX 960 / RX 560 class',
    bestFor: 'Bright, saturated and cinematic: soft light, good water, wind-swept plants. The classic "pretty Minecraft" look.',
    caveat: 'The colour grading is a strong opinion. Blue nights and warm days are not neutral.',
    url: 'https://modrinth.com/shader/bsl-shaders',
    popularity: 3
  },
  {
    id: 'makeup-ultrafast',
    name: 'MakeUp Ultra Fast',
    author: 'KDXavier',
    style: 'performance',
    weight: 'light',
    runsOn: ['iris', 'optifine'],
    minGpu: 'integrated graphics',
    bestFor: 'The one to use on a laptop or an old card: real shadows and water without the frame cost.',
    caveat: 'It looks like a light shader. Do not expect volumetric anything.',
    url: 'https://modrinth.com/shader/makeup-ultra-fast-shaders',
    popularity: 4
  },
  {
    id: 'sildurs-vibrant',
    name: "Sildur's Vibrant Shaders",
    author: 'Sildur',
    style: 'fantasy',
    weight: 'medium',
    runsOn: ['iris', 'optifine'],
    minGpu: 'GTX 960 / RX 560 class',
    bestFor: 'One pack with Lite → Extreme tiers, so you can pick the cost yourself.',
    caveat: 'The higher tiers climb faster than the visuals justify.',
    url: 'https://sildurs-shaders.github.io/',
    popularity: 5
  },
  {
    id: 'photon',
    name: 'Photon',
    author: 'SixthSurge',
    style: 'realistic',
    weight: 'heavy',
    runsOn: ['iris'],
    minGpu: 'GTX 1050 / RX 560 class',
    bestFor:
      'Semi-realistic and gameplay-focused: layered clouds, weather that changes the sky day to day, volumetric fog, screen-space reflections.',
    caveat: 'Coloured lighting and the Ultra profile need Iris specifically; recent builds do not target OptiFine.',
    url: 'https://modrinth.com/shader/photon-shader',
    popularity: 6
  },
  {
    id: 'bliss',
    name: 'Bliss',
    author: 'X0nk',
    style: 'fantasy',
    weight: 'heavy',
    runsOn: ['iris', 'optifine'],
    minGpu: 'GTX 1060 / RX 580 class',
    bestFor: 'Atmosphere and colour; sits between BSL and SEUS PTGI on cost.',
    caveat: 'Heavier than it looks in screenshots; tune the profile down before blaming the mod.',
    url: 'https://modrinth.com/shader/bliss-shader',
    popularity: 7
  },
  {
    id: 'rethinking-voxels',
    name: 'Rethinking Voxels',
    author: 'gri573',
    style: 'cinematic',
    weight: 'extreme',
    runsOn: ['iris'],
    minGpu: 'GTX 1060 / RX 580 class or better',
    bestFor: 'Coloured block light that casts sharp, voxel-accurate shadows. The cheapest way to a "ray-traced" look.',
    caveat:
      'It is an edit of Complementary Reimagined with a much higher cost, and it needs Iris on current versions — OptiFine builds stopped around 1.19.4.',
    url: 'https://modrinth.com/shader/rethinking-voxels',
    popularity: 8
  },
  {
    id: 'seus-ptgi',
    name: 'SEUS PTGI',
    author: 'Sonic Ether',
    style: 'cinematic',
    weight: 'extreme',
    runsOn: ['optifine'],
    minGpu: 'RTX 3060 / RX 6700 XT class',
    bestFor:
      'The closest thing to path tracing in Java Edition: global illumination that actually bounces light between surfaces.',
    caveat:
      'OptiFine only, not Iris — so no Sodium alongside it. It is a screenshot tool, not a daily driver on consumer hardware.',
    url: 'https://www.sonicether.com/seus/',
    popularity: 9
  },
  {
    id: 'super-duper-vanilla',
    name: 'Super Duper Vanilla',
    author: 'xKingDark',
    style: 'vanilla-plus',
    weight: 'light',
    runsOn: ['iris', 'optifine'],
    minGpu: 'GTX 960 / RX 560 class',
    bestFor: 'A subtle upgrade to vanilla lighting for people who do not want their game to look different.',
    caveat: 'If someone asked for "amazing graphics", this is not what they meant.',
    url: 'https://modrinth.com/shader/super-duper-vanilla',
    popularity: 10
  },
  {
    id: 'kappa',
    name: 'Kappa Shader',
    author: 'RRe36',
    style: 'cinematic',
    weight: 'heavy',
    runsOn: ['iris', 'optifine'],
    minGpu: 'GTX 1060 / RX 580 class',
    bestFor: 'Filmic, high-contrast look with strong atmospheric scattering.',
    caveat: 'Opinionated grading; not a neutral baseline.',
    url: 'https://modrinth.com/shader/kappa-shader',
    popularity: 11
  },
  {
    id: 'nostalgia',
    name: 'Nostalgia Shader',
    author: 'RRe36',
    style: 'vanilla-plus',
    weight: 'light',
    runsOn: ['iris', 'optifine'],
    minGpu: 'GTX 950 class',
    bestFor: 'The old Minecraft trailer look: warm, hazy, low contrast.',
    caveat: 'Deliberately dated. It is a mood, not an upgrade.',
    url: 'https://modrinth.com/shader/nostalgia-shader',
    popularity: 12
  }
]

/* ------------------------------------------------- rendering engines / APIs */

export type EngineKind = 'pack-loader' | 'perf' | 'sdk' | 'instancing' | 'legacy'

export interface RenderEngine {
  id: string
  name: string
  kind: EngineKind
  /** What a mod developer gets out of it. */
  gives: string
  /** The misconception to head off. */
  misread: string
  /** Loaders it ships for. */
  loaders: ('fabric' | 'forge' | 'neoforge')[]
  /** Inclusive Minecraft range, as the project lists it. */
  versions: { min: string; max?: string }
  /** Whether a mod may depend on it (vs. the user installing it). */
  dependOn: boolean
  /** Things that must be installed alongside, or must not be. */
  needs?: string[]
  conflicts?: string[]
  url: string
  /** One line on the cost. */
  cost: string
}

/**
 * The engines and APIs a mod actually builds against.
 *
 * `dependOn: true` means it is a library a mod may declare as a dependency and
 * ship against. `false` means the player installs it and mod code merely has to
 * tolerate it.
 */
export const RENDER_ENGINES: RenderEngine[] = [
  {
    id: 'veil',
    name: 'Veil',
    kind: 'sdk',
    gives:
      'The closest thing to a real rendering SDK for Minecraft mods: JSON-driven framebuffers, a custom post-processing pipeline, support for every OpenGL shader stage, and the ability to inject and modify existing shaders.',
    misread:
      'It is a library you ship against, not a shader pack — a player does not install Veil to get prettier water. It is what Create: Aeronautics uses for its wings and contrails.',
    loaders: ['fabric', 'neoforge'],
    versions: { min: '1.21' },
    dependOn: true,
    needs: ['Iris Veil Compat, if a shader pack is also in use'],
    url: 'https://github.com/FoundryMC/Veil',
    cost: 'Young project with a narrow version range (1.21.x). Adding it is a hard dependency for anyone using your mod.'
  },
  {
    id: 'flywheel',
    name: 'Flywheel',
    kind: 'instancing',
    gives:
      'GPU-instanced rendering for modded entities and block entities: thousands of repeated parts (Create\'s cogs, shafts, belts) in a handful of draw calls, with a custom shader and templating system for those instanced draws.',
    misread:
      '**Not a shader API and not an Iris alternative.** It gives no post-processing, no world PBR and no shadows. It solves draw-call volume.',
    loaders: ['forge', 'neoforge', 'fabric'],
    versions: { min: '1.16' },
    dependOn: true,
    needs: ['Iris & Oculus Flywheel Compat, when a shader pack is active'],
    url: 'https://github.com/Jozufozu/Flywheel',
    cost:
      'Switches its optimisations off while a shaderpack is loaded, because its shaders and the pack cannot both own the pipeline. The compat mod exists to force them together.'
  },
  {
    id: 'iris',
    name: 'Iris',
    kind: 'pack-loader',
    gives:
      'Runs OptiFine-format shader packs (PBR, shadows, reflections) on Fabric, NeoForge and Quilt. It is the loader; the look comes from the pack.',
    misread:
      'Not something a mod depends on to draw an effect, and not a renderer of its own. Without a pack installed it does nothing visible.',
    loaders: ['fabric', 'neoforge'],
    versions: { min: '1.16.5' },
    dependOn: false,
    needs: ['Sodium on current builds', 'The user’s chosen shader pack'],
    url: 'https://irisshaders.dev/',
    cost: 'A pack replaces much of the pipeline, so mod-side rendering that assumes vanilla state can look wrong. Test with a pack on.'
  },
  {
    id: 'oculus',
    name: 'Oculus',
    kind: 'pack-loader',
    gives: 'The Forge port of Iris, for Forge versions where Iris is not published.',
    misread: 'Same feature set as Iris — do not list both as options for one project.',
    loaders: ['forge', 'neoforge'],
    versions: { min: '1.16.5', max: '1.20.1' },
    dependOn: false,
    needs: ['Embeddium (current builds) or Rubidium (old ones)'],
    conflicts: ['Rubidium and Embeddium together — pick one'],
    url: 'https://www.curseforge.com/minecraft/mc-mods/oculus',
    cost: 'Stops at 1.20.1. On NeoForge 1.21+ it has no build, so Iris is the only option there.'
  },
  {
    id: 'sodium',
    name: 'Sodium',
    kind: 'perf',
    gives: 'A rewritten chunk renderer: large frame-rate gains with no visual change, plus a rendering API other mods integrate with.',
    misread: '**No shader API.** It is a terrain optimiser; Iris is the shader loader that pairs with it.',
    loaders: ['fabric'],
    versions: { min: '1.16' },
    dependOn: false,
    url: 'https://sodiummc.net/',
    cost: 'Replaces the chunk renderer, so mods that hook terrain rendering break or need an integration.'
  },
  {
    id: 'embeddium',
    name: 'Embeddium',
    kind: 'perf',
    gives: 'Sodium’s terrain renderer for Forge and NeoForge, from the last FOSS-licensed Sodium codebase, with extra mod-compatibility fixes.',
    misread: 'Forge/NeoForge only — on Fabric you want Sodium itself.',
    loaders: ['forge', 'neoforge'],
    versions: { min: '1.16', max: '1.21.1' },
    dependOn: false,
    conflicts: ['Rubidium'],
    url: 'https://modrinth.com/mod/embeddium',
    cost: 'Same class of risk as Sodium for terrain hooks, plus it bundles the Fabric Rendering API so Indium is unnecessary.'
  },
  {
    id: 'rubidium',
    name: 'Rubidium',
    kind: 'perf',
    gives: 'The older Forge Sodium port. Superseded by Embeddium.',
    misread: 'Old builds only. If a guide says "Oculus needs Rubidium", it is out of date.',
    loaders: ['forge'],
    versions: { min: '1.16', max: '1.19.2' },
    dependOn: false,
    conflicts: ['Embeddium'],
    url: 'https://www.curseforge.com/minecraft/mc-mods/rubidium',
    cost: 'Unmaintained on current versions; conflicts with Embeddium.'
  },
  {
    id: 'optifine',
    name: 'OptiFine',
    kind: 'legacy',
    gives: 'Shader packs, performance options and a pile of visual toggles in one closed-source patch. The only route below 1.16.',
    misread: 'Not a mod API. Packs are written against it, and a mod cannot depend on it cleanly.',
    loaders: ['forge'],
    versions: { min: '1.7' },
    dependOn: false,
    url: 'https://optifine.net/',
    cost: 'Patches the game aggressively and conflicts with Sodium/Iris-era mods. On 1.12 it is still what people run.'
  }
]

/* ------------------------------------------------------------------ results */

export type UseCase =
  | 'looks'
  | 'performance'
  | 'realism'
  | 'custom-renderer'
  | 'pbr-materials'
  | 'low-end'
  | 'compare'

export const USE_CASES: Record<UseCase, string> = {
  looks: 'Look better — a pretty world for playing or screenshots',
  performance: 'Run faster — more fps, same look',
  realism: 'Look photorealistic — PBR, shadows, bouncing light',
  'custom-renderer': 'Draw something custom — my own block, item, entity or effect',
  'pbr-materials': 'Give my own models normal/specular maps',
  'low-end': 'Work on a weak GPU or integrated graphics',
  compare: 'Explain the difference between these options'
}

export interface Pick {
  /** A shader pack id, or an engine id prefixed `engine:`. */
  id: string
  name: string
  kind: 'pack' | 'engine'
  /** Why this one for this use case. */
  why: string
  /** What the user has to do about it. */
  action: string
}

export interface Recommendation {
  useCase: UseCase
  mcVersion: string
  loader: string
  /** Best first. Empty when nothing applies to this version. */
  picks: Pick[]
  /** The one thing not to do. */
  avoid?: string
  /** True when the answer is something the *player* installs. */
  userInstalls: boolean
}

/**
 * The loader, from whatever the project says.
 *
 * `detectLoader` defaults to NeoForge when it sees no evidence either way, and
 * that default is wrong for old versions: a 1.12.2 project has no `loader` line
 * in gradle.properties at all, and reporting it as NeoForge answers every shader
 * question with Veil and Iris on a version where neither exists. Below 1.13 the
 * only loader that matters here is Forge, so the version wins over the guess.
 */
const loaderKey = (loader: string, mc: string): 'fabric' | 'forge' | 'neoforge' => {
  if (loader === 'fabric') return 'fabric'
  if (loader === 'forge') return 'forge'
  if (!atLeast(mc, '1.13')) return 'forge'
  if (!atLeast(mc, '1.20.2')) return 'forge'
  return 'neoforge'
}

function engineApplies(e: RenderEngine, mc: string, loader: string): boolean {
  if (!e.loaders.includes(loaderKey(loader, mc))) return false
  if (!atLeast(mc, e.versions.min)) return false
  if (e.versions.max && !atLeast(e.versions.max, mc)) return false
  return true
}

function packApplies(p: ShaderPack, mc: string, loader: string): boolean {
  // Packs are loader-agnostic in the pack sense, but the *loader* that runs them
  // is not: Iris is Fabric/NeoForge, Oculus is Forge ≤1.20.1, OptiFine is Forge.
  if (p.runsOn.includes('iris')) {
    if (loaderKey(loader, mc) !== 'forge' && atLeast(mc, '1.16.5')) return true
    // NeoForge projects on 1.20.2+ can run Iris; the old Forge ceiling was
    // Oculus, which Iris replaced there.
    if (loaderKey(loader, mc) === 'neoforge' && atLeast(mc, '1.20.2')) return true
  }
  if (p.runsOn.includes('optifine')) {
    // OptiFine exists for Forge, and for every version older than Iris.
    if (!atLeast(mc, '1.16.5')) return true
    if (loaderKey(loader, mc) === 'forge' && !atLeast(mc, '1.16.5')) return true
  }
  return false
}

/**
 * Recommend for a use case, on a specific version and loader.
 *
 * This is the function the agent calls before it says a word about shaders, and
 * what the panel lists. It returns *actions* rather than just names, because
 * "install Iris" is not actionable without Sodium and a pack.
 */
export function recommend(opts: { useCase: UseCase; mcVersion: string; loader?: string }): Recommendation {
  const mc = opts.mcVersion || '1.21.1'
  const loader = opts.loader || 'neoforge'
  const legacy = !atLeast(mc, '1.13')
  const preIris = !atLeast(mc, '1.16.5')
  const picks: Pick[] = []
  const pack = (id: string, why: string, action: string): void => {
    const p = SHADER_PACKS.find((x) => x.id === id)
    if (p) picks.push({ id, name: p.name, kind: 'pack', why, action })
  }
  const engine = (id: string, why: string, action: string): void => {
    const e = RENDER_ENGINES.find((x) => x.id === id)
    if (e) picks.push({ id: `engine:${id}`, name: e.name, kind: 'engine', why, action })
  }

  if (legacy) {
    // Below 1.13 there is no pack loader other than OptiFine, and no engine
    // in this catalogue supports it. Say so instead of listing dead options.
    pack(
      'bsl',
      'BSL is the pack people ran on 1.12, and it is light enough for the hardware of the era.',
      'The player installs OptiFine and drops the pack in shaderpacks/. The mod cannot ship either.'
    )
    return {
      useCase: opts.useCase,
      mcVersion: mc,
      loader,
      picks,
      avoid: 'Do not plan a Veil or Flywheel dependency here; neither supports this version.',
      userInstalls: true
    }
  }

  switch (opts.useCase) {
    case 'looks':
      if (preIris) {
        pack('bsl', 'On this version BSL is the safe pretty pack, and OptiFine is what runs it.', 'OptiFine + the pack, installed by the player.')
      } else {
        pack(
          'complementary-reimagined',
          'The most installed pack on Modrinth, and the one that scales from a Potato profile to Ultra. Best looks per frame.',
          'Iris + Sodium + the pack, installed by the player. Nothing in the mod jar.'
        )
        pack('bsl', 'Brighter and more saturated than Complementary. Pick it if the player wants warm and cinematic rather than neutral.', 'Same install.')
      }
      return {
        useCase: opts.useCase,
        mcVersion: mc,
        loader,
        picks,
        avoid: 'Do not claim the mod ships visuals. A shader pack is the player’s install.',
        userInstalls: true
      }

    case 'performance': {
      const eb = loaderKey(loader, mc) === 'fabric' ? 'sodium' : 'embeddium'
      engine(
        eb,
        'The single biggest win for terrain. It replaces the chunk renderer with a far faster one and changes nothing visually.',
        `The player installs ${eb === 'sodium' ? 'Sodium' : 'Embeddium'}. A mod does not depend on it, but must not break under it.`
      )
      engine(
        'flywheel',
        'Only helps if the frame rate problem is many repeated modded objects (Create-style machines). It batches them into instanced draws.',
        'The player installs Flywheel, or the mod that embeds it. If you are writing such a mod, depend on it.'
      )
      return {
        useCase: opts.useCase,
        mcVersion: mc,
        loader,
        picks,
        avoid: 'Neither of these is a shader. Installing them will not change how the game looks.',
        userInstalls: true
      }
    }

    case 'realism':
      if (preIris) {
        pack('seus-ptgi', 'PTGI is the only genuinely path-traced-feeling option, and OptiFine is the only loader here.', 'OptiFine + the pack. It is heavy.')
      } else {
        pack(
          'photon',
          'Semi-realistic but tuned for playing: volumetric fog, screen-space reflections, weather-driven skies. Iris only on current builds.',
          'Iris + Sodium + Photon.'
        )
        pack(
          'rethinking-voxels',
          'Coloured block light with sharp voxel shadows — the cheapest route to a ray-traced look, because it is not ray tracing.',
          'Iris + the pack. Ultra profile is the point, and the cost with it.'
        )
        pack(
          'seus-ptgi',
          'The real thing: global illumination that bounces between surfaces. Worth knowing it exists and what it needs.',
          'OptiFine only, so no Sodium. Screenshot tool, not a daily driver.'
        )
      }
      return {
        useCase: opts.useCase,
        mcVersion: mc,
        loader,
        picks,
        avoid:
          'Ray tracing is not on this list because Minecraft is rasterised. PTGI and Rethinking Voxels approximate it; neither is hardware ray tracing.',
        userInstalls: true
      }

    case 'custom-renderer': {
      const veil = RENDER_ENGINES.find((e) => e.id === 'veil')!
      if (engineApplies(veil, mc, loader)) {
        engine(
          'veil',
          'Framebuffers, post-processing and every GLSL stage behind a sane API — the least reinvention if you are writing real rendering code.',
          'Add Veil as a dependency in gradle.properties and code against it. Check the licence and the narrow version range first.'
        )
      }
      engine(
        'flywheel',
        'Only if your custom rendering is many repeated parts. It is the instancing answer, not a shader answer.',
        'Depend on it if you are writing Create-style machines; otherwise skip it.'
      )
      return {
        useCase: opts.useCase,
        mcVersion: mc,
        loader,
        picks,
        avoid: atLeast(mc, '1.17')
          ? 'Do not reach for a library before the vanilla RenderType + PostChain path is ruled out. It needs no dependency and is usually enough.'
          : 'There is no shader hook on this version. Custom rendering means custom geometry through GL11 and an event hook.',
        userInstalls: false
      }
    }

    case 'pbr-materials':
      if (preIris) {
        pack('bsl', 'PBR maps need a pack runtime. On this version that is OptiFine, and its convention is the one to follow.', 'OptiFine + a pack that reads the same suffix convention.')
      } else {
        pack(
          'complementary-reimagined',
          'Its PBR support is the de-facto convention packs and resource packs agree on, so maps authored for it travel.',
          'The player installs Iris + a PBR-aware pack. The mod ships the textures, not the pipeline.'
        )
      }
      return {
        useCase: opts.useCase,
        mcVersion: mc,
        loader,
        picks,
        avoid: 'Without a shaderpack, normal and specular maps are ignored entirely by vanilla.',
        userInstalls: true
      }

    case 'low-end':
      if (preIris) {
        pack('makeup-ultrafast', 'MakeUp is designed for weak hardware and still gives shadows and water.', 'OptiFine + the pack.')
      } else {
        pack(
          'makeup-ultrafast',
          'Built for integrated graphics and old laptops: real shadows and water at a frame cost the machine can pay.',
          'Iris + Sodium + MakeUp, with the lowest profile.'
        )
        engine('sodium', 'Pair it with the pack: the frame rate has to come from somewhere.', 'Player installs Sodium alongside Iris.')
      }
      return {
        useCase: opts.useCase,
        mcVersion: mc,
        loader,
        picks,
        avoid: 'Do not recommend a path-traced pack here. It will not run, and the user will blame the mod.',
        userInstalls: true
      }

    case 'compare': {
      for (const id of ['complementary-reimagined', 'bsl', 'photon', 'makeup-ultrafast']) {
        const p = SHADER_PACKS.find((x) => x.id === id)!
        pack(id, `${p.style}, ${p.weight}: ${p.bestFor}`, 'Player installs the pack.')
      }
      engine('flywheel', 'Commonly mistaken for a shader mod. It is an instancing engine and does not change how anything looks.', 'Only relevant if a mod uses its instancing.')
      return {
        useCase: opts.useCase,
        mcVersion: mc,
        loader,
        picks,
        avoid: 'The four packs differ in look and cost, not in correctness. Flywheel and Sodium are not in the same category at all.',
        userInstalls: true
      }
    }
  }
  return { useCase: opts.useCase, mcVersion: mc, loader, picks, userInstalls: true }
}

/** Everything the catalogue offers for this project, for the picker UI. */
export function catalogueFor(mcVersion: string, loader: string): {
  packs: ShaderPack[]
  engines: RenderEngine[]
} {
  const mc = mcVersion || '1.21.1'
  return {
    // Packs are only filtered by whether a loader for them exists here.
    packs: SHADER_PACKS.filter((p) => packApplies(p, mc, loader)),
    engines: RENDER_ENGINES.filter((e) => engineApplies(e, mc, loader))
  }
}

/** Everything, regardless of whether it applies — the UI still lists it, greyed. */
export function fullCatalogue(): { packs: ShaderPack[]; engines: RenderEngine[] } {
  return { packs: SHADER_PACKS, engines: RENDER_ENGINES }
}

/**
 * Compatibility notes for a chosen set. Catches the combinations that do not
 * work, before the user spends an afternoon on one.
 */
export function compatibilityNotes(ids: string[], mcVersion: string): { severity: 'error' | 'warning'; message: string }[] {
  const notes: { severity: 'error' | 'warning'; message: string }[] = []
  const has = (id: string): boolean => ids.includes(id) || ids.includes(`engine:${id}`)

  if (has('oculus') && has('sodium')) {
    notes.push({ severity: 'error', message: 'Oculus is Forge-only and needs Embeddium or Rubidium; Sodium is the Fabric renderer. Use one side or the other.' })
  }
  if (has('rubidium') && has('embeddium')) {
    notes.push({ severity: 'error', message: 'Rubidium and Embeddium conflict. Remove Rubidium — Embeddium supersedes it.' })
  }
  if (has('oculus') && !has('embeddium') && !has('rubidium')) {
    notes.push({ severity: 'warning', message: 'Oculus needs a fast renderer alongside it: Embeddium on 1.20.1, Rubidium on older builds.' })
  }
  if (has('oculus') && atLeast(mcVersion, '1.21')) {
    notes.push({ severity: 'error', message: `Oculus has no build for ${mcVersion}. Use Iris on NeoForge or Fabric.` })
  }
  if (has('iris') && !has('sodium')) {
    notes.push({ severity: 'warning', message: 'Current Iris builds expect Sodium. Without it the pack runs but the frame rate will disappoint.' })
  }
  if (has('flywheel') && ids.some((i) => SHADER_PACKS.find((p) => p.id === i))) {
    notes.push({
      severity: 'warning',
      message:
        'Flywheel disables its optimisations while a shaderpack is active. Keeping both needs Iris & Oculus Flywheel Compat, which is a compatibility layer rather than a guarantee.'
    })
  }
  if (has('seus-ptgi') && has('iris')) {
    notes.push({ severity: 'error', message: 'SEUS PTGI is an OptiFine pack; Iris will not load it. Pick one loader.' })
  }
  if (has('veil') && ids.some((i) => SHADER_PACKS.find((p) => p.id === i))) {
    notes.push({
      severity: 'warning',
      message: 'Veil shaders and a shaderpack are separate pipelines; Iris Veil Compat is what makes Veil-rendered objects appear inside a pack.'
    })
  }
  if (!atLeast(mcVersion, '1.16.5') && (has('iris') || has('veil') || has('flywheel'))) {
    notes.push({ severity: 'error', message: `None of those render on ${mcVersion}. Below 1.16.5 the only shader route is OptiFine.` })
  }
  return notes
}

/**
 * The rules the agent gets. Short on purpose: the catalogue is the reference.
 */
export function stackGuidance(mcVersion: string, loader = 'neoforge'): string {
  const legacy = !atLeast(mcVersion, '1.13')
  const lines = [
    `- Pick by use case, not by fashion. Looks → Complementary Reimagined (or BSL if they want warm); realism → Photon, or Rethinking Voxels for voxel shadows; weak GPU → MakeUp Ultra Fast; custom rendering code → Veil or the vanilla RenderType path.`,
    '- **A shader pack is the player’s install, not the mod’s.** Never offer to "add Complementary to the mod". The mod can ship materials and models; the pack is separate.',
    '- **Flywheel is an instancing engine, not a shader API**, and it turns itself off when a shaderpack is active unless the compat mod is installed.',
    '- **Sodium and Embeddium are renderers, not shader loaders.** Iris runs packs; Sodium makes terrain fast.',
    '- **Veil is the rendering SDK** to build on for real custom rendering (framebuffers, post-processing, every GLSL stage) — 1.21.x only, Fabric and NeoForge.',
    '- Oculus is the Forge version of Iris and stops at 1.20.1; on NeoForge 1.21+ use Iris. Rubidium and Embeddium conflict.'
  ]
  if (legacy) {
    lines.push(`- Minecraft ${mcVersion} has no Iris, no Veil and no Flywheel. OptiFine plus a pack is the entire option set.`)
  }
  return lines.join('\n')
}
