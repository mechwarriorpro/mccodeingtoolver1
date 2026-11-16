import { resolveEra } from '../versions/eras'
import type { Loader } from '../versions/catalog'

export interface PromptGeneratorInput {
  userInput: string
  mcVersion?: string
  loader?: Loader
  sourceMcVersion?: string
  sourceLoader?: Loader
  jarInJarDeps?: Array<{ modId: string; version: string; loader?: Loader }>
}

export interface GeneratedPrompt {
  prompt: string
  detected: {
    mcVersion: string
    loader: Loader
    loaderVersion?: string
    javaVersion: number
    eraSummary: string
  }
}

const MC_VERSION_RE = /\b(1\.\d{1,2}(?:\.\d{1,2})?)\b/g
const LOADER_RE = /\b(neoforge|forge|fabric)\b/i

/**
 * Extract target Minecraft version and loader from free-form user input
 * when not explicitly provided.
 */
export function processUserInput(input: string): { mcVersion?: string; loader?: Loader } {
  const versions = [...input.matchAll(MC_VERSION_RE)].map((m) => m[1])
  const loaderMatch = input.match(LOADER_RE)?.[1]?.toLowerCase() as Loader | undefined
  return {
    mcVersion: versions.length ? versions[versions.length - 1] : undefined,
    loader: loaderMatch
  }
}

/**
 * Custom prompt generator that combines the app's built-in Forge / NeoForge /
 * Fabric version knowledge (eras, Java levels, API cliffs, Jar-in-Jar bundling)
 * with processed user input to produce a focused, version-accurate agent prompt.
 */
export function generateCustomPrompt(input: PromptGeneratorInput): GeneratedPrompt {
  const parsed = processUserInput(input.userInput)
  const mcVersion = input.mcVersion ?? parsed.mcVersion ?? '1.21.1'
  const loader: Loader = input.loader ?? parsed.loader ?? 'neoforge'
  const era = resolveEra(loader, mcVersion)
  const eraLabel = era?.label ?? mcVersion
  const javaVersion = era?.java ?? 21

  const lines: string[] = [
    `Target: Minecraft ${mcVersion} on ${loader} · Java ${javaVersion}`,
    `Era: ${eraLabel}`
  ]

  if (input.sourceMcVersion) {
    lines.push(`Source: Minecraft ${input.sourceMcVersion}${input.sourceLoader ? ` (${input.sourceLoader})` : ''}`)
  }

  if (input.jarInJarDeps?.length) {
    lines.push(
      `Jar-in-Jar (JiJ) bundled dependencies: ${input.jarInJarDeps.map((d) => `${d.modId}@${d.version}`).join(', ')}`
    )
  }

  lines.push('', 'User request:', input.userInput.trim())

  return {
    prompt: lines.join('\n'),
    detected: {
      mcVersion,
      loader,
      javaVersion,
      eraSummary: eraLabel
    }
  }
}
