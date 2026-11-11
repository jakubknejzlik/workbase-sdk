import { queryMetrics } from './query/observability'
import type { RuntimeEnv } from './types'
import { outboxStats } from './audit'
import { schemaStatus } from './schema-compatibility'
import type { InstanceConfig } from './config'
export async function relayMetrics(env: RuntimeEnv, now = Date.now()) {
  const stats = await outboxStats(env.DB, now)
  const failures = await env.DB.prepare("SELECT count(*) AS failed FROM webhook_deliveries WHERE state='failed'").first<{ failed: number }>()
  const errors = await env.DB.prepare('SELECT count(*) AS failed FROM audit_outbox WHERE delivered_at IS NULL AND last_error IS NOT NULL').first<{ failed: number }>()
  return { backlog: stats.backlog, oldestAgeSeconds: stats.oldest_undelivered_age_seconds, failed: (failures?.failed ?? 0) + (errors?.failed ?? 0) }
}
export async function recordRelayRun(env: RuntimeEnv, metrics: Awaited<ReturnType<typeof relayMetrics>> & { delivered: number; webhookDelivered: number; errors: number }) {
  await env.DB.prepare('INSERT INTO _ops_relay_run (id,ts,backlog,oldest_age_seconds,failed,delivered,webhook_delivered,errors) VALUES (1,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET ts=excluded.ts,backlog=excluded.backlog,oldest_age_seconds=excluded.oldest_age_seconds,failed=excluded.failed,delivered=excluded.delivered,webhook_delivered=excluded.webhook_delivered,errors=excluded.errors')
    .bind(new Date().toISOString(), metrics.backlog, metrics.oldestAgeSeconds, metrics.failed, metrics.delivered, metrics.webhookDelivered, metrics.errors).run()
}
async function lastRelayRun(env: RuntimeEnv) {
  try {
    const row = await env.DB.prepare('SELECT ts,backlog,oldest_age_seconds AS oldestAgeSeconds,failed,delivered,webhook_delivered AS webhookDelivered,errors FROM _ops_relay_run WHERE id=1').first()
    return row
  } catch { return null } // Local-only schema fixtures may omit the optional cron snapshot.
}
const tables = async (db: D1Database) => (await db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all<{ name: string }>()).results.map(row => row.name)
export async function opsStatus(env: RuntimeEnv, config: InstanceConfig) {
  let webhookServiceHealthy = false
  try {
    const response = await env.WEBHOOK_SERVICE?.fetch('https://webhook.internal/health', { signal: AbortSignal.timeout(3000) })
    webhookServiceHealthy = response?.ok === true
    await response?.body?.cancel()
  } catch { /* Presence alone cannot prove the binding target is healthy. */ }
  return { queries: queryMetrics(env.DB), ...(await relayMetrics(env)), lastRun: await lastRelayRun(env), webhookServiceHealthy, schema: await schemaStatus(env, config),
    tables: { DB: await tables(env.DB) },
    bindings: { EVENTS_QUEUE: typeof env.EVENTS_QUEUE?.sendBatch === 'function', DB: !!env.DB, AUDIT_KV: !!env.AUDIT_KV, WEBHOOK_SERVICE: typeof env.WEBHOOK_SERVICE?.fetch === 'function', INTERNAL_TOKEN: !!env.INTERNAL_TOKEN, OPS_TOKEN: !!env.OPS_TOKEN, WEBHOOK_URL: !!env.WEBHOOK_URL, WEBHOOK_ALLOWED_HOSTS: !!env.WEBHOOK_ALLOWED_HOSTS, BETTER_AUTH_SECRET: !!env.BETTER_AUTH_SECRET, AUTH_BASE_URL: !!env.AUTH_BASE_URL },
  }
}
