import { beforeEach, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import sample from './fixtures/sample/config'
import { createApp } from '../src/app'
import { identity } from '@workbasehq/plugins/identity'
import { localAuth } from '@workbasehq/plugins/local-auth'
import { legacyPermissions as rbac } from '@workbasehq/plugins/permissions'
import { members } from '@workbasehq/plugins/members'
import { organizations } from '@workbasehq/plugins/organizations'
import { ApiError } from '../src/errors'
import { sha256 } from '../src/crypto'
import { runtime, setup } from '@workbasehq/test-support/helpers'
import { invitationMailToken } from '../../plugins/members/src/invitation-token'

beforeEach(async () => { await setup() })
it.each(['null', 'throw', 'ambiguous'] as const)('K3 denied verification revokes only its provisional session: %s', async mode => {
  const installed = createApp(sample, runtime())
  const send = () => installed.request('http://localhost/auth/sign-in/magic-link', { method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner.a@example.test' }) })
  const link = () => env.DB.prepare('SELECT body FROM email_outbox ORDER BY rowid DESC LIMIT 1').first<string>('body')
  expect((await send()).status).toBe(200)
  expect((await installed.request((await link())!)).status).toBe(302)
  expect((await send()).status).toBe(200)
  const denied = { ...localAuth, authenticate: mode === 'ambiguous' ? localAuth.authenticate : () => { if (mode === 'throw') throw new ApiError(401, 'unauthenticated'); return null } }
  const app = createApp({ ...sample, plugins: [identity, denied, ...(mode === 'ambiguous' ? [{ ...localAuth, name: 'second-login', provides: { login: '1.x' as const }, requires: { identity: '^1' as const }, routes: undefined }] : []), rbac, members, organizations] }, runtime())
  const before = await env.DB.prepare('SELECT id,token FROM "session" ORDER BY id').all()
  const response = await app.request((await link())!)
  expect(response.status).toBe(401)
  expect(await response.json()).toEqual({ error: mode === 'ambiguous' ? 'ambiguous_login' : 'unauthenticated' })
  expect(response.headers.get('set-auth-token')).toBeNull()
  expect(response.headers.getSetCookie()).toEqual([])
  expect((await env.DB.prepare('SELECT id,token FROM "session" ORDER BY id').all()).results).toEqual(before.results)
})
it('K3 denied invitation authentication revokes the provisional session', async () => {
  await env.DB.prepare('INSERT INTO invitations (id,organization_id,email,role,token_hash,expires_at,inviter_id,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .bind('denied-invite', 'org-b', 'denied@example.test', 'viewer', await sha256('a'.repeat(64)), new Date(Date.now() + 86400000).toISOString(), 'owner-b', new Date().toISOString()).run()
  const app = createApp({ ...sample, plugins: [identity, { ...localAuth, authenticate: () => null }, rbac, members, organizations] }, runtime())
  const sessions = await env.DB.prepare('SELECT count(*) n FROM "session"').first('n')
  const response = await app.request('http://localhost/invitations/accept', { method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: await invitationMailToken(runtime(), 'a'.repeat(64)) }) })
  expect(response.status).toBe(401)
  expect(response.headers.get('set-auth-token')).toBeNull()
  expect(response.headers.getSetCookie()).toEqual([])
  expect(await env.DB.prepare('SELECT accepted_at FROM invitations').first('accepted_at')).toBeNull()
  expect(await env.DB.prepare('SELECT count(*) n FROM "session"').first('n')).toBe(sessions)
})
