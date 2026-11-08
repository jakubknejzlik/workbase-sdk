import type { RuntimeEnv } from '../../../core/src/types'
import type { AuditOutboxRow, AuditRelayOptions } from '../../../core/src/kernel/audit-port'
import type { AuditEvent } from '../../../core/src/audit-event'
import { sendOutboxRows } from '../../../core/src/event-delivery'
import { KvAuditSink } from './sink'

export async function deliverAudit(env: RuntimeEnv, message: AuditOutboxRow, options: AuditRelayOptions = {}) {
  if (!message || typeof message.event_id !== 'string' || typeof message.organization_id !== 'string' || typeof message.payload !== 'string') throw new Error('invalid_audit_message')
  // D1 is authoritative, including tenant and immutable payload. A delayed duplicate
  // after cleanup needs no action; an uncommitted event must never reach the sink.
  const row = await env.DB.prepare('SELECT event_id,organization_id,payload,delivered_at FROM audit_outbox WHERE event_id=? AND organization_id=?').bind(message.event_id, message.organization_id).first<AuditOutboxRow & { delivered_at: string | null }>()
  if (!row) return
  if (row.payload !== message.payload) throw new Error('audit_payload_mismatch')
  if (row.delivered_at) return
  const now = options.now ?? Date.now()
  const timestamp = new Date(now).toISOString()
  const claim = await env.DB.prepare('UPDATE audit_outbox SET attempts=attempts+1 WHERE event_id=? AND organization_id=? AND delivered_at IS NULL RETURNING attempts').bind(row.event_id, row.organization_id).first<{ attempts: number }>()
  if (!claim) return
  try {
    const event = JSON.parse(row.payload) as AuditEvent
    if (event.event_id !== row.event_id || event.organization_id !== row.organization_id) throw new Error('invalid_audit_event')
    if (options.failBeforeSinkInsert) throw new Error('injected_before_sink')
    await (options.sink ?? new KvAuditSink(env.AUDIT_KV)).insert(event)
    if (options.failAfterSinkInsert) throw new Error('injected_after_sink')
    // The webhook intent and audit acknowledgment commit together; a retry cannot lose the automation.
    const statements: D1PreparedStatement[] = []
    if (env.WEBHOOK_EVENTS?.split(',').map(name => name.trim()).includes(event.operation)) statements.push(env.DB.prepare('INSERT OR IGNORE INTO webhook_deliveries (event_id,organization_id,payload,next_attempt_at) VALUES (?,?,?,?)').bind(row.event_id, row.organization_id, row.payload, timestamp))
    statements.push(env.DB.prepare('UPDATE audit_outbox SET delivered_at=?,next_attempt_at=NULL WHERE event_id=? AND organization_id=? AND delivered_at IS NULL').bind(timestamp, row.event_id, row.organization_id))
    await env.DB.batch(statements)
  } catch {
    const retryAt = new Date(now + Math.min(86400000, 300000 * 2 ** Math.min(claim.attempts - 1, 9))).toISOString()
    await env.DB.prepare('UPDATE audit_outbox SET last_error=?,next_attempt_at=? WHERE event_id=? AND organization_id=? AND delivered_at IS NULL').bind('audit_delivery_failed', retryAt, row.event_id, row.organization_id).run()
    throw new Error('audit_delivery_failed')
  }
}

export async function relayAudit(env: RuntimeEnv, options: AuditRelayOptions = {}) {
  const now = options.now ?? Date.now()
  const queue = options.sweep ? env.EVENTS_QUEUE : undefined
  // Queue is primary. Cron repairs the D1 → Queue crash window; manual relay drains synchronously.
  // Fresh rows sort ahead of failed retries, so a full page of poison rows cannot starve new events.
  // Manual drains bypass backoff; scheduled drains (including without Queue) respect it.
  const rows = await env.DB.prepare(`SELECT event_id,organization_id,payload FROM audit_outbox WHERE delivered_at IS NULL${options.sweep ? ' AND (next_attempt_at IS NULL OR next_attempt_at<=?)' : ''}${queue ? ' AND created_at<?' : ''} ORDER BY ${options.sweep ? 'next_attempt_at,' : ''}created_at,event_id LIMIT 100`).bind(...(options.sweep ? [new Date(now).toISOString()] : []), ...(queue ? [new Date(now - 5 * 60000).toISOString()] : [])).all<AuditOutboxRow>()
  let delivered = 0; let errors = 0
  if (queue) {
    const result = await sendOutboxRows(queue, rows.results, row => deliverAudit(env, row, options))
    delivered = result.delivered; errors = result.errors
  } else for (const row of rows.results) {
    try { await deliverAudit(env, row, options); delivered++ } catch { errors++ }
  }
  await env.DB.prepare('DELETE FROM audit_outbox WHERE delivered_at IS NOT NULL AND delivered_at<?').bind(new Date(now - 7 * 86400000).toISOString()).run()
  return { delivered, errors }
}
