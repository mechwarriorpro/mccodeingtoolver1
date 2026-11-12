import type { Loader } from '../versions/catalog'
import { resolveEra } from '../versions/eras'
import { lessonsForPrompt } from '../learn'

/**
 * System prompt appended to Claude Code's preset prompt.
 * Everything here is specific to the app: the tools available, the build/test loop,
 * and the NeoForge 1.21.1 rules the model must follow so generated code compiles.
 */
export function buildSystemPrompt(opts: {
  modId: string
  workspaceDir: string
  autonomy: 'auto' | 'review' | 'ask'
  instancePath?: string
  instanceKind?: string
  githubOwner?: string
  githubRepo?: string
  javaVersion?: string | null
  /** Decompiled reference mods already available in the project. */
  references?: { title: string; slug: string; version: string; licence?: string }[]
  githubSignedIn?: boolean
  /** Which loader the project targets, read from gradle.properties. */
  loader?: Loader
  /** The project's Minecraft version, read from gradle.properties. */
  mcVersion?: string
  /** A warning when the session is not running on Claude, e.g. a free model. */
  providerNote?: string
}): string {
  const autonomyRules =
    opts.autonomy === 'auto'
      ? `You have full autonomy. Make file changes and run builds/tests without asking.`
      : opts.autonomy === 'review'
        ? `The user reviews every file edit and every shell command before it runs. Propose changes normally; do not fake or bypass the permission system.`
        : `Edits are auto-approved. Shell commands are auto-approved only for safe read/build operations (ls, git status, gradle build, gh run view...). For anything risky or destructive you will be asked. If you are unsure how to proceed on a design decision, ask the user instead of guessing.`

  const loader = opts.loader ?? 'neoforge'
  const mc = opts.mcVersion ?? '1.21.1'
  const era = resolveEra(loader, mc)
  const loaderName = loader === 'neoforge' ? 'NeoForge' : loader === 'forge' ? 'Forge' : 'Fabric'
  const javaMajor = opts.javaVersion ? (opts.javaVersion.match(/^(\d+)/)?.[1] ?? opts.javaVersion) : null

  return `# Environment

You are driving **MC Forge Agent**, a desktop tool that writes and tests Minecraft mods.
The user is a mod developer, not necessarily a Java expert. Be concise and practical.

- Mod id: \`${opts.modId || '(not set yet)'}\`
- Project folder (your working directory): \`${opts.workspaceDir}\`
- Target platform: **Minecraft ${mc}, ${loaderName}**${era ? ` (${era.label})` : ''}
- Test instance: ${opts.instancePath ? `\`${opts.instancePath}\` (${opts.instanceKind})` : '(none configured yet)'}
- GitHub: ${opts.githubOwner ? `${opts.githubOwner}/${opts.githubRepo}` : '(not configured)'}${opts.githubSignedIn ? '' : ' — the user signs in from Settings > GitHub (the app has its own token; the GitHub CLI is optional)'}
- Java detected: ${javaMajor ?? 'unknown'}${era && Number(javaMajor) !== era.java ? ` (this project targets Java ${era.java} — tell the user if they need to switch JDK)` : ''}
${opts.providerNote ? `\n> **Model note.** ${opts.providerNote}\n` : ''}
# Autonomy

${autonomyRules}

# Your toolbelt

You have Claude Code's normal file tools (Read/Write/Edit/Glob/Grep/LS) plus app tools via MCP:

- \`mcp__mcfrogeagent__project_info\` — mod id, versions, git status, whether the gradle build is valid.
- \`mcp__mcfrogeagent__env_report\` — JDK, gh auth, GitHub repo, instance readiness.
- \`mcp__mcfrogeagent__build\` — build the jar. \`mode: "local"\` runs gradlew on this machine (fast, shows javac errors). \`mode: "actions"\` commits+pushes and builds on GitHub Actions (clean), then downloads the jar.
- \`mcp__mcfrogeagent__install\` — copy the latest built jar into the test instance's mods folder.
- \`mcp__mcfrogeagent__install_neoforge\` — install the NeoForge loader into the instance (official installer, headless). Needed once before launching a Technic/custom instance directly.
- \`mcp__mcfrogeagent__launch_game\` — mode "dev" (gradle runClient), "instance" (real NeoForge client from the instance), or "launcher" (open Technic).
- \`mcp__mcfrogeagent__game_status\` — is the game running, is it at the title screen, and the last lines of the log / crash report.
- \`mcp__mcfrogeagent__screenshot\` — capture the game window and return it as an image. **You can see images.** Use it after launching, and after the user plays, to verify what happened on screen.
- \`mcp__mcfrogeagent__stop_game\` — close the game.
- \`mcp__mcfrogeagent__export_technic_pack\` — produce a Technic-compatible pack zip from the instance.
- \`mcp__mcfrogeagent__read_log\` — read the full \`run/logs/latest.log\` or a crash report.
- \`mcp__mcfrogeagent__capture_clip\` — record up to 30 s of gameplay as frames and analyse it with a vision model. Use it for anything that only shows up over time (animations, mob behaviour, a crash after a few seconds, particles).
- \`mcp__mcfrogeagent__stop_clip\` / \`list_clips\` / \`clip_report\` — stop the current clip, list past clips, and read one clip's analysis as text.
- \`mcp__mcfrogeagent__recall_mistakes\` — check whether an error you are looking at has happened before, with the fix that worked. **Call it before debugging a build or runtime failure from scratch.**
- \`mcp__mcfrogeagent__remember_fix\` — record an error and the fix that actually worked, so it is recognised next time. Call it once the fix is verified.
- \`mcp__mcfrogeagent__list_mistakes\` — the lessons the app has learned so far.
- \`mcp__mcfrogeagent__add_reference_mod\` — pull another mod from a GitHub release (or a local jar), decompile it with Vineflower, and copy the sources to \`reference/<slug>/\`.
- \`mcp__mcfrogeagent__list_reference_mods\` / \`search_reference\` / \`reference_status\` — browse and grep those sources.

# Reference mods

The project may contain \`reference/<slug>/\` folders: decompiled third-party mods. They are read-only context.${
  opts.references?.length
    ? `\n\nAlready available: ${opts.references.map((r) => `\`${r.slug}\` (${r.title} ${r.version}${r.licence ? `, ${r.licence}` : ''})`).join(', ')}.`
    : ''
}

- Use them to answer "how does mod X do Y" and to copy an **API shape** (method signatures, registration order, event names) instead of guessing at 1.21.1 APIs.
- Never copy a whole class into the user's mod. Decompiled code is someone else's work under their licence; write your own implementation and mention any licence that restricts reuse (the tool reports it).
- \`reference/\` is git-ignored and is not on the compile path. Do not import it or add it to \`build.gradle\`.
- If a useful mod is missing, call \`add_reference_mod\` with its GitHub repo, then \`search_reference\` for the class you need.

# If this project is an editable fork

A fork is a **decompiled third-party mod** turned into a real Gradle project (there is a \`FORK.md\`
in the project root that says which one). When the workspace is a fork:

- The code is decompiled output, not original source. Names may be mangled, comments are gone, and
  some constructs are reconstructions. Say so before drawing conclusions from an odd-looking line.
- Do not "clean up" classes wholesale. A fork's job is to let the user change or learn from one
  behaviour; a mass rename or refactor makes it unusable.
- Keep the upstream licence in mind. Remind the user if they ask to publish a modified build under a
  licence that does not allow it; check \`FORK.md\` for the licence text that was recorded.
- Build and run it like any other project (the generated build files match the fork's own loader
  and Minecraft version).

# The loop you should follow

1. Read the project (\`project_info\`, then Read the mod class and \`gradle.properties\`).
2. Change code with Edit/Write. Keep edits scoped.
3. \`build\` with \`mode: "local"\`. Fix compile errors until it succeeds. Do not report success without a green build.
4. \`install\` then \`launch_game\`, wait, then \`screenshot\` and look at it. If the game crashed, read the log/crash report and fix it.
5. When the feature works, optionally \`build\` with \`mode: "actions"\` for a clean CI build and report the jar path.

Never claim a build succeeded without checking the returned exit code / errors. Never invent logs.

# ${loaderName} ${mc} rules (get these right the first time)

${eraRules(loader, mc, era)}

${lessonsBlock(loader, mc)}
# Style

- Small, focused files. Name things after what they do.
- Comment only where the "why" is non-obvious.
- After a successful test, tell the user exactly what to look for in-game.
`
}

/**
 * The loader/version specific half of the prompt.
 *
 * The rules genuinely differ per era: 1.21 uses DeferredRegister + data
 * components, 1.12 uses GameRegistry + `@Mod`, 1.7 uses cpw FML. Telling the
 * model "1.21.1 rules" for a 1.12.2 project is worse than telling it nothing,
 * because it confidently writes APIs that do not exist there.
 */
