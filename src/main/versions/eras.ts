/**
 * Per-era project generation.
 *
 * Minecraft's build tooling changed shape several times (ForgeGradle 1.2 -> 2.3
 * -> 3.x -> 5.x -> 6.x, then ModDevGradle, and Fabric Loom alongside). Rather than
 * bundle one template per version, the app picks an *era* from (loader, version)
 * and generates the build file, metadata and starter source for it.
 *
 * That is what makes "select 1.22.1 when it ships" work: if no era matches
 * exactly, the closest known era at or below the version is used and the agent is
 * told which assumptions it inherited, so it can adjust the build instead of the
 * app needing a new release.
 */
import { cachedCatalog, fabricExtrasFor, compareMcVersions, type Catalog, type Loader } from './catalog'

export type EraId =
  | 'legacy-fml'
  | 'fg-1.7'
  | 'fg-2.x'
  | 'fg-3.x'
  | 'fg-5.x'
  | 'fg-6.x'
  | 'forge-1.20.2'
  | 'neo-moddev'
  | 'fabric-loom'

export interface Era {
  id: EraId
  label: string
  /** Inclusive Minecraft bounds, dotted. */
  min: string
  max?: string
  loaders: Loader[]
  /** Gradle wrapper version written into gradle-wrapper.properties. */
  gradle: string
  /** Java toolchain + language level. */
  java: number
  /** Can the generated project actually build without manual setup? */
  buildable: boolean
  /** Extra guidance the agent needs for this era. */
  notes: string[]
}

/**
 * Ordered newest-first; `resolveEra` walks this list.
 *
 * Bounds are deliberate: 1.20.2 is where NeoForge forked and where Forge moved to
 * a new metadata layout, so they are the natural cut points.
 */
export const ERAS: Era[] = [
  {
    id: 'fabric-loom',
    label: 'Fabric (Loom)',
    min: '1.14',
    loaders: ['fabric'],
    gradle: '8.9',
    java: 21,
    buildable: true,
    notes: [
      'Fabric has no Forge-style event bus: register content in ModInitializer#onInitialize.',
      'Metadata lives in src/main/resources/fabric.mod.json; mixins are optional but common.'
    ]
  },
  {
    id: 'neo-moddev',
    label: 'NeoForge (ModDevGradle)',
    min: '1.20.2',
    loaders: ['neoforge'],
    gradle: '8.9',
    java: 21,
    buildable: true,
    notes: [
      'NeoForge 1.20.5+ uses DeferredRegister and DataComponents; 1.20.2-1.20.4 still has the old ItemStack tag API.',
      'Metadata lives in src/main/templates/META-INF/neoforge.mods.toml and is expanded by ModDevGradle.'
    ]
  },
  {
    id: 'forge-1.20.2',
    label: 'Forge (ForgeGradle 6)',
    min: '1.20.2',
    loaders: ['forge'],
    gradle: '8.9',
    java: 21,
    buildable: true,
    notes: [
      'Forge for 1.20.2+ uses mods.toml in src/main/resources/META-INF (no template expansion).',
      'Register on FMLJavaModLoadingContext.get().getModEventBus(); DeferredRegister from net.minecraftforge.'
    ]
  },
  {
    id: 'fg-6.x',
    label: 'Forge (ForgeGradle 6)',
    min: '1.19',
    max: '1.20.1',
    loaders: ['forge'],
    gradle: '8.1',
    java: 17,
    buildable: true,
    notes: ['Mappings are official (Mojang names). Use net.minecraftforge.registries.DeferredRegister.']
  },
  {
    id: 'fg-5.x',
    label: 'Forge (ForgeGradle 5)',
    min: '1.17',
    max: '1.18.2',
    loaders: ['forge'],
    gradle: '7.6',
    java: 17,
    buildable: true,
    notes: ['Mappings are official. 1.17+ requires Java 16+, 1.18 requires 17.']
  },
  {
    id: 'fg-3.x',
    label: 'Forge (ForgeGradle 3)',
    min: '1.13',
    max: '1.16.5',
    loaders: ['forge'],
    gradle: '7.6',
    java: 8,
    buildable: true,
    notes: [
      'Mappings are official: mappings channel: "official", version: <minecraft>.',
      'mods.toml replaces mcmod.info at 1.13+.'
    ]
  },
  {
    id: 'fg-2.x',
    label: 'Forge (ForgeGradle 2)',
    min: '1.8',
    max: '1.12.2',
    loaders: ['forge'],
    gradle: '4.10.3',
    java: 8,
    buildable: true,
    notes: [
      'Old MCP mappings: mappings channel: "stable", version: <mcp version>; snapshot mappings differ per version.',
      '@Mod(modid = ..., version = ...) and the MinecraftForge.EVENT_BUS, not the newer event-bus classes.',
      'mcmod.info in src/main/resources is the metadata file.',
      'Item registration is GameRegistry.register in 1.8-1.12, not DeferredRegister.'
    ]
  },
  {
    id: 'fg-1.7',
    label: 'Forge (ForgeGradle 1.2)',
    min: '1.7',
    max: '1.7.10',
    loaders: ['forge'],
    gradle: '4.10.3',
    java: 8,
    buildable: false,
    notes: [
      'ForgeGradle 1.2 needs the old Gradle 2/4 toolchain and often a JDK 8 with permissive TLS.',
      'Expect to fix the build by hand; the agent should keep changes minimal here.'
    ]
  },
  {
    id: 'legacy-fml',
    label: 'Legacy Forge (pre-ForgeGradle)',
    min: '1.2.5',
    max: '1.6.4',
    loaders: ['forge'],
    gradle: '4.10.3',
    java: 8,
    buildable: false,
    notes: [
      'Versions before 1.7 have no maintained Gradle plugin: they need the old src/ layout plus a Forge dev jar.',
      'The generated project is a correct skeleton (mcmod.info, @Mod, load hook) but is not wired to a compiler.',
      'Tell the user plainly that these versions need a manual dev environment; do not fake a green build.'
    ]
  }
]

