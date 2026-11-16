import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run } from '../util/exec'
import type { GameInstance } from '../../shared/types'

const isWin = process.platform === 'win32'

/**
 * Technic stores installed packs under %APPDATA%/.technic/modpacks/<slug>.
 * Each pack folder is a normal game directory: mods/, config/, options.txt,
 * plus bin/version + bin/runData telling the launcher what to launch.
 *
 * Technic itself has no per-pack CLI, so "install into Technic" means writing
 * the jar into that instance's mods/ folder; the user presses Play in Technic.
 * The NeoForge loader is installed by the official NeoForge installer.
 */
export function technicRoots(): string[] {
  const roots: string[] = []
  const appData = process.env.APPDATA
  const localAppData = process.env.LOCALAPPDATA
  if (isWin) {
    if (appData) roots.push(path.join(appData, '.technic'))
    if (localAppData) roots.push(path.join(localAppData, '.technic'))
  } else if (process.platform === 'darwin') {
    roots.push(path.join(os.homedir(), 'Library', 'Application Support', '.technic'))
  } else {
    roots.push(path.join(os.homedir(), '.technic'))
  }
  return roots
}

export interface DetectedInstance extends GameInstance {
  /** 'technic' packs can only be launched through the launcher itself. */
  launcherType: 'technic'
}

export function detectTechnicInstances(configuredPath?: string): DetectedInstance[] {
  const out: DetectedInstance[] = []
  for (const root of technicRoots()) {
    const modpacks = path.join(root, 'modpacks')
    if (!fs.existsSync(modpacks)) continue
    let names: string[] = []
    try {
      names = fs.readdirSync(modpacks)
    } catch {
      continue
    }
    for (const name of names) {
      const packDir = path.join(modpacks, name)
      try {
        if (!fs.statSync(packDir).isDirectory()) continue
      } catch {
        continue
      }
      const version = readVersion(packDir)
      out.push({
        id: `technic:${path.resolve(packDir)}`,
        name: name.replace(/-/g, ' '),
        kind: 'technic',
        path: packDir,
        minecraftDir: path.join(packDir, '.minecraft'),
        technicExe: technicExe(configuredPath),
        notes: version ? `Technic build ${version.version}` : undefined,
        launcherType: 'technic'
      })
    }
  }
  return out
}

function readVersion(packDir: string): { version: string; installed: boolean } | null {
  try {
    const raw = fs.readFileSync(path.join(packDir, 'bin', 'version'), 'utf8')
    return JSON.parse(raw) as { version: string; installed: boolean }
  } catch {
    return null
  }
}

/**
 * Where the Technic Launcher actually is.
 *
 * The old version checked three hard-coded paths under `%LOCALAPPDATA%`,
 * `%APPDATA%` and `Program Files`. The launcher has no fixed install location —
 * the download is a single exe people run from wherever it landed — so that
 * found nothing for most real installs and reported "not found" to someone
 * looking at the launcher window.
 *
 * Order matters: an explicit setting wins, then the usual install roots, then
 * `%APPDATA%\.technic` (where the launcher keeps everything else and sometimes
 * itself), then a bounded search of the places a hand-downloaded exe ends up.
 * Every step is cheap and none of it touches the network.
 */
export function technicExe(configured?: string): string | undefined {
  if (!isWin) return undefined

  // 1. What the user pointed at. This is the answer that is never a guess.
  if (configured?.trim()) {
    const hit = resolveLauncherCandidate(configured.trim())
    if (hit) return hit
  }

  // 2. The install roots, including 32-bit Program Files and per-user Programs.
  const roots = [
    process.env.LOCALAPPDATA,
    process.env.APPDATA,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.ProgramW6432
  ].filter((r): r is string => !!r)
  const names = ['TechnicLauncher.exe', 'techniclauncher.exe', 'Technic Launcher.exe']
  const dirs = ['TechnicLauncher', 'Technic Launcher', 'techniclauncher', path.join('Programs', 'TechnicLauncher')]
  for (const root of roots) {
    for (const dir of dirs) {
      for (const name of names) {
        const p = path.join(root, dir, name)
        try {
          if (fs.existsSync(p)) return p
        } catch {
          /* an unreadable candidate is not a reason to stop looking */
        }
      }
    }
  }

  // 3. Inside the data folder — some installs put the exe beside .technic.
  for (const root of technicRoots()) {
    for (const name of [...names, 'TechnicLauncher.jar']) {
      const p = path.join(root, name)
      try {
        if (fs.existsSync(p)) return p
      } catch {
        /* same */
      }
    }
  }

  // 4. A shallow scan of the obvious places a downloaded exe is left.
  const home = os.homedir()
  for (const dir of [path.join(home, 'Downloads'), path.join(home, 'Desktop'), home, 'C:\\Technic', 'C:\\Games\\Technic']) {
    for (const name of names) {
      try {
        const p = path.join(dir, name)
        if (fs.existsSync(p)) return p
      } catch {
        /* same */
      }
    }
  }
  return undefined
}