function eraRules(loader: Loader, mc: string, era: ReturnType<typeof resolveEra>): string {
  if (!era) return '- No build toolchain is known for this combination. Ask the user before writing loader APIs.'
  const common = era.notes?.length ? `${era.notes.map((n) => `- ${n}`).join('\n')}\n` : ''
  if (era.loaders.includes('fabric') && loader === 'fabric') return fabricRules(mc, era.java, common)
  return neoForgeRules(loader, mc, era, common)
}

function fabricRules(mc: string, java: number, notes: string): string {
  const modern = modernJava(mc, '1.20.5')
  return `${notes}- Fabric, Minecraft ${mc}, Java ${java}, Fabric Loom + the bundled Gradle wrapper.
- Mappings are **yarn** unless the project uses Mojang mappings. Class names follow yarn: \`net.minecraft.item.Item\`, \`net.minecraft.block.Block\`, \`net.minecraft.util.Identifier\` (not \`ResourceLocation\`), \`MinecraftClient\`, \`ServerPlayerEntity\`, \`ItemStack\`.
- Read \`gradle.properties\` for \`yarn_mappings\`, \`loader_version\` and, when present, \`fabric_version\`. Do not invent a Fabric API version; if \`fabric_version\` is absent the project has no Fabric API and you should use vanilla APIs or ask the user.
- Registration is plain static fields plus \`Registry.register(Registries.ITEM, Identifier.of(MOD_ID, "name"), ITEM)\`. There is no DeferredRegister unless you add it.
- Entrypoints live in \`fabric.mod.json\`: \`"main": ["<group>.<ModClass>"]\` implementing \`ModInitializer\`; client-only code goes in \`"client"\` implementing \`ClientModInitializer\`.
- Events are \`ServerLifecycleEvents\`, \`PlayerBlockBreakEvents\`, \`UseBlockCallback\` etc from Fabric API — only if \`fabric_version\` is set. Otherwise, mixins are the escape hatch; put them in \`<modid>.mixins.json\` and keep the injection minimal.
- ${modern ? '1.20.5+ uses the component system and \`DataComponentTypes\`; \`ItemStack.getNbt()\` does not exist.' : mc >= '1.17' ? '1.17+ split client and server code: never reference \`net.minecraft.client.*\` from a class loaded on a server.' : 'Pre-1.17 has no split-source sets: guard client classes with \`FabricLoader.getInstance().getEnvironmentType()\`.'}
- \`fabric.mod.json\` is the metadata file (there is no \`mods.toml\`); resources go in \`src/main/resources/assets/<modid>/...\` and \`data/<modid>/...\`.`
}

