import { atLeast } from './assets'
import { stackGuidance } from './shader-stack'

/**
 * What a project can actually render with.
 *
 * This module exists because the honest answer to "can I write a photorealistic
 * shader for this mod" is *different for every Minecraft version*, and getting
 * it wrong wastes days. The rendering API has been replaced twice, and the
 * answer for 1.12 (the ICBM Classic fork) is not the answer for 1.21.
 *
 * It describes the pipeline a project targets, what that pipeline can express,
 * and which mod (if any) it needs in order to express it. It is deliberately
 * bounded: this is a description of the *platform*, not a shader compiler. The
 * agent writes the code; this stops it writing code for a pipeline that does
 * not exist in that version.
 */

export type ShaderApi = 'gl11' | 'gl20' | 'gl33' | 'core' | 'blaze3d' | 'blaze3d-2' | 'pipeline'

export interface ShaderStage {
  /** What this pipeline can do at all. */
  can: string[]
  /** What it cannot, and the mod or upgrade that adds it. */
  cannot: string[]
}

export interface RendererSupport {
  mcVersion: string
  api: ShaderApi
  apiLabel: string
  /** GLSL-ish language version. GLSL for OpenGL, and worded per pipeline. */
  shadingLanguage: string
  /**
   * How shaders are even loaded. Vanilla has no user shader path at all before
   * 1.17, and even after it, the loader's hook is what matters.
   */
  howShadersLoad: string
  /**
   * True when a third-party renderer mod is the only way to reach real
   * post-processing or physically based lighting.
   */
  needsShaderMod: 'none' | 'iris-sodium' | 'optifine-shaders' | 'both'
  stage: ShaderStage
  /** Honest ceiling for this version. */
  ceiling: string
  /**
   * Things that are true regardless of version and that people waste time
   * rediscovering.
   */
  constraints: string[]
}

/** GLSL version numbers, which differ between the GL and Blaze3D worlds. */
const GLSL = {
  gl11: 'GLSL 1.10 (fixed-function era, ARB assembly on some drivers)',
  gl20: 'GLSL 1.20',
  gl33: 'GLSL 3.30 core',
  core: 'GLSL 3.30 core (OpenGL 3.3+)'
} as const

/**
 * Describe what a specific Minecraft version can render.
 *
 * The version boundaries here are the ones that actually break code, not every
 * release:
 *
 *  - 1.12 and earlier: OpenGL 1.1/2.0 via LWJGL 2, `GL11`/`ARBShaderObjects`.
 *    No vanilla shader path. Custom rendering = `RenderLivingEvent`, tessellator
 *    and `OpenGlHelper`. OptiFine existed and is where shader packs lived.
 *  - 1.13-1.16: LWJGL 3, `GlStateManager`, `RenderSystem`, GL 2.0/3.3 available
 *    through LWJGL, but vanilla still exposes no shader loader.
 *  - 1.17+: Blaze3D with `ShaderInstance`, `RenderType` and a real
 *    `coreShaders` resource path in the mod's assets.
 *  - 1.21.2+: post-1.21.1, `RenderType`/`RenderPipeline` were reorganised again
 *    (render pipelines, `VertexFormat` changes). This project's toolchain stops
 *    at the era that supplies matching Gradle files, so anything newer is
 *    described conservatively rather than guessed.
 */
