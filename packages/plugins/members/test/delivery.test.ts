import { beforeEach, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:workers'
import sample from '../../../core/test/fixtures/sample/config'
import accounts from '../../../core/test/fixtures/accounts/config'
import { createApp } from '@workbasehq/core/app'
import { KernelRegistry } from '@workbasehq/core/kernel/registry'
import { runtime, setup, request } from '@workbasehq/test-support/helpers'
import { invitationMail, invitationOrigin } from '../src/mail'

beforeEach(async () => { await setup() })
it.each(['revoke', 'resend', 'accept', 'expire'])('a failed invitation cannot deliver its stale credential after %s', async action => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const send = vi.fn().mockRejectedValueOnce(new Error('provider failure')).mockResolvedValue({ messageId: 'ok' })
  try {
    const settings = { ...runtime(), EMAIL: { send }, EMAIL_FROM: 'noreply@example.test' }
    const app = createApp(sample, settings)
    const response = await request(app, '/orgs/org-a/invitations', 'POST', { email: 'delivery@example.test', role: 'viewer' })
    expect(response.status).toBe(201)
    const { id } = await response.json() as { id: string }
    const row = (await env.DB.prepare("SELECT id,body FROM email_outbox WHERE recipient='delivery@example.test'").first<{ id: string; body: string }>())!
    expect(send).toHaveBeenCalledTimes(1)
    expect(await new KernelRegistry(sample).mailOutbox.status(env.DB, row.id)).toMatchObject({ delivery_status: 'failed', attempts: 1 })
    if (action === 'revoke') expect((await request(app, `/orgs/org-a/invitations/${id}`, 'DELETE')).status).toBe(204)
    if (action === 'resend') expect((await request(app, `/orgs/org-a/invitations/${id}/resend`, 'POST', {})).status).toBe(200)
    if (action === 'accept') await env.DB.prepare('UPDATE invitations SET accepted_at=? WHERE id=?').bind(new Date().toISOString(), id).run()
    if (action === 'expire') await env.DB.prepare("UPDATE invitations SET expires_at='2000-01-01' WHERE id=?").bind(id).run()
    const before = send.mock.calls.length
    await (await invitationMail(settings, new KernelRegistry(sample).config, row.id, 'org-a', 'delivery@example.test', row.body.replace('Accept: ', ''))).deliver()
    expect(send).toHaveBeenCalledTimes(before)
    expect(await new KernelRegistry(sample).mailOutbox.status(env.DB, row.id)).toMatchObject({ delivery_status: 'failed', attempts: 1 })
  } finally { log.mockRestore() }
})

it('create and manual Resend persist rendered content and inviter sender through failure and retry', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const send = vi.fn().mockRejectedValueOnce(new Error('provider secret must not leak')).mockResolvedValue(undefined)
  try {
    await env.DB.prepare('UPDATE "user" SET name=? WHERE id=?').bind('Alex "Al" Example', 'owner-a').run()
    await env.DB.prepare('UPDATE organizations SET name=? WHERE id=?').bind('Prague Dental', 'org-a').run()
    const settings = { ...runtime(), EMAIL: { send }, EMAIL_FROM: 'noreply@example.test', IDENTITY: { ...runtime().IDENTITY, baseURL: 'https://localhost' } }
    const app = createApp(sample, settings)
    const created = await request(app, '/orgs/org-a/invitations', 'POST', { email: 'ada@example.test', role: 'viewer' })
    const invitation = await created.json() as { id: string; accept_url: string; delivery: { status: string } }
    expect(invitation.delivery.status).toBe('failed')
    const original = await env.DB.prepare('SELECT * FROM email_outbox').first<{ id: string; subject: string; delivery_html: string; delivery_text: string; sender_name: string }>()
    expect(original?.sender_name).toBe('Alex "Al" Example')
    expect(original?.subject).toContain('Prague Dental')
    expect(original?.delivery_text).toContain(invitation.accept_url)
    expect(original?.delivery_html).toContain('Alex &quot;Al&quot; Example')
    expect(send.mock.calls[0][0].from).toBe('"Alex \\"Al\\" Example" <noreply@example.test>')
    const retried = await request(app, `/orgs/org-a/invitations/${invitation.id}/retry-delivery`, 'POST', {})
    expect(await retried.json()).toMatchObject({ delivery: { status: 'delivered', attempts: 2 } })
    expect(send.mock.calls[1][0]).toEqual(send.mock.calls[0][0])
    const reminder = await request(app, `/orgs/org-a/invitations/${invitation.id}/resend`, 'POST', {})
    expect(await reminder.json()).toMatchObject({ delivery: { status: 'delivered', attempts: 1 } })
    expect(send.mock.calls[2][0]).toMatchObject({ from: send.mock.calls[0][0].from, subject: `Reminder: ${original!.subject}` })
    expect(send.mock.calls[2][0].text).toContain('This is a reminder')
    expect(send.mock.calls[2][0].text).not.toContain(invitation.accept_url)
    expect(await env.DB.prepare('SELECT count(*) n FROM email_outbox').first('n')).toBe(2)
  } finally { log.mockRestore() }
})


