import { env } from 'cloudflare:workers'
import { z } from 'zod'
import { runtime, policyGraph } from './fixtures/policy-graph/setup'
import { KernelRegistry } from '../src/kernel/registry'
import { resolveActor, requireScope } from '../src/authorization'
import { executeAtomic } from '../src/execution/atomic'
import { coreExecutionContext } from '../src/execution/context'
import { D1AtomicReader, D1AtomicStore } from '../src/execution/d1'
import { createCommandRegistry } from '../src/commands'
import type { AtomicOperation } from '../src/execution/types'
export async function live(role: string, config = policyGraph) {
    return requireScope(await resolveActor(new Request('http://localhost', { headers: { Authorization: `Bearer synthetic-${role}` } }), runtime(), new KernelRegistry(config).config), 'org-a', new KernelRegistry(config).config)
}
export function operation(sql: string, bindings: string[], entity = 'users'): AtomicOperation {
    return { name: 'users/change', permission: { entity, operation: 'update' }, input: z.strictObject({}), plan: () => ({ rules: [{ name: 'review_change', statements: [{ sql, bindings, expectRows: 1 }] }], result: { status: 200, body: { ok: true } }, event: { entity, entityId: 'reviewer', operation: 'review.changed' } }) }
}
export async function atomic(op: AtomicOperation, role = 'reviewer') {
    const kernel = new KernelRegistry(policyGraph, { commands: createCommandRegistry([op]) })
    const scope = await live(role, kernel.config)
    return executeAtomic(op, {}, coreExecutionContext(kernel.config, scope, new D1AtomicStore(env.DB), new D1AtomicReader(env.DB)))
}
