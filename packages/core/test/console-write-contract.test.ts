import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { setup } from './fixtures/policy-graph/setup'
import { request, json } from '@workbasehq/test-support/helpers'
import { writableFields } from '../../console-generated/src/write'
import type { Model } from '../../console-generated/src/read'
let app: Awaited<ReturnType<typeof setup>>
beforeEach(async () => { app = await setup() })
afterEach(() => vi.unstubAllGlobals())
// RFC 0005 C3 / decision 10; docs/policies.md protected $actor dependencies.
it('console capability intersection hides own-account actor fields and its forced client PATCH receives field_forbidden', async () => {
  const caps = await json(await request(app, '/o/org-a/capabilities', 'GET', undefined, 'reviewer'))
  const schema = await json(await app.request('http://localhost/schema'))
  const model = { instance: schema.instance, revision: schema.revision, limits: schema.query.limits, entities: Object.fromEntries(Object.entries(schema.entities).map(([entity, definition]: [string, any]) => [entity, { ...definition, columns: Object.keys(definition.fields), relations: schema.query.entities[entity].relations, routes: { list: '', detail: '' } }])) } as Model
  expect(writableFields(model, 'users', caps)).toContain('name')
  for (const field of ['role', 'team_id']) {
    expect(caps.entities.users.writable).not.toContain(field)
    expect(writableFields(model, 'users', caps)).not.toContain(field)
  }
  // Browser code has its own DOM tsconfig; keep that boundary out of the Worker type graph.
  const { api } = await import('../../frontend-console/src/api/client' as string)
  vi.stubGlobal('window', { location: { origin: 'http://localhost' } })
  const dispatch = vi.fn((path: string, init: RequestInit) => app.request('http://localhost' + path, { ...init, headers: { ...init.headers, Authorization: 'Bearer synthetic-reviewer' } }))
  vi.stubGlobal('fetch', dispatch)
  for (const field of ['role', 'team_id']) await expect(api('/api/users/reviewer', { method: 'PATCH', orgId: 'org-a', body: { [field]: field === 'role' ? 'administrator' : 'team-b', version: 1 } })).rejects.toMatchObject({ status: 403, code: 'field_forbidden' })
  expect(dispatch).toHaveBeenCalledTimes(2)
  const row = await json(await request(app, '/api/users/reviewer', 'GET', undefined, 'reviewer'))
  expect(row).toMatchObject({ role: 'reviewer', team_id: 'team-a', version: 1 })
})