export function rendererSupport(mcVersion: string): RendererSupport {
  const mc = mcVersion || '1.21.1'

  if (!atLeast(mc, '1.13')) {
    return {
      mcVersion: mc,
      api: 'gl11',
      apiLabel: 'OpenGL 1.1/2.0 through LWJGL 2 (GL11, ARBShaderObjects)',
      shadingLanguage: GLSL.gl20,
      howShadersLoad:
        'Nothing in vanilla reads a shader from a mod. Shader programs are compiled at runtime with ' +
        'ARBShaderObjects/ARBVertexShader/ARBFragmentShader extensions, or loaded by OptiFine.',
      needsShaderMod: 'optifine-shaders',
      stage: {
        can: [
          'Per-vertex colour and per-face lighting through the tessellator',
          'Custom RenderType-equivalents with `RenderingRegistry`',
          'Fixed-function blend, alpha and depth operations',
          'ARB assembly / GLSL 1.20 shaders uploaded by hand (fragile across drivers)',
          'OptiFine shader packs, which replace the whole pipeline and are the only realistic route to post-processing'
        ],
        cannot: [
          'Anything using Blaze3D (`ShaderInstance`, `RenderType`, `RenderStateShard`) — that API does not exist',
          'Vanilla post-processing or framebuffer effects',
          'Reliable GLSL from a mod: driver-dependent, and OptiFine overrides it'
        ]
      },
      ceiling:
        'Custom geometry and recoloured vanilla rendering. Not photorealism: this era has no deferred pipeline and no ' +
        'vanilla shader hook, and OptiFine shader packs are written against OptiFine, not against your mod.',
      constraints: [
        'Write against `GL11`/`GlStateManager 1.x` and the tessellator, not `RenderSystem`.',
        'Do not emit `coreShaders` assets: there is no loader for them before 1.17.',
        'Entity and block renders go through events (`RenderLivingEvent`, `RenderWorldLastEvent`).',
        'Shaders that work on one GPU may fail on another; this was the normal experience on 1.12 and is worth saying plainly.'
      ]
    }
  }

  if (!atLeast(mc, '1.17')) {
    return {
      mcVersion: mc,
      api: 'gl33',
      apiLabel: 'OpenGL 2.0/3.3 through LWJGL 3, wrapped by `RenderSystem`/`GlStateManager`',
      shadingLanguage: GLSL.gl33,
      howShadersLoad:
        'Vanilla exposes no shader resource path. Mods compile GLSL from their own source strings via LWJGL, or rely on ' +
        'Iris/OptiFine for shader packs.',
      needsShaderMod: 'iris-sodium',
      stage: {
        can: [
          'Real GLSL 3.30 vertex and fragment shaders, compiled from strings',
          'Custom framebuffers, multiple render targets and post-processing chains written by hand',
          'Custom vertex formats through `VertexFormat`/`DefaultVertexFormat`',
          'Particles and custom entity renderers with shader-driven materials',
          'Iris shader packs for screen-space effects, reflections and PBR-style lighting'
        ],
        cannot: [
          'Blaze3D `ShaderInstance` / `coreShaders` (introduced in 1.17)',
          'Vanilla resource-pack shader overrides',
          'Stable hooks into the lighting pipeline: Iris replaces it wholesale, so anything you write is either an Iris pack or separate from it'
        ]
      },
      ceiling:
        'Genuine custom GLSL with framebuffers — this era can do a lot. What it cannot do is integrate with the vanilla ' +
        'lighting model cleanly; a full deferred pipeline means writing an Iris shader pack, which is a pack, not a mod feature.',
      constraints: [
        'LWJGL 3 is available, so `GL33`/`GL20` classes are usable without a compatibility layer.',
        'Every GL call must be balanced: unwinding state wrongly corrupts every later render in the frame.',
        'Shader compilation failures are silent in some loaders — log `glGetShaderInfoLog` yourself.',
        'Iris and Sodium replace large parts of rendering; assume your code runs *around* them, not inside.'
      ]
    }
  }

  // 1.17 - 1.21.1: the Blaze3D era this app's own toolchain targets.
  if (!atLeast(mc, '1.21.2')) {
    return {
      mcVersion: mc,
      api: 'blaze3d',
      apiLabel: 'Blaze3D (`ShaderInstance`, `RenderType`, `RenderSystem`) over OpenGL 3.2+ core',
      shadingLanguage: GLSL.core,
      howShadersLoad:
        'Put .fsh / .vsh / .json program definitions under assets/<modid>/shaders/core/ and load them with a ' +
        'ShaderInstance through a RenderType.' +
        (atLeast(mc, '1.20') ? ' From 1.20 this needs no renderer mod and the JSON format is stable.' : ''),
      needsShaderMod: 'iris-sodium',
      stage: {
        can: [
          'Custom `RenderType`s with their own shader program, blend and depth state',
          'GLSL vertex and fragment shaders shipped as mod assets and hot-reloadable in dev',
          'Framebuffer post-processing using `PostChain` and `PostPass` (the same machinery vanilla uses for the Nether)',
          'Per-vertex attributes beyond position/colour/UV, including a custom `VertexFormat`',
          'Iris/Sodium compatibility for full shader packs'
        ],
        cannot: [
          'True real-time ray tracing: Minecraft is rasterised, and no renderer mod changes that. Path-traced screenshots exist in external tools; that is not this.',
          'Arbitrary compute shaders: OpenGL 4.3+ compute is a driver question and Blaze3D has no path for it',
          'PBR lighting that responds to the vanilla light map the way a hand-written engine would — Iris adds PBR, vanilla does not'
        ]
      },
      ceiling:
        'This is where "photorealistic" becomes a real conversation rather than a wish: deferred-style lighting, screen-space ' +
        'reflections, normal maps and PBR are reachable *through a shader pack* (Iris) and, to a lesser degree, through a custom ' +
        'RenderType plus PostChain. What is not reachable is a genuinely different renderer bolted onto a mod — that is a ' +
        'renderer mod, not a mod feature.',
      constraints: [
        '**OpenGL 3.2 Core Profile is required from 1.17.** A machine that ran 1.16 on a GL 2.1 driver cannot run this era at all — check the GPU before promising an effect.',
        'Vanilla registers a fixed set of core shaders; override by matching the file name under `shaders/core/`.',
        atLeast(mc, '1.20')
          ? 'From 1.20.2 the `ShaderInstance` constructor takes a shader-config resource location pair — check the mappings for your exact patch version.'
          : 'The `ShaderInstance` constructor signature changed between 1.17 and 1.20; do not copy a 1.17 example into 1.20.',
        'A `RenderType` must be registered before the world renders, and its buffers flushed in the right phase or the geometry draws twice or not at all.',
        'Sodium replaces the chunk renderer; anything that hooks terrain rendering has to be tested with it installed.',
        'Shader source is compiled at runtime, so a GLSL syntax error is a crash or a black screen, not a build failure. Validate with `glGetShaderInfoLog` and log it.'
      ]
    }
  }

  // 1.21.2+: the rendering module was rewritten again, and the shader *paths*
  // moved out of `core/` at the same time. NeoForge's own 1.21.2 primer is the
  // source for the renames below; getting this wrong produces "Failed to load
  // required shader programs" and a black screen.
  return {
    mcVersion: mc,
    api: 'blaze3d-2',
    apiLabel: 'Blaze3D after the 1.21.2 rewrite (`CompiledShaderProgram`, framegraph pipelines) over OpenGL 3.2+ core',
    shadingLanguage: GLSL.core,
    howShadersLoad:
      'From 1.21.2 shader files live at assets/<modid>/shaders/<name>.vsh and .fsh — the `core/` folder is no longer ' +
      'prepended for you, and a JSON that still points at `core/...` fails to load. Programs are compiled through ' +
      '`CompiledShaderProgram` and the program JSON is described by `ShaderProgramConfig`.',
    needsShaderMod: 'iris-sodium',
    stage: {
      can: [
        'Everything the 1.17-1.21.1 era can, expressed through the rewritten API',
        '`RenderPipeline` definitions in code, and the framegraph for multi-pass rendering',
        'Custom core shaders, with the new flat shader path',
        'Iris/Sodium shader packs'
      ],
      cannot: [
        'True ray tracing, for the same reason as any other version: the renderer is rasterised',
        'Compute shaders, which still have no Blaze3D path',
        'A shader written for 1.21.1 working unchanged — the API and the paths both moved'
      ]
    },
    ceiling:
      'The same ceiling as 1.20/1.21.1 — PBR, shadows and reflections through an Iris pack, custom pipelines and post ' +
      'effects from mod code — but reached through a different API. Anything written here does not backport to 1.21.1 ' +
      'without rewriting.',
    constraints: [
      '**This is not the 1.21.1 API.** `ShaderInstance` is now `CompiledShaderProgram`; `RenderPipeline` moved to ' +
        '`com.mojang.blaze3d.framegraph` and `com.mojang.blaze3d.resources`; `PostChain` is built by `load`.',
      '**Shader paths changed.** Use `shaders/<name>.vsh`, not `shaders/core/<name>.vsh`. A JSON copied from a 1.21.1 ' +
        'project points at the wrong place and the game fails to load the core programs.',
      'Shader JSON is now `ShaderProgramConfig`; a definition that still uses the old shape is rejected.',
      "Follow NeoForge's 1.21.2 migration primer for the exact signatures rather than adapting an older example by hand.",
      'OpenGL 3.2 Core is still required.'
    ]
  }
}

