import { reset } from 'cloudflare:test'
import { bootstrap } from '@workbasehq/test-support/bootstrap'
import { workerAccessFixture } from '../../../core/test/fixtures/worker-access'
import { sha256 } from '@workbasehq/core/crypto'
import { env } from 'cloudflare:workers'
import { beforeEach, expect, it, vi } from 'vitest'
import sample from '../../../core/test/fixtures/sample/config'
import { createApp } from '@workbasehq/core/app'
import { runtime, setup, request, json } from '@workbasehq/test-support/helpers'
import { hasInvitationMailboxProof } from '../src/invitation-token'

beforeEach(async () => { await setup() })
const modes = ['bare', 'plain', 'percent', 'decimal', 'hex'] as const
it.each(modes)('re-renders inputs and ignores tampered stored HTML/text: %s', async mode => {
  const created = await json(await request(createApp(sample, runtime()), '/orgs/org-a/invitations', 'POST', { email: 'tampered@example.test', role: 'viewer' }))
  const row = (await env.DB.prepare('SELECT id,body,delivery_html FROM email_outbox').first<{ id: string; body: string; delivery_html: string }>())!
  const selector = JSON.parse(row.body).selector
  const encoded = [...selector].map(ch => mode === 'percent' ? `%${ch.charCodeAt(0).toString(16)}` : mode === 'decimal' ? `&#${ch.charCodeAt(0)};` : mode === 'hex' ? `&#x${ch.charCodeAt(0).toString(16)};` : ch).join('')
  const extra = `<a title=">" href="/invitations/accept${mode === 'bare' ? '' : `&quest;token&equals;${encoded}`}">extra</a>`
  await env.DB.prepare('UPDATE email_outbox SET delivery_html=? WHERE id=?').bind(row.delivery_html + extra, row.id).run()
  const send = vi.fn().mockResolvedValue(undefined)
  const settings = { ...runtime(), EMAIL: { send }, EMAIL_FROM: 'noreply@example.test' }
  const app = createApp(sample, settings)
  const retry = () => request(app, `/orgs/org-a/invitations/${created.id}/retry-delivery`, 'POST', {})
  expect(await json(await retry())).toMatchObject({ delivery: { status: 'delivered', attempts: 1 } })
  expect(send).toHaveBeenCalledTimes(1)
  const message = send.mock.calls[0][0]
  expect(message.html).not.toContain(extra)
  expect(message.text).not.toContain('tampered stored text')
  const urls = message.text.match(/https?:\/\/[^\s]+/g)!
  expect(urls).toHaveLength(1)
  expect(await hasInvitationMailboxProof(settings, new URL(urls[0]).searchParams.get('token')!)).toBe(true)
  expect([...message.html.matchAll(/href="([^"]+)"/g)].map(m => m[1])).toEqual([urls[0], urls[0]])
  expect(await json(await retry())).toMatchObject({ delivery: { status: 'delivered', attempts: 1 } })
  expect(send).toHaveBeenCalledTimes(1)
})
it('copy before retry neither exposes nor invalidates the delivered credential', async () => {
  const created = await json(await request(createApp(sample, runtime()), '/orgs/org-a/invitations', 'POST', { email: 'owner.b@example.test', role: 'viewer' }))
  const send = vi.fn().mockResolvedValue(undefined)
  const settings = { ...runtime(), EMAIL: { send }, EMAIL_FROM: 'noreply@example.test' }
  const app = createApp(sample, settings)
  const copy = async () => json(await request(app, `/orgs/org-a/invitations/${created.id}/copy-link`, 'POST', {}))
  const copied = await copy()
  const retry = () => request(app, `/orgs/org-a/invitations/${created.id}/retry-delivery`, 'POST', {})
  expect(await json(await retry())).toMatchObject({ delivery: { status: 'delivered', attempts: 1 } })
  expect(send).toHaveBeenCalledTimes(1)
  const delivered = send.mock.calls[0][0].text.match(/https?:\/\/[^\s]+/g)![0]
  expect(send.mock.calls[0][0].text).not.toContain(copied.accept_url)
  expect(new URL(delivered).searchParams.get('token')!.split('.')[0]).not.toBe(new URL(copied.accept_url).searchParams.get('token'))
  await copy()
  expect(await json(await retry())).toMatchObject({ delivery: { status: 'delivered', attempts: 1 } })
  expect(send).toHaveBeenCalledTimes(1)
  const resolve = (token: string) => app.request('http://localhost/invitations/resolve', { method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })
  expect((await resolve(new URL(copied.accept_url).searchParams.get('token')!)).status).toBe(404)
  expect((await resolve(new URL(delivered).searchParams.get('token')!)).status).toBe(200)
})

const escape = (v: string) => v.replace(/[&<>"']/g, ch => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[ch]!))
const matrix = ['members', 'v3'].flatMap(route => ['en','cs'].flatMap(locale => ['organization','inviter','role'].map(field => ({route, locale, field}))))
it.each(matrix)('$route $locale $field display path and escaped markup sends once', async ({route,locale,field}) => {
  const label = `Label & <a href="/invitations/accept"> 'quoted'`
  let config: any = route === 'members' ? {...sample, locale} : {...workerAccessFixture(), locale}
  const actor = route === 'members' ? 'owner-a' : 'admin'
  const role = route === 'members' ? 'viewer' : 'staff'
  if (field === 'role') config = {...config, enumLabels: {[locale]: {[`value_${role}_roles`]: label}}}
  if (route === 'v3') {
    await reset()
    await bootstrap(env.DB,config)
    await env.DB.exec("INSERT INTO organizations VALUES ('org-a','Team')")
    await env.DB.prepare('INSERT INTO users (id,email,password_hash,salt,organization_id,name,role,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(actor,'admin@example.test','x','x','org-a',actor,'admin','now','now').run()
    await env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(actor,actor,'admin@example.test','now','now').run()
    await env.DB.exec("INSERT INTO memberships VALUES ('admin','org-a','admin')")
    await env.DB.prepare("INSERT INTO sessions VALUES (?,'admin','2099-01-01T00:00:00.000Z')").bind(await sha256('synthetic-admin')).run()
    await env.DB.exec("INSERT INTO identities VALUES ('admin','local','local','admin','now')")
    await env.DB.exec("INSERT INTO worker (id,organization_id,name,created_at,updated_at) VALUES ('local','org-a','Recipient','now','now')")
  }
  if (field === 'organization') await env.DB.prepare("UPDATE organizations SET name=? WHERE id='org-a'").bind(label).run()
  if (field === 'inviter') await env.DB.prepare('UPDATE "user" SET name=? WHERE id=?').bind(label,actor).run()
  const send = vi.fn().mockResolvedValue(undefined)
  const settings = {...runtime(), EMAIL:{send}, EMAIL_FROM:'noreply@example.test'}
  const app = createApp(config,settings)
  const path = route === 'members' ? '/orgs/org-a/invitations' : '/api/worker/local/actions/invite'
  const res = await request(app,path,'POST',route === 'members' ? {email:'probe@example.test',role} : {email:'probe@example.test'},actor)
  expect(res.status, await res.clone().text()).toBe(201)
  const created = await json(res)
  expect(created.delivery).toMatchObject({status:'delivered',attempts:1,error:null})
  expect(send).toHaveBeenCalledTimes(1)
  const message = send.mock.calls[0][0]
  expect(message.text).toContain(label)
  expect(message.html).toContain(escape(label))
  expect(message.html).not.toContain(label)
  const delivered = message.text.match(/https?:\/\/[^\s]+\/invitations\/accept\?token=[a-f0-9]+\.[a-f0-9]+/)![0]
  expect(await hasInvitationMailboxProof(settings,new URL(delivered).searchParams.get('token')!)).toBe(true)
  expect(message.text.split(delivered)).toHaveLength(2)
  expect(message.html.split(escape(delivered))).toHaveLength(4)
  const retry = await json(await request(app,`/orgs/org-a/invitations/${created.id ?? created.invitation_id}/retry-delivery`,'POST',{},actor))
  expect(retry.delivery).toMatchObject({status:'delivered',attempts:1,error:null})
  expect(send).toHaveBeenCalledTimes(1)
})

it.each(['text', 'html', 'both', 'null'] as const)('ignores replaced stored output: %s', async part => {
  const created = await json(await request(createApp(sample, runtime()), '/orgs/org-a/invitations', 'POST', { email: 'stored@example.test', role: 'viewer' }))
  const row = (await env.DB.prepare('SELECT id FROM email_outbox').first<{ id: string }>())!
  await env.DB.prepare('UPDATE email_outbox SET delivery_text=?,delivery_html=? WHERE id=?')
    .bind(part === 'null' ? null : part === 'html' ? '' : 'tampered text /invitations/accept', part === 'null' ? null : part === 'text' ? '' : '<a title=">" href="/invitations/accept">tampered html</a>', row.id).run()
  const send = vi.fn().mockResolvedValue(undefined)
  const app = createApp(sample, { ...runtime(), EMAIL: { send }, EMAIL_FROM: 'noreply@example.test' })
  const retry = () => request(app, `/orgs/org-a/invitations/${created.id}/retry-delivery`, 'POST', {})
  expect(await json(await retry())).toMatchObject({ delivery: { status: 'delivered', attempts: 1 } })
  expect(send).toHaveBeenCalledTimes(1)
  expect(send.mock.calls[0][0].text).not.toContain('tampered')
  expect(send.mock.calls[0][0].html).not.toContain('tampered')
  expect(await json(await retry())).toMatchObject({ delivery: { status: 'delivered', attempts: 1 } })
  expect(send).toHaveBeenCalledTimes(1)
})
