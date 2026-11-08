import type { AuditSink } from '../../../core/src/kernel/audit-port'
import type { AuditEvent } from '../../../core/src/audit-event'
import { auditPrefix, segment, sortKey, type AuditMetadata } from './keys'

export class KvAuditSink implements AuditSink {
  constructor(private kv: KVNamespace) {}
  async insert(input: AuditEvent): Promise<void> {
    const base = auditPrefix(input.organization_id, input.instance_id)
    const identityKey = `${base}id/${segment(input.event_id)}`
    // Outbox events are immutable. Keep a canonical event by id so retries also
    // repair partially written indexes without creating new positions.
    const existing = await this.kv.get(identityKey)
    const event = existing ? JSON.parse(existing) as AuditEvent : input
    const value = existing ?? JSON.stringify(event)
    const suffix = sortKey(event.occurred_at, event.event_id)
    const keys = [`${base}all/${suffix}`, `${base}e/${segment(event.entity)}/${segment(event.entity_id)}/${suffix}`, `${base}t/${segment(event.entity)}/${suffix}`]
    if ([identityKey, ...keys].some(key => new TextEncoder().encode(key).length > 512)) throw new Error('audit_key_too_long')
    const metadata: AuditMetadata = { occurred_at: event.occurred_at, event_id: event.event_id, entity: event.entity, entity_id: event.entity_id }
    if (!existing) await this.kv.put(identityKey, value, { metadata })
    for (const key of keys) if (await this.kv.get(key) === null) await this.kv.put(key, value, { metadata })
  }
}
