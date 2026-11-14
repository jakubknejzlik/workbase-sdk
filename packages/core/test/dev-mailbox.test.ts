import { env } from 'cloudflare:workers'
import { beforeEach, expect, it, vi } from 'vitest'
import mailbox from '../src/dev-mailbox'
import { createApp } from '../src/app'
import { defineInstance } from '../src/config'
import { createOrganizations } from '@workbasehq/plugins/organizations'
import { json, runtime, setup } from '@workbasehq/test-support/helpers'
import sample from './fixtures/sample/config'

const token = 'synthetic-mailbox-token-at-least-32-characters'
const config = defineInstance({ ...sample, plugins: sample.plugins!.map(plugin => plugin.name === 'organizations' ? createOrganizations({ allowCreate: false }) : plugin) })
const settings = () => ({ DB: env.DB, STAGE: 'test', DEV_MAILBOX_TOKEN: token })
function read(query = '?recipient=first@example.test', headers: Record<string, string> = { Authorization: `Bearer ${token}` }, method = 'GET') {
  return mailbox.fetch(new Request(`https://mailbox.example.test/messages${query}`, { headers, method }), settings())
}
beforeEach(async () => { await setup(config, async () => {}) })

it('fails closed before accessing D1 for unsupported stages, absent configuration and wrong credentials', async () => {
  const prepare = vi.fn(() => { throw new Error('must not query') })
  for (const STAGE of ['production', 'prod', 'staging', 'preview', '', undefined]) {
    const response = await mailbox.fetch(new Request('https://mailbox.test/messages', { headers: { Authorization: `Bearer ${token}` } }), { ...settings(), DB: { prepare } as unknown as D1Database, STAGE })
    expect(response.status).toBe(404)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  }
  for (const DEV_MAILBOX_TOKEN of [undefined, '', 'short']) {
    expect((await mailbox.fetch(new Request('https://mailbox.test/messages'), { ...settings(), DB: { prepare } as unknown as D1Database, DEV_MAILBOX_TOKEN })).status).toBe(503)
  }
  expect(prepare).not.toHaveBeenCalled()
  for (const headers of [{}, { Authorization: 'Bearer wrong' }, { 'X-Internal-Token': token }, { Cookie: `token=${token}` }] as Record<string, string>[]) {
    const response = await read(undefined, headers)
    expect(response.status).toBe(403)
    expect(await response.text()).not.toContain(token)
  }
  expect((await read(`?recipient=first@example.test&token=${token}`, {})).status).toBe(403)
})

it('requires recipient, rejects browser origins and mutations, and has no CORS or cacheable responses', async () => {
  for (const query of ['', '?recipient=', '?recipient=bad', '?recipient=a@example.test&recipient=b@example.test', '?recipient=a@example.test&limit=51', '?recipient=a@example.test&limit=0', '?recipient=a@example.test&limit=1.5']) {
    expect((await read(query)).status).toBe(400)
  }
  expect((await read(undefined, { Authorization: `Bearer ${token}`, Origin: 'https://attacker.test' })).status).toBe(403)
  for (const method of ['POST', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']) expect((await read(undefined, undefined, method)).status).toBe(405)
  const response = await read()
  expect(await json(response)).toEqual({ messages: [] })
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
  expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
})

it('returns bounded, deterministic recipient-only mail without modifying delivery state', async () => {
  for (let i = 0; i < 55; i++) await env.DB.prepare('INSERT INTO email_outbox (id,recipient,subject,body,created_at) VALUES (?,?,?,?,?)')
    .bind(`mail-${i}`, i === 54 ? 'other@example.test' : 'first@example.test', 'Subject', `credential-${i}`, '2026-11-14T00:00:00.000Z').run()
  const before = await env.DB.prepare('SELECT * FROM email_outbox ORDER BY rowid').all()
  const response = await read()
  const { messages } = await json(response)
  expect(messages).toHaveLength(20)
  expect(messages[0]).toMatchObject({ id: 'mail-53', body: 'credential-53', recipient: 'first@example.test' })
  expect(messages.every((message: any) => message.recipient === 'first@example.test')).toBe(true)
  expect((await json(await read('?recipient=first@example.test&limit=50'))).messages).toHaveLength(50)
  expect((await json(await read('?recipient=first@example.test&limit=1'))).messages).toHaveLength(1)
  expect((await json(await read('?recipient=missing@example.test'))).messages).toEqual([])
  expect((await read('?recipient=' + encodeURIComponent("x' OR 1=1 --@example.test"))).status).toBe(400)
  expect(await env.DB.prepare('SELECT * FROM email_outbox ORDER BY rowid').all()).toEqual(before)
})

it('suppresses database error details', async () => {
  const response = await mailbox.fetch(new Request('https://mailbox.test/messages?recipient=first@example.test', { headers: { Authorization: `Bearer ${token}` } }), {
    ...settings(), DB: { prepare() { throw new Error('secret SQL body credential') } } as unknown as D1Database,
  })
  expect(response.status).toBe(503)
  expect(await json(response)).toEqual({ error: 'dev_mailbox_unavailable' })
})

it('bootstraps the first verified owner and organization through public auth, sidecar and protected provisioning', async () => {
  const app = createApp(config, { ...runtime(), OPS_TOKEN: 'synthetic-ops-token', IDENTITY: { ...runtime().IDENTITY, localPassword: false } })
  expect(await env.DB.prepare('SELECT count(*) n FROM "user"').first('n')).toBe(0)
  expect(await env.DB.prepare('SELECT count(*) n FROM memberships').first('n')).toBe(0)
  const send = (path: string, body?: unknown, bearer?: string, method = body ? 'POST' : 'GET') => app.request(`http://localhost${path}`, { method,
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  expect((await send('/auth/sign-in/magic-link', { email: 'first@example.test', callbackURL: '/me' })).status).toBe(200)
  const { messages } = await json(await read())
  expect(messages).toHaveLength(1)
  expect(messages[0].subject).toBe('Workbase sign-in')
  // The application Worker never mounts the mailbox, even with the sidecar's token.
  const appMailbox = await send('/messages?recipient=first@example.test', undefined, token)
  expect(appMailbox.status).toBe(503)
  expect(await json(appMailbox)).toMatchObject({ error: 'console_not_built' })
  expect((await read(undefined, { Authorization: 'Bearer synthetic-ops-token' })).status).toBe(403)
  const verified = await app.request(messages[0].body)
  expect(verified.status).toBe(302)
  const bearer = verified.headers.get('set-auth-token')!
  expect(bearer).toBeTruthy()
  expect((await app.request(messages[0].body)).headers.get('set-auth-token')).toBeNull()
  expect((await send('/me/profile', { firstName: 'First', lastName: 'Owner' }, bearer, 'PATCH')).status).toBe(200)
  expect((await send('/orgs', { name: 'First organization' }, bearer)).status).toBe(403)
  const provisioned = await app.request('http://localhost/internal/organizations', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Token': 'synthetic-ops-token' }, body: JSON.stringify({ name: 'First organization', ownerEmail: 'first@example.test' }) })
  expect(provisioned.status).toBe(201)
  const organization = await json(provisioned)
  const me = await json(await send('/me', undefined, bearer))
  expect(await env.DB.prepare('SELECT user_id,role FROM memberships WHERE organization_id=?').bind(organization.id).first()).toEqual({ user_id: me.user.id, role: 'owner' })
})
