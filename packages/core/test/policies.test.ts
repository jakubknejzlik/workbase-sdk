import { beforeEach, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { setup, runtime, policyGraph, roles } from './fixtures/policy-graph/setup'
import { request, json } from '@workbasehq/test-support/helpers'
import { defineInstance } from '../src/config'
import { KernelRegistry } from '../src/kernel/registry'
import { legacyPermissions as rbac } from '@workbasehq/plugins/permissions'
import { identity } from '@workbasehq/plugins/identity'
import { localAuth } from '@workbasehq/plugins/local-auth'
import { tenancy } from '../src/kernel/adapters/tenancy'
import { resolveActor, requireScope } from '../src/authorization'
import { executeQuery } from '../src/query/executor'
import { compileRoot } from '../src/query/compiler'
import { validateQuery } from '../src/query/schema'
import { protectedActorFields } from '../src/policies'

let app: Awaited<ReturnType<typeof setup>>
beforeEach(async () => { app = await setup() })
const query = (entity: string, extra = {}) => ({ entity, limit: 100, select: ['id'], ...extra })
const ask = (entity: string, role: string, extra = {}) => request(app, '/query', 'POST', query(entity, extra), role)
const ids = (value: any) => value.data.map((row: any) => row.id).sort()
const canarySafe = (value: unknown) => expect(JSON.stringify(value)).not.toMatch(/CANARY_(?:ORG|ROW|ACCOUNT)|SECRET_FILES_CANARY/)
async function live(role: string, config = policyGraph) {
  return requireScope(await resolveActor(new Request('http://localhost', { headers: { Authorization: `Bearer synthetic-${role}` } }), runtime(), new KernelRegistry(config).config), 'org-a', new KernelRegistry(config).config)
}

it.each([
  ['records', 'administrator', ['record-own', 'record-colleague', 'record-CANARY_ROW']],
  ['records', 'coordinator', ['record-own', 'record-colleague', 'record-CANARY_ROW']],
  ['records', 'operator', ['record-own', 'record-colleague', 'record-CANARY_ROW']],
  ['records', 'reviewer', ['record-own', 'record-colleague']],
  ['records', 'team_user', ['record-own', 'record-colleague']],
  ['jobs', 'administrator', ['job-own', 'job-colleague', 'job-CANARY_ROW']],
  ['jobs', 'coordinator', ['job-own', 'job-colleague', 'job-CANARY_ROW']],
  ['jobs', 'operator', ['job-own', 'job-colleague', 'job-CANARY_ROW']],
  ['jobs', 'reviewer', ['job-own', 'job-colleague']],
  ['jobs', 'team_user', ['job-own', 'job-colleague']],
  ['reports', 'administrator', ['report-own', 'report-colleague', 'report-CANARY_ROW']],
  ['reports', 'reviewer', ['report-own']],
  ['reports', 'team_user', ['report-own', 'report-colleague']],
  ['reports', 'coordinator', []], ['reports', 'operator', []],
  ...(['administrator', 'coordinator', 'operator'] as const).flatMap(role => [
    ['users', role, ['administrator', 'assignable', 'reviewer', 'reviewer-colleague', 'reviewer-other', 'coordinator', 'team_user', 'operator', 'operator-other', 'unknown']],
    ['teams', role, ['team-a', 'team-b']],
  ]),
  ['teams', 'reviewer', ['team-a']], ['teams', 'team_user', ['team-a']],
  ['work_logs', 'administrator', ['log-operator', 'log-operator-other']],
  ['work_logs', 'operator', ['log-operator']],
])('RFC §13 %s/%s returns the exact authorized rows', async (entity, role, expected) => {
  const response = await ask(entity as string, role as string)
  expect(response.status).toBe(200)
  expect(ids(await json(response))).toEqual([...(expected as string[])].sort())
})
it.each(['reviewer', 'team_user'])('users/%s unions self, team, role constants and assignable', async role => {
  const response = await ask('users', role)
  expect(response.status).toBe(200)
  expect(ids(await json(response))).toEqual(['administrator', 'assignable', 'reviewer', 'reviewer-colleague', 'coordinator', 'team_user', 'operator', 'operator-other', 'unknown'].sort())
})
it.each(['coordinator', 'reviewer', 'team_user'])('work_logs/%s returns a closed 403', async role => {
  const response = await ask('work_logs', role)
  expect(response.status).toBe(403); expect(await json(response)).toEqual({ error: 'policy_violation', path: [] })
})
it('operator gets 403 for another operator log through query and REST', async () => {
  for (const response of [await ask('work_logs', 'operator', { where: { id: { eq: 'log-operator-other' } } }), await request(app, '/api/work_logs/log-operator-other', 'GET', undefined, 'operator')]) {
    expect(response.status).toBe(403); canarySafe(await json(response))
  }
})
it('INFD-315 omits internal job files by default, explicit unreadable selections are refused', async () => {
  for (const role of ['reviewer', 'team_user']) {
    const response = await request(app, '/query', 'POST', { entity: 'jobs', limit: 10 }, role)
    expect(response.status).toBe(200)
    const body = await json(response); expect(body.data).toHaveLength(2)
    expect(body.data.every((row: any) => !Object.hasOwn(row, 'internal_files_ids'))).toBe(true); canarySafe(body)
    expect((await ask('jobs', role, { select: ['internal_files_ids'] })).status).toBe(403)
  }
})
it.each([...roles, 'unknown'])('canary oracle spans all entities for %s', async role => {
  for (const entity of Object.keys(policyGraph.entities)) {
    const response = await ask(entity, role); const body = await json(response)
    const expectedCounts: Record<string, Record<string, number>> = {
      administrator: { records: 3, jobs: 3, reports: 3, users: 10, teams: 2, work_logs: 2 },
      coordinator: { records: 3, jobs: 3, reports: 0, users: 10, teams: 2, work_logs: 403 },
      operator: { records: 3, jobs: 3, reports: 0, users: 10, teams: 2, work_logs: 1 },
      reviewer: { records: 2, jobs: 2, reports: 1, users: 9, teams: 1, work_logs: 403 },
      team_user: { records: 2, jobs: 2, reports: 2, users: 9, teams: 1, work_logs: 403 },
      unknown: { records: 0, jobs: 0, reports: 0, users: 0, teams: 0, work_logs: 0 },
    }
    const expected = expectedCounts[role][entity]
    if (expected === 403) { expect(response.status).toBe(403); expect(body.error).toBe('policy_violation') }
    else { expect(response.status).toBe(200); expect(body.data).toHaveLength(expected); expect(body.next_cursor).toBeNull() }
    expect(JSON.stringify(body)).not.toContain('CANARY_ORG')
    if (['reviewer', 'team_user', 'unknown'].includes(role) && entity !== 'users') canarySafe(body)
    if (role === 'unknown') expect(body.data ?? []).toEqual([])
  }
})
it('INFD-228 an unmapped account gets no entity rows even with a mapped role', async () => {
  await env.DB.prepare("UPDATE users SET organization_id='org-b',team_id='team-canary' WHERE id='unknown'").run()
  await env.DB.prepare("UPDATE memberships SET role='reviewer' WHERE user_id='unknown'").run()
  for (const entity of Object.keys(policyGraph.entities)) expect((await json(await ask(entity, 'unknown'))).data ?? []).toEqual([])
})
it('live actor attributes and membership role change between requests; token claims are ignored', async () => {
  expect(ids(await json(await ask('records', 'reviewer')))).toEqual(['record-colleague', 'record-own'])
  await env.DB.prepare("UPDATE users SET team_id='team-b' WHERE id='reviewer'").run()
  expect(ids(await json(await ask('records', 'reviewer')))).toEqual(['record-CANARY_ROW'])
  await env.DB.prepare("UPDATE memberships SET role='unknown' WHERE user_id='reviewer'").run()
  expect(ids(await json(await ask('records', 'reviewer')))).toEqual([])
})
it('policy paths compile into correlated EXISTS to depth four; only scalar membership uses json_each', async () => {
  const kernel = new KernelRegistry(policyGraph); const scope = await live('team_user', kernel.config)
  const parsed = validateQuery(kernel, scope, query('reports')).query
  const compiled = compileRoot(kernel, scope, parsed)
  expect((compiled.sql.match(/EXISTS/g) ?? []).length).toBeGreaterThanOrEqual(4)
  expect(compiled.sql).not.toMatch(/\b(?:NOT )?IN\s*\(\s*SELECT(?! CASE WHEN type IN \('integer', 'real'\) THEN CAST\(value AS REAL\) ELSE value END FROM json_each)/i)
  expect(compiled.sql).not.toContain('$actor'); expect(JSON.stringify(compiled.bindings)).toContain('team_user')
})
it('mutation: disabling only RBAC policy compilation turns the canary oracle red', async () => {
  const mutated = new KernelRegistry(policyGraph, { plugins: [identity, localAuth, tenancy, { ...rbac, tableFilter: () => ({ kind: 'all' }) }] })
  const scope = await live('reviewer', mutated.config)
  const leaked = await executeQuery(mutated, scope, env.DB, 'synthetic-policyGraph-query-secret', query('records'), { writeLog: () => {} })
  expect(() => canarySafe(leaked)).toThrow()
  const safe = await json(await ask('records', 'reviewer')); canarySafe(safe)
})
it.each([
  { policies: { missing: { reviewer: 'all' } } },
  { policies: { records: { absent: 'all' } } },
  { policies: { records: { reviewer: { where: { absent: { eq: 1 } } } } } },
  { policies: { records: { reviewer: { where: { team_id: { contains: 'x' } } } } } },
  { policies: { records: { reviewer: { where: { name: { eq: '$actor.missing' } } } } } },
  { policies: { records: { reviewer: { where: { team: { team_users: { some: { team: { team_users: { some: { team: {} } } } } } } } } } } },
  { policies: { records: { reviewer: { where: {}, fields: ['missing'] } } } },
])('invalid policy configuration fails during whole-model validation %#', input => {
  expect(() => defineInstance({ ...policyGraph, ...input } as any)).toThrow()
})
it('computes actor integrity fields once from the validated policy tree', () => {
  expect([...protectedActorFields(policyGraph)].sort()).toEqual(['id', 'role', 'team_id'])
  const withRole = defineInstance({ ...policyGraph, policies: { ...policyGraph.policies, users: { reviewer: { where: { role: { eq: '$actor.role' } } } } } })
  expect(protectedActorFields(withRole).has('role')).toBe(true)
})

it('Bearer agent policies bind the live issuer account and lose access on membership role loss', async () => {
  const { sha256 } = await import('../src/crypto')
  const token = 'wb_synthetic_policyGraph_reviewer'
  await env.DB.prepare('INSERT INTO access_tokens (id,organization_id,issuer_id,name,token_hash,prefix,role,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)').bind('agent-reviewer', 'org-a', 'reviewer', 'Reviewer agent', await sha256(token), 'wb_synthetic', 'reviewer', '2099-01-01T00:00:00.000Z', 'now').run()
  const call = () => request(app, '/query', 'POST', query('records'), 'reviewer', 'org-a', { Authorization: `Bearer ${token}` })
  const allowed = await call(); expect(allowed.status).toBe(200)
  expect(ids(await json(allowed))).toEqual(['record-colleague', 'record-own'])
  await env.DB.prepare("UPDATE memberships SET role='unknown' WHERE user_id='reviewer'").run()
  expect((await json(await call())).data).toEqual([])
})
it('nested record jobs and none filters cannot reveal a linked job outside the team policy', async () => {
  await env.DB.prepare("UPDATE jobs SET record_id='record-own' WHERE id='job-CANARY_ROW'").run()
  const response = await ask('records', 'reviewer', { include: { jobs: { select: ['id'] } }, where: { jobs: { none: { id: { eq: 'job-CANARY_ROW' } } } } })
  expect(response.status).toBe(200)
  const body = await json(response); canarySafe(body)
  expect(ids(body)).toEqual(['record-colleague', 'record-own'])
  expect(body.data.flatMap((row: any) => row.jobs)).toHaveLength(2)
})
it('policy and/not/1:n none use the shared grammar and compile to scoped NOT EXISTS', async () => {
  const config = defineInstance({ ...policyGraph, policies: { ...policyGraph.policies, records: { ...policyGraph.policies.records, reviewer: { where: { and: [
    { team_id: { eq: '$actor.team_id' } }, { not: { name: { contains: 'excluded' } } }, { jobs: { none: { title: { eq: 'CANARY_ROW' } } } },
  ] } } } } })
  const kernel = new KernelRegistry(config); const scope = await live('reviewer', kernel.config)
  const parsed = validateQuery(kernel, scope, query('records')).query
  expect(compileRoot(kernel, scope, parsed).sql).toContain('NOT EXISTS')
  const result = await executeQuery(kernel, scope, env.DB, 'synthetic-policyGraph-query-secret', parsed, { writeLog: () => {} })
  expect(ids(result)).toEqual(['record-colleague', 'record-own']); canarySafe(result)
})
it('unreadable policy fields are refused in filters and ordering without exposing their values', async () => {
  for (const extra of [{ where: { internal_files_ids: { contains: 'SECRET_FILES_CANARY' } } }, { orderBy: [{ field: 'internal_files_ids', dir: 'asc' }] }]) {
    const response = await ask('jobs', 'reviewer', extra)
    expect(response.status).toBe(403)
    const body = await json(response); expect(body.error).toBe('field_forbidden'); canarySafe(body)
  }
})
it('authorized cursor pages exclude same-org and foreign-org canaries', async () => {
  const first = await ask('records', 'reviewer', { limit: 1 }); const body = await json(first)
  expect(first.status).toBe(200); expect(body.next_cursor).toBeTruthy(); canarySafe(body)
  const second = await json(await ask('records', 'reviewer', { limit: 1, cursor: body.next_cursor }))
  canarySafe(second); expect([...ids(body), ...ids(second)].sort()).toEqual(['record-colleague', 'record-own'])
})
