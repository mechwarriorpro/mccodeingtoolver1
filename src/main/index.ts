import { app, BrowserWindow, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { registerIpc } from './ipc'
import { createMainWindow, getMainWindow } from './ipc/windows'
import { loadConfig, saveConfig } from './config'
import { stopGame } from './game/launcher'
import { detectTechnicInstances } from './game/technic'
import { setAppPathForTemplate } from './mod/scaffold'

// A single-instance app: two windows would fight over the same gradle daemon and game.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = getMainWindow()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.setAppUserModelId('com.shadowclan.mcfrogeagent')

  app.whenReady().then(() => {
    // Vendored 1.21.1 MDK template: dev uses the repo copy, packaged builds unpacked resources.
    setAppPathForTemplate(app.getAppPath())

    // First run: try to find a Technic pack so Settings has something to click.
    const cfg = loadConfig()
    if (!cfg.game.instances.length) {
      const detected = detectTechnicInstances()
      if (detected.length) {
        saveConfig({ game: { ...cfg.game, instances: detected, activeInstanceId: detected[0].id } })
      }
    }

    registerIpc()
    createMainWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  let quitting = false
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    void stopGame()
      .catch(() => undefined)
      .finally(() => app.exit(0))
  })

  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
  })
}
