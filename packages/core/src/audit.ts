import type { RuntimeEnv } from './types'
import { ApiError } from './errors'
import { equalHash } from './crypto'
import type { AuditEvent } from './audit-event'

/** Resolve page actors once, within the audit reader's organization. Never use email. */
export async function auditActorLabels(db: D1Database, organizationId: string, events: AuditEvent[]) {
  const ids = [...new Set(events.filter(event => event.actor?.type === 'user').map(event => event.actor.id))]
  if (!ids.length) return events
  const rows = await db.prepare(`SELECT m.user_id,u.name,p.first_name,p.last_name
    FROM memberships m JOIN "user" u ON u.id=m.user_id
    LEFT JOIN identity_profiles p ON p.user_id=u.id AND (
      NOT EXISTS (SELECT 1 FROM identities i WHERE i.user_id=u.id AND i.provider<>'local')
      OR (p.synced_at IS NOT NULL
        AND (SELECT count(*) FROM identities i WHERE i.user_id=u.id AND i.provider<>'local')=1
        AND EXISTS (SELECT 1 FROM identities i WHERE i.user_id=u.id AND i.provider=p.source_provider AND i.issuer=p.source_issuer AND i.subject=p.source_subject)))
    WHERE m.organization_id=? AND m.user_id IN (SELECT value FROM json_each(?))`)
    .bind(organizationId, JSON.stringify(ids)).all<{ user_id: string; name: string | null; first_name: string | null; last_name: string | null }>()
  const safeName = (name: string) => name && !/[A-Z0-9._%+-]+@[A-Z0-9.-]+/i.test(name)
  const labels = new Map(rows.results.map(row => {
    const fullName = [row.first_name?.trim(), row.last_name?.trim()].filter(Boolean).join(' ')
    const displayName = row.name?.trim() ?? ''
    return [row.user_id, safeName(fullName) ? fullName : safeName(displayName) ? displayName : row.user_id]
  }))
  return events.map(event => event.actor?.type === 'user'
    ? { ...event, actor: { ...event.actor, label: labels.get(event.actor.id) ?? event.actor.id } } : event)
}
export function requireInternal(env: RuntimeEnv, token: string | undefined) {
  const configured = env.OPS_TOKEN ?? env.INTERNAL_TOKEN
  if (!configured) throw new ApiError(503, 'internal_token_not_configured')
  if (!token || !equalHash(configured, token)) throw new ApiError(403, 'internal_token_required')
}
export async function outboxStats(db: D1Database, now = Date.now()) {
  const row = await db.prepare('SELECT count(*) AS backlog,min(created_at) AS oldest FROM audit_outbox WHERE delivered_at IS NULL').first<{ backlog: number; oldest: string | null }>()
  return { backlog: row!.backlog, oldest_undelivered_age_seconds: row!.oldest ? Math.max(0, Math.floor((now - Date.parse(row!.oldest)) / 1000)) : null }
}
