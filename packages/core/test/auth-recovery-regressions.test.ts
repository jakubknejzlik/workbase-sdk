import { beforeEach, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import sample from './fixtures/sample/config'
import { createApp } from '../src/app'
import { sha256 } from '../src/crypto'
import { runtime, setup } from '@workbasehq/test-support/helpers'
import { invitationMailToken } from '../../plugins/members/src/invitation-token'

beforeEach(async () => { await setup() })
it('K2 expired cookie recovers the register invitation alias', async () => {
  await env.DB.prepare('INSERT INTO invitations (id,organization_id,email,role,token_hash,expires_at,inviter_id,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .bind('alias-invite', 'org-b', 'alias@example.test', 'viewer', await sha256('a'.repeat(64)), new Date(Date.now() + 86400000).toISOString(), 'owner-b', new Date().toISOString()).run()
  const response = await createApp(sample, runtime()).request('http://localhost/auth/register', { method: 'POST', headers: { Origin: 'http://localhost', 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', Cookie: '__Host-workbase.session=expired' }, body: JSON.stringify({ token: await invitationMailToken(runtime(), 'a'.repeat(64)) }) })
  expect(response.status).toBe(200)
  expect(response.headers.get('set-auth-token')).toBeTruthy()
})
it('K2 expired cookie can display the OIDC error page without session data', async () => {
  const response = await createApp(sample, runtime()).request('http://localhost/auth/error?error=invalid_state', { headers: { Cookie: '__Host-workbase.session=expired' } })
  expect(response.status).toBe(200)
  expect(response.headers.get('Content-Type')).toContain('text/html')
  expect(await response.text()).toContain('invalid_state')
  expect(response.headers.get('set-auth-token')).toBeNull()
  expect(await env.DB.prepare('SELECT count(*) n FROM "session"').first('n')).toBe(0)
})
