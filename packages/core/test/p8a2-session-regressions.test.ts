import { KernelRegistry } from '../src/kernel/registry'
import { beforeEach, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import sample from './fixtures/sample/config'
import type { PluginContext } from '../src/kernel/plugin'
import { identity } from '@workbasehq/plugins/identity'
import { localAuth } from '@workbasehq/plugins/local-auth'
import { createApp } from '../src/app'
import { resolveActor } from '../src/authorization'
import { sha256 } from '../src/crypto'
import { runtime, setup } from '@workbasehq/test-support/helpers'
import { invitationMailToken } from '../../plugins/members/src/invitation-token'

beforeEach(async () => { await setup() })
async function signIn() {
  const app = createApp(sample, runtime())
  await app.request('http://localhost/auth/sign-in/magic-link', { method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner.a@example.test' }) })
  const url = await env.DB.prepare("SELECT body FROM email_outbox WHERE subject='Workbase sign-in' ORDER BY rowid DESC LIMIT 1").first<string>('body')
  const response = await app.request(url!)
  return response.headers.get('set-auth-token')!
}
it('#46 refresh ambiguity preserves the existing session', async () => {
  const token = await signIn()
  const refresh = { ...localAuth, async authenticate(this: PluginContext, req: Request) {
    const actor = await localAuth.authenticate!.call(this, req, runtime())
    if (req.headers.has('Cookie')) await env.DB.prepare('UPDATE "session" SET "expiresAt"=?').bind(new Date(Date.now() + 2 * 86400000).toISOString()).run()
    return actor
  } }
  const second = { name: 'second', version: '1', provides: { login: '1.x' as const }, requires: { identity: '^1' as const }, authenticate: (req: Request) => req.headers.has('Cookie') ? null : resolveActor(req, runtime(), new KernelRegistry(sample).config) }
  const app = createApp({ ...sample, plugins: [...sample.plugins!.map(plugin => plugin.name === 'local-auth' ? refresh : plugin), second] }, runtime())
  const response = await app.request('http://localhost/auth/get-session', { headers: { Cookie: `__Host-workbase.session=${token}` } })
  expect(response.status).toBe(401)
  expect(await response.json()).toEqual({ error: 'ambiguous_login' })
  expect(await env.DB.prepare('SELECT count(*) n FROM "session"').first('n')).toBe(1)
})
it.each(['already_member', 'invalid_invitation_role'])('#46 failed anonymous accept cleans its provisional session: %s', async mode => {
  const email = mode === 'already_member' ? 'owner.a@example.test' : 'new@example.test'
  // An invalid configured role is still a valid persisted legacy role. Remove
  // its grants from both sources now that top-level tables merge per role.
  const config = mode === 'invalid_invitation_role' ? {
    ...sample,
    plugins: sample.plugins!.map(plugin => plugin.model?.organizationPermissions ? {
      ...plugin, model: { ...plugin.model, organizationPermissions: Object.fromEntries(Object.entries(plugin.model.organizationPermissions).filter(([role]) => role !== 'viewer')) },
    } : plugin),
    pluginConfig: { ...sample.pluginConfig, permissions: { roles: sample.roles.filter(role => role !== 'viewer'), ownerRole: 'owner' } },
    permissions: Object.fromEntries(Object.entries(sample.permissions).filter(([role]) => role !== 'viewer')),
    organizationPermissions: Object.fromEntries(Object.entries(sample.organizationPermissions).filter(([role]) => role !== 'viewer')),
    policies: {},
  } : sample
  await env.DB.prepare('INSERT INTO invitations (id,organization_id,email,role,token_hash,expires_at,inviter_id,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .bind('failed-accept', 'org-a', email, 'viewer', await sha256('a'.repeat(64)), new Date(Date.now() + 86400000).toISOString(), 'owner-a', new Date().toISOString()).run()
  const response = await createApp(config, runtime()).request('http://localhost/invitations/accept', { method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: await invitationMailToken(runtime(), 'a'.repeat(64)) }) })
  expect(response.status).toBe(mode === 'already_member' ? 409 : 403)
  expect(await response.json()).toEqual(mode === 'already_member' ? { error: mode, detail: { organization_id: 'org-a' } } : { error: mode })
  expect(await env.DB.prepare('SELECT count(*) n FROM "session"').first('n')).toBe(0)
})

it('#46 an invitation-used race revokes only the provisional session', async () => {
  await signIn()
  await env.DB.prepare('INSERT INTO invitations (id,organization_id,email,role,token_hash,expires_at,inviter_id,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .bind('raced-accept', 'org-a', 'raced@example.test', 'viewer', await sha256('a'.repeat(64)), new Date(Date.now() + 86400000).toISOString(), 'owner-a', new Date().toISOString()).run()
  await env.DB.prepare(`CREATE TRIGGER consume_invitation AFTER INSERT ON "session" BEGIN
    UPDATE invitations SET accepted_at='2026-01-01' WHERE id='raced-accept';
  END`).run()
  const response = await createApp(sample, runtime()).request('http://localhost/invitations/accept', { method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: await invitationMailToken(runtime(), 'a'.repeat(64)) }) })
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({ error: 'invitation_used' })
  expect(response.headers.get('set-auth-token')).toBeNull()
  expect(response.headers.getSetCookie()).toEqual([])
  expect(await env.DB.prepare('SELECT count(*) n FROM "session"').first('n')).toBe(1)
  expect(await env.DB.prepare('SELECT "userId" FROM "session"').first('userId')).toBe('owner-a')
})
