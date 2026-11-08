import '@cloudflare/vitest-pool-workers/types'
declare global {
  namespace Cloudflare {
    interface Env {
      EVENTS_QUEUE: Queue<import('../src/kernel/audit-port').AuditOutboxRow>; DB: D1Database; AUDIT_KV: KVNamespace; SERVICE_DB: D1Database; SERVICE_AUDIT_KV: KVNamespace;
      FRESH_DB: D1Database; RECEIVER_DB: D1Database; INTERNAL_TOKEN: string;
    }
  }
}
