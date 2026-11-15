/**
 * The base classes, per Minecraft version and per loader.
 *
 * This exists because the model guesses. Ask any coding model for "a block in
 * Minecraft 1.20.1" and it will produce something plausible; ask it for the same
 * for 1.12.2 and it will produce something that looks 1.7.10. The names changed
 * at every major era — `Block` moved from `net.minecraft.block` to
 * `net.minecraft.world.level.block`, `World` became `Level`, `EntityPlayer`
 * became `Player`, registration went from `GameRegistry.register` to
 * `DeferredRegister` to `RegisterEvent` — and a confident wrong import costs a
 * build cycle and a confused user.
 *
 * The data here is *names and signatures*, not prose. It is deliberately small
 * and boring: a table the agent can look up, so it spends its context on the
 * user's mod rather than on remembering which package `BlockPos` lived in during
 * 2019.
 *
 * Where a name genuinely cannot be stated without a project to read (an SRG-mapped
 * 1.16 workspace, for instance), the entry says so rather than guessing.
 */

import type { Loader } from '../versions/catalog'

export type Era = 'legacy' | 'mcp' | 'mojmap'

/** Which naming scheme a version uses. */
export function eraOf(mc: string): Era {
  const [major, minor = 0, patch = 0] = mc.split(/[.-]/).map((n) => Number(n) || 0)
  if (major < 1) return 'legacy'
  if (minor < 13) return 'legacy'
  if (minor > 16 || (minor === 16 && patch >= 5)) return 'mojmap'
  if (minor === 16) return patch >= 5 ? 'mojmap' : 'mcp'
  return 'mcp'
}

/**
 * One row of the table: the same concept across the three eras.
 *
 * `null` means "this concept does not exist in that era", which is the more
 * useful answer than a near-miss. A block model on 1.12.2 is not "written
 * differently", it is a different file format entirely.
 */
interface ClassRow {
  concept: string
  /** `null` means the concept does not exist in that era — a better answer than a near miss. */
  legacy?: string | null
  mcp?: string | null
  mojmap?: string | null
  /**
   * Fabric's own answer, when it differs.
   *
   * Fabric does not use DeferredRegister or a registry event at all — it calls
   * `Registry.register` from the mod initialiser. Answering a Fabric project
   * with "NeoForge: DeferredRegister…" is worse than useless: it is a confident
   * wrong answer, which is the whole thing this table exists to stop.
   */
  fabric?: string | null
  /**
   * A caveat worth stating. If `noteEras` is set the note is only shown for
   * those eras — a 1.21 project does not need to be told about 1.12.
   */
  note?: string
  noteEras?: Era[]
}

