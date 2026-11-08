import { expect, it } from 'vitest'
import sample from './fixtures/sample/config'
import { createApp } from '../src/app'
import { setup, runtime, request } from '@workbasehq/test-support/helpers'

it('rejects_cross_site_anonymous_invitation_login', async () => {
  const fixture = await setup()
  // The attacker possesses a legitimate invitation to their own mailbox.
  const invited = await request(fixture, '/orgs/org-a/invitations', 'POST', { email: 'attacker@example.test', role: 'viewer' })
  const invitation = await invited.json() as { accept_url: string }
  const token = new URL(invitation.accept_url).searchParams.get('token')!
  const origin = 'https://workbase.example.test'
  const app = createApp(sample, { ...runtime(), IDENTITY: { ...runtime().IDENTITY, baseURL: origin, localPassword: false } })
  // Browser-compatible text/plain form encoding: name={"token":"...","padding":" value="}
  // A cross-site POST omits the existing SameSite=Lax session cookie.
  const response = await app.request(`${origin}/invitations/resolve`, {
    method: 'POST', headers: { Origin: 'https://attacker.example', 'Content-Type': 'text/plain',
      'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document',
      'CF-Connecting-IP': '192.0.2.178' },
    body: `{"token":"${token}","padding":"="}\r\n`,
  })
  const cookie = response.headers.getSetCookie().find(value => value.startsWith('__Host-workbase.session='))?.split(';')[0]
  const identity = cookie ? await (await app.request(`${origin}/me`, { headers: { Cookie: cookie } })).json() as any : null
  console.log('AUTHN_LOGIN_CSRF', JSON.stringify({ status: response.status, crossSite: true, contentType: 'text/plain', issuedHostSessionCookie: Boolean(cookie), sessionEmail: identity?.user?.email }))
  expect(response.status).toBe(403)
  expect(cookie).toBeUndefined()
})
