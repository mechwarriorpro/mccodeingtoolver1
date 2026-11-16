import fs from 'node:fs'
import path from 'node:path'
import { conversationsDir } from './config'
import type { Conversation } from '../shared/types'

/**
 * Conversations are persisted as one JSON file each in userData/conversations.
 * Small, greppable, and survives app updates.
 */
export function listConversations(): { id: string; title: string; updatedAt: number }[] {
  const dir = conversationsDir()
  const out: { id: string; title: string; updatedAt: number }[] = []
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    try {
      const conv = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Conversation
      out.push({ id: conv.id, title: conv.title, updatedAt: conv.updatedAt })
    } catch {
      /* skip broken file */
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function loadConversation(id: string): Conversation | null {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '')
  const file = path.join(conversationsDir(), `${safe}.json`)
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Conversation
  } catch {
    return null
  }
}

export function saveConversation(conv: Conversation): void {
  const safe = conv.id.replace(/[^a-zA-Z0-9_-]/g, '')
  const file = path.join(conversationsDir(), `${safe}.json`)
  fs.writeFileSync(file, JSON.stringify(conv, null, 2), 'utf8')
}

export function deleteConversation(id: string): void {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '')
  try {
    fs.unlinkSync(path.join(conversationsDir(), `${safe}.json`))
  } catch {
    /* already gone */
  }
}

export function newConversationId(): string {
  return `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}
