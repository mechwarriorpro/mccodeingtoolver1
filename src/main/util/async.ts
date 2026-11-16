import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

/**
 * Small async push/pull queue: the renderer pushes user messages in,
 * the Agent SDK pulls them out as an async iterable (streaming input mode),
 * which is what enables canUseTool, interrupt() and multi-turn sessions.
 */
export class AsyncQueue<T> {
  private items: T[] = []
  private resolvers: ((v: IteratorResult<T>) => void)[] = []
  private closed = false

  push(item: T): void {
    if (this.closed) return
    const resolve = this.resolvers.shift()
    if (resolve) resolve({ value: item, done: false })
    else this.items.push(item)
  }

  close(): void {
    this.closed = true
    for (const resolve of this.resolvers.splice(0)) resolve({ value: undefined as never, done: true })
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      if (this.items.length) {
        yield this.items.shift() as T
        continue
      }
      if (this.closed) return
      const next = await new Promise<IteratorResult<T>>((resolve) => this.resolvers.push(resolve))
      if (next.done) return
      yield next.value
    }
  }
}

/** Read a workspace file relative to the project root, refusing escapes. */
export function safeRead(root: string, rel: string, maxBytes = 200_000): { ok: true; text: string } | { ok: false; error: string } {
  const full = path.resolve(root, rel)
  if (!full.startsWith(path.resolve(root))) return { ok: false, error: 'Path is outside the project.' }
  try {
    const stat = fs.statSync(full)
    if (stat.size > maxBytes) return { ok: false, error: `File is ${stat.size} bytes (limit ${maxBytes}). Read a section instead.` }
    return { ok: true, text: fs.readFileSync(full, 'utf8') }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** Flatten a zod raw shape into a plain JSON schema for logging/UI. */
export const jsonSchema = z
