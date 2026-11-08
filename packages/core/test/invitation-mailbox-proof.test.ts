import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { json, request, setup } from '@workbasehq/test-support/helpers'

async function invitation() {
  const app = await setup()
  const row = await json(await request(app, '/orgs/org-a/invitations', 'POST', { email: 'owner.b@example.test', role: 'viewer' }, 'dispatcher-a'))
  const mail = await env.DB.prepare('SELECT o.body FROM email_outbox o JOIN invitations i ON i.delivery_outbox_id=o.id WHERE i.id=?').bind(row.id).first<string>('body')
  return { app, id: row.id, selector: new URL(row.accept_url).searchParams.get('token')!, proof: new URL(mail!.replace('Accept: ', '')).searchParams.get('token')! }
}
const headers = { Origin: 'http://localhost', 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }
const paths = ['/invitations/resolve', '/invitations/accept', '/auth/register']

it.each(paths)('inviter selector cannot issue a session through %s; mail proof can', async path => {
  const { app, selector, proof } = await invitation()
  const send = (token: string) => app.request(`http://localhost${path}`, { method: 'POST', headers, body: JSON.stringify({ token }) })
  const denied = await send(selector)
  expect(denied.status).toBe(401)
  expect(denied.headers.get('set-auth-token')).toBeNull()
  expect(denied.headers.getSetCookie()).toEqual([])
  expect(await env.DB.prepare('SELECT count(*) n FROM "session"').first('n')).toBe(0)
  const signedIn = await send(proof)
  expect(signedIn.status).toBe(200)
  expect(signedIn.headers.get('set-auth-token')).toBeTruthy()
  expect(await json(signedIn)).toMatchObject({ next: 'profile' })
})

it('copied and legacy unsigned links require recipient sign-in, and forged mail proof grants nothing', async () => {
  const { app, id, selector, proof } = await invitation()
  const copied = await json(await request(app, `/orgs/org-a/invitations/${id}/copy-link`, 'POST', {}, 'dispatcher-a'))
  const token = new URL(copied.accept_url).searchParams.get('token')!
  const send = (value: string) => app.request('http://localhost/invitations/resolve', { method: 'POST', headers, body: JSON.stringify({ token: value }) })
  expect((await send(selector)).status).toBe(404)
  expect((await send(proof)).status).toBe(404)
  for (const value of [token, `${token}.${'0'.repeat(64)}`, `${token}.${proof.split('.')[1]}`]) {
    const denied = await send(value)
    expect(denied.status).toBe(401)
    expect(denied.headers.get('set-auth-token')).toBeNull()
    expect(denied.headers.getSetCookie()).toEqual([])
  }
  expect((await request(app, '/invitations/resolve', 'POST', { token }, 'owner-b')).status).toBe(200)
  expect((await request(app, '/invitations/resolve', 'POST', { token }, 'dispatcher-a')).status).toBe(403)
  expect(await env.DB.prepare('SELECT count(*) n FROM "session"').first('n')).toBe(0)
})

it.each(paths)('anonymous mailbox login enforces origin, fetch metadata and JSON on %s', async path => {
  const { app, proof } = await invitation()
  for (const override of [
    { Origin: 'https://attacker.example' }, { Origin: '' },
    { 'Sec-Fetch-Site': 'cross-site' }, { 'Content-Type': 'text/plain' },
  ]) {
    const denied = await app.request(`http://localhost${path}`, { method: 'POST', headers: { ...headers, ...override }, body: JSON.stringify({ token: proof }) })
    expect(denied.status).toBe(403)
    expect(denied.headers.get('set-auth-token')).toBeNull()
    expect(denied.headers.getSetCookie()).toEqual([])
  }
  expect(await env.DB.prepare('SELECT count(*) n FROM "session"').first('n')).toBe(0)
})