it('never derives production invitation destinations from a request origin', () => {
  expect(() => invitationOrigin({ ...runtime(), IDENTITY: undefined, STAGE: 'production' }, 'https://attacker.example.test')).toThrow('invitation_origin_required')
  expect(invitationOrigin({ ...runtime(), IDENTITY: undefined, AUTH_BASE_URL: 'https://console.example.test', STAGE: 'production' }, 'https://attacker.example.test')).toBe('https://console.example.test')
})


it('localized create and Resend queue rendered mail with the exact expiry and configured origin', async () => {
  const localized = { ...accounts, locale: 'cs' as const, timeZone: 'Europe/Prague' }
  await setup(localized)
  const now = new Date().toISOString()
  const { sha256 } = await import('@workbasehq/core/crypto')
  await env.DB.prepare('INSERT INTO sessions VALUES (?,?,?)').bind(await sha256('synthetic-administrator'), 'administrator', new Date(Date.now() + 60000).toISOString()).run()
  await env.DB.prepare('UPDATE "user" SET name=?,"emailVerified"=1 WHERE id=?').bind('Alex Example', 'administrator').run()
  const app = createApp(localized, runtime())
  const response = await request(app, '/orgs/org-a/invitations', 'POST', { email: 'ada@example.test', role: 'reviewer' }, 'administrator')
  expect(response.status, await response.clone().text()).toBe(201)
  const created = await response.json() as { id: string; expires_at: string; accept_url: string }
  const read = () => env.DB.prepare('SELECT o.* FROM email_outbox o JOIN invitations i ON i.delivery_outbox_id=o.id WHERE i.id=?').bind(created.id).first<{ subject: string; delivery_text: string; delivery_html: string; expires_at: string; sender_name: string }>()
  const invite = (await read())!
  expect(invite.sender_name).toBe('Alex Example')
  expect(invite.subject).toContain('Alex Example vás zve do organizace Organization A')
  expect(invite.delivery_text).toContain('Vaše role: reviewer.')
  expect(invite.delivery_text).toContain(created.accept_url)
  expect(invite.expires_at).toBe(created.expires_at)
  expect(Date.parse(invite.expires_at)).toBeGreaterThan(Date.parse(now) + 6 * 86400000)
  const exact = new Intl.DateTimeFormat('cs-CZ', { timeZone: 'Europe/Prague', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' }).format(new Date(created.expires_at))
  expect(invite.delivery_text).toContain(exact)
  expect(invite.delivery_html).toContain('<html lang="cs">')
  expect((await request(app, `/orgs/org-a/invitations/${created.id}/resend`, 'POST', {}, 'administrator')).status).toBe(200)
  const reminder = (await read())!
  expect(reminder.subject).toBe(`Připomenutí: ${invite.subject}`)
  expect(reminder.delivery_text).toContain('Připomínáme, že Alex Example')
  expect(reminder.delivery_text).not.toContain(created.accept_url)
})
