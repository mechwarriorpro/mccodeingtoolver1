import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { app, nativeImage } from 'electron'
import { run } from '../util/exec'
import { screenshotsDir } from '../config'

const isWin = process.platform === 'win32'

export interface CaptureResult {
  ok: boolean
  path?: string
  width?: number
  height?: number
  base64?: string
  error?: string
}

/**
 * Capture the Minecraft window. Minecraft runs in its own process, so we use the
 * OS window manager (PowerShell + user32 on Windows, screencapture on macOS,
 * ImageMagick/xwd on Linux) and fall back to a full-screen grab via Electron.
 */
export async function captureGameWindow(label?: string): Promise<CaptureResult> {
  const outDir = screenshotsDir()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = path.join(outDir, `shot-${stamp}.png`)

  try {
    if (isWin) {
      const ok = await captureWindows(outPath)
      if (ok) return finish(outPath, label)
    } else if (process.platform === 'darwin') {
      const ok = await captureMac(outPath)
      if (ok) return finish(outPath, label)
    } else {
      const ok = await captureLinux(outPath)
      if (ok) return finish(outPath, label)
    }
  } catch {
    /* fall through to desktop capture */
  }

  const fallback = await captureDesktop(outPath)
  if (fallback) return finish(outPath, label)
  return { ok: false, error: 'Could not capture the screen. Check screen-recording permissions.' }

  function finish(p: string, lbl?: string): CaptureResult {
    const img = nativeImage.createFromPath(p)
    const size = img.getSize()
    if (lbl) writeLastLabel(p, lbl)
    return { ok: true, path: p, width: size.width, height: size.height, base64: img.toPNG().toString('base64') }
  }
}

function writeLastLabel(p: string, label: string): void {
  try {
    fs.writeFileSync(`${p}.json`, JSON.stringify({ label, createdAt: Date.now() }), 'utf8')
  } catch {
    /* ignore */
  }
}

/** PowerShell script: find the Minecraft window, bring it to front, PrintWindow into a bitmap. */
function captureWindows(outPath: string): Promise<boolean> {
  const ps = `
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string n);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$target = [IntPtr]::Zero
$cb = [W+EnumWindowsProc]{
  param($h, $l)
  $sb = New-Object System.Text.StringBuilder 512
  [void][W]::GetWindowTextW($h, $sb, 512)
  $t = $sb.ToString()
  if ([W]::IsWindowVisible($h) -and ($t -like "*Minecraft*")) { $script:target = $h; return $false }
  return $true
}
[void][W]::EnumWindows($cb, [IntPtr]::Zero)
if ($target -eq [IntPtr]::Zero) { exit 2 }
[void][W]::ShowWindow($target, 9)
[void][W]::SetForegroundWindow($target)
Start-Sleep -Milliseconds 700
$r = New-Object W+RECT
[void][W]::GetWindowRect($target, [ref]$r)
$w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
if ($w -le 0 -or $h -le 0) { exit 3 }
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
$bmp.Save("${outPath.replace(/\\/g, '\\\\')}", [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
exit 0
`
  const scriptPath = path.join(app.getPath('temp'), `mcfrogeagent-capture-${Date.now()}.ps1`)
  fs.writeFileSync(scriptPath, ps, 'utf8')
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { windowsHide: true })
    child.on('close', (code) => {
      try {
        fs.unlinkSync(scriptPath)
      } catch {
        /* ignore */
      }
      resolve(code === 0 && fs.existsSync(outPath))
    })
    child.on('error', () => resolve(false))
  })
}

async function captureMac(outPath: string): Promise<boolean> {
  // -l <windowid> not available without extra deps; capture the frontmost MC window via -R if we can find it.
  const list = await run('osascript', ['-e', 'tell application "System Events" to get name of every process whose background only is false'], { timeoutMs: 15000 })
  if (list.code !== 0) return false
  const res = await run('screencapture', ['-x', '-o', outPath], { timeoutMs: 30000 })
  return res.code === 0 && fs.existsSync(outPath)
}

async function captureLinux(outPath: string): Promise<boolean> {
  const xwd = await run('sh', ['-c', `xwd -root -silent | convert xwd:- "${outPath}"`], { timeoutMs: 30000 })
  if (xwd.code === 0 && fs.existsSync(outPath)) return true
  const importCmd = await run('import', ['-window', 'root', outPath], { timeoutMs: 30000 })
  return importCmd.code === 0 && fs.existsSync(outPath)
}

/** Full virtual desktop grab using Electron (no external tools required). */
async function captureDesktop(outPath: string): Promise<boolean> {
  try {
    const img = await captureViaElectron()
    if (!img) return false
    fs.writeFileSync(outPath, img)
    return true
  } catch {
    return false
  }
}

/**
 * Fallback: grab the whole primary screen with Electron's desktopCapturer.
 * This needs no user gesture and works even when the OS window enumeration fails.
 */
async function captureViaElectron(): Promise<Buffer | null> {
  try {
    const { desktopCapturer, screen } = await import('electron')
    const display = screen.getPrimaryDisplay()
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: display.size.width, height: display.size.height }
    })
    const best =
      sources.find((s) => s.display_id === String(display.id)) ??
      sources[0]
    if (!best) return null
    const png = best.thumbnail.toPNG()
    return png.length ? png : null
  } catch {
    return null
  }
}

export function listScreenshots(): { path: string; createdAt: number; label?: string }[] {
  const dir = screenshotsDir()
  let files: string[] = []
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.png'))
  } catch {
    return []
  }
  return files
    .map((f) => {
      const p = path.join(dir, f)
      let label: string | undefined
      try {
        label = JSON.parse(fs.readFileSync(`${p}.json`, 'utf8')).label
      } catch {
        /* none */
      }
      return { path: p, createdAt: fs.statSync(p).mtimeMs, label }
    })
    .sort((a, b) => b.createdAt - a.createdAt)
}
