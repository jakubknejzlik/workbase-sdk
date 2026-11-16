import { sha256 } from '@workbasehq/core/crypto'
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import sample from '../../../core/test/fixtures/sample/config'
import { createApp } from '@workbasehq/core/app'
import { runtime, setup, request, json } from '@workbasehq/test-support/helpers'
import { KernelRegistry } from '@workbasehq/core/kernel/registry'
import { invitationMailRenderer } from '../src/mail'
import { buildInvitationAcceptUrl, verifyInvitationAcceptUrl, InvitationLinkError } from '../src/invitation-url'
import * as tokens from '../src/invitation-token'
import { hasInvitationMailboxProof } from '../src/invitation-token'

beforeEach(async () => { await setup() })
afterEach(() => vi.restoreAllMocks())
const escape = (v: string) => v.replaceAll('&', '&amp;')
const cases = (['en', 'cs'] as const).flatMap(locale => (['invite', 'reminder'] as const).flatMap(kind =>
  [false, true].map(rotated => ({ locale, kind, rotated }))))
it.each(cases)('current inputs $locale $kind rotated=$rotated re-render with verified proof and send once', async ({ locale, kind, rotated }) => {
  const config = { ...sample, locale }
  const created = await json(await request(createApp(config, runtime()), '/orgs/org-a/invitations', 'POST', { email: 'inputs@example.test', role: 'viewer' }))
  const row = (await env.DB.prepare('SELECT id,body FROM email_outbox').first<{ id: string; body: string }>())!
  const inputs = JSON.parse(row.body)
  inputs.template = { ...inputs.template, kind, inviterDisplayName: 'Alex & Al', organizationName: 'Team & <a href="/invitations/accept">', roleLabel: 'Viewer & reviewer' }
  await env.DB.prepare('UPDATE email_outbox SET body=? WHERE id=?').bind(JSON.stringify(inputs), row.id).run()
  const send = vi.fn().mockResolvedValue(undefined)
  const settings = { ...runtime(), EMAIL: { send }, EMAIL_FROM: 'noreply@example.test' }
  if (rotated) settings.IDENTITY.secret = 'synthetic-rotated-key-at-least-32-characters'
  const acceptUrl = await buildInvitationAcceptUrl(settings, { selector: inputs.selector, purpose: 'email' })
  const app = createApp(config, settings)
  const retry = () => request(app, `/orgs/org-a/invitations/${created.id}/retry-delivery`, 'POST', {})
  expect(await json(await retry())).toMatchObject({ delivery: { status: 'delivered', attempts: 1, error: null } })
  expect(send).toHaveBeenCalledTimes(1)
  const message = send.mock.calls[0][0]
  expect(message.text.split(acceptUrl)).toHaveLength(2)
  expect(message.html.split(escape(acceptUrl))).toHaveLength(4)
  expect(new Set(message.text.match(/https?:\/\/[^\s]+/g))).toEqual(new Set([acceptUrl]))
  expect(message.html).toContain('Team &amp; &lt;a href=&quot;/invitations/accept&quot;&gt;')
  expect(message.text).toContain('Team & <a href="/invitations/accept">')
  expect(message.html).toContain(`<html lang="${locale}">`)
  expect(message.subject.startsWith(locale === 'cs' ? 'Připomenutí: ' : 'Reminder: ')).toBe(kind === 'reminder')
  expect(await json(await retry())).toMatchObject({ delivery: { status: 'delivered', attempts: 1 } })
  expect(send).toHaveBeenCalledTimes(1)
})
it('invalid inputs can be repaired and retried with exactly one native send', async () => {
  const created = await json(await request(createApp(sample, runtime()), '/orgs/org-a/invitations', 'POST', { email: 'repair@example.test', role: 'viewer' }))
  const row = (await env.DB.prepare('SELECT id,body FROM email_outbox').first<{ id: string; body: string }>())!
  await env.DB.prepare('UPDATE email_outbox SET body=? WHERE id=?').bind('{}', row.id).run()
  const send = vi.fn().mockResolvedValue(undefined)
  const app = createApp(sample, { ...runtime(), EMAIL: { send }, EMAIL_FROM: 'noreply@example.test' })
  const retry = () => request(app, `/orgs/org-a/invitations/${created.id}/retry-delivery`, 'POST', {})
  for (const attempts of [1, 2]) expect(await json(await retry())).toMatchObject({ delivery: { status: 'failed', attempts, sent_at: null, error: 'email_send_failed' } })
  expect(send).not.toHaveBeenCalled()
  await env.DB.prepare('UPDATE email_outbox SET body=? WHERE id=?').bind(row.body, row.id).run()
  expect(await json(await retry())).toMatchObject({ delivery: { status: 'delivered', attempts: 3 } })
  expect(await json(await retry())).toMatchObject({ delivery: { status: 'delivered', attempts: 3 } })
  expect(send).toHaveBeenCalledTimes(1)
})
it.each(['missing', 'invalid', 'non-verifying', 'wrong-origin', 'wrong-selector', 'missing-key'] as const)('%s fails before native send', async mode => {
  const created = await json(await request(createApp(sample, runtime()), '/orgs/org-a/invitations', 'POST', { email: 'fail@example.test', role: 'viewer' }))
  const row = (await env.DB.prepare('SELECT id,body FROM email_outbox').first<{ id: string; body: string }>())!
  const inputs = JSON.parse(row.body)
  if (mode === 'wrong-origin') inputs.origin = 'https://foreign.example.test'
  if (mode === 'wrong-selector') inputs.selector = 'a'.repeat(64)
  await env.DB.prepare('UPDATE email_outbox SET body=? WHERE id=?').bind(JSON.stringify(inputs), row.id).run()
  if (['missing', 'invalid', 'non-verifying'].includes(mode)) vi.spyOn(tokens, 'invitationMailToken').mockResolvedValue(
    mode === 'missing' ? inputs.selector : mode === 'invalid' ? `${inputs.selector}.invalid` : `${inputs.selector}.${'0'.repeat(64)}`)
  const send = vi.fn().mockResolvedValue(undefined)
  const settings = { ...runtime(), EMAIL: { send }, EMAIL_FROM: 'noreply@example.test' }
  if (mode === 'missing-key') settings.IDENTITY.secret = ''
  if (mode === 'missing-key') {
    const kernel = new KernelRegistry(sample)
    await kernel.mailOutbox.retry(settings, kernel.config, row.id, async () => true, invitationMailRenderer(settings, await sha256(inputs.selector)))
    expect(await kernel.mailOutbox.status(env.DB, row.id)).toMatchObject({ delivery_status: 'failed', attempts: 1, sent_at: null, last_error: 'email_send_failed' })
  } else {
    const app = createApp(sample, settings)
    expect(await json(await request(app, `/orgs/org-a/invitations/${created.id}/retry-delivery`, 'POST', {})))
      .toMatchObject({ delivery: { status: 'failed', attempts: 1, sent_at: null, error: 'email_send_failed' } })
  }
  expect(send).not.toHaveBeenCalled()
})
it('URL verifier rejects wrong origin, path and proof with a typed error', async () => {
  const settings = runtime()
  const valid = await buildInvitationAcceptUrl(settings, { selector: 'a'.repeat(64), purpose: 'email' })
  for (const value of [valid.replace('localhost', 'foreign.example.test'), valid.replace('/invitations/accept', '/other'), valid.split('.')[0], valid + '&token=duplicate', valid + '#fragment']) {
    await expect(verifyInvitationAcceptUrl(settings, value, 'email')).rejects.toBeInstanceOf(InvitationLinkError)
  }
  expect(await verifyInvitationAcceptUrl(settings, valid, 'email')).toBe(valid)
})
it('AUTH_BASE_URL is the exact configured origin even when IDENTITY differs', async () => {
  const settings = { ...runtime(), AUTH_BASE_URL: 'https://console.example.test', STAGE: 'production' }
  const value = await buildInvitationAcceptUrl(settings, { selector: 'a'.repeat(64), purpose: 'email' })
  expect(new URL(value).origin).toBe(settings.AUTH_BASE_URL)
  await expect(buildInvitationAcceptUrl({ ...settings, AUTH_BASE_URL: settings.AUTH_BASE_URL + '/path' }, { selector: 'a'.repeat(64), purpose: 'email' })).rejects.toBeInstanceOf(InvitationLinkError)
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
