import { boundKernel, KernelRegistry } from './kernel/registry'
import type { InstanceConfig } from './config'
import { runWorkflows, type WorkflowRegistry } from './workflow-runtime'
import type { RuntimeEnv } from './types'
import type { AuditRelayOptions } from './kernel/audit-port'
export type WebhookFetch = (url: string, init: RequestInit) => Promise<Response>
const backoff = [1000, 5000, 30000, 30000]
export async function dispatchWebhooks(env: RuntimeEnv, options: { now?: number; fetcher?: WebhookFetch } = {}) {
  const now = options.now ?? Date.now(); const timestamp = new Date(now).toISOString()
  // A crash during the final claimed attempt must eventually become an inspectable failure.
  await env.DB.prepare("UPDATE webhook_deliveries SET state='failed',last_error='delivery_interrupted',lease_until=NULL WHERE state='pending' AND attempts>=5 AND (lease_until IS NULL OR lease_until<=?)").bind(timestamp).run()
  const rows = await env.DB.prepare("SELECT event_id,organization_id,payload FROM webhook_deliveries WHERE state='pending' AND next_attempt_at<=? AND (lease_until IS NULL OR lease_until<=?) ORDER BY next_attempt_at LIMIT 100").bind(timestamp, timestamp).all<{ event_id: string; organization_id: string; payload: string }>()
  let delivered = 0; let failed = 0
  for (const row of rows.results) {
    const lease = new Date(now + 30000).toISOString()
    const claim = await env.DB.prepare("UPDATE webhook_deliveries SET lease_until=?,attempts=attempts+1 WHERE event_id=? AND organization_id=? AND state='pending' AND attempts<5 AND next_attempt_at<=? AND (lease_until IS NULL OR lease_until<=?) RETURNING attempts").bind(lease, row.event_id, row.organization_id, timestamp, timestamp).first<{ attempts: number }>()
    if (!claim) continue
    try {
      if (!env.WEBHOOK_URL) throw new Error('destination_not_configured')
      const url = new URL(env.WEBHOOK_URL)
      const allowedHosts = (env.WEBHOOK_ALLOWED_HOSTS ?? '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean)
      const hostAllowed = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || (allowedHosts.includes(url.hostname.toLowerCase()) && url.protocol === 'https:')
      if (!hostAllowed || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('destination_not_allowed')
      // Worker-to-Worker calls on Cloudflare must use a Service Binding (public workers.dev fetches between Workers of one account are blocked); local dev keeps plain fetch.
      const transport = options.fetcher ?? (env.WEBHOOK_SERVICE ? (input: string, init?: RequestInit) => env.WEBHOOK_SERVICE!.fetch(input, init) : fetch)
      const response = await transport(url.href, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(3000), headers: { 'Content-Type': 'application/json', 'X-Event-Id': row.event_id }, body: row.payload })
      await response.body?.cancel()
      if (!response.ok) throw new Error('receiver_rejected')
      await env.DB.prepare("UPDATE webhook_deliveries SET state='delivered',last_error=NULL,lease_until=NULL WHERE event_id=? AND organization_id=? AND lease_until=?").bind(row.event_id, row.organization_id, lease).run()
      delivered++
    } catch {
      // Never persist fetch exceptions: a URL or response could contain credentials or personal data.
      const terminal = claim.attempts >= 5
      await env.DB.prepare('UPDATE webhook_deliveries SET state=?,last_error=?,next_attempt_at=?,lease_until=NULL WHERE event_id=? AND organization_id=? AND lease_until=?').bind(terminal ? 'failed' : 'pending', 'delivery_failed', new Date(now + backoff[Math.min(claim.attempts - 1, 3)]).toISOString(), row.event_id, row.organization_id, lease).run()
      if (terminal) failed++
    }
  }
  return { delivered, failed }
}
export async function relay(env: RuntimeEnv, config: InstanceConfig, options: AuditRelayOptions & { fetcher?: WebhookFetch } = {}) {
  const kernel = boundKernel(config) ?? new KernelRegistry(config)
  const audit = await kernel.audit?.relay(env, options) ?? { delivered: 0, errors: 0 }
  return { audit, webhooks: await dispatchWebhooks(env, options) }
}

// Scheduled invocations dispatch explicitly on cron; other schedules must have their own handler.
export async function scheduledRelay(event: Pick<ScheduledController, 'cron'>, env: RuntimeEnv, workflows?: { config: InstanceConfig; definitions?: WorkflowRegistry }) {
  if (event.cron !== '*/5 * * * *') return
  const { createLogger } = await import('./logging')
  const { relayMetrics, recordRelayRun } = await import('./ops')
  const log = createLogger({ stage: env.STAGE ?? 'local' })
  try {
    if (!workflows?.config) throw new Error('relay_composition_required')
    const kernel = boundKernel(workflows.config) ?? new KernelRegistry(workflows.config, { workflows: workflows.definitions }, env)
    if (kernel.workflows.size) await runWorkflows(env, kernel.config, kernel.workflows)
    const result = await relay(env, workflows.config, { sweep: true })
    const metrics = { ...(await relayMetrics(env)), delivered: result.audit.delivered, webhookDelivered: result.webhooks.delivered, errors: result.audit.errors }
    await recordRelayRun(env, metrics)
    log('info', 'ops.relay.run', metrics)
  } catch {
    // A single event even when metrics/DB are unavailable. Never log raw errors or event payloads.
    log('error', 'ops.relay.run', { backlog: null, oldestAgeSeconds: null, failed: null, delivered: 0 })
    throw new Error('relay_run_failed')
  }
}
