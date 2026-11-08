import { capabilities } from '../src/capabilities'
import { KernelRegistry } from '../src/kernel/registry'
import { resolveActor, requireScope } from '../src/authorization'
import { validateQuery } from '../src/query/schema'
import { commands, workflows } from './fixtures/policy-graph/commands'
import { beforeEach, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { setup, runtime, policyGraph, roles } from './fixtures/policy-graph/setup'
import { request, json, setup as setupStandard } from '@workbasehq/test-support/helpers'

let app: Awaited<ReturnType<typeof setup>>
beforeEach(async () => { app = await setup() })
const query = (entity: string, extra = {}) => ({ entity, limit: 100, select: ['id'], ...extra })
const ask = (entity: string, role: string, extra = {}) => request(app, '/query', 'POST', query(entity, extra), role)

it.each([...roles, 'unknown'])('capabilities/%s readable-field property agrees with /query', async role => {
  const response = await request(app, '/o/org-a/capabilities', 'GET', undefined, role)
  expect(response.status).toBe(200)
  const body = await json(response)
  expect(body).toMatchObject({ revision: 1, organization: { role } })
  expect(JSON.stringify(body)).not.toMatch(/\$actor|predicate|team-a|SECRET_FILES/)
  const schema = await json(await app.request('http://localhost/schema'))
  for (const [entity, capability] of Object.entries(body.entities) as [string, any][]) {
    expect(capability.readable.every((field: string) => Object.hasOwn(schema.query.entities[entity].fields, field))).toBe(true)
    // Forbidden policies may reject a rowless read; use a known visible row where read is granted.
    for (const field of capability.readable) {
      const selected = await ask(entity, role, { select: ['id', ...field === 'id' ? [] : [field]] })
      const result = await json(selected)
      if (selected.status === 200) expect(result.data.every((row: Record<string, unknown>) => Object.hasOwn(row, field))).toBe(true)
      else { expect(selected.status).toBe(403); expect(result.error).toBe('policy_violation') }
    }
    for (const field of Object.keys(policyGraph.entities[entity].fields).filter(field => !capability.readable.includes(field))) {
      const denied = await ask(entity, role, { select: [field] })
      expect(denied.status).toBe(403); expect((await json(denied)).error).toBe('field_forbidden')
    }
  }
})
it('capabilities requires authentication and uses the path organization selector', async () => {
  expect((await app.request('http://localhost/o/org-a/capabilities')).status).toBe(401)
  expect((await request(app, '/o/org-b/capabilities', 'GET', undefined, 'reviewer')).status).toBe(403)
})
it.each([...roles, 'unknown'])('navigation resource grants agree with the actual read routes for %s', async role => {
  const document = await json(await request(app, '/o/org-a/capabilities', 'GET', undefined, role))
  for (const [grant, path] of [
    ['members.read', '/orgs/org-a/members'], ['invitations.read', '/orgs/org-a/invitations'],
    ['tokens.read', '/orgs/org-a/tokens'], ['workflows.read', '/workflows?status=needs_attention'],
    ['audit.read', '/audit/events?limit=1'],
  ]) {
    const response = await request(app, path, 'GET', undefined, role)
    expect([200, 403]).toContain(response.status)
    expect(document.resources[grant], path).toBe(response.status === 200)
  }
})
it.each(['owner-a', 'dispatcher-a', 'viewer-a'])('navigation grants retain the standard organization and owner gates for %s', async user => {
  const standard = await setupStandard()
  const document = await json(await request(standard, '/o/org-a/capabilities', 'GET', undefined, user))
  for (const [grant, path] of [
    ['members.read', '/orgs/org-a/members'], ['invitations.read', '/orgs/org-a/invitations'],
    ['tokens.read', '/orgs/org-a/tokens'], ['workflows.read', '/workflows?status=needs_attention'],
    ['audit.read', '/audit/events?limit=1'],
  ]) {
    const response = await request(standard, path, 'GET', undefined, user)
    expect([200, 403]).toContain(response.status)
    expect(document.resources[grant], path).toBe(response.status === 200)
  }
  expect(document.resources['members.read']).toBe(true)
  expect(document.resources['audit.read']).toBe(user === 'owner-a')
})
it('anonymous schema advertises policy presence without predicates or actor literals', async () => {
  const response = await app.request('http://localhost/schema'); const text = await response.text()
  expect(JSON.parse(text).policies.reports.coordinator).toBe(true)
  expect(text).not.toMatch(/\$actor|predicate|SECRET_FILES|team-a/)
})

it('capabilities accepts a real Better Auth cookie and Bearer session with identical scope', async () => {
  const sent = await app.request('http://localhost/auth/sign-in/magic-link', { method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'reviewer@example.test', callbackURL: '/me' }) })
  expect(sent.status).toBe(200)
  const link = (await env.DB.prepare("SELECT body FROM email_outbox WHERE recipient='reviewer@example.test'").first<string>('body'))!
  const signedIn = await app.request(link)
  expect(signedIn.status).toBe(302)
  const cookie = signedIn.headers.getSetCookie().find(value => value.startsWith('__Host-workbase.session='))!.split(';')[0]
  const token = signedIn.headers.get('set-auth-token')!
  const cookieResponse = await app.request('http://localhost/o/org-a/capabilities', { headers: { Cookie: cookie } })
  const bearerResponse = await app.request('http://localhost/o/org-a/capabilities', { headers: { Authorization: `Bearer ${token}` } })
  expect(cookieResponse.status).toBe(200); expect(bearerResponse.status).toBe(200)
  expect(await json(cookieResponse)).toEqual(await json(bearerResponse))
  const dashboard = await app.request('http://localhost/admin/o/org-a', { headers: { Cookie: cookie } })
  expect(dashboard.status).toBe(200)
  const html = await dashboard.text()
  expect(html).toContain('reports</a>: 1')
  expect(html).toContain('records</a>: 2')
  expect(html).not.toMatch(/CANARY_(?:ORG|ROW|ACCOUNT)|SECRET_FILES_CANARY/)
})
it.each(roles)('capability command/workflow actions agree with live execution for %s', async role => {
  app = await setup({ commands, workflows })
  const body = await json(await request(app, '/o/org-a/capabilities', 'GET', undefined, role))
  const allowed = ['administrator', 'reviewer', 'team_user'].includes(role)
  expect(body.commands.includes('reports/rename')).toBe(allowed)
  expect(body.workflows['reports/reconcile']).toEqual(allowed ? ['start'] : [])
  expect(body.entities.reports.operations.includes('read')).toBe(allowed)
  const command = await request(app, '/commands/reports/rename', 'POST', { id: 'report-own', name: 'Updated report' }, role)
  expect(command.status).toBe(allowed ? 200 : 403)
  const workflow = await request(app, '/workflows/reports/reconcile', 'POST', { idempotencyKey: `workflow-${role}` }, role)
  expect(workflow.status).toBe(allowed ? 202 : 403)
})
it('a display-field hint is omitted when that actor cannot select the field', async () => {
  const kernel = new KernelRegistry({ ...policyGraph, policies: { ...policyGraph.policies, users: { ...policyGraph.policies.users, reviewer: { where: {}, fields: ['id'] } } } })
  const actor = await resolveActor(new Request('http://localhost', { headers: { Authorization: 'Bearer synthetic-reviewer' } }), runtime(), kernel.config)
  const scope = await requireScope(actor, 'org-a', kernel.config)
  const document = capabilities(kernel, scope)
  expect(document.entities.users.readable).toEqual(['id'])
  expect(document.entities.users.displayField).toBeUndefined()
  expect(() => validateQuery(kernel, scope, query('users', { select: ['name'] }))).toThrowError(expect.objectContaining({ code: 'field_forbidden' }))
})

it('P6 membership management grants use the same live organization policy for administrators and ordinary members', async () => {
  const standard = await setupStandard()
  for (const role of ['owner-a', 'viewer-a']) {
    const document = await json(await request(standard, '/o/org-a/capabilities', 'GET', undefined, role))
    expect(document.resources['members.read']).toBe(true); expect(document.resources['invitations.read']).toBe(true)
    for (const action of ['members.update', 'members.remove', 'invitations.create', 'invitations.revoke']) expect(document.resources[action]).toBe(role === 'owner-a')
  }
})
