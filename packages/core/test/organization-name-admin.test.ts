import { beforeEach, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { setup, request } from '@workbasehq/test-support/helpers'
import { organizationNameCases } from '../../test-support/src/organization-name-cases'

let app: Awaited<ReturnType<typeof setup>>
let cookie: string
let csrf: string
beforeEach(async () => {
  app = await setup()
  expect((await request(app, '/auth/sign-in/magic-link', 'POST', { email: 'owner.a@example.test', callbackURL: '/admin' })).status).toBe(200)
  const url = await env.DB.prepare("SELECT body FROM email_outbox WHERE recipient='owner.a@example.test' AND subject='Workbase sign-in' ORDER BY rowid DESC LIMIT 1").first<string>('body')
  const verified = await app.request(url!)
  cookie = verified.headers.getSetCookie().find(value => value.startsWith('__Host-workbase.session='))!.split(';')[0]
  const page = await app.request('http://localhost/admin', { headers: { Cookie: cookie } })
  const html = await page.text()
  csrf = /name="_csrf" value="([a-f0-9]+)"/.exec(html)![1]
  expect(html).not.toContain('maxlength="200"') // HTML counts UTF-16, unlike the shared contract.
})

it('Admin form: missing name reports required', async () => {
  const before = (await env.DB.prepare('SELECT id,name FROM organizations ORDER BY id').all()).results
  const response = await app.request('http://localhost/admin', { method: 'POST', headers: {
    Cookie: cookie, Origin: 'http://localhost', 'Content-Type': 'application/x-www-form-urlencoded',
  }, body: new URLSearchParams({ _csrf: csrf }) })
  expect(response.status).toBe(400)
  const html = await response.text()
  expect(html).toContain('Invalid organization name: required.')
  expect(html).toContain('aria-invalid="true" aria-describedby="name-error"')
  expect((await env.DB.prepare('SELECT id,name FROM organizations ORDER BY id').all()).results).toEqual(before)
})

// URLSearchParams converts lone surrogates to U+FFFD before transport. Those two
// cases run through the JSON endpoints, core guards, validator, MCP and Console.
it.each(organizationNameCases.filter(c => !/\p{Cs}/u.test(c.input)))('Admin form: $label', async c => {
  const before = (await env.DB.prepare('SELECT id,name FROM organizations ORDER BY id').all()).results
  const response = await app.request('http://localhost/admin', { method: 'POST', headers: {
    Cookie: cookie, Origin: 'http://localhost', 'Content-Type': 'application/x-www-form-urlencoded',
  }, body: new URLSearchParams({ _csrf: csrf, name: c.input }) })
  if (c.reason) {
    expect(response.status).toBe(400)
    const html = await response.text()
    expect(html).toContain(`Invalid organization name: ${c.reason}.`)
    expect(html).toContain('aria-invalid="true" aria-describedby="name-error"')
    expect((await env.DB.prepare('SELECT id,name FROM organizations ORDER BY id').all()).results).toEqual(before)
  } else {
    expect(response.status).toBe(303)
    const id = decodeURIComponent(response.headers.get('location')!.split('/').at(-1)!)
    expect(await env.DB.prepare('SELECT name FROM organizations WHERE id=?').bind(id).first('name')).toBe(c.value)
  }
})
