import { completeInvitationProfiles } from '@workbasehq/test-support/helpers'
import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { createApp } from '../src/app'
import sample from './fixtures/sample/config'
import { setup, request, json, runtime } from '@workbasehq/test-support/helpers'

let app: Awaited<ReturnType<typeof setup>>
beforeEach(async () => { app = await setup() })
const count = (table: string) => env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<number>('n')

beforeEach(completeInvitationProfiles)
it('OI organization creation rolls back its first write when the owner membership has zero effects', async () => {
  await env.DB.exec("CREATE TRIGGER skip_membership BEFORE INSERT ON memberships BEGIN SELECT RAISE(IGNORE); END;")
  const before = await count('organizations')
  expect((await request(app, '/orgs', 'POST', { name: 'No partial organization' })).status).toBeGreaterThanOrEqual(400)
  expect(await count('organizations')).toBe(before)
  expect(await count('audit_outbox')).toBe(0)
  expect(await count('atomic_assert')).toBe(0)
})
it('OI invitation creation rolls back its claim when the email intent has zero effects', async () => {
  await env.DB.exec("CREATE TRIGGER skip_mail BEFORE INSERT ON email_outbox BEGIN SELECT RAISE(IGNORE); END;")
  expect((await request(app, '/orgs/org-a/invitations', 'POST', { email: 'owner.b@example.test', role: 'viewer' })).status).toBeGreaterThanOrEqual(400)
  expect(await count('invitations')).toBe(0)
  expect(await count('email_outbox')).toBe(0)
  expect(await count('audit_outbox')).toBe(0)
  expect(await count('atomic_assert')).toBe(0)
})
it('OI invitation acceptance rolls back consumption when the membership has zero effects and permits retry', async () => {
  const invitation = await json(await request(app, '/orgs/org-a/invitations', 'POST', { email: 'owner.b@example.test', role: 'viewer' }))
  const mail = await env.DB.prepare('SELECT body FROM email_outbox').first<string>('body')
  const token = /token=([a-f0-9]{64})/.exec(mail!)![1]
  await env.DB.exec("CREATE TRIGGER skip_membership BEFORE INSERT ON memberships BEGIN SELECT RAISE(IGNORE); END;")
  expect((await request(app, '/invitations/accept', 'POST', { token }, 'owner-b')).status).toBeGreaterThanOrEqual(400)
  expect(await env.DB.prepare('SELECT accepted_at FROM invitations WHERE id=?').bind(invitation.id).first('accepted_at')).toBeNull()
  expect(await env.DB.prepare("SELECT count(*) AS n FROM memberships WHERE user_id='owner-b' AND organization_id='org-a'").first('n')).toBe(0)
  expect(await count('audit_outbox')).toBe(1)
  expect(await count('atomic_assert')).toBe(0)
  await env.DB.exec('DROP TRIGGER skip_membership;')
  expect((await request(app, '/invitations/accept', 'POST', { token }, 'owner-b')).status).toBe(201)
})
it('OI every organization mutation uses one assertion-bearing atomic submission', async () => {
  const submissions: string[][] = []
  const db = new Proxy(env.DB, { get(target, key) {
    if (key === 'batch') return (statements: D1PreparedStatement[]) => {
      // SQL text is observed when prepare is called, without inspecting private D1 fields.
      submissions.push(statements.map(statement => sql.get(statement)!))
      return target.batch(statements)
    }
    if (key === 'prepare') return (query: string) => {
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
        const proxy = new Proxy(statement, { get(prepared, property) {
          if (property === 'bind') return (...values: unknown[]) => wrap(prepared.bind(...values))
          const value = Reflect.get(prepared, property)
          return typeof value === 'function' ? value.bind(prepared) : value
        } })
        sql.set(proxy, query)
        return proxy
      }
      return wrap(target.prepare(query))
    }
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  const sql = new WeakMap<D1PreparedStatement, string>()
  app = createApp(sample, { ...runtime(), DB: db })
  async function mutation(path: string, method: string, body: unknown, status: number, user = 'owner-a') {
    const before = submissions.length
    const response = await request(app, path, method, body, user)
    expect(response.status).toBe(status)
    expect(submissions.length - before).toBe(1)
    const statements = submissions.at(-1)!
    expect(statements.some(query => query.startsWith('INSERT INTO atomic_assert'))).toBe(true)
    expect(statements.at(-1)).toBe('DELETE FROM atomic_assert WHERE run_id=?')
    expect(await count('atomic_assert')).toBe(0)
    return response.status === 204 ? undefined : json(response)
  }
  await mutation('/orgs', 'POST', { name: 'Atomic team' }, 201)
  await mutation('/orgs/org-a/members/viewer-a', 'PATCH', { role: 'dispatcher' }, 200)
  await mutation('/orgs/org-a/members/viewer-a', 'DELETE', undefined, 204)
  await mutation('/orgs/org-a/leave', 'POST', undefined, 204, 'dispatcher-a')
  const revoked = await mutation('/orgs/org-a/invitations', 'POST', { email: 'viewer.a@example.test', role: 'viewer' }, 201)
  await mutation(`/orgs/org-a/invitations/${revoked.id}`, 'DELETE', undefined, 204)
  await mutation('/orgs/org-a/invitations', 'POST', { email: 'owner.b@example.test', role: 'viewer' }, 201)
  const mail = await env.DB.prepare("SELECT body FROM email_outbox WHERE recipient='owner.b@example.test'").first<string>('body')
  await mutation('/invitations/accept', 'POST', { token: /token=([a-f0-9]{64})/.exec(mail!)![1] }, 201, 'owner-b')
  const token = await mutation('/orgs/org-a/tokens', 'POST', { name: 'Atomic token', role: 'viewer' }, 201)
  await mutation(`/orgs/org-a/tokens/${token.id}`, 'DELETE', undefined, 204)
})
