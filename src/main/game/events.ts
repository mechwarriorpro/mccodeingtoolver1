import type { GameStatus } from '../../shared/types'

/**
 * Process-wide game event bus. The launcher/runner modules publish here; the IPC
 * layer subscribes once and forwards to the renderer, which keeps the game code
 * free of window/electron-webContents details.
 */
const statusListeners = new Set<(s: GameStatus) => void>()
const logListeners = new Set<(line: string) => void>()

export function onGameStatus(fn: (s: GameStatus) => void): () => void {
  statusListeners.add(fn)
  return () => statusListeners.delete(fn)
}

export function onGameLog(fn: (line: string) => void): () => void {
  logListeners.add(fn)
  return () => logListeners.delete(fn)
}

/** Convenience: rebuild a status object from the live process registry. */
let statusProvider: (() => GameStatus) | null = null

export function setStatusProvider(fn: () => GameStatus): void {
  statusProvider = fn
}

export function currentStatus(): GameStatus {
  return statusProvider ? statusProvider() : { running: false }
}

export function emitGameStatus(status: GameStatus = currentStatus()): void {
  for (const fn of statusListeners) fn(status)
}

export function emitGameLog(line: string): void {
  for (const fn of logListeners) fn(line)
}
