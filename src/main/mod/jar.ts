import AdmZip from 'adm-zip'
import fs from 'node:fs'
import path from 'node:path'
import type { JarInfo } from '../../shared/types'

/** NeoForge mods are plain jars with META-INF/neoforge.mods.toml. */
export function readJarInfo(jarPath: string): JarInfo {
  const stat = fs.statSync(jarPath)
  const info: JarInfo = { path: jarPath, name: path.basename(jarPath), size: stat.size, builtAt: stat.mtimeMs }
  let zip: AdmZip
  try {
    zip = new AdmZip(jarPath)
  } catch {
    return info
  }
  const tomlEntry =
    zip.getEntry('META-INF/neoforge.mods.toml') ??
    zip.getEntry('META-INF/mods.toml') ??
    zip.getEntry('META-INF/MANIFEST.MF')
  if (!tomlEntry) return info
  const text = tomlEntry.getData().toString('utf8')
  info.modId = matchToml(text, 'modId')
  info.version = matchToml(text, 'version')
  info.displayName = matchToml(text, 'displayName')
  info.loader = text.includes('javafml') ? 'neoforge' : 'unknown'
  const mcRange = text.match(/modId\s*=\s*"minecraft"[\s\S]{0,200}?versionRange\s*=\s*"([^"]+)"/)
  info.mcVersion = mcRange?.[1]
  if (!info.version) {
    const impl = text.match(/Implementation-Version:\s*(\S+)/)
    if (impl) info.version = impl[1]
  }
  return info
}

function matchToml(text: string, key: string): string | undefined {
  const m = text.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'))
  return m?.[1]
}

/** Copy a built jar into an instance's mods folder, replacing older copies of the same mod. */
export function installJar(jarPath: string, instanceDir: string, modId?: string, keepOld = false): { installed: string; removed: string[] } {
  const modsDir = path.join(instanceDir, 'mods')
  fs.mkdirSync(modsDir, { recursive: true })
  const info = readJarInfo(jarPath)
  const target = path.join(modsDir, path.basename(jarPath))
  const removed: string[] = []
  if (!keepOld) {
    const id = modId ?? info.modId
    for (const file of fs.readdirSync(modsDir)) {
      if (!file.endsWith('.jar')) continue
      const full = path.join(modsDir, file)
      if (full === target) continue
      try {
        const existing = readJarInfo(full)
        const sameMod = id ? existing.modId === id : false
        const looksLikeAgentBuild = file === path.basename(jarPath) || /\-1\.0\.0|SNAPSHOT/.test(file)
        if (sameMod || (looksLikeAgentBuild && file.startsWith(path.basename(jarPath).split('-')[0]))) {
          fs.unlinkSync(full)
          removed.push(full)
        }
      } catch {
        /* unreadable jar, leave it alone */
      }
    }
  }
  fs.copyFileSync(jarPath, target)
  return { installed: target, removed }
}

export function copyExtraMods(paths: string[], instanceDir: string): { copied: string[]; missing: string[] } {
  const modsDir = path.join(instanceDir, 'mods')
  fs.mkdirSync(modsDir, { recursive: true })
  const copied: string[] = []
  const missing: string[] = []
  for (const p of paths) {
    if (!p) continue
    if (!fs.existsSync(p)) {
      missing.push(p)
      continue
    }
    const target = path.join(modsDir, path.basename(p))
    fs.copyFileSync(p, target)
    copied.push(target)
  }
  return { copied, missing }
}
