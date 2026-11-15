import { beforeEach, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:workers'
import { createApp } from '@workbasehq/core/app'
import { defineInstance } from '@workbasehq/core/config'
import { D1AtomicStore } from '@workbasehq/core/execution/d1'
import { KernelRegistry } from '@workbasehq/core/kernel/registry'
import { runtime, setup, json } from '@workbasehq/test-support/helpers'
import sample from '../../../core/test/fixtures/sample/config'
import accounts from '../../../core/test/fixtures/accounts/config'

const config = defineInstance({ ...sample, plugins: sample.plugins!.filter(plugin => !plugin.provides?.organizations) })
const opsToken = 'synthetic-instance-bootstrap-ops'
let app: ReturnType<typeof createApp>
beforeEach(async () => {
  await setup(config, async () => {})
  app = createApp(config, { ...runtime(), OPS_TOKEN: opsToken, IDENTITY: { ...runtime().IDENTITY, localPassword: false } })
})
const bootstrap = (ownerEmail = 'first@example.test', token: string | null = opsToken, extra = {}) => app.request('http://localhost/internal/members/instance-owner', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(token === null ? {} : { 'X-Internal-Token': token }) },
  body: JSON.stringify({ ownerEmail, ...extra }),
})
async function login(email = 'first@example.test') {
  expect((await app.request('http://localhost/auth/sign-in/magic-link', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
    body: JSON.stringify({ email, callbackURL: '/me' }),
  })).status).toBe(200)
  const url = await env.DB.prepare('SELECT body FROM email_outbox WHERE recipient=? ORDER BY rowid DESC LIMIT 1').bind(email).first<string>('body')
  const response = await app.request(url!)
  expect(response.status).toBe(302)
  const bearer = response.headers.get('set-auth-token')!
  expect(bearer).toBeTruthy()
  return (path: string) => app.request(`http://localhost${path}`, { headers: { Authorization: `Bearer ${bearer}`, 'X-Organization-Id': 'instance' } })
}
async function counts() {
  const tables = ['organizations', 'users', 'memberships', 'audit_outbox', 'email_outbox', 'access_tokens', 'invitations', 'idempotency_keys', 'atomic_assert']
  return Object.fromEntries(await Promise.all(tables.map(async table => [table, await env.DB.prepare(`SELECT count(*) n FROM ${table}`).first('n')])))
}

it('bootstraps a fresh Members-only instance after magic-link login, unlocking scoped API access', async () => {
  expect(await env.DB.prepare('SELECT count(*) n FROM "user"').first('n')).toBe(0)
  expect(await env.DB.prepare('SELECT count(*) n FROM memberships').first('n')).toBe(0)
  const send = await login()
  expect(await json(await send('/me'))).toMatchObject({ organizationsEnabled: false, memberships: [] })
  const forbidden = await send('/api/workers')
  expect(forbidden.status).toBe(403)
  expect(await json(forbidden)).toEqual({ error: 'organization_forbidden' })
  expect((await app.request('http://localhost/internal/organizations', { method: 'POST', headers: { 'X-Internal-Token': opsToken } })).status).toBe(404)
  const response = await bootstrap()
  expect(response.status).toBe(201)
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  const result = await json(response)
  const me = await json(await send('/me'))
  expect(result).toEqual({ organization_id: 'instance', user_id: me.user.id, role: 'owner', replayed: false })
  expect(me.memberships).toEqual([{ organization_id: 'instance', name: 'Instance', role: 'owner' }])
  expect((await send('/api/workers')).status).toBe(200)
  expect(await env.DB.prepare('SELECT user_id,scope_id,role FROM memberships').first()).toEqual({ user_id: me.user.id, scope_id: 'instance', role: 'owner' })
  const event = JSON.parse((await env.DB.prepare("SELECT payload FROM audit_outbox WHERE payload LIKE '%membership.bootstrapped%'").first<string>('payload'))!)
  expect(event).toMatchObject({ operation: 'membership.bootstrapped', organization_id: 'instance', actor: { type: 'service' } })
  const before = await counts()
  expect((await bootstrap('FIRST@example.test')).status).toBe(200)
  expect(await json(await bootstrap())).toEqual({ ...result, replayed: true })
  expect(await counts()).toEqual(before)
})

