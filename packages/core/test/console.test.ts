import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { CONSOLE_CSP } from '../src/console'
import { setup, runtime } from '@workbasehq/test-support/helpers'
import sample from './fixtures/sample/config'

beforeEach(() => setup())
it('console serves assets, extensionless SPA routes and exact CSP without swallowing APIs', async () => {
  const paths: string[] = []
  const app = createApp(sample, { ...runtime(), BUILD_SHA: 'a'.repeat(40), BUILD_AT: '2026-10-24T00:00:00.000Z', ASSETS: { fetch: async (r: Request) => {
    const path = new URL(r.url).pathname; paths.push(path)
    return path === '/index.html' ? new Response('<h1>Console</h1>', { headers: { 'Content-Type': 'text/html' } }) : new Response('missing', { status: 404 })
  } } as Fetcher })
  for (const path of ['/', '/o/123', '/organizations', '/unknown/path', '/auth/complete']) {
    const response = await app.request('http://localhost' + path)
    expect(response.status).toBe(200); expect(response.headers.get('Content-Security-Policy')).toBe(CONSOLE_CSP)
  }
  expect((await app.request('http://localhost/missing.js')).status).toBe(404)
  expect((await app.request('http://localhost/api/not-an-entity')).status).toBe(401)
  expect(paths).not.toContain('/api/not-an-entity')
  for (const path of ['/api', '/auth/unknown', '/mcp', '/mcp/unknown', '/ops/unknown', '/query/unknown', '/orgs/unknown', '/invitations/unknown', '/audit/unknown', '/workflows/unknown', '/schema/unknown', '/bootstrap/unknown', '/o/123/bootstrap/unknown', '/o/123/capabilities/unknown']) {
    const response = await app.request('http://localhost' + path)
    expect(response.status, path).not.toBe(200)
    expect(response.headers.get('Content-Type'), path).not.toContain('text/html')
    expect(paths, path).not.toContain(path)
  }
  for (const method of ['POST', 'OPTIONS']) {
    expect((await app.request('http://localhost/unknown/path', { method })).status).toBe(404)
  }
  expect(await (await app.request('http://localhost/build.json')).json()).toEqual({ sha: 'a'.repeat(40), builtAt: '2026-10-24T00:00:00.000Z', revision: sample.revision })
})

