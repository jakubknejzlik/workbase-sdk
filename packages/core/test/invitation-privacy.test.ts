import { env } from 'cloudflare:workers'
import { beforeEach, expect, it, vi } from 'vitest'
import sample from './fixtures/sample/config'
import { createApp } from '../src/app'
import { KernelRegistry } from '../src/kernel/registry'
import type { PluginContext } from '../src/kernel/plugin'
import { localAuth } from '@workbasehq/plugins/local-auth'
import { setup, runtime, request, json } from '@workbasehq/test-support/helpers'

// Ported from the independent #176 review's raw HTTP privacy probe.
let app: ReturnType<typeof createApp>
const send = vi.fn().mockResolvedValue(undefined)
beforeEach(async () => {
  send.mockClear()
  await setup()
  app = createApp(sample, { ...runtime(), EMAIL: { send }, EMAIL_FROM: 'noreply@example.test' })
})
async function invite(email = 'owner.b@example.test') {
  const response = await request(app, '/orgs/org-a/invitations', 'POST', { email, role: 'viewer' })
  expect(response.status).toBe(201)
  const row = await json(response)
  const link = send.mock.calls.at(-1)![0].text.match(/https?:\/\/[^\s]+\/invitations\/accept\?token=[a-f0-9]+\.[a-f0-9]+/)![0]
  return { id: row.id as string, copied: new URL(row.accept_url).searchParams.get('token')!, proof: new URL(link).searchParams.get('token')! }
}
function anonymous(path: string, body?: unknown) {
  return app.request(`http://localhost${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
function session(path: string, bearer: string, body?: unknown) {
  return app.request(`http://localhost${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${bearer}`, Origin: 'http://localhost', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
const selectorPaths = ['/invitations/preflight', '/invitations/resolve', '/invitations/accept', '/auth/register', '/invitations/decline']
const terminals = ['expired', 'revoked', 'declined', 'accepted'] as const
async function setState(id: string, state: 'pending' | typeof terminals[number]) {
  await env.DB.prepare('UPDATE invitations SET expires_at=?,expired_at=NULL,revoked_at=?,declined_at=?,accepted_at=?,accepted_user_id=? WHERE id=?')
    .bind(state === 'expired' ? '2000-01-01T00:00:00.000Z' : '2099-01-01T00:00:00.000Z',
      state === 'revoked' ? 'now' : null, state === 'declined' ? 'now' : null,
      state === 'accepted' ? 'now' : null, state === 'accepted' ? 'owner-b' : null, id).run()
}
async function privateResponse(response: Response) {
  expect(response.headers.get('Cache-Control')).toContain('no-store')
  expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
  expect(response.headers.get('set-auth-token')).toBeNull()
  expect(response.headers.getSetCookie()).toEqual([])
  expect(response.headers.get('Location')).toBeNull()
  return { status: response.status, body: await json(response) }
}

it.each(terminals)('%s is indistinguishable from pending to non-recipients on every entry route', async terminal => {
  const a = await invite()
  // Exercise a real verified session as well as unsigned copied/delivery selectors.
  const other = await invite('privacy-other@example.test')
  const login = await anonymous('/invitations/resolve', { token: other.proof })
  expect(login.status).toBe(200)
  const bearer = login.headers.get('set-auth-token')!
  expect(bearer).toBeTruthy()
  const baseline = new Map<string, Awaited<ReturnType<typeof privateResponse>>>()
  for (const state of ['pending', terminal] as const) {
    await setState(a.id, state)
    for (const [purpose, token] of [['copied', a.copied], ['stripped-delivery', a.proof.split('.')[0]]] as const) {
      for (const actor of ['anonymous', 'other'] as const) for (const path of selectorPaths) {
        const response = await privateResponse(await (actor === 'anonymous'
          ? anonymous(path, { token }) : session(path, bearer, { token })))
        const expected = path.endsWith('preflight')
          ? { status: 200, body: { id: a.id, account_match: actor === 'anonymous' ? null : false } }
          : { status: actor === 'anonymous' ? 401 : 403, body: { error: actor === 'anonymous' ? 'unauthenticated' : 'invitation_not_for_this_account' } }
        const key = `${purpose} ${actor} ${path}`
        expect(response, `${state} ${key}`).toEqual(expected)
        if (state === 'pending') baseline.set(key, response)
        else expect(response, key).toEqual(baseline.get(key))
      }
    }
    for (const actor of ['anonymous', 'other'] as const) for (const action of ['preview', 'resolve', 'accept', 'decline']) {
      const path = `/invitations/${a.id}/${action}`
      const body = action === 'preview' ? undefined : {}
      const response = await privateResponse(await (actor === 'anonymous' ? anonymous(path, body) : session(path, bearer, body)))
      const key = `${actor} ${action}`
      expect(response, `${state} ${key}`).toEqual({ status: actor === 'anonymous' ? 401 : 404,
        body: { error: actor === 'anonymous' ? 'unauthenticated' : 'invitation_not_found' } })
      if (state === 'pending') baseline.set(key, response)
      else expect(response, key).toEqual(baseline.get(key))
    }
  }
  expect(await env.DB.prepare('SELECT bound_user_id FROM invitations WHERE id=?').bind(a.id).first('bound_user_id')).toBeNull()
})

it.each(terminals)('matching recipients and mailbox proof retain the real %s errors', async terminal => {
  const a = await invite()
  await setState(a.id, terminal)
  const expected = { status: terminal === 'expired' ? 410 : 409,
    body: { error: terminal === 'accepted' ? 'invitation_used' : `invitation_${terminal}` } }
  for (const path of selectorPaths.filter(path => !path.endsWith('preflight'))) {
    // The decline endpoint always requires an existing session.
    if (!path.endsWith('decline')) expect(await privateResponse(await anonymous(path, { token: a.proof }))).toEqual(expected)
    expect(await privateResponse(await request(app, path, 'POST', { token: a.copied }, 'owner-b'))).toEqual(
      terminal === 'accepted' && (path.endsWith('accept') || path === '/auth/register')
        ? { status: 200, body: { id: a.id, state: 'accepted', replayed: true, organization_id: 'org-a', role: 'viewer', entry_target: '/o/org-a' } }
        : expected)
  }
  expect(await privateResponse(await request(app, `/invitations/${a.id}/resolve`, 'POST', {}, 'owner-b'))).toEqual(expected)
  const preview = await request(app, `/invitations/${a.id}/preview`, 'GET', undefined, 'owner-b')
  expect(preview.status).toBe(200)
  expect(await json(preview)).toMatchObject({ account_match: true, state: terminal, next: 'terminal', actions: [] })
  expect(await env.DB.prepare('SELECT count(*) n FROM "session"').first('n')).toBe(0)
})

it.each(['role', 'return target'])('non-recipients cannot diagnose an invalid %s', async diagnostic => {
  const a = await invite()
  if (diagnostic === 'role') await env.DB.prepare('UPDATE invitations SET role=? WHERE id=?').bind('removed-role', a.id).run()
  const extra = diagnostic === 'return target' ? { return_to: 'https://attacker.example' } : {}
  for (const path of selectorPaths.filter(path => !path.endsWith('preflight'))) {
    expect(await privateResponse(await anonymous(path, { token: a.copied, ...extra }))).toEqual({ status: 401, body: { error: 'unauthenticated' } })
    expect(await privateResponse(await request(app, path, 'POST', { token: a.copied, ...extra }, 'viewer-a'))).toEqual({ status: 403, body: { error: 'invitation_not_for_this_account' } })
  }
  const response = await request(app, '/invitations/resolve', 'POST', { token: a.copied, ...extra }, 'owner-b')
  expect(await privateResponse(response)).toEqual({ status: diagnostic === 'role' ? 403 : 400,
    body: { error: diagnostic === 'role' ? 'invalid_invitation_role' : 'invalid_return_target' } })
})

it.each([...terminals, 'role', 'recipient', 'return target'] as const)('login rechecks %s and revokes its session on failure', async change => {
  const a = await invite()
  const wrapped = { ...localAuth, async signInInvitation(this: PluginContext, ...args: Parameters<NonNullable<typeof localAuth.signInInvitation>>) {
    const login = await localAuth.signInInvitation!.apply(this, args)
    if (change === 'role') await env.DB.prepare('UPDATE invitations SET role=? WHERE id=?').bind('removed-role', a.id).run()
    else if (change === 'recipient') {
      // A concurrent recipient change must hide even a concurrent terminal state.
      await env.DB.prepare('UPDATE invitations SET email=?,revoked_at=? WHERE id=?').bind('changed@example.test', 'now', a.id).run()
    } else if (change !== 'return target') await setState(a.id, change)
    return login
  } }
  app = createApp({ ...sample, plugins: sample.plugins!.map(plugin => plugin.name === 'local-auth' ? wrapped : plugin) }, runtime())
  const response = await privateResponse(await anonymous('/invitations/resolve', {
    token: a.proof, ...(change === 'return target' ? { return_to: 'https://attacker.example' } : {}),
  }))
  expect(response).toEqual({ status: change === 'expired' ? 410 : change === 'role' || change === 'recipient' ? 403 : change === 'return target' ? 400 : 409,
    body: { error: change === 'accepted' ? 'invitation_used' : change === 'role' ? 'invalid_invitation_role'
      : change === 'recipient' ? 'invitation_not_for_this_account' : change === 'return target' ? 'invalid_return_target' : `invitation_${change}` } })
  expect(await env.DB.prepare('SELECT count(*) n FROM "session"').first('n')).toBe(0)
  expect(await env.DB.prepare("SELECT count(*) n FROM memberships WHERE user_id='owner-b' AND organization_id='org-a'").first('n')).toBe(0)
})

it('real verified sessions enforce raw field sets and only explicit recipient acceptance creates membership', async () => {
  const a = await invite()
  const other = await invite('privacy-other@example.test')
  const login = await anonymous('/invitations/resolve', { token: other.proof })
  expect(login.status).toBe(200)
  const otherBearer = login.headers.get('set-auth-token')!
  expect(otherBearer).toBeTruthy()
  expect(await json(await session('/invitations/preflight', otherBearer, { token: a.copied }))).toEqual({ id: a.id, account_match: false })
  expect(await privateResponse(await session(`/invitations/${a.id}/preview`, otherBearer))).toEqual({ status: 404, body: { error: 'invitation_not_found' } })
  for (const token of [a.copied, a.proof, a.proof.split('.')[0]]) {
    expect(await privateResponse(await anonymous('/invitations/preflight', { token }))).toEqual({ status: 200, body: { id: a.id, account_match: null } })
  }
  const recipient = await anonymous('/invitations/resolve', { token: a.proof })
  expect(recipient.status).toBe(200)
  const bearer = recipient.headers.get('set-auth-token')!
  expect(bearer).toBeTruthy()
  const memberships = () => env.DB.prepare("SELECT count(*) n FROM memberships WHERE user_id='owner-b' AND organization_id='org-a'").first('n')
  expect(await memberships()).toBe(0)
  const preview = await json(await session(`/invitations/${a.id}/preview`, bearer))
  expect(preview).toMatchObject({ id: a.id, account_match: true, organization: { id: 'org-a', name: 'Organization A' },
    inviter: { display_name: 'owner-a' }, role: 'viewer', state: 'pending', navigation_target: `/invitation?id=${a.id}` })
  expect(JSON.stringify(preview)).not.toMatch(/token|hash|accept_url|email/)
  await env.DB.prepare('UPDATE "user" SET "emailVerified"=0 WHERE id=?').bind('owner-b').run()
  for (const path of [...selectorPaths, ...['preview', 'resolve', 'accept', 'decline'].map(action => `/invitations/${a.id}/${action}`), '/me/invitations']) {
    const body = path.endsWith('/preview') || path === '/me/invitations' ? undefined : path.includes(a.id) ? {} : { token: a.copied }
    expect(await privateResponse(await session(path, bearer, body))).toEqual({ status: 403, body: { error: 'verified_session_required' } })
  }
  await env.DB.prepare('UPDATE "user" SET "emailVerified"=1 WHERE id=?').bind('owner-b').run()
  const kernel = new KernelRegistry(sample)
  await kernel.identity.updateProfile(runtime(), kernel.config, 'owner-b', { firstName: 'Privacy', lastName: 'Recipient' })
  expect(await memberships()).toBe(0)
  expect((await session(`/invitations/${a.id}/accept`, bearer, {})).status).toBe(201)
  expect(await memberships()).toBe(1)
})