it('requires the shared operator credential and rejects request authority overrides', async () => {
  await login()
  const before = await counts()
  for (const token of [null, 'wrong', runtime().INTERNAL_TOKEN]) {
    const response = await bootstrap(undefined, token)
    expect(response.status).toBe(403)
    expect(await json(response)).toEqual({ error: 'internal_token_required' })
  }
  for (const extra of [{ role: 'owner' }, { scope: 'other' }, { organization_id: 'other' }]) expect((await bootstrap(undefined, undefined, extra)).status).toBe(400)
  app = createApp(config, { ...runtime(), INTERNAL_TOKEN: undefined })
  const response = await bootstrap()
  expect(response.status).toBe(503)
  expect(await json(response)).toEqual({ error: 'internal_token_not_configured' })
  expect(await counts()).toEqual(before)
})

it('requires an existing verified identity', async () => {
  await login('unverified@example.test')
  await env.DB.prepare('UPDATE "user" SET "emailVerified"=0').run()
  const before = await counts()
  for (const email of ['missing@example.test', 'unverified@example.test']) {
    const response = await bootstrap(email)
    expect(response.status).toBe(409)
    expect(await json(response)).toEqual({ error: 'owner_sign_in_required' })
  }
  expect(await counts()).toEqual(before)
})

it('supports the legacy internal token when no dedicated ops token is configured', async () => {
  await login()
  app = createApp(config, runtime())
  expect((await bootstrap(undefined, runtime().INTERNAL_TOKEN)).status).toBe(201)
})

it.each([false, true])('uses the configured owner role and provisions the domain account atomically (insertion fails=%s)', async fail => {
  const singleAccount = defineInstance({ ...accounts, plugins: accounts.plugins!.filter(plugin => !plugin.provides?.organizations) })
  await setup(singleAccount, async () => {})
  app = createApp(singleAccount, { ...runtime(), OPS_TOKEN: opsToken })
  const send = await login()
  expect(await env.DB.prepare('SELECT count(*) n FROM users').first('n')).toBe(0)
  if (fail) await env.DB.exec('CREATE TRIGGER skip_membership BEFORE INSERT ON memberships BEGIN SELECT RAISE(IGNORE); END;')
  const before = await counts()
  const response = await bootstrap()
  expect(response.status).toBe(fail ? 409 : 201)
  if (fail) expect(await counts()).toEqual(before)
  else {
    const result = await json(response)
    expect(result).toMatchObject({ organization_id: 'instance', role: 'administrator' })
    expect(await env.DB.prepare('SELECT id,organization_id FROM users').first()).toEqual({ id: result.user_id, organization_id: 'instance' })
    expect(await json(await send('/me'))).toMatchObject({ memberships: [{ organization_id: 'instance', role: 'administrator' }] })
  }
})

it('refuses a second owner, including an owner that predates bootstrap', async () => {
  await login()
  await login('second@example.test')
  expect((await bootstrap()).status).toBe(201)
  const before = await counts()
  const response = await bootstrap('second@example.test')
  expect(response.status).toBe(409)
  expect(await json(response)).toEqual({ error: 'instance_owner_exists' })
  expect(await counts()).toEqual(before)
  await env.DB.prepare('DELETE FROM idempotency_keys').run()
  expect(await json(await bootstrap())).toEqual({ error: 'instance_owner_exists' })
})

it('replays the receipt after ownership changes without restoring grants', async () => {
  await login()
  const result = await json(await bootstrap())
  await env.DB.prepare("UPDATE memberships SET role='viewer'").run()
  const before = await counts()
  expect(await json(await bootstrap())).toEqual({ ...result, replayed: true })
  expect(await env.DB.prepare('SELECT role FROM memberships').first('role')).toBe('viewer')
  expect(await counts()).toEqual(before)
})

