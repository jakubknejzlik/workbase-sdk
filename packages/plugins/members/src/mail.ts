import type { MailDeliveryRenderer } from '../../../core/src/kernel/mail-outbox-port'
import type { InvitationMailOptions } from '../../../core/src/kernel/invitation-mail-port'
import { enumLabel } from '../../../core/src/query/search'
import type { InstanceConfig } from '@workbasehq/core/config'
import type { RuntimeEnv } from '../../../core/src/types'
import { kernelFor } from '@workbasehq/core/kernel/registry'
import { sha256 } from '@workbasehq/core/crypto'
import { z } from 'zod'
import { buildInvitationAcceptUrl, invitationOrigin, InvitationLinkError } from './invitation-url'
import { renderInvitationEmail } from './emails/invitation-email'

export { invitationOrigin } from './invitation-url'

/** The sole display-identity seam; replace with Identity's projection when available. */
export async function inviterDisplay(db: D1Database, userId: string): Promise<string> {
  const user = await db.prepare('SELECT coalesce(nullif(trim(u.name),\'\'),a.email) AS display FROM users a LEFT JOIN "user" u ON u.id=a.id WHERE a.id=?').bind(userId).first<{ display: string }>()
  return user?.display.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, '').trim() || 'Unavailable'
}

/** Eligibility is rechecked by the outbox for every delivery/retry. */
export async function invitationDeliveryEligible(db: D1Database, id: string, organizationId: string, outboxId: string, hash: string) {
  return !!await db.prepare(`SELECT id FROM invitations WHERE id=? AND organization_id=? AND delivery_outbox_id=? AND delivery_token_hash=?
    AND accepted_at IS NULL AND revoked_at IS NULL AND declined_at IS NULL AND expired_at IS NULL AND expires_at>?`)
    .bind(id, organizationId, outboxId, hash, new Date().toISOString()).first()
}

const mailInputs = z.strictObject({
  selector: z.string().regex(/^[a-f0-9]{64}$/), origin: z.string(),
  template: z.strictObject({
    kind: z.enum(['invite', 'reminder']), inviterDisplayName: z.string(), organizationName: z.string().optional(),
    roleLabel: z.string(), expiresAt: z.iso.datetime(), timeZone: z.string(), language: z.enum(['en', 'cs']).optional(),
  }),
})

export const invitationMailRenderer = (env: RuntimeEnv, expectedHash: string): MailDeliveryRenderer => async ({ body }) => {
  const inputs = mailInputs.parse(JSON.parse(body))
  if (inputs.origin !== invitationOrigin(env, inputs.origin) || await sha256(inputs.selector) !== expectedHash) {
    throw new InvitationLinkError('invitation_link_invalid')
  }
  const acceptUrl = await buildInvitationAcceptUrl(env, { selector: inputs.selector, purpose: 'email', localFallback: inputs.origin })
  return renderInvitationEmail({ ...inputs.template, expiresAt: new Date(inputs.template.expiresAt), acceptUrl,
    configuredOrigin: inputs.origin, allowLocalHttp: !env.STAGE || env.STAGE === 'local' })
}

/** Members owns the P10 template and credential eligibility; the shared port owns transport. */
export async function invitationMail(env: RuntimeEnv, config: InstanceConfig, id: string, organizationId: string, recipient: string, selector: string,
  options?: InvitationMailOptions) {
  const outbox = kernelFor(config).mailOutbox
  const hash = await sha256(selector)
  const organization = options && kernelFor(config).providers.has('organizations')
    ? await env.DB.prepare('SELECT name FROM organizations WHERE id=?').bind(organizationId).first<{ name: string }>() : null
  const senderName = options ? await inviterDisplay(env.DB, options.inviterId) : undefined
  const language = config.locale
  const inputs = options ? mailInputs.parse({ selector, origin: invitationOrigin(env, options.localFallback), template: {
    kind: options.kind, inviterDisplayName: senderName!, organizationName: organization?.name,
    roleLabel: enumLabel(config, 'roles', options.role, language), expiresAt: options.expiresAt, timeZone: config.timeZone, language,
  } }) : undefined
  return {
    intent: (expiresAt: string) => {
      if (!inputs) throw new Error('invitation_mail_metadata_required')
      return outbox.intent({ id, organizationId, recipient, subject: 'Workbase invitation', body: JSON.stringify(inputs), expiresAt,
        text: '', html: '', senderName,
      }, 'changes()=1')
    },
    deliver: () => outbox.deliver(env, config, id, async () => (options?.invitationId
      ? await invitationDeliveryEligible(env.DB, options.invitationId, organizationId, id, hash)
      : !!await env.DB.prepare(`SELECT id FROM invitations WHERE organization_id=? AND delivery_token_hash=? AND delivery_outbox_id=?
      AND accepted_at IS NULL AND revoked_at IS NULL AND declined_at IS NULL AND expired_at IS NULL AND expires_at>?`)
      .bind(organizationId, hash, id, new Date().toISOString()).first()) && (!options?.eligible || await options.eligible()), invitationMailRenderer(env, hash)),
  }
}

export async function invitationDeliveryStatus(env: RuntimeEnv, config: InstanceConfig, outboxId: string | null) {
  const row = outboxId ? await kernelFor(config).mailOutbox.status(env.DB, outboxId) : null
  return row ? { status: row.delivery_status === 'sent' ? 'delivered' : row.delivery_status === 'pending' ? 'queued' : row.delivery_status,
    attempts: row.attempts, sent_at: row.sent_at, error: row.last_error ? 'email_send_failed' : null }
    : { status: 'not_requested', attempts: 0, sent_at: null, error: null }
}