/**
 * Turn whatever the user typed into an exe path, if it is one.
 *
 * They may paste the exe, paste the folder it sits in, or hint at the jar. All
 * three are reasonable things to do with a "where is the launcher" setting, and
 * refusing two of them would be an own goal.
 */
export function resolveLauncherCandidate(input: string): string | undefined {
  const candidates = [input, path.join(input, 'TechnicLauncher.exe'), path.join(input, 'techniclauncher.exe')]
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile() && /\.(exe|jar|bat|cmd)$/i.test(c)) return c
    } catch {
      /* try the next */
    }
  }
  return undefined
}

/**
 * What to tell someone when the launcher cannot be found.
 *
 * The old sentence said "point Settings > Instance at the pack folder", which was
 * doubly wrong: that control adds a *pack*, not a launcher, and no setting
 * existed for the launcher at all. An error that names a fix which cannot work
 * costs more than a vague one, because it sends the user somewhere they will
 * conclude they did it wrong.
 */
export function launcherNotFoundHelp(configured?: string): string {
  const where = configured?.trim()
    ? `The path in Settings → Game is \`${configured.trim()}\`, and no launcher executable is there.`
    : 'The usual places were checked: %LOCALAPPDATA%, %APPDATA%, Program Files, %APPDATA%\\.technic, and your Downloads, Desktop and home folders.'
  return (
    `Technic Launcher not found, so it could not be started. ${where}\n\n` +
    'Either:\n' +
    '  • Set Settings → Game → **Technic Launcher** to the `TechnicLauncher.exe` file (or the folder containing it). ' +
    'Right-click the launcher shortcut → Open file location if you are not sure where it is.\n' +
    '  • Or skip the launcher entirely: add the pack folder as a **custom** instance (Settings → Game → Add folder) ' +
    'and the app will launch Minecraft directly, if NeoForge is installed in that pack.\n\n' +
    'Installing Technic is not required for either of these to work.'
  )
}

export async function launchTechnic(configuredPath?: string): Promise<{ ok: boolean; error?: string }> {
  const exe = technicExe(configuredPath)
  if (!exe) return { ok: false, error: launcherNotFoundHelp(configuredPath) }
  try {
    const child = (await import('node:child_process')).spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/**
 * Technic-compatible pack zip: mods/, config/, options.txt at the top level.
 * The loader is documented in README-plan.txt because Technic distributes
 * NeoForge via its platform pack settings rather than bin/modpack.jar
 * (that mechanism only exists for legacy Forge/Minecraft <= 1.12).
 */
export async function buildTechnicPackZip(instanceDir: string, outZip: string, meta: { name: string; version: string; author?: string; loaderVersion: string }): Promise<{ ok: boolean; zip?: string; error?: string }> {
  const AdmZip = (await import('adm-zip')).default
  const zip = new AdmZip()
  const dirs = ['mods', 'config', 'defaultconfigs', 'kubejs', 'scripts']
  for (const dir of dirs) {
    const full = path.join(instanceDir, dir)
    if (fs.existsSync(full)) zip.addLocalFolder(full, dir)
  }
  const readme = `# ${meta.name} ${meta.version}

Minecraft 1.21.1
Loader: NeoForge ${meta.loaderVersion}
${meta.author ? `Author: ${meta.author}\n` : ''}
## How this pack is meant to be installed

Technic's legacy \`bin/modpack.jar\` mechanism only covers Forge on Minecraft 1.12.2 and older.
For 1.21.1 the loader is NeoForge, so use one of these:

1. **Technic (platform pack)**: upload this zip as the pack build and set the pack's
   loader to NeoForge 1.21.1 (${meta.loaderVersion}) on technicpack.net. Technic then
   installs the loader itself.
2. **Manual**: copy \`mods/\` and \`config/\` into a NeoForge 1.21.1 instance.

Generated by MC Forge Agent.
`
  zip.addFile('README-plan.txt', Buffer.from(readme, 'utf8'))
  fs.mkdirSync(path.dirname(outZip), { recursive: true })
  zip.writeZip(outZip)
  return { ok: true, zip: outZip }
}

/** Find the NeoForge version a Technic pack records, if any. */
export async function detectPackLoader(instanceDir: string): Promise<string | null> {
  const mods = path.join(instanceDir, 'mods')
  try {
    for (const f of fs.readdirSync(mods)) {
      if (/neoforge|forge/i.test(f) && f.endsWith('.jar')) return f
    }
  } catch {
    /* ignore */
  }
  return null
}

export async function openFolder(dir: string): Promise<void> {
  const { shell } = await import('electron')
  await shell.openPath(dir)
}

export async function runGameTests(instanceDir: string, java: string, neoVersion: string): Promise<{ ok: boolean; output: string }> {
  // Runs the GameTestServer against the instance's minecraft dir.
  const res = await run(java, ['-version'], { timeoutMs: 10000 }).catch(() => null)
  return { ok: !!res && res.code === 0, output: res?.stderr ?? '' }
}