const CLASSES: ClassRow[] = [
  // ---- core game types -------------------------------------------------
  { concept: 'Block', legacy: 'net.minecraft.block.Block', mcp: 'net.minecraft.block.Block', mojmap: 'net.minecraft.world.level.block.Block' },
  { concept: 'Block properties', legacy: 'net.minecraft.block.Block.Properties.create(Material.ROCK)', mcp: 'net.minecraft.block.AbstractBlock.Properties.of(Material.STONE)', mojmap: 'net.minecraft.world.level.block.state.BlockBehaviour.Properties.of()' },
  { concept: 'Block position', legacy: 'net.minecraft.util.math.BlockPos', mcp: 'net.minecraft.util.math.BlockPos', mojmap: 'net.minecraft.core.BlockPos' },
  { concept: 'Item', legacy: 'net.minecraft.item.Item', mcp: 'net.minecraft.item.Item', mojmap: 'net.minecraft.world.item.Item' },
  { concept: 'Item stack', legacy: 'net.minecraft.item.ItemStack', mcp: 'net.minecraft.item.ItemStack', mojmap: 'net.minecraft.world.item.ItemStack' },
  { concept: 'Creative tab', legacy: 'net.minecraft.creativetab.CreativeTabs', mcp: 'net.minecraft.item.ItemGroup (1.13–1.19.2), net.minecraft.world.item.CreativeModeTab (1.19.3+)', mojmap: 'net.minecraft.world.item.CreativeModeTab' },
  { concept: 'World / Level', legacy: 'net.minecraft.world.World', mcp: 'net.minecraft.world.World', mojmap: 'net.minecraft.world.level.Level' },
  { concept: 'Identifier', legacy: 'net.minecraft.util.ResourceLocation', mcp: 'net.minecraft.util.ResourceLocation', mojmap: 'net.minecraft.resources.ResourceLocation' },
  { concept: 'Text component', legacy: 'net.minecraft.util.text.TextComponentString', mcp: 'net.minecraft.util.text.StringTextComponent', mojmap: 'net.minecraft.network.chat.Component' },
  { concept: 'Sound event', legacy: 'net.minecraft.util.SoundEvent', mcp: 'net.minecraft.util.SoundEvent', mojmap: 'net.minecraft.sounds.SoundEvent' },

  // ---- entities and players -------------------------------------------
  { concept: 'Player', legacy: 'net.minecraft.entity.player.EntityPlayer', mcp: 'net.minecraft.entity.player.PlayerEntity', mojmap: 'net.minecraft.world.entity.player.Player' },
  { concept: 'Server player', legacy: 'net.minecraft.entity.player.EntityPlayerMP', mcp: 'net.minecraft.entity.player.ServerPlayerEntity', mojmap: 'net.minecraft.server.level.ServerPlayer' },
  { concept: 'Entity', legacy: 'net.minecraft.entity.Entity', mcp: 'net.minecraft.entity.Entity', mojmap: 'net.minecraft.world.entity.Entity' },
  { concept: 'Mob', legacy: 'net.minecraft.entity.EntityLiving', mcp: 'net.minecraft.entity.MobEntity', mojmap: 'net.minecraft.world.entity.Mob' },
  { concept: 'Item entity', legacy: 'net.minecraft.entity.item.EntityItem', mcp: 'net.minecraft.entity.item.ItemEntity', mojmap: 'net.minecraft.world.entity.item.ItemEntity' },

  // ---- tile entities / block entities ---------------------------------
  { concept: 'Tile entity', legacy: 'net.minecraft.tileentity.TileEntity', mcp: 'net.minecraft.tileentity.TileEntity', mojmap: 'net.minecraft.world.level.block.entity.BlockEntity' },
  {
    concept: 'Tile-entity ticker',
    legacy: 'ITickable.update()',
    mcp: 'net.minecraft.tileentity.ITickableTileEntity',
    mojmap: 'net.minecraft.world.level.block.entity.BlockEntityTicker<T>',
    note: '1.21 removed ITickableTileEntity; a BlockEntity ticks through a ticker returned by getTicker, or (NeoForge) ITickableBlockEntity covers it.'
  },

  // ---- networking ------------------------------------------------------
  {
    concept: 'Network channel',
    legacy: 'net.minecraftforge.fml.common.network.simpleimpl.SimpleNetworkWrapper',
    mcp: 'net.minecraftforge.fml.network.simple.SimpleChannel / NetworkRegistry.newSimpleChannel',
    mojmap: 'NeoForge: CustomPacketPayload + RegisterPayloadHandlersEvent. Forge 1.20.1: SimpleChannel from net.minecraftforge.network',
    note: 'SimpleChannel is gone in NeoForge 1.20.6+. Do not use it on a modern project.'
  },

  // ---- registration ----------------------------------------------------
  {
    concept: 'Deferred registration',
    legacy: null,
    mcp: 'net.minecraftforge.registries.DeferredRegister (1.14+)',
    mojmap: 'NeoForge: DeferredRegister.Items / DeferredBlock / DeferredRegister<T>; Forge: DeferredRegister<T> + RegisterEvent',
    fabric: 'net.minecraft.core.Registry.register(Registries.BLOCK, ResourceLocation.fromNamespaceAndPath(MOD_ID, "name"), block) — called from onInitialize. Fabric has no DeferredRegister.',
    note: '1.12 and older have no DeferredRegister at all: use GameRegistry.register with setRegistryName.',
    noteEras: ['legacy']
  },
  {
    concept: 'Registry event',
    legacy: null,
    mcp: 'net.minecraftforge.event.RegistryEvent.Register<Item> (1.13–1.19)',
    mojmap: 'NeoForge: RegisterEvent from net.neoforged.neoforge.registries; Forge: net.minecraftforge.registries.RegisterEvent',
    fabric: 'Fabric has no registry event. Register eagerly in onInitialize(), or use the Fabric API registry modules (e.g. net.fabricmc.fabric.api.object.builder.v1.block.FabricBlockSettings).',
    note: 'RegistryEvent was removed in 1.19.3.'
  },

  // ---- data and NBT ----------------------------------------------------
  {
    concept: 'Custom item data',
    legacy: 'ItemStack.getTagCompound() / setTagCompound(NBTTagCompound)',
    mcp: 'ItemStack.getOrCreateTag() / getTag() (may be null)',
    mojmap: '1.20.5+: DataComponents.CUSTOM_DATA or an attachment type. getOrCreateTag() is gone.',
    note: 'The single most common stale API in generated code.'
  }
]

