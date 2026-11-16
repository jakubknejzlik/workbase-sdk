import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import sample from '../../../core/test/fixtures/sample/config'
import { createApp } from '@workbasehq/core/app'
import { runtime, setup, request, json } from '@workbasehq/test-support/helpers'
import { invitationMailRenderer } from '../src/mail'
import { renderInvitationEmail } from '../src/emails/invitation-email'
import { invitationMailToken, invitationTokenSchema, hasInvitationMailboxProof } from '../src/invitation-token'

beforeEach(async () => { await setup() })
afterEach(() => vi.restoreAllMocks())
const escape = (v: string) => v.replaceAll('&', '&amp;')
const cases = (['en', 'cs'] as const).flatMap(locale => (['invite', 'reminder'] as const).flatMap(kind =>
  (['unsigned', 'signed', 'rotated'] as const).flatMap(tokenKind => [false, true].map(amp => ({ locale, kind, tokenKind, amp })))))
it.each(cases)('legitimate payload $locale $kind $tokenKind amp=$amp retries and sends once', async ({ locale, kind, tokenKind, amp }) => {
  const config = { ...sample, locale }
  const created = await json(await request(createApp(config, runtime()), '/orgs/org-a/invitations', 'POST', { email: 'legacy@example.test', role: 'viewer' }))
  expect(created.delivery).toMatchObject({ status: 'queued', attempts: 0 })
  const row = (await env.DB.prepare('SELECT * FROM email_outbox').first<{ id: string }>())!
  const oldEnv = runtime()
  const selector = new URL(created.accept_url).searchParams.get('token')!
  const token = tokenKind === 'unsigned' ? selector : await invitationMailToken(oldEnv, selector)
  expect(invitationTokenSchema.safeParse(token).success).toBe(true)
  const link = new URL(created.accept_url)
  link.searchParams.set('token', token)
  if (amp) { link.searchParams.set('source', 'email'); link.searchParams.set('label', 'A & B') }
  const rendered = renderInvitationEmail({ language: locale, kind, inviterDisplayName: 'Alex & Al', organizationName: 'Team & Co', roleLabel: 'Viewer & reviewer', timeZone: 'Europe/Prague', expiresAt: new Date(created.expires_at), acceptUrl: link.href, configuredOrigin: 'http://localhost', allowLocalHttp: true })
  await env.DB.prepare('UPDATE email_outbox SET body=?,delivery_text=?,delivery_html=? WHERE id=?').bind(`Accept: ${link.href}`, rendered.text, rendered.html, row.id).run()
  const send = vi.fn().mockResolvedValue(undefined)
  const settings = { ...runtime(), EMAIL: { send }, EMAIL_FROM: 'noreply@example.test' }
  if (tokenKind === 'rotated') settings.IDENTITY.secret = 'synthetic-rotated-key-at-least-32-characters'
  const app = createApp(config, settings)
  const retry = () => request(app, `/orgs/org-a/invitations/${created.id}/retry-delivery`, 'POST', {})
  expect(await json(await retry())).toMatchObject({ delivery: { status: 'delivered', attempts: 1, error: null } })
  expect(send).toHaveBeenCalledTimes(1)
  const signed = new URL(link.href)
  signed.searchParams.set('token', await invitationMailToken(settings, selector))
  expect(await hasInvitationMailboxProof(settings, signed.searchParams.get('token')!)).toBe(true)
  expect(send.mock.calls[0][0].text.split(signed.href)).toHaveLength(2)
  expect(send.mock.calls[0][0].html.split(escape(signed.href))).toHaveLength(4)
  expect(await json(await retry())).toMatchObject({ delivery: { status: 'delivered', attempts: 1 } })
  expect(send).toHaveBeenCalledTimes(1)
  expect(await env.DB.prepare('SELECT sent_at FROM email_outbox WHERE id=?').bind(row.id).first('sent_at')).not.toBeNull()
})
it('failed finalization can be repaired and retried without duplicate native send', async () => {
  const created = await json(await request(createApp(sample, runtime()), '/orgs/org-a/invitations', 'POST', { email: 'repair@example.test', role: 'viewer' }))
  const row = (await env.DB.prepare('SELECT * FROM email_outbox').first<{ id: string; delivery_text: string }>())!
  await env.DB.prepare('UPDATE email_outbox SET delivery_text=? WHERE id=?').bind('Unmatched legitimate template link', row.id).run()
  const send = vi.fn().mockResolvedValue(undefined)
  const settings = { ...runtime(), EMAIL: { send }, EMAIL_FROM: 'noreply@example.test' }
  const app = createApp(sample, settings)
  const retry = () => request(app, `/orgs/org-a/invitations/${created.id}/retry-delivery`, 'POST', {})
  expect(await json(await retry())).toMatchObject({ delivery: { status: 'failed', attempts: 1, sent_at: null, error: 'email_send_failed' } })
  expect(send).not.toHaveBeenCalled()
  expect(await json(await retry())).toMatchObject({ delivery: { status: 'failed', attempts: 2, sent_at: null, error: 'email_send_failed' } })
  expect(send).not.toHaveBeenCalled()
  await env.DB.prepare('UPDATE email_outbox SET delivery_text=? WHERE id=?').bind(row.delivery_text, row.id).run()
  expect(await json(await retry())).toMatchObject({ delivery: { status: 'delivered', attempts: 3, error: null } })
  expect(send).toHaveBeenCalledTimes(1)
  expect(await json(await retry())).toMatchObject({ delivery: { status: 'delivered', attempts: 3 } })
  expect(send).toHaveBeenCalledTimes(1)
})
it('missing signing key fails closed when generated proof does not verify', async () => {
  const settings = { ...runtime(), IDENTITY: { ...runtime().IDENTITY, secret: '' } }
  const link = `http://localhost/invitations/accept?token=${'a'.repeat(64)}`
  await expect(invitationMailRenderer(settings)({ body: `Accept: ${link}`, text: link, html: link })).rejects.toThrow('invitation_mail_finalization_failed')
})
it.each(['plain', 'percent', 'decimal-entity', 'hex-entity'])('residual unsigned %s copies fail closed before transport', async mode => {
  const created = await json(await request(createApp(sample, runtime()), '/orgs/org-a/invitations', 'POST', { email: 'residual@example.test', role: 'viewer' }))
  const row = (await env.DB.prepare('SELECT * FROM email_outbox').first<{ id: string; body: string; delivery_html: string }>())!
  const link = row.body.slice(8)
  const token = new URL(link).searchParams.get('token')!
  const encoded = [...token].map(ch => mode === 'plain' ? ch : mode === 'percent' ? `%${ch.charCodeAt(0).toString(16)}` : mode === 'decimal-entity' ? `&#${ch.charCodeAt(0)};` : `&#x${ch.charCodeAt(0).toString(16)};`).join('')
  await env.DB.prepare('UPDATE email_outbox SET delivery_html=? WHERE id=?').bind(row.delivery_html+`<a href="${link.replace(token, encoded)}">extra</a>`, row.id).run()
  const send = vi.fn().mockResolvedValue(undefined)
  const app = createApp(sample, { ...runtime(), EMAIL: { send }, EMAIL_FROM: 'noreply@example.test' })
  expect(await json(await request(app, `/orgs/org-a/invitations/${created.id}/retry-delivery`, 'POST', {}))).toMatchObject({ delivery: { status: 'failed', attempts: 1, sent_at: null, error: 'email_send_failed' } })
  expect(send).not.toHaveBeenCalled()
})
// Review3 METADATA_REPRO: a path in display text is not an invitation link.
it('Members invitation delivers with acceptance path in organization display text and retry does not resend', async () => {
  const send = vi.fn().mockResolvedValue(undefined)
  const settings = { ...runtime(), EMAIL: { send }, EMAIL_FROM: 'noreply@example.test' }
  const app = createApp(sample, settings)
  expect((await request(app, '/orgs/org-a', 'PATCH', { name: 'Team /invitations/accept' })).status).toBe(200)
  const response = await request(app, '/orgs/org-a/invitations', 'POST', { email: 'metadata@example.test', role: 'viewer' })
  expect(response.status).toBe(201)
  const created = await json(response)
  expect(created.delivery).toMatchObject({ status: 'delivered', attempts: 1, error: null })
  expect(send).toHaveBeenCalledTimes(1)
  const message = send.mock.calls[0][0]
  expect(message.text).toContain('Team /invitations/accept')
  expect(message.html).toContain('Team /invitations/accept')
  const delivered = message.text.match(/https?:\/\/[^\s]+\/invitations\/accept\?token=[a-f0-9]+\.[a-f0-9]+/)![0]
  expect(await hasInvitationMailboxProof(settings, new URL(delivered).searchParams.get('token')!)).toBe(true)
  expect(message.text.split(delivered)).toHaveLength(2)
  expect(message.html.split(escape(delivered))).toHaveLength(4)
  expect(await json(await request(app, `/orgs/org-a/invitations/${created.id}/retry-delivery`, 'POST', {})))
    .toMatchObject({ delivery: { status: 'delivered', attempts: 1, error: null } })
  expect(send).toHaveBeenCalledTimes(1)
})