/**
 * The rules the agent gets, or nothing at all when the version is one the
 * generic prompt already covers.
 */
export function rendererGuidance(mcVersion: string): string {
  const r = rendererSupport(mcVersion)
  const lines: string[] = [
    `- **Rendering API:** ${r.apiLabel}. Shading language: ${r.shadingLanguage}.`,
    `- **How shaders load:** ${r.howShadersLoad}`,
    `- **Can:** ${r.stage.can.join('; ')}.`,
    `- **Cannot:** ${r.stage.cannot.join('; ')}.`,
    `- **Ceiling:** ${r.ceiling}`,
    ...r.constraints.map((c) => `- ${c}`)
  ]
  if (r.needsShaderMod !== 'none') {
    lines.push(
      '- For shader *packs* (post-processing, PBR, reflections) the realistic route is a pack for ' +
        (r.needsShaderMod === 'both' ? 'Iris or OptiFine' : r.needsShaderMod === 'iris-sodium' ? 'Iris/Sodium' : 'OptiFine') +
        '. Say so plainly rather than promising photorealistic output from mod code alone.'
    )
  }
  // The catalogue rules: which pack or engine for which use case, and which of
  // the popular mods are not shader APIs at all.
  lines.push(stackGuidance(mcVersion))
  return lines.join('\n')
}

/**
 * Is "photorealistic" an achievable goal here, and in what form? A direct answer
 * because the alternative is an agent that agrees to something impossible.
 */
export function realismVerdict(mcVersion: string): { achievable: boolean; how: string } {
  const r = rendererSupport(mcVersion)
  if (r.api === 'gl11') {
    return {
      achievable: false,
      how: `Not on Minecraft ${mcVersion} from mod code. There is no shader loader and no deferred pipeline; the closest thing is an OptiFine shader pack, which is written against OptiFine rather than your mod.`
    }
  }
  if (r.api === 'gl33') {
    return {
      achievable: true,
      how: 'Partly, and only by writing GLSL yourself: framebuffers and custom materials work, but the vanilla light map and the Iris pipeline are separate worlds. Expect a strong custom look, not a new renderer.'
    }
  }
  return {
    achievable: true,
    how: 'Through Iris: PBR materials, normal and specular maps, screen-space reflections and shadow maps are all real on this version. Vanilla-plus-mod-code gets you custom render pipelines and post effects; the full deferred look needs a shader pack.'
  }
}
