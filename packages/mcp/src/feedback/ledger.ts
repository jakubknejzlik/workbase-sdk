import { constants } from 'node:fs'
import { mkdir, open, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { byteHash } from '../byte-digest.ts'
import { acquireInstanceLock } from '../instance-lock.ts'
import type { Configuration } from './config.ts'
import { FeedbackError, type AgentEvent, type Receipt } from './schemas.ts'

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}'
  return JSON.stringify(value)
}
export const digest = (value: unknown) => byteHash(Buffer.from(canonical(value)))
export type SavedEvent = { event_id: string; event: AgentEvent; digest: string; marker: string; created_at: string; posted: boolean }
export type Entry = { packet_id: string; packet_digest: string; feedbackId: string; marker: string; receipt?: Receipt; events: SavedEvent[] }
export type Ledger = { version: 1; scope: string; posting_login: string; entries: Entry[] }
export function scopeOf(config: Configuration) { return digest([config.owner.toLowerCase(), config.repository.toLowerCase(), config.agentId]) }

/** Shared operator ledger; reuse the proven instance-lock primitive in its own root. */
export class FeedbackLedger {
  readonly directory: string
  readonly scope: string
  constructor(config: Configuration, private login: string) {
    this.scope = scopeOf(config); this.directory = join(config.stateDirectory, `feedback-${this.scope}`)
  }
  async transaction<T>(operation: (ledger: Ledger, save: () => Promise<void>) => Promise<T>): Promise<T> {
    // Do not reclaim ambiguous lock metadata. The shared primitive only reclaims
    // a dead local process with proven host/boot/process identity.
    await mkdir(join(this.directory, 'proposals'), { recursive: true, mode: 0o700 })
    let release: () => Promise<void>
    try { release = await acquireInstanceLock(this.directory) }
    catch { throw new FeedbackError('ledger_busy', 409) }
    try {
      const path = join(this.directory, 'ledger.json')
      let ledger: Ledger = { version: 1, scope: this.scope, posting_login: this.login, entries: [] }
      let handle
      try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        const stat = await handle.stat(); if (!stat.isFile() || stat.size > 8000000) throw new Error()
        ledger = JSON.parse(await handle.readFile('utf8')) as Ledger
        if (ledger.version !== 1 || ledger.scope !== this.scope || ledger.posting_login !== this.login || !Array.isArray(ledger.entries)) throw new Error()
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new FeedbackError('invalid_ledger', 503) }
      finally { await handle?.close() }
      const save = async () => {
        const bytes = JSON.stringify(ledger)
        if (ledger.entries.length > 1000 || Buffer.byteLength(bytes, 'utf8') > 8000000) throw new FeedbackError('ledger_capacity', 409)
        const temporary = join(this.directory, `write-${crypto.randomUUID()}.json`)
        const file = await open(temporary, 'wx', 0o600)
        try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
        await rename(temporary, path)
        const directory = await open(this.directory, 'r')
        try { await directory.sync() } finally { await directory.close() }
      }
      return await operation(ledger, save)
    } finally { await release() }
  }
}
