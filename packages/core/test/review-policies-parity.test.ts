// Ported from the independent FIX FIRST review (2026-10-24).
import { defaultOrganizationPermissions } from '../src/config'
import { beforeEach, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { setup, runtime, policyGraph } from './fixtures/policy-graph/setup'
import { request, json } from '@workbasehq/test-support/helpers'
import { defineInstance } from '../src/config'
import { createApp } from '../src/app'
import { KernelRegistry } from '../src/kernel/registry'
import { executeAtomic } from '../src/execution/atomic'
import { coreExecutionContext } from '../src/execution/context'
import { D1AtomicReader, D1AtomicStore } from '../src/execution/d1'
import { createCommandRegistry } from '../src/commands'
import { executeQuery } from '../src/query/executor'
import { live, operation } from './review-policies-helpers'
let app: Awaited<ReturnType<typeof setup>>
beforeEach(async () => { app = await setup(); })
it.each([
    ['eq', { name: { eq: 'own' } }], ['ne', { name: { ne: 'own' } }], ['in', { name: { in: ['own', null] } }], ['empty in', { name: { in: [] } }],
    ['lt', { name: { lt: 'own' } }], ['lte', { name: { lte: 'own' } }], ['gt', { name: { gt: 'own' } }], ['gte', { name: { gte: 'own' } }],
    ['contains', { name: { contains: 'own' } }], ['isNull', { name: { isNull: true } }], ['not nullable', { not: { name: { eq: 'own' } } }],
    ['and', { and: [{ name: { ne: 'own' } }, { name: { isNull: false } }] }], ['or', { or: [{ name: { eq: 'own' } }, { name: { eq: 'colleague' } }] }],
    ['n:1', { team: { name: { eq: 'A' } } }], ['some', { jobs: { some: { title: { eq: 'own' } } } }], ['none', { jobs: { none: { title: { eq: 'own' } } } }],
] as const)('review: policy/client grammar parity %s', async (_label, where) => {
    const config = defineInstance({ ...policyGraph, policies: { ...policyGraph.policies, records: { ...policyGraph.policies.records, reviewer: { where: where as any } } } })
    const kernel = new KernelRegistry(config)
    const scope = await live('reviewer', kernel.config)
    const ordinary = new KernelRegistry({ ...policyGraph, policies: { ...policyGraph.policies, records: { ...policyGraph.policies.records, reviewer: 'all' } } })
    const unrestricted = await live('reviewer', ordinary.config)
    const base = { entity: 'records', limit: 100, select: ['id'] }
    const p = await executeQuery(kernel, scope, env.DB, 'synthetic-review-secret', base, { writeLog: () => { } })
    const q = await executeQuery(ordinary, unrestricted, env.DB, 'synthetic-review-secret', { ...base, where }, { writeLog: () => { } })
    expect(p).toEqual(q)
})
it('review: NOT nullable policy excludes SQL UNKNOWN like client filters', async () => {
    await env.DB.prepare("UPDATE users SET team_id=NULL WHERE id='assignable'").run()
    const where = { not: { team_id: { eq: 'team-a' } } }
    const config = defineInstance({ ...policyGraph, policies: { ...policyGraph.policies, users: { ...policyGraph.policies.users, reviewer: { where } } } })
    const kernel = new KernelRegistry(config)
    const scope = await live('reviewer', kernel.config)
    const r = await executeQuery(kernel, scope, env.DB, 'synthetic-review-secret', { entity: 'users', limit: 100, select: ['id'] }, { writeLog: () => { } })
    expect(r.data.map(x => x.id)).not.toContain('assignable')
    expect(r.data.map(x => x.id)).toEqual(['operator-other', 'reviewer-other'])
})
it('review: large policy enforces 100 bindings with sanitized query_too_expensive', async () => {
    const config = defineInstance({ ...policyGraph, policies: { ...policyGraph.policies, records: { ...policyGraph.policies.records, reviewer: { where: { or: Array.from({ length: 100 }, (_, i) => ({ name: { eq: `synthetic-${i}` } })) } } } } })
    const a = createApp(config, runtime())
    const r = await request(a, '/query', 'POST', { entity: 'records', limit: 10, select: ['id'] }, 'reviewer')
    const b = await json(r)
    expect(JSON.stringify(b)).not.toMatch(/SELECT|synthetic-|bindings/)
    expect(b.error).toBe('query_too_expensive')
})
it.each(['coordinator', 'operator', 'reviewer', 'team_user'])('review: capability writable fields accept representative visible job writes for %s', async (role) => {
    const cap = await json(await request(app, '/o/org-a/capabilities', 'GET', undefined, role))
    expect(cap.entities.jobs.operations).toContain('update')
    const values: Record<string, unknown> = { title: 'Updated', reviewer_user_id: 'reviewer', operator_user_id: 'operator', record_id: 'record-own', report_id: 'report-own', internal_files_ids: 'synthetic-private-file' }
    let version = 1
    for (const field of cap.entities.jobs.writable) {
        const r = await request(app, '/api/jobs/job-own', 'PATCH', { [field]: values[field], version }, role)
        expect(r.status, `${role} ${field}`).toBe(200)
        version++
    }
})
it('review: omitted capability actor dependencies reject own row writes', async () => {
    const cap = await json(await request(app, '/o/org-a/capabilities', 'GET', undefined, 'reviewer'))
    for (const field of ['role', 'team_id']) {
        expect(cap.entities.users.writable).not.toContain(field)
        const r = await request(app, '/api/users/reviewer', 'PATCH', { [field]: field === 'role' ? 'reviewer' : 'team-a', version: 1 }, 'reviewer')
        expect(r.status).toBe(403)
        expect((await json(r)).error).toBe('field_forbidden')
    }
})
it('review: policy missing grant remains empty on REST, includes and cursor', async () => {
    const config = defineInstance({ ...policyGraph, policies: { ...policyGraph.policies, reports: { administrator: 'all' } }, entities: { ...policyGraph.entities, jobs: { ...policyGraph.entities.jobs, relations: { ...policyGraph.entities.jobs.relations, report: { entity: 'reports', field: 'report_id' } } } } })
    const a = createApp(config, runtime())
    const list = await request(a, '/api/reports', 'GET', undefined, 'coordinator')
    expect(list.status).toBe(200)
    expect(await json(list)).toEqual({ data: [], next_cursor: null })
    expect((await request(a, '/api/reports/report-own', 'GET', undefined, 'coordinator')).status).toBe(404)
    const q = await request(a, '/query', 'POST', { entity: 'jobs', limit: 1, select: ['id'], include: { report: { select: ['id'] } } }, 'coordinator')
    expect(q.status).toBe(200)
    const body = await json(q)
    expect(body.data[0].report).toBeNull()
    expect(body.next_cursor).toBeTruthy()
    const next = await request(a, '/query', 'POST', { entity: 'jobs', limit: 1, select: ['id'], include: { report: { select: ['id'] } }, cursor: body.next_cursor }, 'coordinator')
    expect(next.status).toBe(200)
    expect((await json(next)).data[0].report).toBeNull()
})
it('review: no account policy defaults to none for all read entities', async () => {
    const config = defineInstance({ ...policyGraph, policies: {} })
    const a = createApp(config, runtime())
    for (const entity of Object.keys(config.entities)) {
        const r = await request(a, '/query', 'POST', { entity, select: ['id'], limit: 10 }, 'administrator')
        expect(r.status).toBe(200)
        expect((await json(r)).data).toEqual([])
    }
})
it('review: include default projection omits masked job field', async () => {
    const r = await request(app, '/query', 'POST', { entity: 'records', limit: 10, include: { jobs: {} } }, 'reviewer')
    expect(r.status).toBe(200)
    const body = await json(r)
    expect(body.data.flatMap((x: any) => x.jobs)).toHaveLength(2)
    expect(JSON.stringify(body)).not.toMatch(/internal_files_ids|SECRET_FILES_CANARY/)
})
it.each([
    { team_id: { eq: '$actor.absent' } }, { absent_relation: { some: { id: { eq: 'x' } } } }, { name: { isNull: '$actor.role' } },
    { team_id: { eq: '$actor.assignable_to_job' } }, { team: { absent_field: { eq: 'x' } } },
])('review: malformed policies reject at validation %#', where => {
    expect(() => defineInstance({ ...policyGraph, policies: { records: { reviewer: { where } } } } as any)).toThrow()
})
it('review: policy compilation and query logs contain no actor attributes or SQL literals', async () => {
    const kernel = new KernelRegistry(policyGraph)
    const scope = await live('reviewer', kernel.config)
    const logs: unknown[] = []
    const r = await executeQuery(kernel, scope, env.DB, 'synthetic-review-secret', { entity: 'records', limit: 10, select: ['id'], where: { name: { eq: 'private-client-literal' } } }, { writeLog: l => logs.push(l) })
    expect(r.data).toEqual([])
    expect(JSON.stringify(logs)).not.toMatch(/team-a|private-client-literal|SELECT|bindings|\$actor/)
})
it('review: policy CREATE refuses another team without domain/audit side effects', async () => {
    const before = (await env.DB.prepare('SELECT count(*) AS n FROM records').first('n'))
    const r = await request(app, '/api/records', 'POST', { name: 'Rejected', team_id: 'team-b' }, 'reviewer')
    expect(r.status).toBe(403)
    expect((await json(r)).error).toBe('policy_violation')
    expect(await env.DB.prepare('SELECT count(*) AS n FROM records').first('n')).toBe(before)
    expect(await env.DB.prepare('SELECT count(*) AS n FROM audit_outbox').first('n')).toBe(0)
})
it('review: SQLite expression depth failure is sanitized to query_invalid', async () => {
    const config = defineInstance({ ...policyGraph, policies: { ...policyGraph.policies, records: { ...policyGraph.policies.records, reviewer: { where: { or: Array.from({ length: 130 }, () => ({ name: { isNull: false } })) } } } } })
    const a = createApp(config, runtime())
    const r = await request(a, '/query', 'POST', { entity: 'records', limit: 10, select: ['id'] }, 'reviewer')
    expect(r.status).toBe(400)
    expect(await json(r)).toEqual({ error: 'query_invalid', path: [] })
})
it.each([
    { assignable_to_job: { eq: true } }, { assignable_to_job: { ne: false } }, { assignable_to_job: { in: [true, null] } }, { assignable_to_job: { isNull: false } },
    { version: { eq: 1 } }, { version: { ne: 2 } }, { version: { in: [1, 2, null] } }, { version: { lt: 2 } }, { version: { lte: 1 } }, { version: { gt: 0 } }, { version: { gte: 1 } }, { version: { isNull: false } }
])('review: policy/client grammar parity bool and int %#', async (where) => {
    const config = defineInstance({ ...policyGraph, policies: { ...policyGraph.policies, users: { ...policyGraph.policies.users, reviewer: { where } } } })
    const ordinary = new KernelRegistry({ ...policyGraph, policies: { ...policyGraph.policies, users: { ...policyGraph.policies.users, reviewer: 'all' } } })
    const unrestricted = await live('reviewer', ordinary.config)
    const kernel = new KernelRegistry(config)
    const scope = await live('reviewer', kernel.config)
    const base = { entity: 'users', limit: 100, select: ['id'] }
    expect(await executeQuery(kernel, scope, env.DB, 'synthetic-review-secret', base, { writeLog: () => { } })).toEqual(await executeQuery(ordinary, unrestricted, env.DB, 'synthetic-review-secret', { ...base, where }, { writeLog: () => { } }))
})
it('review: command replay rechecks a newly tightened configured policy', async () => {
    const op = operation('UPDATE records SET name=? WHERE id=?', ['Replayed', 'record-own'], 'records')
    const kernel = new KernelRegistry(policyGraph, { commands: createCommandRegistry([op]) })
    const scope = await live('reviewer', kernel.config)
    expect((await executeAtomic(op, {}, coreExecutionContext(kernel.config, scope, new D1AtomicStore(env.DB), new D1AtomicReader(env.DB), 'review-policy-replay'))).status).toBe(200)
    const config = defineInstance({ ...policyGraph, policies: { ...policyGraph.policies, records: { ...policyGraph.policies.records, reviewer: { where: { team_id: { eq: 'team-b' } } } } } })
    const changed = new KernelRegistry(config, { commands: createCommandRegistry([op]) })
    const next = await live('reviewer', changed.config)
    await expect(executeAtomic(op, {}, coreExecutionContext(changed.config, next, new D1AtomicStore(env.DB), new D1AtomicReader(env.DB), 'review-policy-replay'))).rejects.toMatchObject({ status: 403, code: 'policy_violation' })
    expect(await env.DB.prepare('SELECT count(*) AS n FROM audit_outbox').first('n')).toBe(1)
})
it('review: owner member endpoint protects self and permits another member', async () => {
    const config = defineInstance({ ...policyGraph, roles: [...policyGraph.roles, 'owner', 'viewer'], organizationPermissions: { owner: defaultOrganizationPermissions.owner, viewer: [] }, permissions: { ...policyGraph.permissions, owner: policyGraph.permissions.administrator }, policies: Object.fromEntries(Object.entries(policyGraph.policies).map(([e, p]) => [e, { ...p, owner: 'all' }])) })
    await env.DB.prepare("UPDATE memberships SET role='owner' WHERE user_id IN ('administrator','operator')").run()
    app = createApp(config, runtime())
    const own = await request(app, '/orgs/org-a/members/administrator', 'PATCH', { role: 'viewer' }, 'administrator')
    expect(own.status).toBe(403)
    expect((await json(own)).error).toBe('field_forbidden')
    const other = await request(app, '/orgs/org-a/members/reviewer-colleague', 'PATCH', { role: 'viewer' }, 'administrator')
    expect(other.status).toBe(200)
    expect(await env.DB.prepare("SELECT role FROM memberships WHERE user_id='reviewer-colleague'").first('role')).toBe('viewer')
})
it('review: PUT cannot mutate a protected field', async () => {
    const r = await request(app, '/api/users/reviewer', 'PUT', { role: 'administrator', team_id: 'team-b', version: 1 }, 'reviewer')
    expect(r.status).toBe(404)
    expect(await env.DB.prepare("SELECT team_id FROM users WHERE id='reviewer'").first('team_id')).toBe('team-a')
})
it('review: invitation cannot rewrite an existing protected membership', async () => {
    const { sha256 } = await import('../src/crypto')
    await env.DB.prepare('INSERT INTO invitations (id,organization_id,email,role,token_hash,expires_at,inviter_id,created_at) VALUES (?,?,?,?,?,?,?,?)').bind('review-invitation', 'org-a', 'reviewer@example.test', 'viewer', await sha256('a'.repeat(64)), '2099-01-01T00:00:00.000Z', 'administrator', 'now').run()
    const r = await request(app, '/invitations/accept', 'POST', { token: 'a'.repeat(64), role: 'owner' }, 'reviewer')
    expect(r.status).toBe(403)
    expect((await json(r)).error).toBe('invalid_invitation_role')
    expect(await env.DB.prepare("SELECT role FROM memberships WHERE user_id='reviewer'").first('role')).toBe('reviewer')
})
it('review: capability revision matches schema and GET needs session without CSRF headers', async () => {
    const cap = await request(app, '/o/org-a/capabilities', 'GET', undefined, 'reviewer')
    expect(cap.status).toBe(200)
    const schema = await app.request('http://localhost/schema')
    expect((await json(cap)).revision).toBe((await json(schema)).revision)
    expect((await app.request('http://localhost/o/org-a/capabilities')).status).toBe(401)
})
it('review: REST omits masked job fields', async () => {
    for (const path of ['/api/jobs', '/api/jobs/job-own']) {
        const r = await request(app, path, 'GET', undefined, 'reviewer')
        expect(r.status).toBe(200)
        expect(JSON.stringify(await json(r))).not.toMatch(/internal_files_ids|SECRET_FILES_CANARY/)
    }
})
