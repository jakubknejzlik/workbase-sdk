// Ported from the independent FIX FIRST review (2026-10-24).
import { beforeEach, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { setup, runtime, policyGraph } from './fixtures/policy-graph/setup'
import { request, json } from '@workbasehq/test-support/helpers'
import { defineInstance } from '../src/config'
import { createApp } from '../src/app'
import { KernelRegistry } from '../src/kernel/registry'
import { executeQuery } from '../src/query/executor'
import { live } from './review-policies-helpers'
let app: Awaited<ReturnType<typeof setup>>
beforeEach(async () => { app = await setup(); })
it.each(['lt', 'lte', 'gt', 'gte', 'contains'])('review: NOT with NULL actor operand fails closed for %s', async (op) => {
    await env.DB.prepare("UPDATE users SET team_id=NULL WHERE id='reviewer'").run()
    const where = { not: { name: { [op]: '$actor.team_id' } } }
    const config = defineInstance({ ...policyGraph, policies: { ...policyGraph.policies, records: { ...policyGraph.policies.records, reviewer: { where } } } })
    const kernel = new KernelRegistry(config)
    const scope = await live('reviewer', kernel.config)
    const actual = await executeQuery(kernel, scope, env.DB, 'synthetic-review-secret', { entity: 'records', limit: 10, select: ['id'] }, { writeLog: () => { } })
    expect(actual.data).toEqual([])
})
it('review: NULL actor in NOT cannot authorize CREATE', async () => {
    await env.DB.prepare("UPDATE users SET team_id=NULL WHERE id='reviewer'").run()
    const config = defineInstance({ ...policyGraph, policies: { ...policyGraph.policies, records: { ...policyGraph.policies.records, reviewer: { where: { not: { name: { lt: '$actor.team_id' } } } } } } })
    const raw = await env.DB.prepare('SELECT id FROM records WHERE organization_id=? AND NOT(name<?)').bind('org-a', null).all()
    expect(raw.results).toEqual([])
    const a = createApp(config, runtime())
    const r = await request(a, '/api/records', 'POST', { name: 'Outside', team_id: 'team-b' }, 'reviewer')
    expect(r.status).toBe(403)
    expect((await json(r)).error).toBe('policy_violation')
})
