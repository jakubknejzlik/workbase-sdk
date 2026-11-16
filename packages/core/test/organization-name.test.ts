import { beforeEach, expect, it, describe } from 'vitest'
import { env } from 'cloudflare:workers'
import { organizationNameCases } from '../../test-support/src/organization-name-cases'
import { setup, runtime, request, json } from '@workbasehq/test-support/helpers'
import { KernelRegistry } from '../src/kernel/registry'
import sample from './fixtures/sample/config'
import { provisionOrganization, organizationCreationRule } from '../src/organizations'

let app: Awaited<ReturnType<typeof setup>>
beforeEach(async () => { app = await setup() })
const stored = () => env.DB.prepare('SELECT id,name FROM organizations ORDER BY id').all()
for (const [method, path] of [['POST', '/orgs'], ['POST', '/internal/organizations'], ['PATCH', '/organizations/org-a'], ['PATCH', '/orgs/org-a']] as const) {
  describe(`${method} ${path}`, () => {
    it.each(organizationNameCases)('$label', async c => {
      const before = (await stored()).results
      const response = path === '/internal/organizations'
        ? await app.request(`http://localhost${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Internal-Token': 'synthetic-test-internal' }, body: JSON.stringify({ name: c.input, ownerEmail: 'owner.a@example.test' }) })
        : await request(app, path, method, { name: c.input })
      const body = await json(response)
      if (c.reason) {
        expect(response.status).toBe(400)
        expect(body).toEqual({ error: 'invalid_organization_name', detail: { field: 'name', reason: c.reason } })
        expect((await stored()).results).toEqual(before)
      } else {
        expect(response.status).toBe(method === 'POST' ? 201 : 200)
        expect(body.name).toBe(c.value)
        expect(await env.DB.prepare('SELECT name FROM organizations WHERE id=?').bind(body.id).first('name')).toBe(c.value)
      }
    })
  })
}
describe('provisionOrganization core guard', () => {
  it.each(organizationNameCases)('$label', async c => {
    const config = new KernelRegistry(sample).config
    const before = (await stored()).results
    const run = () => provisionOrganization(config, runtime(), c.input, 'owner.a@example.test', 'name-contract')
    if (c.reason) {
      await expect(run()).rejects.toMatchObject({ status: 400, code: 'invalid_organization_name', detail: { field: 'name', reason: c.reason } })
      expect((await stored()).results).toEqual(before)
    } else {
      const result = await run()
      expect(result.status).toBe(201)
      expect(result.body).toMatchObject({ name: c.value })
      expect(await env.DB.prepare('SELECT name FROM organizations WHERE id=?').bind((result.body as { id: string }).id).first('name')).toBe(c.value)
    }
  })
})
describe('organizationCreationRule core guard', () => {
  it.each(organizationNameCases)('$label', async c => {
    const config = new KernelRegistry(sample).config
    const run = () => organizationCreationRule(config, runtime(), { id: 'owner-a', email: 'owner.a@example.test' }, 'new-org', c.input, 'owner')
    if (c.reason) await expect(run()).rejects.toMatchObject({ status: 400, code: 'invalid_organization_name', detail: { field: 'name', reason: c.reason } })
    else expect((await run()).statements[0].bindings?.[1]).toBe(c.value)
  })
})