it('refuses an existing non-owner membership without changing its role', async () => {
  const send = await login()
  const { user } = await json(await send('/me'))
  await env.DB.prepare("INSERT INTO memberships (user_id,organization_id,role) VALUES (?,'instance','viewer')").bind(user.id).run()
  const before = await counts()
  expect(await json(await bootstrap())).toEqual({ error: 'membership_conflict' })
  expect(await env.DB.prepare('SELECT role FROM memberships').first('role')).toBe('viewer')
  expect(await counts()).toEqual(before)
})

it('converges concurrent retries atomically', async () => {
  await login()
  const responses = await Promise.all([bootstrap(), bootstrap()])
  expect(responses.map(response => response.status).sort()).toEqual([200, 201])
  expect(await counts()).toMatchObject({ organizations: 1, memberships: 1, idempotency_keys: 1, atomic_assert: 0 })
  expect(await env.DB.prepare("SELECT count(*) n FROM audit_outbox WHERE payload LIKE '%membership.bootstrapped%'").first('n')).toBe(1)
})

it('allows only one of two competing first owners', async () => {
  await login()
  await login('second@example.test')
  const responses = await Promise.all([bootstrap(), bootstrap('second@example.test')])
  expect(responses.map(response => response.status).sort()).toEqual([201, 409])
  expect(await counts()).toMatchObject({ memberships: 1, idempotency_keys: 1, atomic_assert: 0 })
})

it('rolls back the membership and receipt when insertion fails', async () => {
  await login()
  await env.DB.exec('CREATE TRIGGER skip_membership BEFORE INSERT ON memberships BEGIN SELECT RAISE(IGNORE); END;')
  const before = await counts()
  const response = await bootstrap()
  expect(response.status).toBe(409)
  expect(await json(response)).toEqual({ error: 'membership_conflict' })
  expect(await counts()).toEqual(before)
})

it('rechecks owner verification inside the atomic write', async () => {
  await login()
  const before = await counts()
  const run = D1AtomicStore.prototype.run
  const commit = vi.spyOn(D1AtomicStore.prototype, 'run').mockImplementation(async function (this: D1AtomicStore, plan) {
    if (plan.rules.some(rule => rule.name === 'instance_owner_bootstrap')) await env.DB.prepare('UPDATE "user" SET "emailVerified"=0').run()
    return run.call(this, plan)
  })
  try {
    const response = await bootstrap()
    expect(response.status).toBe(409)
    expect(await json(response)).toEqual({ error: 'owner_sign_in_required' })
    expect(await counts()).toEqual(before)
  } finally { commit.mockRestore() }
})

it('does not mount the bootstrap when Organizations is installed or Members is absent', async () => {
  for (const plugins of [sample.plugins!, config.plugins!.filter(plugin => ['identity', 'local-auth', 'rbac', 'permissions', 'mail-outbox'].includes(plugin.name))]) {
    app = createApp(defineInstance({ ...sample, plugins }), { ...runtime(), OPS_TOKEN: opsToken })
    expect((await bootstrap()).status).toBe(404)
  }
})

it('restricts the bootstrap system permission to service actors even in trust mode', () => {
  const scope = { actor: { type: 'service' as const, id: 'test-service' }, organizationId: 'instance', role: '', correlationId: 'test-bootstrap' }
  const command = { name: 'members/bootstrap', kind: 'command' as const, permission: { system: 'members.bootstrap' as const } }
  for (const kernel of [new KernelRegistry(config), new KernelRegistry(config, { authorization: 'trust' })]) {
    expect(() => kernel.commandGuard(command, scope, undefined)).not.toThrow()
    for (const actor of [{ type: 'user' as const, id: 'first' }, { type: 'agent' as const, id: 'agent' }]) {
      expect(() => kernel.commandGuard(command, { ...scope, actor, role: 'owner' }, undefined)).toThrow(expect.objectContaining({ status: 403 }))
    }
    expect(() => kernel.permission(scope, 'workers', 'create')).toThrow(expect.objectContaining({ status: 403 }))
  }
})
