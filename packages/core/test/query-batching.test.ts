import { beforeEach, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import sample from './fixtures/sample/config'
import { defineInstance } from '../src/config'
import { KernelRegistry } from '../src/kernel/registry'
import { identity } from '@workbasehq/plugins/identity'
import { localAuth } from '@workbasehq/plugins/local-auth'
import { tenancy } from '../src/kernel/adapters/tenancy'
import { legacyPermissions as rbac } from '@workbasehq/plugins/permissions'
import type { WorkbasePlugin } from '../src/kernel/plugin'
import { resolveActor, requireScope } from '../src/authorization'
import type { Scope } from '../src/types'
import { executeQuery } from '../src/query/executor'
import { validateQuery } from '../src/query/schema'
import { QUERY_LIMITS as L } from '../src/query/limits'
import { compileInclude } from '../src/query/compiler'
import { setup, insertDomain, runtime } from '@workbasehq/test-support/helpers'

const config = defineInstance({ ...sample, entities: { ...sample.entities,
  clients: { ...sample.entities.clients, relations: {
    jobs: { entity: 'jobs', field: 'client_id', many: true },
    other_jobs: { entity: 'jobs', field: 'client_id', many: true },
  } },
} })
let kernel: KernelRegistry; let scope: Scope
let counts: number[]; let queries: string[]; let batches: number[]
const secret = 'synthetic-query-secret-32-characters'
function observedDb(): D1Database {
  return new Proxy(env.DB, { get(target, key) {
    if (key === 'batch') return (statements: D1PreparedStatement[]) => { batches.push(statements.length); return target.batch(statements) }
    if (key === 'prepare') return (sql: string) => {
      queries.push(sql); const prepared = target.prepare(sql)
      return new Proxy(prepared, { get(statement, member) {
        if (member === 'bind') return (...values: unknown[]) => { counts.push(values.length); return statement.bind(...values) }
        const value = Reflect.get(statement, member); return typeof value === 'function' ? value.bind(statement) : value
      } })
    }
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
  } })
}
const run = (input: unknown, k = kernel) => executeQuery(k, scope, observedDb(), secret, input, { writeLog: () => {} })
beforeEach(async () => {
  await setup(config)
  scope = await requireScope(await resolveActor(new Request('http://localhost', { headers: { Authorization: 'Bearer synthetic-owner-a' } }), runtime(), new KernelRegistry(config).config), 'org-a', new KernelRegistry(config).config)
  await env.DB.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100)
    INSERT INTO clients(id,organization_id,name,created_at,updated_at)
    SELECT printf('parent%03d',x),'org-a','Batch parent',datetime('now'),datetime('now') FROM n;`.replaceAll('\n', ' '))
  await env.DB.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<21)
    INSERT INTO jobs(id,organization_id,title,client_id,created_at,updated_at)
    SELECT c.id||printf('-child%02d',x),'org-a',printf('title%02d',x),c.id,datetime('now'),datetime('now') FROM clients c CROSS JOIN n;`.replaceAll('\n', ' '))
  kernel = new KernelRegistry(config); counts = []; queries = []; batches = []
})
it('P12: executes sibling includes in one batch per level, including separate parent branches', async () => {
  await insertDomain()
  const input = { entity: 'slots', select: ['id'], where: { id: { eq: 'slot-org-a' } }, limit: 1, include: {
    job: { select: ['id'] },
    worker: { select: ['id'] },
  } }
  const result = await run(input)
  expect(result.data).toEqual([{ id: 'slot-org-a', job: { id: 'job-org-a' }, worker: { id: 'worker-org-a' } }])
  console.log(`P12 sibling_content_batches=${JSON.stringify(batches)} d1_roundtrips=${batches.length} statements=${queries.length}`)
  expect(batches).toEqual([1, 2])
  batches = []; queries = []; counts = []
  const branches = await run({ entity: 'clients', select: ['id'], limit: 1, include: {
    jobs: { select: ['id'], limit: 1, include: { client: { select: ['id'] } } },
    other_jobs: { select: ['id'], limit: 1, include: { client: { select: ['id'] } } },
  } })
  expect(branches.data[0].jobs[0].client).toEqual({ id: branches.data[0].id })
  expect(branches.data[0].other_jobs).toEqual(branches.data[0].jobs)
  console.log(`P12 nested_content_batches=${JSON.stringify(batches)} d1_roundtrips=${batches.length} statements=${queries.length}`)
  expect(batches).toEqual([1, 2, 2])
})
it('keeps sibling result positions and forbidden denial when a branch has no visible parent IDs', async () => {
  await insertDomain()
  const input = { entity: 'slots', select: ['id'], where: { id: { eq: 'slot-org-a' } }, limit: 1,
    include: { worker: { select: ['id'] }, job: { select: ['id'] } } }
  const hiddenWorker: WorkbasePlugin = { name: 'hidden_worker', version: '1', tableFilter: entity => entity === 'workers' ? { kind: 'none' } : { kind: 'all' } }
  const hidden = new KernelRegistry(config, { plugins: [identity, localAuth, tenancy, rbac, hiddenWorker] })
  expect((await run(input, hidden)).data).toEqual([{ id: 'slot-org-a', worker: null, job: { id: 'job-org-a' } }])
  expect(batches).toEqual([1, 1]); batches = []
  const forbiddenWorker: WorkbasePlugin = { ...hiddenWorker, tableFilter: entity => entity === 'workers' ? { kind: 'none', deny: 'forbidden' } : { kind: 'all' } }
  const forbidden = new KernelRegistry(config, { plugins: [identity, localAuth, tenancy, rbac, forbiddenWorker] })
  await expect(run(input, forbidden)).rejects.toMatchObject({ code: 'policy_violation', path: ['include', 'worker'] })
  expect(batches).toEqual([1, 1])
})
it('batches 100 parents and 2,000 included rows with 20 per parent, stable order and no N+1', async () => {
  const result = await run({ entity: 'clients', limit: 100, select: ['id'], include: { jobs: { select: ['id', 'title'], limit: 20, orderBy: [{ field: 'title', dir: 'desc' }] } } })
  expect(result.data).toHaveLength(100)
  for (const parent of result.data) { expect(parent.jobs).toHaveLength(20); expect(parent.jobs[0].title).toBe('title21'); expect(parent.jobs.at(-1).title).toBe('title02') }
  expect(result.data.flatMap(parent => parent.jobs)).toHaveLength(2_000)
  expect(queries).toHaveLength(2); expect(Math.max(...counts)).toBeLessThanOrEqual(L.bindings)
  expect(queries.slice(1).every(sql => sql.includes('ROW_NUMBER() OVER') && sql.includes('scope_row'))).toBe(true)
})
it('JSON parent lists stay in one statement alongside policy/client/window bindings', async () => {
  const policy: WorkbasePlugin = { name: 'binding_policy', version: '1', tableFilter(entity) {
    return entity === 'jobs' ? { kind: 'where', predicate: { any: Array.from({ length: 45 }, (_, i) => ({ title: { eq: `title${String(i + 1).padStart(2, '0')}` } })) } } : { kind: 'all' }
  } }
  const k = new KernelRegistry(config, { plugins: [identity, localAuth, tenancy, rbac, policy] })
  const result = await run({ entity: 'clients', select: ['id'], limit: 100, include: { jobs: { select: ['id'], where: { title: { ne: 'nope' } }, limit: 1 } } }, k)
  expect(result.data.every(parent => parent.jobs.length === 1)).toBe(true)
  expect(queries).toHaveLength(2); expect(Math.max(...counts)).toBeLessThanOrEqual(L.bindings); expect(counts.every(n => n <= 100)).toBe(true)
  const base = compileInclude(k, scope, 'jobs', { select: ['id'], limit: 1, where: { title: { ne: 'nope' } } }, 'client_id', [])
  expect(base.bindings).toHaveLength(48)
})
it('scopes children before ROW_NUMBER so hidden rows never consume the per-parent limit', async () => {
  const policy: WorkbasePlugin = { name: 'child_policy', version: '1', tableFilter: entity => entity === 'jobs' ? { kind: 'where', predicate: { title: { eq: 'title20' } } } : { kind: 'all' } }
  const k = new KernelRegistry(config, { plugins: [identity, localAuth, tenancy, rbac, policy] })
  const result = await run({ entity: 'clients', select: ['id'], limit: 100, include: { jobs: { select: ['title'], orderBy: [{ field: 'title', dir: 'desc' }], limit: 1 } } }, k)
  expect(result.data.every(parent => parent.jobs.length === 1 && parent.jobs[0].title === 'title20')).toBe(true)
})
it('masks included child FK values before per-parent ordering and ROW_NUMBER', async () => {
  await insertDomain()
  await env.DB.prepare(`INSERT INTO workers(id,organization_id,name,created_at,updated_at) VALUES (?,?,?,datetime('now'),datetime('now'))`).bind('worker-hidden-canary', 'org-a', 'Hidden').run()
  await env.DB.prepare(`INSERT INTO slots(id,organization_id,job_id,worker_id,starts_at,capacity,created_at,updated_at) VALUES (?,?,?,?,datetime('now'),3,datetime('now'),datetime('now'))`).bind('hidden-slot', 'org-a', 'job-org-a', 'worker-hidden-canary').run()
  const withSlots = defineInstance({ ...config, entities: { ...config.entities, jobs: { ...config.entities.jobs, relations: { ...config.entities.jobs.relations, slots: { entity: 'slots', field: 'job_id', many: true } } } } })
  const policy: WorkbasePlugin = { name: 'worker_policy', version: '1', tableFilter: entity => entity === 'workers' ? { kind: 'where', predicate: { name: { eq: 'Synthetic worker' } } } : { kind: 'all' } }
  const k = new KernelRegistry(withSlots, { plugins: [identity, localAuth, tenancy, rbac, policy] })
  const result = await run({ entity: 'jobs', select: ['id'], limit: 1, where: { id: { eq: 'job-org-a' } }, include: { slots: { select: ['id', 'worker_id'], orderBy: [{ field: 'worker_id', dir: 'asc' }], limit: 1 } } }, k)
  expect(result.data[0].slots).toEqual([{ id: 'hidden-slot', worker_id: null }])
  expect(JSON.stringify(result)).not.toContain('worker-hidden-canary'); expect(queries).toHaveLength(2)
})
it('rejects an over-budget child policy before any child statement executes', async () => {
  const policy: WorkbasePlugin = { name: 'costly_policy', version: '1', tableFilter: entity => entity === 'jobs' ? { kind: 'where', predicate: { any: Array.from({ length: 101 }, (_, i) => ({ title: { eq: i ? `unmatched-${i}` : 'title20' } })) } } : { kind: 'all' } }
  const k = new KernelRegistry(config, { plugins: [identity, localAuth, tenancy, rbac, policy] })
  await expect(run({ entity: 'clients', select: ['id'], limit: 100, include: { jobs: { select: ['id'], limit: 1 } } }, k)).rejects.toMatchObject({ code: 'query_too_expensive' })
  expect(queries).toHaveLength(1); expect(counts.every(n => n <= 100)).toBe(true)
})
it('JSON parent lists preserve the exact binding cap and reject overflow before child SQL', async () => {
  const withBindings = (size: number) => new KernelRegistry(config, { plugins: [identity, localAuth, tenancy, rbac, { name: 'costly_policy', version: '1', tableFilter: entity => entity === 'jobs' ? { kind: 'where', predicate: { any: Array.from({ length: Math.ceil(size / 10) }, (_, chunk) => ({ any: Array.from({ length: Math.min(10, size - chunk * 10) }, (_, offset) => ({ title: { eq: chunk || offset ? `unmatched-${chunk}-${offset}` : 'title20' } })) })) } } : { kind: 'all' } }] })
  const input = { entity: 'clients', select: ['id'], limit: 100, include: { jobs: { select: ['id'], limit: 1 } } }
  expect((await run(input, withBindings(97))).data.every(row => row.jobs.length === 1)).toBe(true)
  expect(queries).toHaveLength(2); expect(counts.at(-1)).toBe(L.bindings)
  queries = []; counts = []
  await expect(run(input, withBindings(98))).rejects.toMatchObject({ code: 'query_too_expensive' })
  expect(queries).toHaveLength(1)
})
it('includes target-visibility policy bindings in the root binding cap before preparing SQL', async () => {
  const policy: WorkbasePlugin = { name: 'costly_target', version: '1', tableFilter: entity => entity === 'clients' ? { kind: 'where', predicate: { any: Array.from({ length: 101 }, (_, i) => ({ name: { eq: i ? `unmatched-${i}` : 'Batch parent' } })) } } : { kind: 'all' } }
  const k = new KernelRegistry(config, { plugins: [identity, localAuth, tenancy, rbac, policy] })
  await expect(run({ entity: 'jobs', select: ['id'], orderBy: [{ field: 'client_id', dir: 'asc' }], limit: 1 }, k)).rejects.toMatchObject({ code: 'query_too_expensive' })
  expect(queries).toEqual([])
})
it('includes implicit FK visibility probes in the pre-SQL EXISTS cost cap', async () => {
  const fields = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`ref${i}`, { type: 'ref' as const, entity: 'clients', required: false }]))
  const k = new KernelRegistry({ ...config, entities: { ...config.entities, jobs: { ...config.entities.jobs, fields: { ...config.entities.jobs.fields, ...fields } } } })
  await expect(run({ entity: 'jobs', select: ['id'], limit: 1 }, k)).rejects.toMatchObject({ code: 'query_too_expensive', cost: expect.objectContaining({ exists: 18 }) })
  expect(queries).toEqual([])
})
it('enforces 100 parents for the next level and 2,000 rows across all relations in one level', async () => {
  await expect(run({ entity: 'clients', select: ['id'], limit: 100, include: { jobs: { select: ['id'], limit: 2, include: { client: { select: ['id'] } } } } })).rejects.toMatchObject({ code: 'query_too_expensive' })
  expect(batches).toEqual([1, 1]); batches = []
  await expect(run({ entity: 'clients', select: ['id'], limit: 100, include: { jobs: { select: ['id'], limit: 20 }, other_jobs: { select: ['id'], limit: 1 } } })).rejects.toMatchObject({ code: 'query_too_expensive' })
  expect(batches).toEqual([1, 2])
})
it('static field-row budget rejects excessive branching before SQL execution', () => {
  const fields = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`wide${i}`, { type: 'string' as const }]))
  const wide = new KernelRegistry({ ...config, entities: { ...config.entities, jobs: { ...config.entities.jobs, fields: { ...config.entities.jobs.fields, ...fields } } } })
  const selection = { limit: 20, include: { jobs: { limit: 20 }, other_jobs: { limit: 20 } } }
  expect(() => validateQuery(wide, scope, { entity: 'jobs', limit: 100, include: { client: selection } })).toThrowError(expect.objectContaining({ code: 'query_too_expensive', cost: expect.objectContaining({ fieldRows: expect.any(Number) }) }))
  expect(queries).toEqual([])
})

it('rejects an oversized compiled policy before preparing any D1 statement', async () => {
  const policy: WorkbasePlugin = { name: 'long_sql', version: '1', tableFilter: () => ({ kind: 'where', predicate: { any: Array.from({ length: 5_000 }, () => ({ id: { isNull: true } })) } }) }
  const k = new KernelRegistry(config, { plugins: [identity, localAuth, tenancy, rbac, policy] })
  await expect(run({ entity: 'clients', select: ['id'], limit: 1 }, k)).rejects.toMatchObject({ code: 'query_too_expensive' })
  expect(queries).toEqual([])
})