/** Pick the era for a loader + version, preferring an exact match. */
export function resolveEra(loader: Loader, mcVersion: string): Era | null {
  const candidates = ERAS.filter((e) => e.loaders.includes(loader))
  // Only compare the major.minor part: 1.21.1 and 1.21.4 share a toolchain.
  const minor = mcVersion.split('.').slice(0, 2).join('.')
  for (const era of candidates) {
    const okMin = compareMcVersions(mcVersion, era.min) >= 0
    const okMax = era.max ? compareMcVersions(minor, era.max) <= 0 : true
    if (okMin && okMax) return era
  }
  // Nothing matched: use the newest era of that loader so a brand-new Minecraft
  // version still produces a project with a recent toolchain.
  return candidates[0] ?? null
}

/**
 * Java major for a specific Minecraft version.
 *
 * Mojang's own requirements: 1.17 needs 16, 1.18+ needs 17, 1.20.5+ needs 21.
 * Fabric spans all of those with one loader, so the era alone is not enough.
 */
export function javaForVersion(loader: Loader, mcVersion: string, era: Era): number {
  const atLeast = (v: string): boolean => compareMcVersions(mcVersion, v) >= 0
  if (atLeast('1.20.5')) return 21
  if (atLeast('1.18')) return 17
  if (atLeast('1.17')) return 16
  // Everything older runs on Java 8. Returning era.java here was a bug: Fabric's
  // era spans 1.14-1.21, so its single value (21) leaked onto 1.14-1.16 projects.
  if (era.id === 'fabric-loom') return 8
  return era.java
}

/** A catalog-shaped zero value, so Fabric extras fall back to defaults offline. */
const EMPTY_CATALOG = { fetchedAt: 0, minecraft: [], loaders: { neoforge: [], forge: [], fabric: [] }, errors: [] } as Catalog

export interface ProjectConfig {
  modId: string
  modName: string
  group: string
  version: string
  author: string
  license: string
  mcVersion: string
  loaderVersion: string
  loader: Loader
  era: Era
  /** Maven/Fabric mapping version, when the loader needs one. */
  mappingsVersion?: string
  /** Fabric API build, normally resolved from the version catalog. */
  fabricApi?: string
}

