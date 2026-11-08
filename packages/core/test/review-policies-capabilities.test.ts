// Ported from the independent FIX FIRST review (2026-10-24).
import { beforeEach, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { setup, policyGraph } from './fixtures/policy-graph/setup'
import { defineInstance } from '../src/config'
import { KernelRegistry } from '../src/kernel/registry'
import { executeQuery } from '../src/query/executor'
import { capabilities } from '../src/capabilities'
import { live } from './review-policies-helpers'
let app: Awaited<ReturnType<typeof setup>>
beforeEach(async () => { app = await setup(); })
it('review: capability readable must remain selectable when policy omits id', async () => {
    const config = defineInstance({ ...policyGraph, policies: { ...policyGraph.policies, users: { ...policyGraph.policies.users, reviewer: { where: {}, fields: ['name'] } } } })
    const kernel = new KernelRegistry(config)
    const scope = await live('reviewer', kernel.config)
    const doc = capabilities(kernel, scope)
    expect(doc.entities.users.readable).toContain('name')
    await expect(executeQuery(kernel, scope, env.DB, 'synthetic-review-secret', { entity: 'users', limit: 10, select: ['name'] }, { writeLog: () => { } })).resolves.toBeDefined()
})
