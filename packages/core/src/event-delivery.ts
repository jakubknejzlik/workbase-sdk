import { AsyncLocalStorage } from 'node:async_hooks'
import type { InstanceConfig } from './config'
import type { RuntimeEnv } from './types'
import type { AuditEvent } from './audit-event'
import type { AuditOutboxRow } from './kernel/audit-port'
import { boundKernel, KernelRegistry } from './kernel/registry'

// Request-local: cached apps and simultaneous requests must never share a context.
export const eventDeliveryContext = new AsyncLocalStorage<Pick<ExecutionContext, 'waitUntil'>>()
const auditPort = (config: InstanceConfig) => (boundKernel(config) ?? new KernelRegistry(config)).audit

export async function sendOutboxRows(queue: Queue<AuditOutboxRow>, rows: readonly AuditOutboxRow[], deliverOversized: (row: AuditOutboxRow) => Promise<void>) {
  // Leave headroom for Queue's per-message metadata within the 256 KB batch limit.
  let delivered = 0; let errors = 0
  let batch: MessageSendRequest<AuditOutboxRow>[] = []; let bytes = 0
  const flush = async () => {
    if (batch.length) {
      try { await queue.sendBatch(batch) } catch { errors += batch.length }
    }
    batch = []; bytes = 0
  }
  for (const row of rows) {
    const size = new TextEncoder().encode(JSON.stringify(row)).byteLength + 100
    if (size > 128 * 1024) {
      try { await deliverOversized(row); delivered++ } catch { errors++ }
      continue
    }
    if (batch.length === 100 || bytes + size > 250000) await flush()
    batch.push({ body: row, contentType: 'json' }); bytes += size
  }
  await flush()
  return { delivered, errors }
}

/** Called only after the domain batch has resolved successfully. Never rejects a committed write. */
export async function publishCommittedEvents(env: RuntimeEnv, config: InstanceConfig, events: readonly AuditEvent[]) {
  if (!events.length) return
  const rows = events.map(event => ({ event_id: event.event_id, organization_id: event.organization_id, payload: JSON.stringify(event) }))
  const deliver = async () => {
    try {
      if (env.EVENTS_QUEUE) {
        const result = await sendOutboxRows(env.EVENTS_QUEUE, rows, async row => {
          const audit = auditPort(config)
          if (!audit) throw new Error('audit_port_required')
          await audit.deliver(env, row)
        })
        if (result.errors) console.error('audit_publish_failed')
      }
      else {
        const audit = auditPort(config)
        if (audit) for (const row of rows) await audit.deliver(env, row)
      }
    } catch {
      // D1 remains the retry source; never expose payloads or transport exceptions.
      console.error('audit_publish_failed')
    }
  }
  const context = eventDeliveryContext.getStore()
  if (env.EVENTS_QUEUE && context) context.waitUntil(deliver())
  else await deliver()
}

export async function consumeEvents(batch: MessageBatch<AuditOutboxRow>, env: RuntimeEnv, config: InstanceConfig) {
  let audit: ReturnType<typeof auditPort>
  try { audit = auditPort(config) } catch {
    for (const message of batch.messages) message.retry()
    return
  }
  for (const message of batch.messages) {
    try {
      if (!audit) throw new Error('audit_port_required')
      await audit.deliver(env, message.body)
      message.ack()
    } catch { message.retry() }
  }
}
