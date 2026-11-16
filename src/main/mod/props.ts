/**
 * `gradle.properties` parsing.
 *
 * Lives on its own so the build code can read a project's declared Minecraft
 * version without importing the agent's tool registry — that would be a cycle
 * (`tools` → `build/gradle` → `tools`), which works until it does not, usually
 * as an undefined function at the worst moment.
 */
import fs from 'node:fs'

/** Parse `key=value` lines, ignoring comments and stripping surrounding quotes. */
export function readProps(file: string): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*)\s*$/)
      if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch {
    /* a missing or unreadable file is an empty property set, not an error */
  }
  return out
}
