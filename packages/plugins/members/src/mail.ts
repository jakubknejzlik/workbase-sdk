import { enumLabel } from '../../../core/src/query/search'
import type { InstanceConfig } from '@workbasehq/core/config'
import type { RuntimeEnv } from '../../../core/src/types'
import { kernelFor } from '@workbasehq/core/kernel/registry'
import { sha256 } from '@workbasehq/core/crypto'
import { renderInvitationEmail } from './emails/invitation-email'
import { invitationMailToken, invitationSelector } from './invitation-token'

/** The sole display-identity seam; replace with Identity's projection when available. */
export async function inviterDisplay(db: D1Database, userId: string): Promise<string> {
  const user = await db.prepare('SELECT coalesce(nullif(trim(u.name),\'\'),a.email) AS display FROM users a LEFT JOIN "user" u ON u.id=a.id WHERE a.id=?').bind(userId).first<{ display: string }>()
  return user?.display.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, '').trim() || 'Unavailable'
}

/** Production links require a configured origin; request headers cannot choose a credential destination. */
export function invitationOrigin(env: RuntimeEnv, localFallback?: string): string {
  const configured = env.IDENTITY?.baseURL ?? env.AUTH_BASE_URL
  if (configured) return new URL(configured).origin
  if ((!env.STAGE || env.STAGE === 'local') && localFallback) {
    const url = new URL(localFallback)
    if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return url.origin
  }
  throw new Error('invitation_origin_required')
}

/** Eligibility is rechecked by the outbox for every delivery/retry. */
export async function invitationDeliveryEligible(db: D1Database, id: string, organizationId: string, outboxId: string, hash: string) {
  return !!await db.prepare(`SELECT id FROM invitations WHERE id=? AND organization_id=? AND delivery_outbox_id=? AND token_hash=?
    AND accepted_at IS NULL AND revoked_at IS NULL AND declined_at IS NULL AND expired_at IS NULL AND expires_at>?`)
    .bind(id, organizationId, outboxId, hash, new Date().toISOString()).first()
}

/** Members owns the P10 template and credential eligibility; the shared port owns transport. */
export async function invitationMail(env: RuntimeEnv, config: InstanceConfig, id: string, organizationId: string, recipient: string, link: string,
  options?: { inviterId: string; role: string; expiresAt: string; kind: 'invite' | 'reminder' }) {
  const outbox = kernelFor(config).mailOutbox
  const recipientLink = new URL(link)
  const selector = invitationSelector(recipientLink.searchParams.get('token')!)
  const hash = await sha256(selector)
  recipientLink.searchParams.set('token', await invitationMailToken(env, selector))
  link = recipientLink.href
  const organization = options && kernelFor(config).providers.has('organizations')
    ? await env.DB.prepare('SELECT name FROM organizations WHERE id=?').bind(organizationId).first<{ name: string }>() : null
  const senderName = options ? await inviterDisplay(env.DB, options.inviterId) : undefined
  const language = config.locale
  const rendered = options ? renderInvitationEmail({
    kind: options.kind, inviterDisplayName: senderName!, organizationName: organization?.name,
    roleLabel: enumLabel(config, 'roles', options.role, language), expiresAt: new Date(options.expiresAt), timeZone: config.timeZone,
    language, acceptUrl: link, configuredOrigin: invitationOrigin(env, link),
    allowLocalHttp: !env.STAGE || env.STAGE === 'local',
  }) : undefined
  return {
    intent: (expiresAt: string) => {
      if (!rendered) throw new Error('invitation_mail_metadata_required')
      return outbox.intent({ id, organizationId, recipient, subject: rendered.subject, body: `Accept: ${link}`, expiresAt,
        text: rendered.text, html: rendered.html, senderName,
      }, 'changes()=1')
    },
    deliver: () => outbox.deliver(env, config, id, async () => !!await env.DB.prepare(`SELECT id FROM invitations WHERE organization_id=? AND token_hash=? AND delivery_outbox_id=?
      AND accepted_at IS NULL AND revoked_at IS NULL AND declined_at IS NULL AND expired_at IS NULL AND expires_at>?`)
      .bind(organizationId, hash, id, new Date().toISOString()).first()),
  }
}

export async function invitationDeliveryStatus(env: RuntimeEnv, config: InstanceConfig, outboxId: string | null) {
  const row = outboxId ? await kernelFor(config).mailOutbox.status(env.DB, outboxId) : null
  return row ? { status: row.delivery_status === 'sent' ? 'delivered' : row.delivery_status === 'pending' ? 'queued' : row.delivery_status,
    attempts: row.attempts, sent_at: row.sent_at, error: row.last_error ? 'email_send_failed' : null }
    : { status: 'not_requested', attempts: 0, sent_at: null, error: null }
}
