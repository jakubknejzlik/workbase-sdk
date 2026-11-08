import type { InstanceConfig } from '@workbasehq/core/config'
import type { RuntimeEnv } from '../../../core/src/types'
import { identityWrite } from '../../../core/src/identity-writes'
import { kernelFor } from '@workbasehq/core/kernel/registry'
import { magicLinkTokenHash } from '@workbasehq/core/crypto'

const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
export async function sendMagicLink(env: RuntimeEnv, config: InstanceConfig, recipient: string, generatedUrl: string) {
  const outbox = kernelFor(config).mailOutbox
  const id = crypto.randomUUID()
  const generated = new URL(generatedUrl)
  const token = generated.searchParams.get('token')!
  let link = generatedUrl
  if (env.EMAIL) {
    const url = new URL('/auth/magic-link/verify', env.IDENTITY!.baseURL)
    url.searchParams.set('token', token)
    link = url.href
  }
  const hint = 'This link expires in 10 minutes and can be used once. If you did not request it, ignore this email.'
  const subject = 'Workbase sign-in'
  await identityWrite(env, config, 'magic_link_sent', [outbox.intent({
    id, organizationId: null, recipient, subject, body: link,
    text: `${subject}:\n\n${link}\n\n${hint}`,
    html: `<p><a href="${escape(link)}">${escape(subject)}</a></p><p>${escape(hint)}</p>`,
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  })])
  await outbox.deliver(env, config, id, async () => !!await env.DB.prepare('SELECT id FROM verification WHERE identifier=? AND "expiresAt">?').bind(await magicLinkTokenHash(token), new Date().toISOString()).first())
}