it.each([
  '/invitations/accept',
  `/invitations/accept?token=${'b'.repeat(64)}`,
  `?token=${'b'.repeat(64)}`,
  `/invitations/accept?token=${'b'.repeat(64)}.${'c'.repeat(64)}`,
])('residual unsigned or unverified href %s fails closed', async href => {
  const app = createApp(sample, runtime())
  const created = await json(await request(app, '/orgs/org-a/invitations', 'POST', { email: 'unsigned@example.test', role: 'viewer' }))
  const row = (await env.DB.prepare('SELECT id,delivery_html FROM email_outbox').first<{ id: string; delivery_html: string }>())!
  await env.DB.prepare('UPDATE email_outbox SET delivery_html=? WHERE id=?').bind(row.delivery_html + `<a href="${href}">extra</a>`, row.id).run()
  const send = vi.fn().mockResolvedValue(undefined)
  const deliveryApp = createApp(sample, { ...runtime(), EMAIL: { send }, EMAIL_FROM: 'noreply@example.test' })
  expect(await json(await request(deliveryApp, `/orgs/org-a/invitations/${created.id}/retry-delivery`, 'POST', {})))
    .toMatchObject({ delivery: { status: 'failed', attempts: 1, sent_at: null, error: 'email_send_failed' } })
  expect(send).not.toHaveBeenCalled()
})

it('escaped display metadata resembling a relative href is still display text', async () => {
  const link = `http://localhost/invitations/accept?token=${'a'.repeat(64)}`
  const rendered = renderInvitationEmail({ language: 'en', kind: 'invite',
    inviterDisplayName: 'Alex /invitations/accept', organizationName: 'Team <a href="/invitations/accept">',
    roleLabel: 'Viewer /invitations/accept', timeZone: 'Europe/Prague', expiresAt: new Date('2099-01-01'),
    acceptUrl: link, configuredOrigin: 'http://localhost', allowLocalHttp: true,
  })
  const finalized = await invitationMailRenderer(runtime())({ body: `Accept: ${link}`, text: rendered.text, html: rendered.html })
  expect(finalized.html).toContain('Team &lt;a href=&quot;/invitations/accept&quot;&gt;')
  expect(finalized.text).toContain('Team <a href="/invitations/accept">')
})