// ------------------------------------------------------------------ gradle

/**
 * The build file for an era. Written as a template string per era rather than a
 * generic one: the loaders disagree on plugins, DSL and even the minecraft{}
 * block, so a single generic file would be wrong for most versions.
 */
export function buildGradle(cfg: ProjectConfig): string {
  const { era, loader, mcVersion, loaderVersion } = cfg
  const java = javaForVersion(loader, mcVersion, era)
  switch (era.id) {
    case 'neo-moddev':
      return `plugins {
    id 'java-library'
    id 'maven-publish'
    id 'net.neoforged.moddev' version '2.0.107'
}

version = mod_version
group = mod_group_id

base { archivesName = mod_id }

java.toolchain.languageVersion = JavaLanguageVersion.of(${java})

neoForge {
    version = neo_version

    parchment {
        mappingsVersion = project.parchment_mappings_version
        minecraftVersion = project.parchment_minecraft_version
    }

    runs {
        client {
            client()
            systemProperty 'neoforge.enabledGameTestNamespaces', project.mod_id
        }
        server {
            server()
            programArgument '--nogui'
            systemProperty 'neoforge.enabledGameTestNamespaces', project.mod_id
        }
    }

    mods {
        "\${project.mod_id}" {
            sourceSet sourceSets.main
        }
    }
}

repositories {
    mavenLocal()
}

def resourceTargets = ['META-INF/neoforge.mods.toml', 'pack.mcmeta']
def replaceProperties = [
    minecraft_version      : minecraft_version,
    minecraft_version_range: minecraft_version_range,
    neo_version            : neo_version,
    neo_version_range      : neo_version_range,
    loader_version_range   : loader_version_range,
    mod_id                 : mod_id,
    mod_name               : mod_name,
    mod_license            : mod_license,
    mod_version            : mod_version,
    mod_authors            : mod_authors,
    mod_description        : mod_description
]
tasks.withType(ProcessResources).configureEach {
    inputs.properties replaceProperties
    filesMatching(resourceTargets) {
        expand replaceProperties
    }
}
`
    case 'forge-1.20.2':
    case 'fg-6.x':
    case 'fg-5.x':
    case 'fg-3.x': {
      const plugin = era.id === 'fg-3.x' ? "net.minecraftforge.gradle:ForgeGradle:3.+" : "net.minecraftforge.gradle:ForgeGradle:[6.0,6.2)"
      const pluginBlock =
        era.id === 'fg-3.x'
          ? `buildscript {
    repositories {
        maven { url = 'https://maven.minecraftforge.net/' }
        mavenCentral()
    }
    dependencies {
        classpath group: '${plugin}'
    }
}
apply plugin: 'net.minecraftforge.gradle'
apply plugin: 'eclipse'`
          : `plugins {
    id 'eclipse'
    id 'idea'
    id 'maven-publish'
    id 'net.minecraftforge.gradle' version '[6.0,6.2)'
}`
      return `${pluginBlock}

version = mod_version
group = mod_group_id

base { archivesName = mod_id }

java.toolchain.languageVersion = JavaLanguageVersion.of(${java})

minecraft {
    mappings channel: 'official', version: '${mcVersion}'
    copyIdeResources = true
    runs {
        client {
            workingDirectory project.file('run')
            mods { "\${mod_id}" { source sourceSets.main } }
        }
        server {
            workingDirectory project.file('run')
            mods { "\${mod_id}" { source sourceSets.main } }
        }
    }
}

repositories {
    mavenLocal()
    maven { url = 'https://maven.minecraftforge.net/' }
}

dependencies {
    minecraft "net.minecraftforge:forge:\${minecraft_version}-\${forge_version}"
}

tasks.withType(ProcessResources).configureEach {
    var replaceProperties = [
        minecraft_version: minecraft_version,
        minecraft_version_range: minecraft_version_range,
        forge_version: forge_version,
        forge_version_range: forge_version_range,
        loader_version_range: loader_version_range,
        mod_id: mod_id, mod_name: mod_name,
        mod_license: mod_license, mod_version: mod_version,
        mod_authors: mod_authors, mod_description: mod_description
    ]
    inputs.properties replaceProperties
    filesMatching(['META-INF/mods.toml']) {
        expand replaceProperties + [project: project]
    }
}
`
    }
    case 'fg-2.x': {
      // 1.8-1.12: ForgeGradle 2, MCP mappings, no toolchain block.
      const fg = mcVersion.startsWith('1.12') ? '2.3-SNAPSHOT' : mcVersion.startsWith('1.11') ? '2.2-SNAPSHOT' : mcVersion.startsWith('1.10') || mcVersion.startsWith('1.9') ? '2.1-SNAPSHOT' : '2.0-SNAPSHOT'
      return `buildscript {
    repositories {
        maven { url = 'https://maven.minecraftforge.net' }
        mavenCentral()
    }
    dependencies {
        classpath group: 'net.minecraftforge.gradle', name: 'ForgeGradle', version: '${fg}', changing: true
    }
}
apply plugin: 'net.minecraftforge.gradle'
apply plugin: 'eclipse'

version = mod_version
group = mod_group_id
archivesBaseName = mod_id

sourceCompatibility = targetCompatibility = '1.8'

minecraft {
    mappings channel: '${mappingsChannel(cfg)}', version: '${cfg.mappingsVersion ?? mappingsVersionFor(cfg)}'
    runs {
        client {
            workingDirectory project.file('run')
        }
    }
}

dependencies {
    minecraft 'net.minecraftforge:forge:${mcVersion}-${loaderVersion}'
}
`
    }
    case 'fg-1.7': {
      return `buildscript {
    repositories {
        maven { url = 'https://maven.minecraftforge.net' }
        mavenCentral()
    }
    dependencies {
        classpath group: 'net.minecraftforge.gradle', name: 'ForgeGradle', version: '1.2-SNAPSHOT', changing: true
    }
}
apply plugin: 'net.minecraftforge.gradle'
apply plugin: 'eclipse'

version = mod_version
group = mod_group_id
archivesBaseName = mod_id

minecraft {
    version = '${mcVersion}-${loaderVersion}'
    runDir = 'run'
}

dependencies {
    // 1.7.10 has no deobf dependency helper worth using here; add mods by hand.
}
`
    }
    case 'legacy-fml': {
      // Pre-1.7: no Gradle plugin exists. A plain javac setup against a dev jar is
      // the honest thing to ship; the notes tell the user what is missing.
      return `// ${cfg.era.label}: Minecraft ${mcVersion}
//
// There is no maintained Gradle plugin for this era. This project is laid out the
// old way (src/main/java + mcmod.info) so it can be dropped into a legacy dev
// workspace. Set FORGE_DEV_JAR to a deobfuscated Forge dev jar to compile here.
plugins {
    id 'java'
}

version = mod_version
group = mod_group_id
archivesBaseName = mod_id

sourceCompatibility = targetCompatibility = '1.8'

repositories {
    flatDir { dirs 'libs' }
}

dependencies {
    def devJar = System.getenv('FORGE_DEV_JAR')
    if (devJar) {
        implementation files(devJar)
    }
}

jar {
    manifest {
        attributes(['FMLCorePluginContainsFMLMod': 'true'])
    }
}
`
    }
    case 'fabric-loom':
      return `plugins {
    id 'fabric-loom' version '1.8-SNAPSHOT'
    id 'maven-publish'
}

version = mod_version
group = mod_group_id

base { archivesName = mod_id }

repositories {
    mavenCentral()
}

dependencies {
    minecraft "com.mojang:minecraft:\${minecraft_version}"
    mappings "net.fabricmc:yarn:\${yarn_mappings}:v2"
    modImplementation "net.fabricmc:fabric-loader:\${loader_version}"
    // fabric_version is only defined when the version catalog resolved a real
    // Fabric API build for this Minecraft version.
    if (project.hasProperty('fabric_version')) {
        modImplementation "net.fabricmc.fabric-api:fabric-api:\${fabric_version}"
    }
}

processResources {
    inputs.property 'version', project.version
    filesMatching('fabric.mod.json') {
        expand 'version': project.version
    }
}

tasks.withType(JavaCompile).configureEach {
    it.options.release = ${java}
}

java {
    withSourcesJar()
    sourceCompatibility = JavaVersion.VERSION_${java}
    targetCompatibility = JavaVersion.VERSION_${java}
}
`
  }
}

