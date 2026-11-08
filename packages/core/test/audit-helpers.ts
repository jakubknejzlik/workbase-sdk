import { env } from 'cloudflare:workers'
import type { AuditEvent } from '../src/audit-event'
import { KvAuditSink } from '../../plugins/audit/src/sink'
/** Inspect only the activity index: the canonical and entity keys are replicas. */
export async function auditEvents(kv = env.AUDIT_KV): Promise<AuditEvent[]> {
  const events: AuditEvent[] = []
  let cursor: string | undefined
  do {
    const page = await kv.list({ prefix: 'org/', cursor })
    for (const key of page.keys) if (key.name.includes('/all/')) {
      const event = await kv.get<AuditEvent>(key.name, 'json')
      if (event) events.push(event)
    }
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
  return events
}
export const seedAudit = (event: Partial<AuditEvent>) => new KvAuditSink(env.AUDIT_KV).insert(event as AuditEvent)
