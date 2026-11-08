import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import sample from './fixtures/sample/config'
import { createApp } from '../src/app'
import { LocalIdentityProvider } from '@workbasehq/plugins/local-auth/identity-providers'
import { setup, runtime, syntheticPassword, json } from '@workbasehq/test-support/helpers'

beforeEach(async () => { await setup() })

it.each(['http://staging.example.test', 'http://localhost.example.test', 'http://127.0.0.2'])('identity refuses non-loopback HTTP origin %s in object and flat bindings', origin => {
  expect(() => createApp(sample, { ...runtime(), IDENTITY: { ...runtime().IDENTITY, baseURL: origin, localPassword: false } })).toThrow('invalid_identity_origin')
  const { IDENTITY, ...bindings } = runtime()
  expect(() => createApp(sample, { ...bindings, AUTH_BASE_URL: origin, BETTER_AUTH_SECRET: IDENTITY.secret })).toThrow('invalid_identity_origin')
})

it.each([
  ['https://staging.example.test', {}],
  ['https://staging.example.test', { Origin: 'https://staging.example.test' }],
  ['https://staging.example.test', { Origin: 'http://localhost', Host: 'localhost' }],
  ['http://localhost', { Origin: 'https://staging.example.test' }],
  ['http://localhost', { Host: 'staging.example.test' }],
  ['http://localhost.example.test', {}],
] as [string, Record<string, string>][])('copied dev config rejects password and legacy sessions on request %s %j', async (origin, headers) => {
  const app = createApp(sample, runtime()) // Deliberately copied localhost + localPassword=true.
  const before = await env.DB.prepare('SELECT count(*) AS n FROM sessions').first('n')
  const login = await app.request(`${origin}/auth/login`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner.a@example.test', password: syntheticPassword }) })
  const insecure = origin.startsWith('http:')
  expect(login.status).toBe(insecure ? 403 : 404)
  expect(await json(login)).toEqual({ error: insecure ? 'insecure_identity_transport' : 'provider_not_enabled' })
  expect(await env.DB.prepare('SELECT count(*) AS n FROM sessions').first('n')).toBe(before)
  const providers = await app.request(`${origin}/auth/providers`, { headers })
  expect(providers.status).toBe(insecure ? 403 : 200)
  if (!insecure) expect(await json(providers)).toEqual({ providers: [{ id: 'better-auth' }] })
  for (const path of ['/me', '/api/clients', '/orgs', '/orgs/org-a/members', '/auth/logout', '/auth/revoke-all']) {
    const response = await app.request(`${origin}${path}`, { method: path === '/orgs' || path.startsWith('/auth/') ? 'POST' : 'GET',
      headers: { ...headers, Authorization: 'Bearer synthetic-owner-a', 'X-Organization-Id': 'org-a' } })
    expect(response.status, path).toBe(insecure && path.startsWith('/auth/') ? 403 : 401)
  }
  await expect(new LocalIdentityProvider(runtime(), new Request(origin, { headers })).authenticate({ email: 'owner.a@example.test', password: syntheticPassword })).rejects.toMatchObject({ status: 404 })
})

it.each(['http://localhost', 'http://127.0.0.1', 'http://[::1]'])('dev password and legacy sessions require explicit flag on actual loopback %s', async origin => {
  for (const enabled of [true, false]) {
    const app = createApp(sample, { ...runtime(), IDENTITY: { ...runtime().IDENTITY, baseURL: origin, localPassword: enabled } })
    const login = await app.request(`${origin}/auth/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner.a@example.test', password: syntheticPassword }) })
    expect(login.status).toBe(enabled ? 200 : 404)
    const headers = { Authorization: 'Bearer synthetic-owner-a', 'X-Organization-Id': 'org-a', Origin: origin }
    expect((await app.request(`${origin}/api/clients`, { headers })).status).toBe(enabled ? 200 : 401)
  }
})

it('local provider without a request cannot accept password credentials', async () => {
  await expect(new LocalIdentityProvider(runtime()).authenticate({ email: 'owner.a@example.test', password: syntheticPassword })).rejects.toMatchObject({ status: 404 })
})