function mappingsChannel(cfg: ProjectConfig): string {
  // 1.8-1.12 use MCP names; stable_39 covers 1.12, snapshot covers the rest.
  return cfg.mcVersion.startsWith('1.12') ? 'stable' : 'snapshot'
}

/**
 * MCP mapping strings for the 1.8-1.12 era. Stable mappings only exist from 1.12;
 * earlier versions use snapshots, where the date has to come from the user (it is
 * per-recommended-build), so the latest known one is used and flagged.
 */
function mappingsVersionFor(cfg: ProjectConfig): string {
  if (cfg.mcVersion.startsWith('1.12')) return '39-1.12'
  if (cfg.mcVersion.startsWith('1.11')) return 'snapshot_20161220'
  if (cfg.mcVersion.startsWith('1.10')) return 'snapshot_20160518'
  if (cfg.mcVersion.startsWith('1.9')) return 'snapshot_20160312'
  return 'snapshot_20141130'
}

// ------------------------------------------------------------------ properties

export function gradleProperties(cfg: ProjectConfig): string {
  const { era } = cfg
  const base = [
    `mod_id=${cfg.modId}`,
    `mod_name=${cfg.modName}`,
    `mod_license=${cfg.license}`,
    `mod_version=${cfg.version}`,
    `mod_group_id=${cfg.group}`,
    `mod_authors=${cfg.author}`,
    `mod_description=${cfg.modName} - a ${loaderLabel(cfg)} mod for Minecraft ${cfg.mcVersion}.`,
    // Explicit, so the agent prompt can tell which loader it is writing for
    // without inferring from which *_version key happens to exist.
    `mod_loader=${cfg.loader}`,
    '',
    `minecraft_version=${cfg.mcVersion}`,
    `minecraft_version_range=[${cfg.mcVersion},)`
  ].join('\n')

  if (era.id === 'neo-moddev') {
    return `${base}
neo_version=${cfg.loaderVersion}
neo_version_range=[${neoMajor(cfg.loaderVersion)},)
loader_version_range=[4,)
parchment_mappings_version=2024.07.28
parchment_minecraft_version=${cfg.mcVersion}
`
  }
  if (cfg.loader === 'forge') {
    return `${base}
forge_version=${cfg.loaderVersion}
forge_version_range=[${forgeMajor(cfg.loaderVersion)},)
loader_version_range=[${loaderRangeFor(cfg.mcVersion)})
`
  }
  if (cfg.loader === 'fabric') {
    const extras = fabricExtrasFor(cachedCatalog() ?? EMPTY_CATALOG, cfg.loaderVersion, cfg.mcVersion)
    const yarn = cfg.mappingsVersion ?? extras.yarnMappings ?? `${cfg.mcVersion}+build.1`
    const api = cfg.fabricApi ?? extras.fabricApi
    // Only declare Fabric API when the catalog named a real build for this game
    // version; inventing "0.110.0+1.14.4" would fail the first resolve.
    return `${base}
yarn_mappings=${yarn}
loader_version=${cfg.loaderVersion}
${api ? `fabric_version=${api}\n` : ''}`
  }
  return base + '\n'
}

