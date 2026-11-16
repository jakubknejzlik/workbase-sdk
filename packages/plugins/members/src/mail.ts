import type { MailDeliveryRenderer } from '../../../core/src/kernel/mail-outbox-port'
import type { InvitationMailOptions } from '../../../core/src/kernel/invitation-mail-port'
import { enumLabel } from '../../../core/src/query/search'
import type { InstanceConfig } from '@workbasehq/core/config'
import type { RuntimeEnv } from '../../../core/src/types'
import { kernelFor } from '@workbasehq/core/kernel/registry'
import { sha256 } from '@workbasehq/core/crypto'
import { renderInvitationEmail } from './emails/invitation-email'
import { hasInvitationMailboxProof, invitationMailToken, invitationSelector, invitationTokenSchema } from './invitation-token'

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

/** Finalize a durable invitation payload on every send/retry, without writing proof to a plan or row. */
export const invitationMailRenderer = (env: RuntimeEnv): MailDeliveryRenderer => async ({ body, text, html }) => {
  const fail = (): never => { throw new Error('invitation_mail_finalization_failed') }
  const link = body.replace(/^Accept: /, '')
  const url = new URL(link)
  const token = invitationTokenSchema.safeParse(url.searchParams.get('token'))
  if (!token.success || body !== `Accept: ${link}`) fail()
  const selector = invitationSelector(token.data!)
  const proof = await invitationMailToken(env, selector)
  if (!await hasInvitationMailboxProof(env, proof)) fail()
  url.searchParams.set('token', proof)
  const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
  const finalize = (part: string, source: string, signed: string, expected: number, htmlPart = false) => {
    const slots = part.split(source)
    // The Members template has one text link and three HTML occurrences (two
    // hrefs and the visible fallback). Never accept a partially matched template.
    if (slots.length - 1 !== expected) fail()
    const remainder = slots.join('')
    // Inspect residual links, not display labels that happen to contain the path.
    // Decode link values before checking for percent/entity-encoded credentials.
    const decode = (value: string) => value.replace(/&#(?:x([0-9a-f]+)|([0-9]+));?/gi,
      (_, hex, decimal) => String.fromCodePoint(Number.parseInt(hex ?? decimal, hex ? 16 : 10)))
      .replace(/%([0-9a-f]{2})/gi, (_, byte) => String.fromCharCode(Number.parseInt(byte, 16)))
    const decoded = decode(remainder)
    const links: string[] = decoded.match(/(?:[a-z][a-z0-9+.-]*:)?\/\/[^\s<>"']+|[^\s<>"']*[?&]token=[^\s<>"']+/gi) ?? []
    // Extract attributes from actual tags before decoding, so escaped display
    // text cannot turn into an HTML link during this validation.
    for (const tag of (htmlPart ? remainder : '').matchAll(/<[^>]+>/g)) {
      for (const href of tag[0].matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
        links.push(decode(href[1] ?? href[2] ?? href[3]))
      }
    }
    if (links.some(value => value.includes('/invitations/accept') || value.includes(selector) || /[?&]token=/.test(value))) fail()
    const result = slots.join(signed)
    if (result.split(signed).length - 1 !== expected) fail()
    return result
  }
  // Body is the durable source of the selector, never a transport-ready proof.
  finalize(body, link, url.href, 1)
  return { text: finalize(text, link, url.href, 1), html: finalize(html, escape(link), escape(url.href), 3, true) }
}

/** Members owns the P10 template and credential eligibility; the shared port owns transport. */
export async function invitationMail(env: RuntimeEnv, config: InstanceConfig, id: string, organizationId: string, recipient: string, link: string,
  options?: InvitationMailOptions) {
  const outbox = kernelFor(config).mailOutbox
  const recipientLink = new URL(link)
  const selector = invitationSelector(recipientLink.searchParams.get('token')!)
  const hash = await sha256(selector)
  // Persist only the unsigned selector; mailbox proof exists only at send time.
  recipientLink.searchParams.set('token', selector)
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
    deliver: () => outbox.deliver(env, config, id, async () => (options?.invitationId
      ? await invitationDeliveryEligible(env.DB, options.invitationId, organizationId, id, hash)
      : !!await env.DB.prepare(`SELECT id FROM invitations WHERE organization_id=? AND token_hash=? AND delivery_outbox_id=?
      AND accepted_at IS NULL AND revoked_at IS NULL AND declined_at IS NULL AND expired_at IS NULL AND expires_at>?`)
      .bind(organizationId, hash, id, new Date().toISOString()).first()) && (!options?.eligible || await options.eligible()), invitationMailRenderer(env)),
  }
}

export async function invitationDeliveryStatus(env: RuntimeEnv, config: InstanceConfig, outboxId: string | null) {
  const row = outboxId ? await kernelFor(config).mailOutbox.status(env.DB, outboxId) : null
  return row ? { status: row.delivery_status === 'sent' ? 'delivered' : row.delivery_status === 'pending' ? 'queued' : row.delivery_status,
    attempts: row.attempts, sent_at: row.sent_at, error: row.last_error ? 'email_send_failed' : null }
    : { status: 'not_requested', attempts: 0, sent_at: null, error: null }
}
