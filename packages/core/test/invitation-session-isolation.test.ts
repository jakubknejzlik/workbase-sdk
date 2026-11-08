import { expect, it } from 'vitest'
import { setup, request, json } from '@workbasehq/test-support/helpers'

it('inviter_visible_invitation_must_not_authenticate_as_recipient', async () => {
  const app = await setup()
  const invitationResponse = await request(app, '/orgs/org-a/invitations', 'POST', { email: 'owner.b@example.test', role: 'viewer' }, 'dispatcher-a')
  expect(invitationResponse.status).toBe(201)
  const invitation = await json(invitationResponse)
  const resolution = await app.request('http://localhost/invitations/resolve', {
    method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: new URL(invitation.accept_url).searchParams.get('token') }),
  })
  const credential = resolution.headers.get('set-auth-token')
  let identity: any = null
  if (credential) {
    identity = await json(await app.request('http://localhost/me', { headers: { Authorization: `Bearer ${credential}` } }))
  }
  console.log('AUDIT_INVITATION_SESSION', JSON.stringify({ inviter: 'dispatcher-a', invitationStatus: invitationResponse.status, resolveStatus: resolution.status, recipientSessionIssued: !!credential, principal: identity?.user?.id, memberships: identity?.memberships }))
  expect(credential, 'An inviter-visible link must not create a global recipient session').toBeNull()
})
