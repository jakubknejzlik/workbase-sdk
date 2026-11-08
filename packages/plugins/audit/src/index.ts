import { migrations } from './migrations/index'
import { builtinPlugin } from '@workbasehq/core/kernel/builtin-source'
import type { WorkbasePlugin } from '@workbasehq/core/kernel/plugin'
import { auditRoutes } from './routes'
import { relayAudit, deliverAudit } from './relay'

export function audit(): WorkbasePlugin {
  return builtinPlugin({
    name: 'audit', version: '0.1.0', provides: { audit: '1.x' },
    requires: { console: '^1' },
    contributes: { console: {
      pages: [{ id: 'audit.activity', path: '/settings/activity', label: 'activity', grant: 'audit.read', renderer: 'audit.activity' }],
      navigation: [{ id: 'audit.activity', placement: 'settings', page: 'audit.activity', label: 'activity', icon: 'Activity', group: { id: 'operations', label: 'settingsOperations', order: 100 }, order: 60, grant: 'audit.read' }],
    } },
    audit: Object.freeze({ relay: relayAudit, deliver: deliverAudit }), routes: auditRoutes,
    migrations,
    async checkSchema(db) {
      await db.prepare('SELECT event_id,organization_id,payload,created_at,delivered_at,attempts,last_error,next_attempt_at FROM audit_outbox INDEXED BY audit_outbox_delivery_queue LIMIT 0').all()
    },
    async checkEnvironment(env) {
      if (!env.AUDIT_KV || typeof env.AUDIT_KV.list !== 'function' || typeof env.AUDIT_KV.get !== 'function' || typeof env.AUDIT_KV.put !== 'function') throw new Error('audit_kv_required')
    },
  })
}
export { KvAuditSink } from './sink'
export type { AuditSink, AuditPort } from '../../../core/src/kernel/audit-port'
