import { migrations } from './migrations/index'
import { builtinPlugin } from '@workbasehq/core/kernel/builtin-source'
import type { WorkbasePlugin } from '@workbasehq/core/kernel/plugin'
import type { MailOutboxPort, MailStatus } from '../../../core/src/kernel/mail-outbox-port'
import { identityWrite } from '../../../core/src/identity-writes'
import { RuleFailed } from '../../../core/src/execution/errors'

const providerTimeoutMs = 60000
const leaseMarginMs = 5000
class EmailSendTimeout extends Error {}

export interface EmailSender {
  send(message: { to: string; from: string; subject: string; text: string; html: string }): Promise<void>
}
/** Native send_email binding; Cloudflare owns MIME encoding and transport. */
export class CloudflareEmailSender implements EmailSender {
  constructor(private readonly binding: SendEmail, private readonly deadline = Date.now() + providerTimeoutMs) {}
  async send(message: Parameters<EmailSender['send']>[0]) {
    const remaining = this.deadline - Date.now()
    if (remaining <= 0) throw new EmailSendTimeout()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.binding.send(message),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new EmailSendTimeout()), remaining) }),
      ])
    } finally { clearTimeout(timer) }
  }
}
const status: MailOutboxPort['status'] = (db, id) => db.prepare('SELECT id,delivery_status,attempts,sent_at,last_error FROM email_outbox WHERE id=?').bind(id).first<MailStatus>()
const deliver: MailOutboxPort['deliver'] = async (env, config, id, eligible) => {
  if (!env.EMAIL) return
  const now = new Date().toISOString()
  const row = await env.DB.prepare('SELECT sender_name,recipient,subject,delivery_text,delivery_html,expires_at,delivery_status,attempts,lease_until,last_error FROM email_outbox WHERE id=?').bind(id)
    .first<{ sender_name: string | null; recipient: string; subject: string; delivery_text: string | null; delivery_html: string | null; expires_at: string | null; delivery_status: string; attempts: number; lease_until: string | null; last_error: string | null }>()
  // Legacy rows lack a caller-rendered payload/expiry. Retain them, never guess a template.
  if (!row || row.delivery_status === 'sent' || row.last_error === 'email_send_timeout' || row.delivery_text === null || row.delivery_html === null
    || !row.expires_at || !Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) <= Date.now()
    || (row.delivery_status === 'sending' && row.lease_until !== null && row.lease_until > now)) return
  if (row.delivery_status === 'sending') {
    // An expired lease says nothing about native send completion. Any observer
    // can persist the fence, even while the original timeout write is delayed.
    await identityWrite(env, config, 'email_stale_lease', [{
      sql: "UPDATE email_outbox SET delivery_status='failed',last_error='email_send_timeout',lease_until=NULL WHERE id=? AND delivery_status='sending' AND last_error IS NULL AND (lease_until IS NULL OR lease_until<=?)",
      bindings: [id, now],
    }])
    return
  }
  if (!await eligible()) return
  const attempt = row.attempts + 1
  const deadline = Date.now() + providerTimeoutMs
  try {
    await identityWrite(env, config, 'email_sending', [{
      sql: "UPDATE email_outbox SET delivery_status='sending',attempts=attempts+1,lease_until=?,last_error=NULL WHERE id=? AND attempts=? AND delivery_status<>'sent' AND (last_error IS NULL OR last_error<>'email_send_timeout') AND delivery_status<>'sending' AND expires_at>?",
      bindings: [new Date(deadline + leaseMarginMs).toISOString(), id, row.attempts, now], expectRows: 1,
    }])
  } catch (error) {
    if (error instanceof RuleFailed) return // A competing attempt owns the claim.
    throw error
  }
  let failed = false
  let timedOut = false
  try {
    if (!env.EMAIL_FROM) throw new Error('email_sender_missing')
    await new CloudflareEmailSender(env.EMAIL, deadline).send({ from: row.sender_name ? `${JSON.stringify(row.sender_name)} <${env.EMAIL_FROM}>` : env.EMAIL_FROM, to: row.recipient, subject: row.subject, text: row.delivery_text, html: row.delivery_html })
  } catch (error) {
    failed = true
    // Native send_email cannot be cancelled. A timeout has an unknown outcome;
    // retain a durable fence so retry cannot duplicate a late provider delivery.
    timedOut = error instanceof EmailSendTimeout
    // Provider errors can echo credentials. Log only a fixed code and opaque ID.
    console.error(JSON.stringify({ event: 'email_send_failed', outboxId: id }))
  }
  await identityWrite(env, config, 'email_delivery', [{
    // A stale-lease observer may already have fenced this attempt. In that case
    // completion is a no-op, preserving the unknown outcome rather than clearing it.
    sql: "UPDATE email_outbox SET delivery_status=?,sent_at=?,last_error=?,lease_until=NULL WHERE id=? AND attempts=? AND delivery_status='sending' AND last_error IS NULL",
    bindings: [failed ? 'failed' : 'sent', failed ? null : new Date().toISOString(), timedOut ? 'email_send_timeout' : failed ? 'email_send_failed' : null, id, attempt],
  }])
}
const mailPort: MailOutboxPort = Object.freeze<MailOutboxPort>({
  intent(message, guard = '1=1') {
    if (message.senderName !== undefined && (!message.senderName.trim() || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(message.senderName))) throw new Error('invalid_mail_sender_name')
    if (!Number.isFinite(Date.parse(message.expiresAt))) throw new Error('invalid_mail_expiry')
    return {
      sql: `INSERT INTO email_outbox (id,organization_id,recipient,subject,body,created_at,delivery_text,delivery_html,expires_at,sender_name) SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${guard}`,
      bindings: [message.id, message.organizationId, message.recipient, message.subject, message.body, new Date().toISOString(), message.text, message.html, message.expiresAt, message.senderName ?? null], expectRows: 1,
    }
  }, status, deliver, retry: deliver,
})
export function mailOutbox(): WorkbasePlugin {
  return builtinPlugin({
    name: 'mail-outbox', version: '0.1.0', provides: { 'mail-outbox': '1.x' }, mailOutbox: mailPort,
    migrations,
    async checkSchema(db) {
      await db.prepare('SELECT id,sender_name,recipient,subject,body,delivery_text,delivery_html,expires_at,delivery_status,attempts,sent_at,last_error,lease_until FROM email_outbox INDEXED BY email_outbox_delivery_queue LIMIT 0').all()
    },
  })
}
export type { MailOutboxPort, MailIntent, MailStatus } from '../../../core/src/kernel/mail-outbox-port'