export function settingsGradle(cfg: ProjectConfig): string {
  return `pluginManagement {
    repositories {
        gradlePluginPortal()
        maven { url = 'https://maven.neoforged.net/releases' }
        maven { url = 'https://maven.minecraftforge.net/' }
        maven { url = 'https://maven.fabricmc.net/' }
    }
}

rootProject.name = '${cfg.modId}'
`
}

function loaderLabel(cfg: ProjectConfig): string {
  return cfg.loader === 'neoforge' ? 'NeoForge' : cfg.loader === 'forge' ? 'Forge' : 'Fabric'
}

/** "21.1.265" -> "21.1"; used for the NeoForge version range. */
function neoMajor(v: string): string {
  const m = v.match(/^(\d+)\.(\d+)/)
  return m ? `${m[1]}.${m[2]}` : v
}

/** "52.0.2" -> "52"; Forge ranges are major-based. */
function forgeMajor(v: string): string {
  return v.split('.')[0]
}

/** FML loader version range differs wildly; keep the common ones. */
function loaderRangeFor(mc: string): string {
  if (compareMcVersions(mc, '1.20.5') >= 0) return '3,'
  if (compareMcVersions(mc, '1.18') >= 0) return '39,'
  return '36,'
}

// ------------------------------------------------------------------ sources

