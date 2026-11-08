import { sha256, ulid } from './crypto'
import type { Scope } from './identity'
import type { AuditEvent } from './audit-event'
export { makeEvent, type AuditEvent } from './audit-event'
export const outboxStatement = (db: D1Database, event: AuditEvent, guard = 'changes() = 1') => db.prepare(`INSERT INTO audit_outbox (event_id,organization_id,payload,created_at) SELECT ?,?,?,? WHERE ${guard}`).bind(event.event_id, event.organization_id, JSON.stringify(event), event.occurred_at)
export async function securityLog(db: D1Database, scope: Partial<Scope>, operation: string, status: number) {
  const requested = scope.organizationId
  const organization = requested ? await db.prepare('SELECT id FROM organizations WHERE id=?').bind(requested).first<string>('id') : null
  const requestedHash = requested && !organization ? await sha256(requested) : null
  await db.prepare('INSERT INTO security_log (id,organization_id,requested_scope_hash,actor_id,operation,status,correlation_id,occurred_at) VALUES (?,?,?,?,?,?,?,?)').bind(ulid(), organization, requestedHash, scope.actor?.id ?? null, operation, status, scope.correlationId ?? ulid(), new Date().toISOString()).run()
}
