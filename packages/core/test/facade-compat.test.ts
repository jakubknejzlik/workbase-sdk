import { beforeEach, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import sample from './fixtures/sample/config'
import { defineInstance } from '../src/config'
import { setup, request, insertDomain, json } from '@workbasehq/test-support/helpers'
import { legacyRestFixtures } from './facade-compat-fixtures'

const config = defineInstance({ ...sample, entities: { ...sample.entities,
  clients: { ...sample.entities.clients, fields: { ...sample.entities.clients.fields,
    active: { type: 'bool' }, memo: { type: 'text' }, ratio: { type: 'float' }, category: { type: 'enum', values: ['a', 'z'] },
  } },
} })
let app: Awaited<ReturnType<typeof setup>>
beforeEach(async () => {
  app = await setup(config); await insertDomain()
  await env.DB.prepare('UPDATE clients SET active=1,memo=?,ratio=1.5,category=? WHERE id=?').bind('x'.repeat(2001), 'a', 'client-org-a').run()
})
it.each(legacyRestFixtures)('legacy REST matrix: $name', async fixture => {
  const response = await request(app, `/api/${fixture.entity}?${new URLSearchParams(fixture.params)}`)
  const body = await json(response)
  expect(response.status).toBe(fixture.status)
  if ('error' in fixture) expect(body).toEqual({ error: fixture.error })
  else { expect(body.data.map((row: { id: string }) => row.id)).toEqual(fixture.ids); expect(body.next_cursor).toBeNull() }
})
it('REST accepts all four boolean spellings with every legacy comparison operator', async () => {
  for (const value of ['true', 'false', '1', '0']) for (const op of ['eq', 'gte', 'lte', 'gt', 'lt']) {
    const param = op === 'eq' ? 'active' : `active[${op}]`
    const response = await request(app, `/api/clients?${new URLSearchParams({ [param]: value })}`)
    expect(response.status, `${param}=${value}`).toBe(200)
    const expected = op === 'eq' ? ['true', '1'].includes(value) : op === 'gte' ? true : op === 'lte' ? ['true', '1'].includes(value) : op === 'gt' ? ['false', '0'].includes(value) : false
    expect((await json(response)).data.map((row: { id: string }) => row.id)).toEqual(expected ? ['client-org-a'] : [])
  }
})
it('REST permits range operands on string, text, float, enum, datetime and ref fields', async () => {
  for (const [entity, field, operand] of [
    ['clients', 'name', 'A'], ['clients', 'memo', 'w'], ['clients', 'ratio', '1.25'], ['clients', 'category', '0'],
    ['slots', 'starts_at', '1900'], ['jobs', 'client_id', 'client-'],
  ]) {
    const response = await request(app, `/api/${entity}?${new URLSearchParams({ [`${field}[gt]`]: operand })}`)
    expect(response.status, field).toBe(200); expect((await json(response)).data).toHaveLength(1)
  }
})
it('REST long text operands retain the old absence of a write-length validation cap', async () => {
  const memo = 'x'.repeat(100_001)
  await env.DB.prepare('UPDATE clients SET memo=?').bind(memo).run()
  const response = await request(app, `/api/clients?${new URLSearchParams({ memo })}`)
  expect(response.status).toBe(200); expect((await json(response)).data).toHaveLength(1)
})
it('REST retains invalid_filter for non-finite numeric and malformed boolean operands', async () => {
  for (const params of [{ 'capacity[gte]': 'Infinity' }, { capacity: 'NaN' }, { active: 'yes' }, { 'active[lt]': '2' }] as Record<string, string>[]) {
    const entity = 'capacity' in params || 'capacity[gte]' in params ? 'slots' : 'clients'
    const response = await request(app, `/api/${entity}?${new URLSearchParams(params as Record<string, string>)}`)
    expect(response.status).toBe(400); expect(await json(response)).toEqual({ error: 'invalid_filter' })
  }
})
it('POST /query keeps strict numeric, boolean-operator and string operand rules', async () => {
  for (const [entity, where] of [
    ['slots', { capacity: { gte: 1.5 } }], ['slots', { capacity: { eq: 1.5 } }],
    ['clients', { active: { gte: false } }], ['clients', { active: { eq: 1 } }],
    ['clients', { memo: { eq: 'x'.repeat(2001) } }], ['clients', { name: { eq: 'x'.repeat(2001) } }],
  ]) {
    const response = await request(app, '/query', 'POST', { entity, where, limit: 1 })
    expect(response.status).toBe(400); expect((await json(response)).error).toBe('query_invalid')
  }
})
it('JSON cannot opt POST /query into the trusted REST grammar', async () => {
  const response = await request(app, '/query', 'POST', { entity: 'slots', limit: 1, where: { capacity: { gte: 1.5 } }, legacyErrors: true, rest: true })
  expect(response.status).toBe(400); expect((await json(response)).error).toBe('query_invalid')
})