export function mainClass(cfg: ProjectConfig, className: string): string {
  switch (cfg.loader) {
    case 'fabric':
      return `package ${cfg.group};

import net.fabricmc.api.ModInitializer;
import net.minecraft.item.Item;
import net.minecraft.registry.Registries;
import net.minecraft.registry.Registry;
import net.minecraft.util.Identifier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * ${cfg.modName} - Fabric entry point for Minecraft ${cfg.mcVersion}.
 * Generated by MC Forge Agent; change it freely.
 */
public class ${className} implements ModInitializer {
    public static final String MOD_ID = "${cfg.modId}";
    public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

    /** A simple item: ${cfg.modId}:example_item. */
    public static final Item EXAMPLE_ITEM = new Item(new Item.Settings());

    @Override
    public void onInitialize() {
        Registry.register(Registries.ITEM, Identifier.of(MOD_ID, "example_item"), EXAMPLE_ITEM);
        LOGGER.info("{} loaded (Minecraft ${cfg.mcVersion} / Fabric)", "${cfg.modName}");
    }
}
`
    case 'neoforge':
      return `package ${cfg.group};

import net.minecraft.core.registries.Registries;
import net.minecraft.world.item.CreativeModeTab;
import net.minecraft.world.item.Item;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.common.Mod;
import net.neoforged.neoforge.registries.DeferredItem;
import net.neoforged.neoforge.registries.DeferredRegister;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * ${cfg.modName} - NeoForge mod for Minecraft ${cfg.mcVersion}.
 * Generated by MC Forge Agent; change it freely.
 */
@Mod(${className}.MOD_ID)
public class ${className} {
    public static final String MOD_ID = "${cfg.modId}";
    public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

    public static final DeferredRegister.Items ITEMS = DeferredRegister.createItems(MOD_ID);
    public static final DeferredItem<Item> EXAMPLE_ITEM = ITEMS.registerSimpleItem("example_item", new Item.Properties());

    public ${className}(IEventBus modEventBus) {
        ITEMS.register(modEventBus);
        LOGGER.info("{} loaded (Minecraft ${cfg.mcVersion} / NeoForge)", "${cfg.modName}");
    }
}
`
    default: {
      // Forge, all eras. The annotation and registry style changed at 1.13 and again
      // at 1.20.2, so the body differs by era while the skeleton stays recognisable.
      const modern = cfg.era.id === 'forge-1.20.2' || cfg.era.id === 'fg-6.x'
      const mid = cfg.era.id === 'fg-3.x' || cfg.era.id === 'fg-5.x'
      if (modern) {
        return `package ${cfg.group};

import net.minecraft.world.item.Item;
import net.minecraftforge.eventbus.api.IEventBus;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.fml.javafmlmod.FMLJavaModLoadingContext;
import net.minecraftforge.registries.DeferredRegister;
import net.minecraftforge.registries.ForgeRegistries;
import net.minecraftforge.registries.RegistryObject;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * ${cfg.modName} - Forge mod for Minecraft ${cfg.mcVersion}.
 * Generated by MC Forge Agent; change it freely.
 */
@Mod(${className}.MOD_ID)
public class ${className} {
    public static final String MOD_ID = "${cfg.modId}";
    public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

    public static final DeferredRegister<Item> ITEMS = DeferredRegister.create(ForgeRegistries.ITEMS, MOD_ID);
    public static final RegistryObject<Item> EXAMPLE_ITEM = ITEMS.register("example_item", () -> new Item(new Item.Properties()));

    public ${className}() {
        IEventBus bus = FMLJavaModLoadingContext.get().getModEventBus();
        ITEMS.register(bus);
        LOGGER.info("{} loaded (Minecraft ${cfg.mcVersion} / Forge)", "${cfg.modName}");
    }
}
`
      }
      if (mid) {
        return `package ${cfg.group};

import net.minecraft.world.item.Item;
import net.minecraftforge.eventbus.api.IEventBus;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.fml.javafmlmod.FMLJavaModLoadingContext;
import net.minecraftforge.registries.DeferredRegister;
import net.minecraftforge.registries.ForgeRegistries;
import net.minecraftforge.registries.RegistryObject;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;

/**
 * ${cfg.modName} - Forge mod for Minecraft ${cfg.mcVersion}.
 * Generated by MC Forge Agent; change it freely.
 */
@Mod(${className}.MOD_ID)
public class ${className} {
    public static final String MOD_ID = "${cfg.modId}";
    public static final Logger LOGGER = LogManager.getLogger();

    public static final DeferredRegister<Item> ITEMS = DeferredRegister.create(ForgeRegistries.ITEMS, MOD_ID);
    public static final RegistryObject<Item> EXAMPLE_ITEM = ITEMS.register("example_item", () -> new Item(new Item.Properties().tab(null)));

    public ${className}() {
        IEventBus bus = FMLJavaModLoadingContext.get().getModEventBus();
        ITEMS.register(bus);
        LOGGER.info("{} loaded (Minecraft ${cfg.mcVersion} / Forge)", "${cfg.modName}");
    }
}
`
      }
      // 1.8 - 1.12: no DeferredRegister, no mod event bus.
      return `package ${cfg.group};

import net.minecraft.item.Item;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.fml.common.event.FMLInitializationEvent;
import net.minecraftforge.fml.common.event.FMLPreInitializationEvent;
import net.minecraftforge.fml.common.registry.GameRegistry;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;

/**
 * ${cfg.modName} - Forge mod for Minecraft ${cfg.mcVersion}.
 * Generated by MC Forge Agent; change it freely.
 */
@Mod(modid = ${className}.MODID, name = ${className}.NAME, version = ${className}.VERSION, acceptedMinecraftVersions = "[${cfg.mcVersion}]")
public class ${className} {
    public static final String MODID = "${cfg.modId}";
    public static final String NAME = "${cfg.modName}";
    public static final String VERSION = "${cfg.version}";
    public static final Logger LOGGER = LogManager.getLogger(MODID);

    public static Item exampleItem;

    @Mod.EventHandler
    public void preInit(FMLPreInitializationEvent event) {
        exampleItem = new Item();
        exampleItem.setRegistryName(MODID, "example_item");
        GameRegistry.findRegistry(Item.class).register(exampleItem);
    }

    @Mod.EventHandler
    public void init(FMLInitializationEvent event) {
        LOGGER.info("{} loaded (Minecraft ${cfg.mcVersion} / Forge)", NAME);
    }
}
`
    }
  }
}