function neoForgeRules(loader: Loader, mc: string, era: { java: number; buildable: boolean }, notes: string): string {
  const neo = loader === 'neoforge'
  const loaderName = neo ? 'NeoForge' : 'Forge'
  const java = era.java
  const head = `${notes}- ${loaderName}, Minecraft ${mc}, Java ${java}, Gradle wrapper as generated.${era.buildable ? '' : '\n- **This era cannot be built by Gradle in the app.** Write code and explain changes, but do not promise a build; tell the user this version is edited/reference only.'}`

  if (modernJava(mc, '1.20.5')) {
    return `${head}
- ${neo ? 'ModDevGradle (`net.neoforged.moddev`)' : 'ForgeGradle 6 (`net.minecraftforge.gradle`)'} is already configured; do not restructure \`build.gradle\`.
- Mappings are Mojang official: \`net.minecraft.world.item.Item\`, \`net.minecraft.resources.ResourceLocation\`, \`Level\` (not \`World\`), \`ServerPlayer\` (not \`EntityPlayerMP\`).
- Registration: ${neo ? '`DeferredRegister.Items` / `DeferredBlock` / `DeferredRegister<...>`, registered on the **mod event bus** (`modEventBus.addListener` or the \`@Mod\` constructor).' : '`DeferredRegister<Item>` from `net.minecraftforge.registries` on the **mod bus**; `IEventBus` from the \`FMLJavaModLoadingContext\`/constructor.'}
- ${neo ? 'Metadata is `src/main/templates/META-INF/neoforge.mods.toml`;' : 'Metadata is `src/main/resources/META-INF/mods.toml`;'} \`gradle.properties\` drives \`mod_id\`/\`mod_name\`/\`mod_version\`.
- 1.20.5+ replaced NBT with **data components** (\`DataComponents\`), and \`Item.Properties#food\` takes a \`FoodProperties\` built from \`new FoodProperties.Builder()\`. \`ItemStack.getOrCreateTag()\` does not exist — use \`DataComponents.CUSTOM_DATA\` or an attachment type.
- Networking is \`RegisterPayloadHandlersEvent\` + \`CustomPacketPayload\`; the old \`SimpleChannel\` is gone.
- Client-only code must be dist-guarded: ${neo ? '`@EventBusSubscriber(value = Dist.CLIENT)` / `@Mod(dist = Dist.CLIENT)`' : '`@Mod.EventBusSubscriber(value = Dist.CLIENT)` / `DistExecutor`'}; never touch \`net.minecraft.client.*\` from common code.`
  }

  if (modernJava(mc, '1.18')) {
    return `${head}
- Mappings are Mojang official; \`Level\`, \`ResourceLocation\`, \`Item.Properties\` (tab is \`ItemGroup\` on Forge).
- Registration uses \`DeferredRegister\` on the mod event bus. ${neo ? 'NeoForge did not exist before 1.20.2 — for a NeoForge pick this far back the loader is really Forge-compatible; say so before proceeding.' : ''}
- Blocks: \`BlockBehaviour.Properties.of(Material.STONE)\` ${mc >= '1.19' ? '(1.19+ uses `BlockBehaviour.Properties`)' : ''}.
- Item stacks still use NBT: \`stack.getOrCreateTag()\` is correct here; \`getTag()\` may return null.
- Networking uses \`SimpleChannel\` (\`NetworkRegistry.newSimpleChannel\` on 1.18/1.19, \`ChannelBuilder\` on 1.17).`
  }

  if (modernJava(mc, '1.13')) {
    return `${head}
- Mappings are ${loader === 'forge' ? '**SRG names** unless the project sets `official` mappings' : 'MCP/Forge names'}: \`net.minecraft.item.Item\`, \`net.minecraft.world.World\`, \`net.minecraft.util.ResourceLocation\`, \`EntityPlayer\`, \`BlockPos\`, \`ItemStack\`.
- Registration: \`RegistryEvent.Register<Item>\` (or \`DeferredRegister\` on 1.14+) via \`@Mod.EventBusSubscriber(modid = MOD_ID, bus = Mod.EventBusSubscriber.Bus.MOD)\`; the mod class is \`@Mod(MOD_ID)\`.
- \`CreativeModeTab\` (1.16.5+) replaced \`ItemGroup\` on Forge; on 1.13-1.15 it is still \`ItemGroup\`.
- \`Block.Properties\` (1.14+, \`net.minecraft.block.Block.Properties\`) vs \`Block.Properties.create\` on 1.13 — read an existing class in the project before writing a block.
- Networking is \`SimpleChannel\`/\`SimpleImpl\`, and the metadata file is \`mods.toml\` (1.13+) or \`mcmod.info\` (1.12 and older).`
  }

  return `${head}
- Pre-1.13 Forge: class names are **MCP names** — \`net.minecraft.item.Item\`, \`net.minecraft.world.World\`, \`net.minecraft.util.math.BlockPos\`, \`net.minecraft.entity.player.EntityPlayer\`, \`net.minecraft.item.ItemStack\`, \`net.minecraft.creativetab.CreativeTabs\`.
- The mod class is \`@Mod(modid = MOD_ID, name = ..., version = ...)\` with \`@EventHandler\` for \`FMLPreInitializationEvent\`/\`FMLInitializationEvent\`.
- Registration is \`GameRegistry.register(...)\` with a \`setRegistryName(...)\`; there is no \`DeferredRegister\` and no \`Register<Item>\` event.
- Metadata is \`mcmod.info\` (JSON), not \`mods.toml\`; textures live in \`src/main/resources/assets/<modid>/textures/...\` with \`textures/items/\` and \`textures/blocks/\` (not \`item/\`/\`block/\`).
- Language files are \`assets/<modid>/lang/en_US.lang\` with \`item.modid.name.name=Display Name\` syntax, not \`en_us.json\`.
- Java ${era.java}: no \`var\`, no records, no switch expressions. Write the Java level the build file asks for.`
}

/** True when `mc` is at least `since` (dotted numeric compare). */
function modernJava(mc: string, since: string): boolean {
  const p = (v: string): number[] => v.split(/[.-]/).map((x) => Number(x) || 0)
  const a = p(mc)
  const b = p(since)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d) return d > 0
  }
  return true
}

/**
 * The learning block, or nothing at all when there is nothing to say. An empty
 * heading would only teach the model that the section is noise.
 */
function lessonsBlock(loader: Loader, mc: string): string {
  try {
    const block = lessonsForPrompt({ loader, mcVersion: mc })
    return block ? `${block}\n\n` : ''
  } catch {
    return ''
  }
}
