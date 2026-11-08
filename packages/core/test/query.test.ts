import { beforeEach, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:workers'
import sample from './fixtures/sample/config'
import { defineInstance } from '../src/config'
import { createApp } from '../src/app'
import { KernelRegistry, renderPredicate } from '../src/kernel/registry'
import { identity } from '@workbasehq/plugins/identity'
import { localAuth } from '@workbasehq/plugins/local-auth'
import { tenancy } from '../src/kernel/adapters/tenancy'
import { legacyPermissions as rbac } from '@workbasehq/plugins/permissions'
import type { WorkbasePlugin, TableFilter } from '../src/kernel/plugin'
import { resolveActor, requireScope } from '../src/authorization'
import type { Scope } from '../src/types'
import { executeQuery, type QueryLog } from '../src/query/executor'
import { validateQuery, querySchema } from '../src/query/schema'
import { compileRoot, compileInclude, assertStatement } from '../src/query/compiler'
import { QUERY_LIMITS as L } from '../src/query/limits'
import { restQuery } from '../src/query/facade'
import { ApiError } from '../src/errors'
import { setup, insertDomain, runtime, request, json } from '@workbasehq/test-support/helpers'

let scope: Scope = { organizationId: 'org-a', actor: { type: 'user', id: 'owner-a' }, role: 'owner', correlationId: 'query-tests' }
const secret = 'synthetic-query-secret-32-characters'
const policy: WorkbasePlugin = { name: 'scratch_policy', version: '1', tableFilter(entity, actor) {
  return entity === 'clients' ? { kind: 'where', predicate: { owner_user_id: { eq: actor.actor.id } } } : { kind: 'all' }
} }
const config = defineInstance({ ...sample, entities: { ...sample.entities,
  clients: { ...sample.entities.clients, fields: { ...sample.entities.clients.fields, owner_user_id: { type: 'string' } },
    relations: { jobs: { entity: 'jobs', field: 'client_id', many: true } } },
  jobs: { ...sample.entities.jobs, fields: { ...sample.entities.jobs.fields, client_id: { ...sample.entities.jobs.fields.client_id, required: false } } },
} })
let kernel: KernelRegistry
let logs: QueryLog[]
const execute = (input: unknown, k = kernel) => executeQuery(k, scope, env.DB, secret, input, { writeLog: log => logs.push(log) })
const q = (extra = {}) => ({ entity: 'clients', limit: 100, ...extra })
const forbiddenIds = ['client-org-b', 'client-policy', 'job-org-b', 'slot-org-b', 'worker-org-b']
const ids = (result: any) => result.data.map((row: any) => row.id)
function assertCanarySafe(result: unknown) {
  const text = JSON.stringify(result)
  for (const id of forbiddenIds) expect(text).not.toContain(id)
  const cursor = (result as any).next_cursor
  if (cursor) for (const id of forbiddenIds) expect(atob(cursor.split('.')[0].replaceAll('-', '+').replaceAll('_', '/'))).not.toContain(id)
}
beforeEach(async () => {
  await setup(config); await insertDomain(); await insertDomain('org-b')
  scope = await requireScope(await resolveActor(new Request('http://localhost', { headers: { Authorization: 'Bearer synthetic-owner-a' } }), runtime(), new KernelRegistry(config).config), 'org-a', new KernelRegistry(config).config)
  await env.DB.prepare('UPDATE clients SET owner_user_id=CASE organization_id WHEN ? THEN ? ELSE ? END').bind('org-a', 'owner-a', 'owner-b').run()
  await env.DB.prepare(`INSERT INTO clients (id,organization_id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,?,datetime('now'),datetime('now')),(?,?,?,?,datetime('now'),datetime('now'))`)
    .bind('client-policy', 'org-a', 'AAA policy canary', 'viewer-a', 'client-two', 'org-a', 'ZZZ visible', 'owner-a').run()
  await env.DB.prepare(`INSERT INTO jobs (id,organization_id,title,client_id,created_at,updated_at) VALUES (?,?,?,?,datetime('now'),datetime('now'))`).bind('job-policy-link', 'org-a', 'Policy-linked visible job', 'client-policy').run()
  kernel = new KernelRegistry(config, { plugins: [identity, localAuth, tenancy, rbac, policy] }); logs = []
})

it('canary oracle: roots and projected row counts exclude foreign-org and denied-policy rows', async () => {
  const result = await execute(q())
  expect(ids(result)).toEqual(['client-org-a', 'client-two']); expect(result.data).toHaveLength(2); assertCanarySafe(result)
  expect((await execute(q({ where: { name: { eq: 'AAA policy canary' } } }))).data).toEqual([])
})
it('canary oracle: included targets are scoped, policy-hidden n:1 is null, reverse includes are bounded', async () => {
  const result = await execute({ entity: 'jobs', select: ['id', 'title'], limit: 100, include: { client: { include: { jobs: { select: ['id', 'title'], limit: 1 } } } } })
  expect(result.data.find(row => row.id === 'job-policy-link')!.client).toBeNull()
  expect(result.data.find(row => row.id === 'job-org-a')!.client.jobs).toHaveLength(1); assertCanarySafe(result)
  const reverse = await execute(q({ include: { jobs: {} } })); assertCanarySafe(reverse)
})
it('canary oracle: FK projection masks hidden targets with and without an include or configured relation', async () => {
  for (const include of [undefined, { client: { select: ['id'] } }]) {
    const result = await execute({ entity: 'jobs', limit: 100, select: ['id', 'client_id'], include })
    expect(result.data.find(row => row.id === 'job-policy-link')).toEqual({ id: 'job-policy-link', client_id: null, ...(include ? { client: null } : {}) })
    expect(result.data.find(row => row.id === 'job-org-a')!.client_id).toBe('client-org-a'); assertCanarySafe(result)
  }
  assertCanarySafe(await execute({ entity: 'jobs', limit: 100 }))
  const noRelation = new KernelRegistry({ ...config, entities: { ...config.entities, jobs: { ...config.entities.jobs, relations: {} } } }, { plugins: [identity, localAuth, tenancy, rbac, policy] })
  assertCanarySafe(await execute({ entity: 'jobs', limit: 100 }, noRelation))
})
it.each([
  [{ eq: 'client-policy' }, []], [{ ne: 'client-policy' }, []], [{ ne: 'missing-target' }, []],
  [{ in: ['client-policy'] }, []], [{ lt: 'zzzz' }, []], [{ isNull: false }, []], [{ ne: null }, []],
  [{ isNull: true }, ['job-null-fk', 'job-policy-link']], [{ eq: null }, ['job-null-fk', 'job-policy-link']],
  [{ in: [null, 'client-policy'] }, ['job-null-fk', 'job-policy-link']],
] as const)('canary oracle: FK predicates use null semantics for hidden targets %#', async (predicate, expected) => {
  await env.DB.prepare(`INSERT INTO jobs(id,organization_id,title,created_at,updated_at) VALUES (?,?,?,datetime('now'),datetime('now'))`).bind('job-null-fk', 'org-a', 'Null FK').run()
  const result = await execute({ entity: 'jobs', select: ['id'], limit: 100, where: { id: { in: ['job-null-fk', 'job-policy-link'] }, client_id: predicate } })
  expect(ids(result)).toEqual(expected); assertCanarySafe(result)
  // Nested predicates must read the same masked source as root predicates.
  const nested = await execute(q({ where: { jobs: { some: { client_id: { eq: 'client-policy' } } } } }))
  expect(nested.data).toEqual([]); assertCanarySafe(nested)
})
it.each(['asc', 'desc'] as const)('canary oracle: FK ordering and decoded cursors use masked keys with select id only (%s)', async dir => {
  await env.DB.prepare(`INSERT INTO jobs(id,organization_id,title,created_at,updated_at) VALUES (?,?,?,datetime('now'),datetime('now'))`).bind('job-null-fk', 'org-a', 'Null FK').run()
  const seen: string[] = []; let cursor: string | undefined
  do {
    const result = await execute({ entity: 'jobs', select: ['id'], limit: 1, orderBy: [{ field: 'client_id', dir }], ...(cursor ? { cursor } : {}) })
    assertCanarySafe(result); seen.push(...ids(result))
    if (result.next_cursor) {
      const payload = JSON.parse(atob(result.next_cursor.split('.')[0].replaceAll('-', '+').replaceAll('_', '/')))
      expect(payload.keys).toEqual([result.data[0].id === 'job-org-a' ? 'client-org-a' : null, result.data[0].id])
    }
    cursor = result.next_cursor ?? undefined
  } while (cursor)
  expect(seen).toEqual(dir === 'asc' ? ['job-null-fk', 'job-policy-link', 'job-org-a'] : ['job-org-a', 'job-null-fk', 'job-policy-link'])
})
it('canary oracle: hidden FK and stored null give identical filter results, counts and cursors', async () => {
  const inputs = [
    ...[{ eq: 'client-policy' }, { ne: 'client-policy' }, { ne: 'missing' }, { isNull: true }, { isNull: false }, { in: [null, 'client-policy'] }].map(client_id => ({ entity: 'jobs', limit: 100, where: { client_id } })),
    { entity: 'jobs', limit: 100, where: { not: { client_id: { eq: 'client-policy' } } } },
    { entity: 'jobs', limit: 100, where: { or: [{ client_id: { eq: 'client-policy' } }, { client_id: { isNull: true } }] } },
    { entity: 'jobs', select: ['id'], limit: 1, orderBy: [{ field: 'client_id', dir: 'asc' }] },
  ]
  const hidden = await Promise.all(inputs.map(input => execute(input)))
  await env.DB.prepare('UPDATE jobs SET client_id=NULL WHERE id=?').bind('job-policy-link').run()
  for (const [i, input] of inputs.entries()) {
    expect(await execute(input)).toEqual(hidden[i]); assertCanarySafe(hidden[i])
  }
})
it('FK visibility uses one scoped EXISTS per column and counts it in the static estimate', () => {
  const { query, cost } = validateQuery(kernel, scope, { entity: 'jobs', select: ['id', 'client_id'], where: { client_id: { ne: 'missing' } }, orderBy: [{ field: 'client_id', dir: 'asc' }], limit: 1 })
  const statement = compileRoot(kernel, scope, query, undefined, cost)
  expect(statement.sql.match(/EXISTS/g)).toHaveLength(1); expect(statement.sql).toContain('CASE WHEN')
  expect(statement.bindings).toContain('owner-a'); expect(cost.exists).toBe(1)
})
it('FK visibility masks identities when target read permission or target id readability is denied', async () => {
  for (const plugin of [
    { name: 'deny_target', version: '1', commandGuard(operation) { if (operation.permission && 'entity' in operation.permission && operation.permission.entity === 'clients') throw new ApiError(403, 'permission_denied'); return { allow: true } } },
    { name: 'mask_target', version: '1', fieldMask(entity) { return entity === 'clients' ? ['name'] : ['id', 'client_id'] } },
  ] satisfies WorkbasePlugin[]) {
    const k = new KernelRegistry(config, { plugins: [identity, localAuth, tenancy, rbac, policy, plugin] })
    const result = await execute({ entity: 'jobs', select: ['id', 'client_id'], limit: 100 }, k)
    expect(result.data.every(row => row.client_id === null)).toBe(true); assertCanarySafe(result)
  }
})
it('canary oracle: n:1 and correlated some/none subqueries cannot become existence oracles', async () => {
  for (const quantifier of ['some', 'none']) {
    const result = await execute(q({ where: { jobs: { [quantifier]: { client: { name: { eq: 'AAA policy canary' } } } } } }))
    expect(result.data).toHaveLength(quantifier === 'some' ? 0 : 2); assertCanarySafe(result)
  }
  expect((await execute({ entity: 'jobs', limit: 100, where: { client: { name: { eq: 'AAA policy canary' } } } })).data).toEqual([])
  const { query, cost } = validateQuery(kernel, scope, q({ where: { jobs: { none: {} } } }))
  const statement = compileRoot(kernel, scope, query, undefined, cost)
  expect(statement.sql).toContain('NOT EXISTS'); expect(statement.sql).not.toMatch(/NOT IN.*SELECT/s)
})
it('canary oracle: every cursor page and error body omits canaries, including decoded cursor keys', async () => {
  let cursor: string | undefined; const seen: string[] = []
  do {
    const page = await execute(q({ limit: 1, orderBy: [{ field: 'name', dir: 'asc' }], ...(cursor ? { cursor } : {}) }))
    assertCanarySafe(page); seen.push(...ids(page)); cursor = page.next_cursor ?? undefined
  } while (cursor)
  expect(seen).toEqual(['client-org-a', 'client-two'])
  const app = createApp(config, runtime(), { plugins: [identity, localAuth, tenancy, rbac, policy] })
  for (const input of [q({ cursor: 'client-policy' }), q({ where: { 'client-policy': { eq: 'client-org-b' } } })]) {
    const response = await request(app, '/query', 'POST', input); expect(response.status).toBe(400); assertCanarySafe(await json(response))
  }
})
it('mutation proof: removing transformTable predicate injection makes the same canary assertion go red, then restores', async () => {
  const hook = vi.spyOn(kernel, 'tableFilter').mockReturnValue({ kind: 'all' })
  try {
    const leaked = await execute(q()); expect(ids(leaked)).toContain('client-org-b'); expect(ids(leaked)).toContain('client-policy')
    expect(() => assertCanarySafe(leaked)).toThrow()
    const subqueryLeak = await execute({ entity: 'jobs', limit: 100, where: { client: { name: { eq: 'AAA policy canary' } } }, include: { client: {} } })
    expect(subqueryLeak.data[0].client.id).toBe('client-policy'); expect(() => assertCanarySafe(subqueryLeak)).toThrow()
  } finally { hook.mockRestore() }
  assertCanarySafe(await execute(q()))
})
it('mutation proof: removing only the scratch policy leaks a same-org canary', async () => {
  const mutated = new KernelRegistry(config, { plugins: [identity, localAuth, tenancy, rbac] })
  const result = await execute(q(), mutated)
  expect(ids(result)).toContain('client-policy'); expect(ids(result)).not.toContain('client-org-b')
  expect(() => assertCanarySafe(result)).toThrow()
})

it.each([
  { raw: 'SELECT * FROM clients' }, { union: [] }, { where: { name: { raw: '1=1' } } },
  { where: { name: { eq: { sql: '1=1' } } } }, { where: { 'name" OR 1=1 --': { eq: 'x' } } },
  { where: { version: { contains: '1' } } }, { where: { name: { unknown: 'x' } } },
  { limit: 0 }, { limit: -1 }, { limit: 1_000_000 }, { orderBy: [{ field: 'x', dir: 'asc' }] },
  { select: ['name', 'name'] }, { where: { jobs: { some: {}, none: {} } } },
])('rejects injected grammar %# without exposing caller literals', async extra => {
  await expect(execute(q(extra))).rejects.toMatchObject({ code: 'query_invalid' })
})
it('rejects proto keys, serialized ASTs, missing limit, deep malformed trees and fifth relation nesting', async () => {
  await expect(execute(JSON.parse('{"entity":"clients","limit":1,"where":{"__proto__":{"eq":"secret"}}}'))).rejects.toMatchObject({ code: 'query_invalid' })
  await expect(execute({ entity: 'clients' })).rejects.toMatchObject({ code: 'query_invalid', path: ['limit'] })
  await expect(execute({ type: 'SelectQuery', _tables: [] })).rejects.toMatchObject({ code: 'entity_not_found' })
  let where: any = {}; for (let i = 0; i < 30; i++) where = { not: where }
  await expect(execute(q({ where }))).rejects.toMatchObject({ code: 'query_too_expensive', cost: expect.any(Object) })
  await expect(execute(q({ where: { jobs: { some: { client: { jobs: { some: { client: { jobs: { some: {} } } } } } } } } }))).rejects.toMatchObject({ code: 'query_too_expensive', cost: expect.any(Object) })
})
it('binds hostile values and contains treats SQL wildcard characters literally', async () => {
  const hostile = "' OR 1=1 -- ? %_"
  await env.DB.prepare('UPDATE clients SET name=? WHERE id=?').bind(hostile, 'client-two').run()
  const input = q({ where: { name: { contains: '%_' } } })
  const { query } = validateQuery(kernel, scope, input); const statement = compileRoot(kernel, scope, query)
  expect(statement.sql).not.toContain('%_'); expect(statement.bindings).toContain('%_')
  expect(ids(await execute(input))).toEqual(['client-two'])
  expect(ids(await execute(q({ where: { name: { eq: hostile } } })))).toEqual(['client-two'])
})
it('all operators, empty IN, null membership and boolean predicates retain SQLite semantics', async () => {
  expect(ids(await execute(q({ where: { and: [{ name: { ne: null, contains: 'Client' } }, { version: { in: [1, 2], gte: 1, lte: 2, gt: 0, lt: 3 } }], not: { name: { eq: 'no' } } } })))).toEqual(['client-org-a'])
  expect((await execute(q({ where: { id: { in: [] } } }))).data).toEqual([])
  expect((await execute(q({ where: { or: [{ email: { isNull: true } }, { email: { in: [null, 'no'] } }] } }))).data).toHaveLength(2)
})
it('applies custom field masks to select, filter, sort, cursor keys and implicit projection', async () => {
  const mask: WorkbasePlugin = { name: 'mask', version: '1', fieldMask: () => ['id', 'name'] }
  const masked = new KernelRegistry(config, { plugins: [identity, localAuth, tenancy, rbac, policy, mask] })
  expect((await execute(q(), masked)).data[0]).toEqual({ id: 'client-org-a', name: 'Client org-a' })
  for (const [extra, path] of [
    [{ select: ['email'] }, ['select', 0]], [{ where: { email: { eq: 'secret' } } }, ['where', 'email']],
    [{ orderBy: [{ field: 'email', dir: 'asc' }] }, ['orderBy', 0, 'field']],
  ] as const) await expect(execute(q(extra), masked)).rejects.toMatchObject({ code: 'field_forbidden', path })
  const noId = new KernelRegistry({ ...config, interactive: false }, { plugins: [rbac, { ...mask, fieldMask: () => ['name'] }] })
  await expect(execute(q(), noId)).rejects.toMatchObject({ code: 'field_forbidden', path: ['orderBy'] })
})
it('requires readable FK fields for both relation directions and checks child select/filter/sort paths', async () => {
  const mask: WorkbasePlugin = { name: 'mask', version: '1', fieldMask(entity) { return ['id', 'name', 'title', ...(entity === 'jobs' ? [] : ['email'])] } }
  const masked = new KernelRegistry(config, { plugins: [identity, localAuth, tenancy, rbac, mask] })
  for (const [input, path] of [
    [{ entity: 'jobs', limit: 1, include: { client: {} } }, ['include', 'client']],
    [q({ include: { jobs: {} } }), ['include', 'jobs']],
    [q({ where: { jobs: { some: {} } } }), ['where', 'jobs']],
  ] as const) await expect(execute(input, masked)).rejects.toMatchObject({ code: 'relation_forbidden', path })
  const childMask: WorkbasePlugin = { name: 'child_mask', version: '1', fieldMask(entity) { return Object.keys({ id: 1, client_id: 1, title: 1, name: 1, owner_user_id: 1, organization_id: 1 }).filter(f => entity !== 'clients' || f !== 'owner_user_id') } }
  const child = new KernelRegistry(config, { plugins: [identity, localAuth, tenancy, rbac, childMask] })
  await expect(execute({ entity: 'jobs', limit: 1, include: { client: { select: ['owner_user_id'] } } }, child)).rejects.toMatchObject({ code: 'field_forbidden', path: ['include', 'client', 'select', 0] })
})
it('cursor rejects tampering, query/revision/actor/org/sort changes and unreadable keys', async () => {
  const first = await execute(q({ limit: 1 })); expect(first.next_cursor).toBeTruthy()
  const cursor = first.next_cursor!
  for (const extra of [{ cursor: cursor.slice(0, -1) + (cursor.endsWith('a') ? 'b' : 'a') }, { cursor, select: ['id'] }, { cursor, orderBy: [{ field: 'name', dir: 'asc' }] }])
    await expect(execute(q({ limit: 1, ...extra }))).rejects.toMatchObject({ code: 'query_invalid', path: ['cursor'] })
  await env.DB.prepare('INSERT INTO memberships VALUES (?,?,?)').bind('owner-a', 'org-b', 'owner').run()
  const liveScope = async (id: string, org: string) => requireScope(await resolveActor(new Request('http://localhost', { headers: { Authorization: `Bearer synthetic-${id}` } }), runtime(), new KernelRegistry(config).config), org, new KernelRegistry(config).config)
  for (const changed of [await liveScope('owner-a', 'org-b'), await liveScope('owner-b', 'org-b')])
    await expect(executeQuery(kernel, changed, env.DB, secret, q({ limit: 1, cursor }), { writeLog: () => {} })).rejects.toMatchObject({ code: 'query_invalid' })
  const revised = new KernelRegistry({ ...config, revision: 2 }, { plugins: [identity, localAuth, tenancy, rbac, policy] })
  await expect(execute(q({ limit: 1, cursor }), revised)).rejects.toMatchObject({ code: 'query_invalid' })
})
it('cursor paging handles ascending/descending nullable keys with deterministic id ties', async () => {
  await env.DB.prepare('UPDATE clients SET email=? WHERE id=?').bind('x', 'client-two').run()
  for (const dir of ['asc', 'desc']) {
    const expected = dir === 'asc' ? ['client-org-a', 'client-two'] : ['client-two', 'client-org-a']
    const first = await execute(q({ limit: 1, orderBy: [{ field: 'email', dir }] }))
    const second = await execute(q({ limit: 1, orderBy: [{ field: 'email', dir }], cursor: first.next_cursor }))
    expect([...ids(first), ...ids(second)]).toEqual(expected); expect(second.next_cursor).toBeNull()
  }
})
it('projection is explicit in every scoped table, including nested EXISTS and window sources', () => {
  const input = q({ select: ['name'], where: { jobs: { some: { client: { name: { contains: 'x' } } } } } })
  const { query } = validateQuery(kernel, scope, input); const sql = compileRoot(kernel, scope, query).sql
  expect(sql).not.toContain('SELECT *'); expect((sql.match(/FROM `(?:clients|jobs)` AS `scope_row_\d+`/g) ?? [])).toHaveLength(4)
  expect((sql.match(/scope_row/g) ?? []).length).toBeGreaterThan(6)
})
it('binding order remains correct when multiple structured predicates and client values interleave in EXISTS', async () => {
  const extra: WorkbasePlugin = { name: 'second_policy', version: '1', tableFilter: entity => entity === 'clients' ? { kind: 'where', predicate: { any: [{ name: { eq: 'Client org-a' } }, { name: { eq: "'hostile?" } }] } } : { kind: 'all' } }
  const k = new KernelRegistry(config, { plugins: [identity, localAuth, tenancy, rbac, policy, extra] })
  const result = await execute({ entity: 'jobs', limit: 100, where: { title: { ne: 'nope' }, client: { name: { eq: 'Client org-a' } } } }, k)
  expect(ids(result)).toEqual(['job-org-a'])
})
it('estimates cost before compilation and enforces deterministic SQL/binding caps', async () => {
  const where = { or: Array.from({ length: 17 }, () => ({ jobs: { some: {} } })) }
  await expect(execute(q({ where }))).rejects.toMatchObject({ code: 'query_too_expensive', cost: expect.objectContaining({ exists: 34 }) })
  expect(() => assertStatement({ sql: 'x', bindings: Array(101).fill(1) })).toThrowError(expect.objectContaining({ code: 'query_too_expensive' }))
  expect(() => assertStatement({ sql: 'x'.repeat(L.sqlLength + 1), bindings: [] })).toThrowError(expect.objectContaining({ code: 'query_too_expensive' }))
  expect((await execute(q({ where: { id: { in: Array.from({ length: 100 }, (_, i) => `id-${i}`) } } }))).data).toEqual([])
})
it('logs only hash, shape, identity, cost, statement count and closed outcome, never values or SQL', async () => {
  await execute(q({ where: { name: { eq: 'LOG_LITERAL_CANARY' } } }))
  expect(logs[0]).toMatchObject({ queryHash: expect.stringMatching(/^[a-f0-9]{64}$/), shape: { entity: 'clients', depth: 0, relationCount: 0, includeCount: 0 }, actorKind: 'user', organizationId: 'org-a', statementCount: 1, errorCode: null })
  expect(JSON.stringify(logs)).not.toMatch(/LOG_LITERAL_CANARY|SELECT|bindings|owner_user_id/)
})
it('POST /query uses the live scope middleware and closes invalid JSON/entity/driver errors', async () => {
  const app = createApp(config, runtime(), { plugins: [identity, localAuth, tenancy, rbac, policy] })
  expect((await app.request('http://localhost/query', { method: 'POST', body: '{}' })).status).toBe(401)
  expect((await request(app, '/query', 'POST', q(), 'owner-a', 'org-b')).status).toBe(403)
  const bad = await request(app, '/query', 'POST', { entity: 'MISSING_LITERAL', limit: 1 })
  expect(bad.status).toBe(404); expect(await json(bad)).toEqual({ error: 'entity_not_found', path: ['entity'] })
  const broken = new Proxy(env.DB, { get(target, key) { return key === 'prepare' ? () => { throw new Error('SQL POLICY SECRET') } : Reflect.get(target, key) } })
  await expect(executeQuery(kernel, scope, broken, secret, q(), { writeLog: () => {} })).rejects.toMatchObject({ code: 'query_invalid', message: 'query_invalid' })
})
it('facade translation covers harness equality, numeric comparisons, bools, cursor, limit and expand', async () => {
  const app = createApp(config, runtime(), { plugins: [identity, localAuth, tenancy, rbac, policy] })
  for (const [entity, params] of [
    ['clients', {}], ['clients', { name: 'Client org-a' }], ['clients', { limit: '1' }],
    ['clients', { cursor: 'client-org-a' }], ['jobs', { expand: 'client' }],
    ['slots', { 'capacity[gte]': '1', 'capacity[lte]': '5', 'booked[gt]': '-1', 'booked[lt]': '3', expand: 'job,worker' }],
    ['bookings', { slot_id: 'slot-org-a', limit: '90' }],
  ] as [string, Record<string, string>][]) {
    const direct = await execute(restQuery(config, entity, params))
    const facade = await json(await request(app, `/api/${entity}?${new URLSearchParams(params)}`))
    expect(facade).toEqual({ data: direct.data, next_cursor: direct.next_cursor ? direct.data.at(-1)!.id : null })
  }
  const direct = await execute(restQuery(config, 'jobs', { expand: 'client' }, 'job-org-a'))
  expect(await json(await request(app, '/api/jobs/job-org-a?expand=client'))).toEqual(direct.data[0])
  expect(querySchema(kernel.config, 'clients').safeParse(q()).success).toBe(true)
})

it('NULL child foreign keys preserve NOT EXISTS semantics and null n:1 includes', async () => {
  await env.DB.prepare(`INSERT INTO jobs(id,organization_id,title,created_at,updated_at) VALUES (?,?,?,datetime('now'),datetime('now'))`).bind('job-null-fk', 'org-a', 'Null FK child').run()
  const none = await execute(q({ where: { jobs: { none: { title: { eq: 'Null FK child' } } } } }))
  expect(ids(none)).toEqual(['client-org-a', 'client-two']); assertCanarySafe(none)
  const orphan = await execute({ entity: 'jobs', select: ['id'], limit: 1, where: { id: { eq: 'job-null-fk' } }, include: { client: {} } })
  expect(orphan.data).toEqual([{ id: 'job-null-fk', client: null }])
})
it('every rejection gets a digest/cost without logging rejected field names or literals', async () => {
  await expect(execute(q({ where: { PRIVATE_FIELD_CANARY: { eq: 'PRIVATE_VALUE_CANARY' } } }))).rejects.toMatchObject({ code: 'query_invalid' })
  expect(logs[0]).toMatchObject({ queryHash: expect.stringMatching(/^[a-f0-9]{64}$/), statementCount: 0, errorCode: 'query_invalid' })
  expect(JSON.stringify(logs)).not.toMatch(/PRIVATE_FIELD_CANARY|PRIVATE_VALUE_CANARY/)
  const expensive = q({ where: { or: Array.from({ length: 17 }, () => ({ jobs: { some: {} } })) } })
  await expect(execute(expensive)).rejects.toMatchObject({ code: 'query_too_expensive' })
  expect(logs.at(-1)!.estimatedCost).toMatchObject({ exists: 34 })
})
it('query surface rejects invalid JSON, oversized streaming input and unknown grammar with safe paths', async () => {
  const app = createApp(config, runtime(), { plugins: [identity, localAuth, tenancy, rbac, policy] })
  const send = (body: string) => app.request('http://localhost/query', { method: 'POST', headers: { Authorization: 'Bearer synthetic-owner-a', 'X-Organization-Id': 'org-a' }, body })
  const malformed = await send('{PRIVATE_LITERAL_CANARY')
  expect(malformed.status).toBe(400); expect(await json(malformed)).toEqual({ error: 'query_invalid', path: [] })
  const oversized = await send('x'.repeat(L.inputBytes + 1))
  expect(oversized.status).toBe(400); expect(await json(oversized)).toEqual({ error: 'query_too_expensive', path: [] })
})
it('explicit id ordering retains caller priority and cursors cannot reuse a newly forbidden sort key', async () => {
  const input = q({ limit: 1, orderBy: [{ field: 'id', dir: 'desc' }, { field: 'name', dir: 'asc' }] })
  const first = await execute(input); expect(ids(first)).toEqual(['client-two'])
  expect(ids(await execute({ ...input, cursor: first.next_cursor }))).toEqual(['client-org-a'])
  const masked = new KernelRegistry(config, { plugins: [identity, localAuth, tenancy, rbac, policy, { name: 'no_name', version: '1', fieldMask: () => ['id'] }] })
  await expect(execute({ ...input, cursor: first.next_cursor }, masked)).rejects.toMatchObject({ code: 'field_forbidden', path: ['orderBy', 1, 'field'] })
})
it('rejected child filters and ordering retain their exact include paths', async () => {
  const mask: WorkbasePlugin = { name: 'no_email', version: '1', fieldMask: () => ['id', 'name', 'client_id', 'title'] }
  const k = new KernelRegistry(config, { plugins: [identity, localAuth, tenancy, rbac, mask] })
  for (const [child, path] of [
    [{ where: { email: { eq: 'hidden' } } }, ['include', 'client', 'where', 'email']],
    [{ orderBy: [{ field: 'email', dir: 'asc' }] }, ['include', 'client', 'orderBy', 0, 'field']],
  ]) await expect(execute({ entity: 'jobs', limit: 1, include: { client: child } }, k)).rejects.toMatchObject({ code: 'field_forbidden', path })
})

it('overlong readable sort keys fail safely instead of returning an unusable cursor', async () => {
  await env.DB.prepare('UPDATE clients SET name=? WHERE organization_id=?').bind('SORT_LITERAL_CANARY'.repeat(600), 'org-a').run()
  await expect(execute(q({ limit: 1, orderBy: [{ field: 'name', dir: 'asc' }] }))).rejects.toMatchObject({ code: 'query_too_expensive', path: ['cursor'] })
  expect(JSON.stringify(logs)).not.toContain('SORT_LITERAL_CANARY')
})

it('structured port predicates support resolved operators and scoped correlated relations over unreadable policy fields', async () => {
  const policy: WorkbasePlugin = { name: 'future_policy_compiler_output', version: '1', tableFilter(entity, actor): TableFilter {
    return entity === 'jobs' ? { kind: 'where', predicate: { exists: { entity: 'clients', field: 'id', parentField: 'client_id', predicate: {
      all: [{ owner_user_id: { eq: actor.actor.id } }, { name: { contains: 'Client', ne: 'no', in: ['Client org-a', null] } }, { not: { version: { lt: 1 } } }],
    } } } } : { kind: 'all' }
  }, fieldMask: () => ['id', 'title'] }
  const k = new KernelRegistry(config, { plugins: [identity, localAuth, tenancy, rbac, policy] })
  const result = await execute({ entity: 'jobs', limit: 100 }, k)
  expect(result.data).toEqual([{ id: 'job-org-a', title: 'Synthetic job' }]); assertCanarySafe(result)
})
it('server notExists sees scoped targets and limits recursive port policies before emitting SQL', async () => {
  const policy: WorkbasePlugin = { name: 'future_none_policy', version: '1', tableFilter(entity) {
    return entity === 'jobs' ? { kind: 'where', predicate: { notExists: { entity: 'clients', field: 'id', parentField: 'client_id', predicate: { name: { eq: 'AAA policy canary' } } } } } : { kind: 'all' }
  } }
  const k = new KernelRegistry(config, { plugins: [identity, localAuth, tenancy, rbac, policy, { ...policy, name: 'owner_policy', tableFilter: entity => entity === 'clients' ? { kind: 'where', predicate: { owner_user_id: { eq: 'owner-a' } } } : { kind: 'all' } }] })
  expect((await execute({ entity: 'jobs', select: ['id'], limit: 100 }, k)).data).toHaveLength(2)
  const recursive: WorkbasePlugin = { name: 'cycle', version: '1', tableFilter: () => ({ kind: 'where', predicate: { exists: { entity: 'clients', field: 'id', parentField: 'id', predicate: { id: { ne: null } } } } }) }
  const cycle = new KernelRegistry(config, { plugins: [identity, localAuth, tenancy, rbac, recursive] })
  await expect(execute(q(), cycle)).rejects.toMatchObject({ code: 'query_too_expensive' })
})

it('legacy scalar predicate rendering remains bound and relation predicates fail closed without compiler context', async () => {
  const rendered = renderPredicate({ all: [{ organization_id: { eq: 'org-a' } }, { owner_user_id: { ne: 'viewer-a' }, version: { gte: 1, lte: 1 }, name: { contains: 'Client', in: ['Client org-a', null] }, email: { isNull: true } }] }, 'clients')
  const rows = await env.DB.prepare(`SELECT id FROM clients WHERE ${rendered.sql}`).bind(...rendered.bindings).all<{ id: string }>()
  expect(rows.results.map(row => row.id)).toEqual(['client-org-a'])
  expect(() => renderPredicate({ exists: { entity: 'clients', field: 'id', parentField: 'client_id', predicate: { id: { ne: null } } } }, 'jobs')).toThrow('requires scoped compiler')
})

it('D1 user and policy IN lists each spend one JSON binding; repeated contains spends one', async () => {
  const values = ['Client org-a', 'ZZZ visible', "hostile?1'", ...Array.from({ length: 90 }, (_, i) => `name-${i}`)]
  const listPolicy: WorkbasePlugin = { name: 'list_policy', version: '1', tableFilter: entity => entity === 'clients' ? { kind: 'where', predicate: { name: { in: values } } } : { kind: 'all' } }
  const k = new KernelRegistry(config, { plugins: [identity, localAuth, tenancy, rbac, policy, listPolicy] })
  const input = q({ where: { and: [{ name: { in: values } }, { or: [{ name: { contains: 'Client' } }, { id: { contains: 'Client' } }] }] } })
  const { query, cost } = validateQuery(k, scope, input)
  const statement = compileRoot(k, scope, query, undefined, cost)
  expect(statement.sql.match(/json_each\(/g)).toHaveLength(2)
  expect(statement.bindings.filter(value => value === 'Client')).toHaveLength(1)
  expect(statement.bindings.filter(value => value === JSON.stringify(values)).length).toBeGreaterThanOrEqual(1)
  expect(ids(await execute(input, k))).toEqual(['client-org-a'])
  const json = await env.DB.prepare('SELECT value, type FROM json_each(?)').bind(JSON.stringify([1, '1', true, false, null])).all()
  expect(json.results).toEqual([{ value: 1, type: 'integer' }, { value: '1', type: 'text' }, { value: 1, type: 'true' }, { value: 0, type: 'false' }, { value: null, type: 'null' }])
})

it('null ref labels are empty while dangling and policy-hidden non-null refs stay unavailable', async () => {
  // Scratch ref without a database FK models legacy dangling IDs.
  await env.DB.exec('ALTER TABLE jobs ADD COLUMN optional_client_id TEXT')
  await env.DB.exec('UPDATE jobs SET optional_client_id=client_id')
  const configured = defineInstance({ ...config, entities: { ...config.entities, jobs: { ...config.entities.jobs, fields: { ...config.entities.jobs.fields, optional_client_id: { type: 'ref', entity: 'clients' } } } } })
  const k = new KernelRegistry(configured, { plugins: [identity, localAuth, tenancy, rbac, policy] })
  await env.DB.prepare(`INSERT INTO jobs(id,organization_id,title,optional_client_id,created_at,updated_at) VALUES
    ('job-null','org-a','Null',NULL,datetime('now'),datetime('now')),
    ('job-dangling','org-a','Dangling','missing-client',datetime('now'),datetime('now'))`).run()
  const query = { entity: 'jobs', select: ['id', 'optional_client_id'], labels: ['optional_client_id'], limit: 100 }
  const result = await execute(query, k)
  expect(result.data.find(row => row.id === 'job-null')).toEqual({ id: 'job-null', optional_client_id: null, __labels: { optional_client_id: { status: 'empty' } } })
  for (const id of ['job-dangling', 'job-policy-link']) {
    expect(result.data.find(row => row.id === id)).toEqual({ id, optional_client_id: null, __labels: { optional_client_id: { status: 'unavailable' } } })
  }
  assertCanarySafe(result)
  const denied: WorkbasePlugin = { name: 'deny_target', version: '1', commandGuard(operation) {
    if (operation.permission && 'entity' in operation.permission && operation.permission.entity === 'clients') throw new ApiError(403, 'permission_denied')
    return { allow: true }
  } }
  const masked = await execute({ ...query, select: ['id'] }, new KernelRegistry(configured, { plugins: [identity, localAuth, tenancy, rbac, denied] }))
  expect(masked.data.find(row => row.id === 'job-null')!.__labels.optional_client_id).toEqual({ status: 'empty' })
  expect(masked.data.find(row => row.id === 'job-org-a')!.__labels.optional_client_id).toEqual({ status: 'unavailable' })
})
it('related column labels distinguish null at either hop from dangling and forbidden targets', async () => {
  // An optional first hop; the scratch second hop has no FK constraint so it can
  // model historical dangling references without weakening the production schema.
  await env.DB.exec('ALTER TABLE workers ADD COLUMN client_id TEXT')
  await env.DB.exec('ALTER TABLE slots ADD COLUMN optional_worker_id TEXT')
  const joined = defineInstance({ ...config, entities: { ...config.entities, slots: { ...config.entities.slots, fields: { ...config.entities.slots.fields, optional_worker_id: { type: 'ref', entity: 'workers' } } }, workers: { ...config.entities.workers, fields: { ...config.entities.workers.fields, client_id: { type: 'ref', entity: 'clients' } } } }, ui: { entities: { slots: { list: { columns: ['client_label'], relatedColumns: { client_label: { via: 'optional_worker_id', field: 'client_id' } } } } } } })
  const k = new KernelRegistry(joined, { plugins: [identity, localAuth, tenancy, rbac, policy] })
  const query = { entity: 'slots', select: ['id'], labels: ['client_label'], where: { id: { eq: 'slot-org-a' } }, limit: 1 }
  for (const [worker, client, status] of [
    [null, 'client-org-a', 'empty'], ['worker-org-a', null, 'empty'],
    ['missing-worker', 'client-org-a', 'unavailable'], ['worker-org-b', 'client-org-a', 'unavailable'], ['worker-org-a', 'missing-client', 'unavailable'],
    ['worker-org-a', 'client-policy', 'unavailable'],
  ] as const) {
    await env.DB.prepare('UPDATE slots SET optional_worker_id=? WHERE id=?').bind(worker, 'slot-org-a').run()
    await env.DB.prepare('UPDATE workers SET client_id=? WHERE id=?').bind(client, 'worker-org-a').run()
    const result = await execute(query, k)
    expect(result.data[0].__labels.client_label, `worker=${worker}, client=${client}`).toEqual({ status })
    assertCanarySafe(result)
  }
})

it('SR-51 direct ref labels sort before pagination, including ties and hidden targets in both directions', async () => {
  await env.DB.prepare(`INSERT INTO jobs(id,organization_id,title,client_id,created_at,updated_at) VALUES ('job-second','org-a','Second','client-two',datetime('now'),datetime('now')),('job-tie','org-a','Tie','client-org-a',datetime('now'),datetime('now'))`).run()
  for (const dir of ['asc', 'desc'] as const) {
    let cursor: string | undefined; const seen: string[] = []
    do {
      const page = await execute({ entity: 'jobs', select: ['id'], labels: ['client_id'], orderBy: [{ field: 'client_id', dir, label: true }], limit: 1, ...(cursor ? { cursor } : {}) })
      assertCanarySafe(page)
      const row = page.data[0]; seen.push(row.id)
      if (row.id === 'job-policy-link') expect(row.__labels.client_id).toEqual({ status: 'unavailable' })
      else expect(row.__labels.client_id).toMatchObject({ status: 'ok', entity: 'clients', display: 'name', row: { name: row.id === 'job-second' ? 'ZZZ visible' : 'Client org-a' } })
      if (page.next_cursor) {
        const payload = JSON.parse(atob(page.next_cursor.split('.')[0].replaceAll('-', '+').replaceAll('_', '/')))
        expect(payload.keys[0]).toBe(row.__labels.client_id.row?.name ?? null)
      }
      cursor = page.next_cursor ?? undefined
    } while (cursor)
    expect(seen).toEqual(dir === 'asc' ? ['job-policy-link', 'job-org-a', 'job-tie', 'job-second'] : ['job-second', 'job-org-a', 'job-tie', 'job-policy-link'])
  }
})
it('SR-50/51 two-hop labels share joined paths and filter the authorized label before limiting', async () => {
  const joined = defineInstance({ ...config, ui: { entities: { slots: { list: { columns: ['client_label'], relatedColumns: { client_label: { via: 'job_id', field: 'client_id' } } } } } } })
  const k = new KernelRegistry(joined, { plugins: [identity, localAuth, tenancy, rbac, policy] })
  const input = { entity: 'slots', select: ['id'], labels: ['job_id', 'client_label'], labelWhere: { client_label: { contains: 'Client org-a' } }, orderBy: [{ field: 'client_label', dir: 'desc', label: true }], limit: 1 }
  const result = await execute(input, k)
  expect(ids(result)).toEqual(['slot-org-a'])
  expect(result.data[0].__labels.client_label.row.name).toBe('Client org-a'); assertCanarySafe(result)
  const { query, cost } = validateQuery(k, scope, input)
  const compiled = compileRoot(k, scope, query, undefined, cost)
  expect(compiled.sql.match(/LEFT JOIN/g)).toHaveLength(2)
  expect(logs.at(-1)?.statementCount).toBe(1)
  expect((await execute({ ...input, labelWhere: { client_label: { contains: 'AAA policy canary' } } }, k)).data).toEqual([])
  await env.DB.prepare("UPDATE jobs SET client_id='client-policy' WHERE id='job-org-a'").run()
  const denied = await execute({ ...input, labelWhere: undefined }, k)
  expect(denied.data[0].__labels.client_label).toEqual({ status: 'unavailable' }); assertCanarySafe(denied)
})
it('SR-50 joined labels respect target entity, id, display and intermediate FK masks without leaking cached names', async () => {
  for (const plugin of [
    { name: 'deny_target', version: '1', commandGuard(operation) { if (operation.permission && 'entity' in operation.permission && operation.permission.entity === 'clients') throw new ApiError(403, 'permission_denied'); return { allow: true } } },
    { name: 'mask_target', version: '1', fieldMask(entity) { return entity === 'clients' ? ['name'] : ['id', 'client_id'] } },
    { name: 'mask_display', version: '1', fieldMask(entity) { return entity === 'clients' ? ['id'] : ['id', 'client_id'] } },
  ] satisfies WorkbasePlugin[]) {
    const k = new KernelRegistry(config, { plugins: [identity, localAuth, tenancy, rbac, policy, plugin] })
    const result = await execute({ entity: 'jobs', select: ['id'], labels: ['client_id'], orderBy: [{ field: 'client_id', dir: 'asc', label: true }], limit: 1 }, k)
    expect(JSON.stringify(result)).not.toContain('Client org-a'); assertCanarySafe(result)
    expect(result.data[0].__labels.client_id).toMatchObject(plugin.name === 'mask_display' && result.data[0].id === 'job-org-a' ? { status: 'ok', display: null, row: { id: 'client-org-a' } } : { status: 'unavailable' })
  }
})
it('SR-50 schema-bound labels reject arbitrary paths, scalar labels and masked source fields', async () => {
  for (const input of [{ labels: ['title'] }, { labels: ['client.name'] }, { orderBy: [{ field: 'title', dir: 'asc', label: true }] }, { labels: ['client_id', 'client_id'] }, { orderBy: [{ field: 'not_configured', dir: 'asc', label: true }] }]) {
    await expect(execute({ entity: 'jobs', select: ['id'], limit: 1, ...input })).rejects.toMatchObject({ code: 'query_invalid' })
  }
  const plugin: WorkbasePlugin = { name: 'mask_source', version: '1', fieldMask() { return ['id'] } }
  await expect(execute({ entity: 'jobs', select: ['id'], labels: ['client_id'], limit: 1 }, new KernelRegistry(config, { plugins: [identity, localAuth, tenancy, rbac, plugin] }))).rejects.toMatchObject({ code: 'field_forbidden' })
})
it.each(['intermediate_read', 'intermediate_id', 'intermediate_fk', 'intermediate_policy'] as const)('SR-50 two-hop labels never bypass %s', async denial => {
  const joined = defineInstance({ ...config, ui: { entities: { slots: { list: { columns: ['client_label'], relatedColumns: { client_label: { via: 'job_id', field: 'client_id' } } } } } } })
  const plugin: WorkbasePlugin = { name: 'deny_hop', version: '1',
    commandGuard(operation) { if (denial === 'intermediate_read' && operation.permission && 'entity' in operation.permission && operation.permission.entity === 'jobs') throw new ApiError(403, 'permission_denied'); return { allow: true } },
    fieldMask(entity) { return entity === 'jobs' && ['intermediate_id', 'intermediate_fk'].includes(denial) ? denial === 'intermediate_id' ? ['client_id'] : ['id'] : ['id', 'client_id', 'job_id'] },
    tableFilter(entity) { return entity === 'jobs' && denial === 'intermediate_policy' ? { kind: 'none' } : { kind: 'all' } },
  }
  const k = new KernelRegistry(joined, { plugins: [identity, localAuth, tenancy, rbac, policy, plugin] })
  const result = await execute({ entity: 'slots', select: ['id'], labels: ['client_label'], orderBy: [{ field: 'client_label', dir: 'asc', label: true }], limit: 1 }, k)
  expect(result.data[0].__labels.client_label).toEqual({ status: 'unavailable' })
  expect(JSON.stringify(result)).not.toContain('Client org-a'); assertCanarySafe(result)
})

it('SR-57/58 ref search and header filters match translated enum display labels server-side', async () => {
  await env.DB.prepare("UPDATE clients SET name='earn' WHERE id='client-org-a'").run()
  const enumDisplay = defineInstance({ ...config,
    enumLabels: { ...config.enumLabels, cs: { ...config.enumLabels?.cs, value_earn: 'Připsáno', value_redeem: 'Uplatněno' } },
    entities: { ...config.entities, clients: { ...config.entities.clients, fields: { ...config.entities.clients.fields, name: { type: 'enum', values: ['earn', 'redeem'] } } } },
  })
  const k = new KernelRegistry(enumDisplay, { plugins: [identity, localAuth, tenancy, rbac, policy] })
  const base = { entity: 'jobs', select: ['id'], labels: ['client_id'], limit: 10 }
  expect(ids(await execute({ ...base, search: { text: 'PŘIPS', fields: ['client_id'], locale: 'cs' } }, k))).toEqual(['job-org-a'])
  expect(ids(await execute({ ...base, labelWhere: { client_id: { contains: 'přips', locale: 'cs' } } }, k))).toEqual(['job-org-a'])
})