// ------------------------------------------------------------------ metadata

export function metadataFiles(cfg: ProjectConfig, className: string): { path: string; content: string }[] {
  if (cfg.loader === 'fabric') {
    return [
      {
        path: 'src/main/resources/fabric.mod.json',
        content: JSON.stringify(
          {
            schemaVersion: 1,
            id: cfg.modId,
            version: '${version}',
            name: cfg.modName,
            description: `${cfg.modName} - a Fabric mod for Minecraft ${cfg.mcVersion}.`,
            authors: [cfg.author || 'unknown'],
            license: cfg.license,
            environment: '*',
            entrypoints: { main: [`${cfg.group}.${className}`] },
            depends: {
              fabricloader: '>=0.14.0',
              minecraft: `~${cfg.mcVersion}`,
              java: `>=${javaForVersion(cfg.loader, cfg.mcVersion, cfg.era)}`
            }
          },
          null,
          2
        ) + '\n'
      }
    ]
  }

  if (cfg.era.id === 'neo-moddev') {
    return [
      {
        path: 'src/main/templates/META-INF/neoforge.mods.toml',
        content: `modLoader="javafml"
loaderVersion="\${loader_version_range}"
license="\${mod_license}"
issueTrackerURL="https://github.com/${cfg.author}/issues"

[[mods]]
modId="\${mod_id}"
version="\${mod_version}"
displayName="\${mod_name}"
authors="\${mod_authors}"
description="'''\${mod_description}'''"

[[dependencies.\${mod_id}]]
modId="neoforge"
type="required"
versionRange="\${neo_version_range}"
ordering="NONE"
side="BOTH"

[[dependencies.\${mod_id}]]
modId="minecraft"
type="required"
versionRange="\${minecraft_version_range}"
ordering="NONE"
side="BOTH"
`
      },
      {
        path: 'src/main/resources/pack.mcmeta',
        content: JSON.stringify({ pack: { description: cfg.modId, pack_format: 34 } }, null, 2) + '\n'
      }
    ]
  }

  if (cfg.loader === 'forge') {
    const legacy = cfg.era.id === 'fg-2.x' || cfg.era.id === 'fg-1.7' || cfg.era.id === 'legacy-fml'
    const tomlFor = (): string => `modLoader="javafml"
loaderVersion="[${loaderRangeFor(cfg.mcVersion)},)"
license="\${mod_license}"

[[mods]]
modId="\${mod_id}"
version="\${mod_version}"
displayName="\${mod_name}"
authors="\${mod_authors}"
description='''\${mod_description}'''

[[dependencies.\${mod_id}]]
    modId="forge"
    mandatory=true
    versionRange="[${forgeMajor(cfg.loaderVersion)},)"
    ordering="NONE"
    side="BOTH"

[[dependencies.\${mod_id}]]
    modId="minecraft"
    mandatory=true
    versionRange="[${cfg.mcVersion},)"
    ordering="NONE"
    side="BOTH"
`
    return [
      {
        path: legacy ? 'src/main/resources/mcmod.info' : 'src/main/resources/META-INF/mods.toml',
        content: legacy
          ? JSON.stringify(
              [
                {
                  modid: cfg.modId,
                  name: cfg.modName,
                  description: `${cfg.modName} - a Forge mod for Minecraft ${cfg.mcVersion}.`,
                  version: '${version}',
                  mcversion: cfg.mcVersion,
                  authorList: [cfg.author || 'unknown'],
                  credits: 'Generated with MC Forge Agent',
                  logoFile: ''
                }
              ],
              null,
              2
            ) + '\n'
          : tomlFor()
      },
      {
        path: 'src/main/resources/pack.mcmeta',
        content: JSON.stringify({ pack: { description: cfg.modId, pack_format: 3, _comment: 'MC Forge Agent' } }, null, 2) + '\n'
      }
    ]
  }

  return []
}

