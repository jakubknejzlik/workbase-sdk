import { beforeEach, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import sample from './fixtures/sample/config'
import { KernelRegistry } from '../src/kernel/registry'
import { requireVerifiedSession } from '../src/authorization'
import { createIdentityAuth } from '../../plugins/local-auth/src/better-auth'
import { recordExternalRegistration } from '../../plugins/identity/src/registration'
import { runtime, setup } from '@workbasehq/test-support/helpers'

beforeEach(async () => { await setup() })
const external = { provider: 'oidc', issuer: 'https://idp.example.test', subject: 'new-subject', email: 'owner.a@example.test', emailVerified: true }

it('local-auth verified sessions do not supply providerVerified authority', async () => {
  const kernel = new KernelRegistry(sample)
  const actor = await kernel.requireActor(new Request('http://localhost', { headers: { Authorization: 'Bearer synthetic-owner-a' } }), runtime())
  expect(await requireVerifiedSession(actor, env.DB)).toBe(false)
})
it('account create.after rejects an existing user without local confirmation', async () => {
  const kernel = new KernelRegistry({ ...sample, pluginConfig: { ...sample.pluginConfig,
    identity: { trustedIssuers: { [external.issuer]: ['example.test'] } },
  } })
  const environment = { ...runtime(), IDENTITY: { ...runtime().IDENTITY, oidc: { issuer: external.issuer, clientId: 'test-client', clientSecret: 'test-secret' } } }
  const auth = createIdentityAuth(environment, kernel.config, false, false)
  const after = auth.options.databaseHooks!.account!.create!.after!
  const now = new Date()
  await expect(after({ id: 'new-account', userId: 'owner-a', providerId: 'oidc', issuer: external.issuer, accountId: external.subject, createdAt: now, updatedAt: now })).rejects.toMatchObject({ status: 403, code: 'identity_link_not_allowed' })
  expect(await env.DB.prepare('SELECT count(*) n FROM identities WHERE issuer=?').bind(external.issuer).first('n')).toBe(0)
})
it('recordExternalRegistration rejects a user who already has a session atomically', async () => {
  const kernel = new KernelRegistry(sample)
  // Leave no mapping so that only the existing-session guard can reject this write.
  await env.DB.prepare("DELETE FROM identities WHERE user_id='owner-a'").run()
  await env.DB.prepare('INSERT INTO "session" (id,token,"userId","expiresAt","createdAt","updatedAt") VALUES (?,?,?,?,?,?)')
    .bind('existing-session', 'existing-token', 'owner-a', '2099-01-01', '2026-01-01', '2026-01-01').run()
  const events = await env.DB.prepare('SELECT count(*) n FROM audit_outbox').first('n')
  await expect(recordExternalRegistration(runtime(), kernel.config, 'owner-a', external)).rejects.toMatchObject({ status: 409, code: 'rule_failed' })
  expect(await env.DB.prepare("SELECT count(*) n FROM identities WHERE user_id='owner-a'").first('n')).toBe(0)
  expect(await env.DB.prepare('SELECT count(*) n FROM audit_outbox').first('n')).toBe(events)
})
