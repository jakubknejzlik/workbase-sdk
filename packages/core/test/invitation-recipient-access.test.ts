import { expect, it } from 'vitest'
import { setup, request, insertDomain } from '@workbasehq/test-support/helpers'

it('inviter_cannot_exchange_invitation_for_recipient_session_or_other_org_access', async () => {
  const app = await setup()
  await insertDomain('org-b')
  const invite = await request(app, '/orgs/org-a/invitations', 'POST', { email: 'owner.b@example.test', role: 'viewer' }, 'dispatcher-a')
  const body = await invite.json() as { accept_url: string }
  expect(invite.status).toBe(201)
  const token = new URL(body.accept_url).searchParams.get('token')!
  // No mailbox access, victim cookie, recipient interaction, or invitation acceptance.
  const resolve = await app.request('http://localhost/invitations/resolve', { method: 'POST',
    headers: { Origin: 'http://localhost', 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.180' }, body: JSON.stringify({ token }) })
  const bearer = resolve.headers.get('set-auth-token')
  const me = await app.request('http://localhost/me', { headers: { Authorization: `Bearer ${bearer}` } })
  const identity = await me.json() as any
  const read = await app.request('http://localhost/api/clients', { headers: { Authorization: `Bearer ${bearer}`, 'X-Organization-Id': 'org-b' } })
  const rows = await read.json() as any
  console.log('AUTHN_INVITATION_TAKEOVER', JSON.stringify({ attacker: 'dispatcher-a', attackerOrg: 'org-a', inviteStatus: invite.status, resolveStatus: resolve.status, victimSessionIssued: Boolean(bearer), authenticatedUser: identity.user?.id, victimOrgReadStatus: read.status, victimRowIds: rows.data?.map((row: any) => row.id) }))
  expect(bearer, 'An invitation disclosed to its inviter cannot prove recipient mailbox ownership').toBeNull()
  expect(read.status).not.toBe(200)
})