export function langFile(cfg: ProjectConfig): { path: string; content: string } {
  return {
    path: `src/main/resources/assets/${cfg.modId}/lang/en_us.json`,
    content:
      JSON.stringify(
        {
          [`item.${cfg.modId}.example_item`]: `${cfg.modName} Example Item`,
          [`itemGroup.${cfg.modId}`]: cfg.modName,
          [`block.${cfg.modId}.example_block`]: `${cfg.modName} Example Block`
        },
        null,
        2
      ) + '\n'
  }
}

/** Everything the generator writes, so the caller only has to place files. */
export function eraFiles(cfg: ProjectConfig, className: string): { path: string; content: string }[] {
  return [
    { path: 'build.gradle', content: buildGradle(cfg) },
    { path: 'settings.gradle', content: settingsGradle(cfg) },
    { path: 'gradle.properties', content: gradleProperties(cfg) },
    { path: `src/main/java/${cfg.group.split('.').join('/')}/${className}.java`, content: mainClass(cfg, className) },
    langFile(cfg),
    ...metadataFiles(cfg, className)
  ]
}

/** Gradle wrapper version for the era, written into gradle-wrapper.properties. */
export function wrapperProperties(era: Era): string {
  return `distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionUrl=https\\://services.gradle.org/distributions/gradle-${era.gradle}-bin.zip
networkTimeout=10000
validateDistributionUrl=true
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists
`
}