const mutationPaths = ['/api/clients', '/commands/jobs/create', '/workflows/test', '/query', '/orgs', '/orgs/org-a/leave', '/invitations/accept', '/auth/link', '/auth/logout', '/auth/revoke-all']
const valid = { Origin: 'http://localhost', 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' }
const refusals: [string, Record<string, string>][] = [
  ['missing Origin', { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' }],
  ['hostile Origin', { ...valid, Origin: 'https://attacker.test' }],
  ['missing Fetch Metadata', { Origin: 'http://localhost', 'Content-Type': 'application/json' }],
  ['cross-site Fetch Metadata', { ...valid, 'Sec-Fetch-Site': 'cross-site' }],
  ['text/plain', { ...valid, 'Content-Type': 'text/plain' }],
  ['missing Content-Type', { Origin: 'http://localhost', 'Sec-Fetch-Site': 'same-origin' }],
]
for (const path of mutationPaths) for (const [reason, headers] of refusals) {
  it(`cookie JSON mutation at ${path} refuses ${reason}`, async () => {
    const app = createApp(sample, runtime())
    const sent = await app.request('http://localhost/auth/sign-in/magic-link', { method: 'POST', headers: valid, body: JSON.stringify({ email: 'owner.a@example.test', callbackURL: '/me' }) })
    expect(sent.status).toBe(200)
    const url = await env.DB.prepare("SELECT body FROM email_outbox WHERE recipient=? AND subject='Workbase sign-in' ORDER BY rowid DESC LIMIT 1").bind('owner.a@example.test').first<string>('body')
    const verified = await app.request(url!)
    expect(verified.status).toBe(302)
    const cookie = verified.headers.getSetCookie().find(value => value.startsWith('__Host-workbase.session='))!.split(';')[0]
    expect((await app.request('http://localhost/me', { headers: { Cookie: cookie } })).status).toBe(200)
    const response = await app.request('http://localhost' + path, { method: 'POST', headers: { Cookie: cookie, ...headers }, body: '{}' })
    expect(response.status).toBe(403)
    if (path === '/auth/logout' && ['text/plain', 'missing Content-Type'].includes(reason)) expect(await response.text()).toContain('csrf_failed')
    else expect(await response.json()).toEqual({ error: 'csrf_failed' })
  })
}
it('Bearer with cookie ignores browser provenance', async () => {
  const app = createApp(sample, runtime())
  const response = await app.request('http://localhost/api/clients', { method: 'POST', headers: {
    Authorization: 'Bearer synthetic-owner-a', Cookie: '__Host-workbase.session=unrelated', 'X-Organization-Id': 'org-a', 'Content-Type': 'text/plain',
  }, body: JSON.stringify({ name: 'Bearer client' }) })
  expect(response.status).toBe(201)
})

async function ownerCookie(app: ReturnType<typeof createApp>) {
  await app.request('http://localhost/auth/sign-in/magic-link', { method: 'POST', headers: valid, body: JSON.stringify({ email: 'owner.a@example.test', callbackURL: '/me' }) })
  const url = await env.DB.prepare("SELECT body FROM email_outbox WHERE recipient=? AND subject='Workbase sign-in' ORDER BY rowid DESC LIMIT 1").bind('owner.a@example.test').first<string>('body')
  const verified = await app.request(url!)
  expect(verified.status).toBe(302)
  return verified.headers.getSetCookie().find(value => value.startsWith('__Host-workbase.session='))!.split(';')[0]
}
it('cookie JSON create accepts a JSON charset with complete same-origin provenance', async () => {
  const app = createApp(sample, runtime()); const cookie = await ownerCookie(app)
  const response = await app.request('http://localhost/api/clients', { method: 'POST', headers: { ...valid, 'Content-Type': 'application/json; charset=utf-8', Cookie: cookie, 'X-Organization-Id': 'org-a' }, body: JSON.stringify({ name: 'Cookie client' }) })
  expect(response.status).toBe(201)
})
it('cookie JSON Origin includes the exact port', async () => {
  const app = createApp(sample, runtime()); const cookie = await ownerCookie(app)
  const response = await app.request('http://localhost/api/clients', { method: 'POST', headers: { ...valid, Origin: 'http://localhost:8971', Cookie: cookie }, body: '{}' })
  expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: 'csrf_failed' })
})
it('a malformed signed Bearer never falls back to the live cookie', async () => {
  const app = createApp(sample, runtime()); const cookie = await ownerCookie(app)
  const response = await app.request('http://localhost/api/clients', { method: 'POST', headers: { Cookie: cookie, Authorization: 'Bearer invalid.signature', 'X-Organization-Id': 'org-a', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Never created' }) })
  expect(response.status).toBe(401)
})
it('an unbuilt console fails closed with CSP and never serves an empty shell', async () => {
  const response = await createApp(sample, runtime()).request('http://localhost/')
  expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'console_not_built' })
  expect(response.headers.get('Content-Security-Policy')).toBe(CONSOLE_CSP)
})
it('raw local assets supply build identity without SST environment bindings', async () => {
  const app = createApp(sample, { ...runtime(), ASSETS: { fetch: async (request: Request) => {
    expect(new URL(request.url).pathname).toBe('/build-meta.json')
    expect(request.headers.has('Cookie')).toBe(false)
    return Response.json({ sha: 'b'.repeat(40), builtAt: '2026-10-24T00:00:00.000Z', ignored: 'never exposed' })
  } } as Fetcher })
  const response = await app.request('http://localhost/build.json', { headers: { Cookie: 'private=credential' } })
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  expect(await response.json()).toEqual({ sha: 'b'.repeat(40), builtAt: '2026-10-24T00:00:00.000Z', revision: sample.revision })
})
