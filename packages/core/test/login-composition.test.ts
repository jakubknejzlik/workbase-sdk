import { beforeEach, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:workers'
import sample from './fixtures/sample/config'
import { identity } from '@workbasehq/plugins/identity'
import { localAuth } from '@workbasehq/plugins/local-auth'
import { legacyPermissions as rbac } from '@workbasehq/plugins/permissions'
import { members } from '@workbasehq/plugins/members'
import { organizations } from '@workbasehq/plugins/organizations'
import { createApp } from '../src/app'
import { resolveActor } from '../src/authorization'
import { sha256 } from '../src/crypto'
import { KernelRegistry } from '../src/kernel/registry'
import { request, runtime, setup } from '@workbasehq/test-support/helpers'

beforeEach(async () => { await setup() })
const paths = [
  ['/auth/sign-in/magic-link', 'POST', { email: 'owner.a@example.test' }],
  ['/auth/magic-link/verify?token=invalid', 'GET', undefined],
  ['/me', 'GET', undefined], ['/orgs', 'POST', { name: 'Bypass' }],
  ['/invitations/accept', 'POST', { token: 'a'.repeat(64) }],
  ['/bootstrap', 'GET', undefined], ['/o/org-a/bootstrap', 'GET', undefined],
] as const
async function invitation() {
  await env.DB.prepare('INSERT INTO invitations (id,organization_id,email,role,token_hash,expires_at,inviter_id,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .bind('composition-invite', 'org-a', 'owner.a@example.test', 'viewer', await sha256('a'.repeat(64)), new Date(Date.now() + 86400000).toISOString(), 'owner-a', new Date().toISOString()).run()
}
it.each(paths)('F1 absent login denies %s without minting a session', async (path, method, body) => {
  await invitation()
  const app = createApp({ ...sample, interactive: false, plugins: [] }, runtime())
  const sessions = await env.DB.prepare('SELECT count(*) n FROM "session"').first('n')
  const response = await request(app, path, method, body)
  expect(response.status).toBe(path.includes('bootstrap') ? 401 : 404)
  expect(response.headers.get('set-auth-token')).toBeNull()
  expect(await env.DB.prepare('SELECT count(*) n FROM "session"').first('n')).toBe(sessions)
})
for (const mode of ['no claimant', 'ambiguous claims']) it.each(paths)(`F1 ${mode} denies %s`, async (path, method, body) => {
  await invitation()
  const authenticate = vi.fn(mode === 'no claimant' ? () => null : localAuth.authenticate!)
  const login = { ...localAuth, authenticate }
  const plugins = mode === 'no claimant' ? [identity, login, rbac, organizations, members] : [identity, login, { name: 'second-login', version: '1', provides: { login: '1.x' as const }, requires: { identity: '^1' as const }, authenticate: localAuth.authenticate }, rbac, organizations, members]
  const app = createApp({ ...sample, plugins }, runtime())
  const response = await request(app, path, method, body)
  expect(await response.json()).toEqual({ error: mode === 'no claimant' ? 'unauthenticated' : 'ambiguous_login' })
  expect(response.status).toBe(401)
  expect(authenticate).toHaveBeenCalled()
  expect(await env.DB.prepare("SELECT count(*) n FROM organizations WHERE name='Bypass'").first('n')).toBe(0)
  expect(await env.DB.prepare('SELECT accepted_at FROM invitations WHERE id=?').bind('composition-invite').first('accepted_at')).toBeNull()
})
it('F1 a custom login provider does not install the bundled session endpoints', async () => {
  const custom = { name: 'custom-login', version: '1', provides: { login: '1.x' as const }, requires: { identity: '^1' as const }, authenticate: () => null }
  const app = createApp({ ...sample, plugins: [identity, custom] }, runtime())
  expect((await request(app, '/auth/sign-in/magic-link', 'POST', { email: 'owner.a@example.test' })).status).toBe(404)
})

it('F1 absent login cannot consume a live verification link or mint an anonymous invitation session', async () => {
  await invitation()
  const installed = createApp(sample, runtime())
  const sent = await installed.request('http://localhost/auth/sign-in/magic-link', { method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner.a@example.test' }) })
  expect(sent.status).toBe(200)
  const url = await env.DB.prepare("SELECT body FROM email_outbox WHERE subject='Workbase sign-in' ORDER BY rowid DESC LIMIT 1").first<string>('body')
  const absent = createApp({ ...sample, plugins: [], interactive: false }, runtime())
  const response = await absent.request(url!)
  expect(response.status).toBe(404)
  expect(response.headers.get('set-auth-token')).toBeNull()
  const accepted = await absent.request('http://localhost/invitations/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'a'.repeat(64) }) })
  expect(accepted.status).toBe(404)
  expect(await env.DB.prepare('SELECT count(*) n FROM "session"').first('n')).toBe(0)
})

it('F1 permits login recovery with an expired cookie while preserving no-claimant denial', async () => {
  const headers = { Origin: 'http://localhost', 'Content-Type': 'application/json', Cookie: '__Host-workbase.session=expired', 'Sec-Fetch-Site': 'same-origin' }
  const body = JSON.stringify({ email: 'owner.a@example.test' })
  const installed = createApp(sample, runtime())
  expect((await installed.request('http://localhost/auth/sign-in/magic-link', { method: 'POST', headers, body })).status).toBe(200)
  const noClaimant = createApp({ ...sample, plugins: [identity, { ...localAuth, authenticate: () => null }] }, runtime())
  expect((await noClaimant.request('http://localhost/auth/sign-in/magic-link', { method: 'POST', headers, body })).status).toBe(401)
})

it('G2 a second login provider can claim alone after identity abstains without credentials', async () => {
  const actor = await resolveActor(new Request('http://localhost', { headers: { Authorization: 'Bearer synthetic-owner-a' } }), runtime(), new KernelRegistry(sample).config)
  const authenticate = vi.fn(() => actor)
  const second = { name: 'second-login', version: '1', provides: { login: '1.x' as const }, requires: { identity: '^1' as const }, authenticate }
  const kernel = new KernelRegistry({ ...sample, plugins: [localAuth, second, identity] })
  expect(kernel.plugins.map(plugin => plugin.name)).toEqual(['identity', 'local-auth', 'second-login'])
  expect(await kernel.requireActor(new Request('http://localhost'), runtime())).toBe(actor)
  expect(authenticate).toHaveBeenCalledOnce()
  await expect(kernel.requireActor(new Request('http://localhost', { headers: { Authorization: 'Bearer synthetic-owner-a' } }), runtime())).rejects.toMatchObject({ status: 401, code: 'ambiguous_login' })
  const unclaimed = new KernelRegistry({ ...sample, plugins: [identity, localAuth, { ...second, authenticate: () => null }] })
  await expect(unclaimed.requireActor(new Request('http://localhost'), runtime())).rejects.toMatchObject({ status: 401, code: 'unauthenticated' })
})

it.each<Record<string, string>>([{ Authorization: 'Bearer invalid' }, { Authorization: '' }, { Cookie: '__Host-workbase.session=invalid' }])('G2 present invalid credentials deny before a second provider can claim: %j', async headers => {
  const authenticate = vi.fn(() => null)
  const second = { name: 'second-login', version: '1', provides: { login: '1.x' as const }, requires: { identity: '^1' as const }, authenticate }
  const kernel = new KernelRegistry({ ...sample, plugins: [localAuth, second, identity] })
  await expect(kernel.requireActor(new Request('http://localhost', { headers }), runtime())).rejects.toMatchObject({ status: 401, code: 'unauthenticated' })
  expect(authenticate).not.toHaveBeenCalled()
})

it('G4 identity without a login contract does not mount organization or invitation routes', async () => {
  await invitation()
  const app = createApp({ ...sample, interactive: false, plugins: [{ ...identity, provides: { identity: '1.x' }, authenticate: undefined }] }, runtime())
  for (const [path, method, body] of [['/me', 'GET', undefined], ['/orgs', 'POST', { name: 'Unreachable' }], ['/invitations/accept', 'GET', undefined], ['/invitations/accept', 'POST', { token: 'a'.repeat(64) }]] as const) {
    const response = await request(app, path, method, body)
    expect(response.status).toBe(404)
    expect(response.headers.get('set-auth-token')).toBeNull()
  }
  expect(await env.DB.prepare('SELECT accepted_at FROM invitations WHERE id=?').bind('composition-invite').first('accepted_at')).toBeNull()
})