/** Loader-specific entry points, which differ even within one era. */
interface LoaderRow {
  concept: string
  neoforge: string
  forge: string
  fabric: string
}

const LOADERS: LoaderRow[] = [
  {
    concept: 'Mod entry class',
    neoforge: '@Mod("modid") on a class; constructor takes IEventBus, FMLModContainer or nothing depending on version.',
    forge: '@Mod("modid") (1.13+) or @Mod(modid = ..., version = ...) (1.12 and older, with @EventHandler).',
    fabric: 'implements ModInitializer, registered in fabric.mod.json under "entrypoints": { "main": [...] }.'
  },
  {
    concept: 'Client-only entry class',
    neoforge: '@Mod(value = "modid", dist = Dist.CLIENT) or @EventBusSubscriber(value = Dist.CLIENT).',
    forge: '@Mod.EventBusSubscriber(value = Dist.CLIENT) or DistExecutor (Forge 1.13+).',
    fabric: 'implements ClientModInitializer under the "client" entrypoint; never reference net.minecraft.client.* from a server class.'
  },
  {
    concept: 'Metadata file',
    neoforge: 'META-INF/neoforge.mods.toml (src/main/templates on ModDevGradle)',
    forge: 'META-INF/mods.toml (1.13+), mcmod.info JSON (1.12 and older)',
    fabric: 'fabric.mod.json at the jar root'
  },
  {
    concept: 'Block/item model file',
    neoforge: 'assets/<modid>/models/block/<name>.json with a blockstate at assets/<modid>/blockstates/<name>.json',
    forge: 'Same as NeoForge for 1.13+. Pre-1.13 uses a .json model plus a registry name, or a .obj for TESR.',
    fabric: 'Same layout; models are vanilla resources and do not need a loader API.'
  }
]

export interface ApiLookupArgs {
  /** Concept to look up, e.g. "block", "tile entity", "nbt". */
  query?: string
  mcVersion: string
  loader: Loader
}

/**
 * The reference block for a project.
 *
 * Returns names only, never invented signatures: a table entry that cannot be
 * stated without the project on disk says so.
 */
export function apiReference(args: ApiLookupArgs): { text: string; hits: number } {
  const era = eraOf(args.mcVersion)
  const eraLabel = era === 'legacy' ? 'legacy / MCP names (pre-1.13)' : era === 'mcp' ? 'MCP names (1.13 – 1.16.4)' : 'Mojang official names (1.16.5+)'
  const q = (args.query ?? '').trim().toLowerCase()
  const matches = q
    ? CLASSES.filter((r) => r.concept.toLowerCase().includes(q) || [r.legacy, r.mcp, r.mojmap].some((v) => (v ?? '').toLowerCase().includes(q)))
    : CLASSES

  const lines: string[] = [`# Base API — Minecraft ${args.mcVersion}, ${args.loader}`, `Naming: **${eraLabel}**`]
  if (q && !matches.length) {
    lines.push(
      '',
      `No entry matches "${args.query}". Rather than guess, decompile the game jar with \`decompile_api\` and grep it, or add a reference mod that already does what you need.`
    )
  }
  for (const row of matches) {
    const byEra = era === 'legacy' ? row.legacy : era === 'mcp' ? row.mcp : row.mojmap
    // Fabric diverges for a handful of concepts; when it has its own answer, use it.
    const value = args.loader === 'fabric' && row.fabric !== undefined ? row.fabric : byEra
    lines.push('', `**${row.concept}**`, value ? `  ${value}` : `  Does not exist in this era.`)
    if (row.note && (!row.noteEras || row.noteEras.includes(era))) lines.push(`  _${row.note}_`)
  }

  const loaderRows = LOADERS.filter((r) => !q || r.concept.toLowerCase().includes(q))
  if (loaderRows.length) {
    lines.push('', `## ${args.loader} specifics`)
    for (const row of loaderRows) {
      const key = args.loader === 'neoforge' ? row.neoforge : args.loader === 'forge' ? row.forge : row.fabric
      lines.push('', `**${row.concept}**`, `  ${key}`)
    }
  }
  lines.push('', 'These are names, not a promise about signatures. Read the actual class in a decompiled reference before writing a call you are unsure of.')
  return { text: lines.join('\n'), hits: matches.length }
}

/** Every concept, for a tool that lists what it knows. */
export function apiConcepts(): string[] {
  return [...CLASSES.map((c) => c.concept), ...LOADERS.map((l) => l.concept)]
}
