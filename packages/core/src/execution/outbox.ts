import type { AuditEvent } from '../audit-event'
import type { GuardedStatement } from './types'

export function outboxInsert(event: AuditEvent, guard?: { sql: string; bindings?: readonly (string | number | null)[] }): GuardedStatement {
  return { sql: `INSERT INTO audit_outbox (event_id,organization_id,payload,created_at) SELECT ?,?,?,?${guard ? ` WHERE ${guard.sql}` : ''}`,
    bindings: [event.event_id, event.organization_id, JSON.stringify(event), event.occurred_at, ...(guard?.bindings ?? [])], outboxEvent: event, expectRows: 1 }
}

