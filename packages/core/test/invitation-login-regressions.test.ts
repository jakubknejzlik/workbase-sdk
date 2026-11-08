import { KernelRegistry } from '../src/kernel/registry'
import { beforeEach, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import sample from './fixtures/sample/config'
import { createApp } from '../src/app'
import { identity } from '@workbasehq/plugins/identity'
import { localAuth } from '@workbasehq/plugins/local-auth'
import { legacyPermissions as rbac } from '@workbasehq/plugins/permissions'
import { members } from '@workbasehq/plugins/members'
import { organizations } from '@workbasehq/plugins/organizations'
import { resolveActor } from '../src/authorization'
import { sha256 } from '../src/crypto'
import { runtime, setup } from '@workbasehq/test-support/helpers'
import { invitationMailToken } from '../../plugins/members/src/invitation-token'

beforeEach(async () => { await setup() })
it.each(['single', 'ambiguous', 'anonymous'] as const)('K1 invitation authenticates original custom claims: %s', async mode => {
  const actor = await resolveActor(new Request('http://localhost', { headers: { Authorization: 'Bearer synthetic-owner-a' } }), runtime(), new KernelRegistry(sample).config)
  const second = { name: 'second-login', version: '1', provides: { login: '1.x' as const }, requires: { identity: '^1' as const },
    authenticate: (request: Request) => request.headers.get('X-Second-Login') === 'yes' ? actor : null }
  const app = createApp({ ...sample, plugins: [identity, localAuth, second, ...(mode === 'ambiguous' ? [{ ...second, name: 'third-login' }] : []), rbac, members, organizations] }, runtime())
  await env.DB.prepare('INSERT INTO invitations (id,organization_id,email,role,token_hash,expires_at,inviter_id,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .bind('custom-invite', 'org-b', 'invitee@example.test', 'viewer', await sha256('a'.repeat(64)), new Date(Date.now() + 86400000).toISOString(), 'owner-b', new Date().toISOString()).run()
  const headers = { Origin: 'http://localhost', 'Content-Type': 'application/json', ...(mode === 'anonymous' ? {} : { 'X-Second-Login': 'yes' }) }
  const me = await app.request('http://localhost/me', { headers })
  expect(me.status).toBe(mode === 'single' ? 200 : 401)
  if (mode === 'single') expect(await me.json()).toMatchObject({ user: { id: 'owner-a' } })
  const sessions = await env.DB.prepare('SELECT count(*) n FROM "session"').first<number>('n')
  const response = await app.request('http://localhost/invitations/accept', { method: 'POST', headers, body: JSON.stringify({ token: await invitationMailToken(runtime(), 'a'.repeat(64)) }) })
  expect(response.status).toBe(mode === 'anonymous' ? 200 : mode === 'single' ? 403 : 401)
  if (mode === 'anonymous') {
    expect(response.headers.get('set-auth-token')).toBeTruthy()
    expect(await env.DB.prepare('SELECT accepted_at FROM invitations').first('accepted_at')).toBeNull()
    expect(await response.json()).toMatchObject({ next: 'profile' })
  } else {
    expect(await response.json()).toEqual({ error: mode === 'single' ? 'invitation_not_for_this_account' : 'ambiguous_login' })
    expect(response.headers.get('set-auth-token')).toBeNull()
    expect(response.headers.getSetCookie()).toEqual([])
    expect(await env.DB.prepare('SELECT accepted_at FROM invitations').first('accepted_at')).toBeNull()
    expect(await env.DB.prepare('SELECT count(*) n FROM memberships WHERE organization_id=? AND user_id<>?').bind('org-b', 'owner-b').first('n')).toBe(0)
    expect(await env.DB.prepare('SELECT count(*) n FROM "session"').first('n')).toBe(sessions)
  }
})
