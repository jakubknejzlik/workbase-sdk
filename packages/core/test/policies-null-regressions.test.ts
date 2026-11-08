import { beforeEach, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { z } from 'zod'
import { setup, runtime, policyGraph } from './fixtures/policy-graph/setup'
import { request, json } from '@workbasehq/test-support/helpers'
import { defineInstance } from '../src/config'
import { createApp } from '../src/app'
import { KernelRegistry } from '../src/kernel/registry'
import { resolveActor, requireScope } from '../src/authorization'
import { executeAtomic } from '../src/execution/atomic'
import { coreExecutionContext } from '../src/execution/context'
import { D1AtomicReader, D1AtomicStore } from '../src/execution/d1'
import { createCommandRegistry } from '../src/commands'
import { renderStatement } from '../src/query/compiler'
import { Q } from '@jakub.knejzlik/ts-query'
import type { AtomicOperation } from '../src/execution/types'

beforeEach(async () => { await setup() })
const where = { not: { name: { gt: '$actor.team_id' } } }
const nullConfig = () => defineInstance({ ...policyGraph, policies: { ...policyGraph.policies, records: { ...policyGraph.policies.records, reviewer: { where } } } })
async function live(config = nullConfig()) {
  return requireScope(await resolveActor(new Request('http://localhost', { headers: { Authorization: 'Bearer synthetic-reviewer' } }), runtime(), new KernelRegistry(config).config), 'org-a', new KernelRegistry(config).config)
}
it('NULL actor in NOT cannot authorize UPDATE or commit audit/replay effects', async () => {
  await env.DB.prepare("UPDATE users SET team_id=NULL WHERE id='reviewer'").run()
  const op: AtomicOperation = { name: 'records/move', permission: { entity: 'records', operation: 'update' }, input: z.strictObject({}), plan: () => ({
    rules: [{ name: 'rename', statements: [{ sql: 'UPDATE records SET name=? WHERE id=?', bindings: ['Changed', 'record-own'], expectRows: 1 }] }],
    event: { entity: 'records', entityId: 'record-own', operation: 'test.rename' }, result: { status: 200, body: {} },
  }) }
  const kernel = new KernelRegistry(nullConfig(), { commands: createCommandRegistry([op]) })
  await expect(executeAtomic(op, {}, coreExecutionContext(kernel.config, await live(kernel.config), new D1AtomicStore(env.DB), new D1AtomicReader(env.DB), 'null-update'))).rejects.toMatchObject({ status: 403, code: 'policy_violation' })
  expect(await env.DB.prepare("SELECT name FROM records WHERE id='record-own'").first('name')).toBe('own')
  for (const table of ['audit_outbox', 'idempotency_keys', 'atomic_assert']) expect(await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first('n')).toBe(0)
})
it('NULL actor canary oracle stays empty on query, REST and cursor continuation', async () => {
  const app = createApp(nullConfig(), runtime())
  const query = { entity: 'records', select: ['id'], limit: 1 }
  const page = await json(await request(app, '/query', 'POST', query, 'reviewer'))
  expect(page.next_cursor).toBeTruthy()
  await env.DB.prepare("UPDATE users SET team_id=NULL WHERE id='reviewer'").run()
  for (const response of [
    await request(app, '/query', 'POST', query, 'reviewer'),
    await request(app, '/query', 'POST', { ...query, cursor: page.next_cursor }, 'reviewer'),
    await request(app, '/api/records', 'GET', undefined, 'reviewer'),
  ]) {
    expect(response.status).toBe(200)
    const body = await json(response)
    expect(body).toEqual({ data: [], next_cursor: null })
    expect(JSON.stringify(body)).not.toMatch(/CANARY|record-/)
  }
  expect((await request(app, '/api/records/record-CANARY_ROW', 'GET', undefined, 'reviewer')).status).toBe(404)
  expect((await request(app, '/api/records/record-own', 'PATCH', { name: 'Changed', version: 1 }, 'reviewer')).status).toBe(404)
})
it('NULL actor in NOT denies includes and the shared dashboard count compiler', async () => {
  await env.DB.prepare("UPDATE users SET team_id=NULL WHERE id='reviewer'").run()
  const config = defineInstance({ ...nullConfig(), policies: { ...nullConfig().policies, jobs: { ...policyGraph.policies.jobs, reviewer: { where: { not: { title: { lt: '$actor.team_id' } } } } } } })
  const kernel = new KernelRegistry(config)
  const statement = renderStatement(kernel, await live(kernel.config), Q.select().from('records', 'count_row').field(Q.raw('COUNT(*)'), 'n'))
  expect(await env.DB.prepare(statement.sql).bind(...statement.bindings).first('n')).toBe(0)
  // The parent grant is independent; only the included child has the NULL dependency.
  const withParents = defineInstance({ ...config, policies: { ...config.policies, records: { ...config.policies.records, reviewer: 'all' } } })
  const response = await request(createApp(withParents, runtime()), '/query', 'POST', { entity: 'records', select: ['id'], limit: 10, include: { jobs: { select: ['id'] } } }, 'reviewer')
  expect(response.status).toBe(200)
  expect((await json(response)).data.flatMap((row: any) => row.jobs)).toEqual([])
})
it.each([
  { not: { team_id: { eq: '$actor.team_id' } } },
  { team_id: { ne: '$actor.team_id' } },
  { not: { not: { name: { contains: '$actor.team_id' } } } },
  { or: [{ name: { isNull: false } }, { name: { lt: '$actor.team_id' } }] },
  { jobs: { none: { title: { lt: '$actor.team_id' } } } },
])('NULL actor cannot widen negated or combined policy %#', async where => {
  await env.DB.prepare("UPDATE users SET team_id=NULL WHERE id='reviewer'").run()
  const config = defineInstance({ ...policyGraph, policies: { ...policyGraph.policies, records: { ...policyGraph.policies.records, reviewer: { where } } } })
  const response = await request(createApp(config, runtime()), '/query', 'POST', { entity: 'records', select: ['id'], limit: 10 }, 'reviewer')
  expect(response.status).toBe(200)
  expect(await json(response)).toEqual({ data: [], next_cursor: null })
})
