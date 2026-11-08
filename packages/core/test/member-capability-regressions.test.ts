// Adapted from the independent round-2 F2 witnesses; package aliases are tested in infra.
import { beforeEach, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { z } from 'zod'
import { setup, policyGraph, runtime } from './fixtures/policy-graph/setup'
import { request, json } from '@workbasehq/test-support/helpers'
import { operation, live, atomic } from './review-policies-helpers'
import { KernelRegistry } from '../src/kernel/registry'
import { defineInstance } from '../src/config'
import { executeAtomic } from '../src/execution/atomic'
import * as contexts from '../src/execution/context'
import { D1AtomicReader, D1AtomicStore } from '../src/execution/d1'
import { createCommandRegistry } from '../src/commands'
import { createWorkflowRegistry } from '../src/workflow-runtime'
import type { AtomicOperation, ExecutionContext } from '../src/execution/types'

beforeEach(async () => { await setup() })
// Keep the exploit executable on the vulnerable revision and the attack's protected
// plan executable after the setter is removed (rather than passing on import failure).
function legacyMint(context: ExecutionContext, op: AtomicOperation) {
  const setter = (contexts as Record<string, unknown>).memberManagementContext
  if (typeof setter === 'function') setter(context, op)
}
const promotion = () => operation('UPDATE memberships SET role=? WHERE user_id=? AND organization_id=?', ['administrator', 'reviewer-colleague', 'org-a'])
async function unchanged() {
  expect(await env.DB.prepare("SELECT role FROM memberships WHERE user_id='reviewer-colleague'").first('role')).toBe('reviewer')
  expect(await env.DB.prepare('SELECT count(*) AS n FROM audit_outbox').first('n')).toBe(0)
}
it('F2 request and plan fields cannot supply provenance', async () => {
  const op = promotion()
  op.input = z.record(z.string(), z.unknown())
  const plan = op.plan
  op.plan = (ctx, body) => ({ ...plan(ctx, body), memberManagement: 'update', memberManagementMode: 'update', provenance: true })
  const app = await setup({ commands: createCommandRegistry([op]) })
  const response = await request(app, '/commands/users/change', 'POST', { memberManagement: 'update', scope: { role: 'owner' }, permission: { system: 'members.update' } }, 'reviewer')
  expect(response.status).toBe(403)
  expect(await json(response)).toMatchObject({ error: 'field_forbidden' })
  await unchanged()
})
it('F2 generic command cannot mint the core member capability during prepare', async () => {
  const forged: AtomicOperation = { ...promotion(), name: 'invitations/accept', permission: { system: 'invitations.accept' } }
  const plan = forged.plan
  forged.plan = (ctx, body) => { forged.permission = { system: 'members.update' }; return plan(ctx, body) }
  const op = operation('UPDATE users SET name=name WHERE id=?', ['reviewer'])
  op.prepare = async ctx => {
    const original = Object.getPrototypeOf(ctx)
    if (original && original.scope) {
      legacyMint(original, forged)
      return executeAtomic(forged, {}, original)
    }
    // With no leaked verified context, attempt the same write in the outer plan.
  }
  const outer = op.plan
  op.plan = (ctx, body) => Object.getPrototypeOf(ctx)?.scope ? outer(ctx, body) : promotion().plan(ctx, body)
  const app = await setup({ commands: createCommandRegistry([op]) })
  const ask = () => request(app, '/query', 'POST', { entity: 'records', select: ['id'], limit: 10 }, 'reviewer-colleague')
  const before = await json(await ask())
  expect((await request(app, '/commands/users/change', 'POST', {}, 'reviewer')).status).toBe(403)
  expect(await json(await ask())).toEqual(before)
  await unchanged()
})
it('F2 generic owner plan cannot set member-route provenance itself', async () => {
  await env.DB.prepare("UPDATE memberships SET role='owner' WHERE user_id='administrator'").run()
  const config = defineInstance({ ...policyGraph, roles: [...policyGraph.roles, 'owner'], organizationPermissions: { owner: ['members.update'] }, permissions: { ...policyGraph.permissions, owner: policyGraph.permissions.administrator } })
  const op: AtomicOperation = { ...promotion(), name: 'members/update', permission: { system: 'members.update' } }
  const plan = op.plan
  op.plan = (ctx, body) => { legacyMint(Object.getPrototypeOf(ctx) ?? ctx, op); return plan(ctx, body) }
  const kernel = new KernelRegistry(config)
  await expect(executeAtomic(op, {}, contexts.coreExecutionContext(kernel.config, await live('administrator', kernel.config), new D1AtomicStore(env.DB), new D1AtomicReader(env.DB)))).rejects.toMatchObject({ status: 403, code: 'field_forbidden' })
  await unchanged()
})
function inspectCallback(context: object) {
  expect(Object.isFrozen(context)).toBe(true)
  expect(Object.getPrototypeOf(context)).toBe(null)
  const seen = new Set<object>()
  function walk(value: unknown) {
    if (!value || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    for (let object: object | null = value; object && object !== Object.prototype && object !== Array.prototype; object = Object.getPrototypeOf(object)) {
      for (const key of Reflect.ownKeys(object)) {
        const descriptor = Object.getOwnPropertyDescriptor(object, key)!
        expect(typeof key).toBe('string')
        expect(String(key)).not.toMatch(/memberManagement|capability|provenance|\bdb\b|store/)
        if ('value' in descriptor) walk(descriptor.value)
      }
    }
  }
  walk(context)
  expect(Object.isFrozen((context as ExecutionContext).scope)).toBe(true)
  expect(Object.isFrozen((context as ExecutionContext).scope.actor)).toBe(true)
  expect(Reflect.set((context as ExecutionContext).scope, 'role', 'owner')).toBe(false)
}
it('command prepare and plan descriptor walks expose frozen data without a verified context or capability', async () => {
  const op = operation('UPDATE users SET name=name WHERE id=?', ['reviewer'])
  const calls: string[] = []
  op.prepare = async ctx => { inspectCallback(ctx); calls.push('prepare') }
  const plan = op.plan
  op.plan = (ctx, body) => { inspectCallback(ctx); calls.push('plan'); return plan(ctx, body) }
  expect((await atomic(op)).status).toBe(200)
  expect(calls).toEqual(['prepare', 'plan'])
})
it('membership and permission mutation during prepare cannot upgrade invitation authority', async () => {
  const op: AtomicOperation = { ...promotion(), name: 'invitations/accept', permission: { system: 'invitations.accept' } }
  op.prepare = async ctx => {
    // Synthetic competing request changes live storage after this request's snapshot.
    await env.DB.prepare("UPDATE memberships SET role='owner' WHERE user_id='reviewer'").run()
    expect(Reflect.set(ctx.scope, 'role', 'owner')).toBe(false)
    const original = Object.getPrototypeOf(ctx)
    if (original?.scope) legacyMint(original, op)
    op.permission = { system: 'members.update' }
  }
  await expect(atomic(op)).rejects.toMatchObject({ status: 403, code: 'field_forbidden' })
  await unchanged()
})
it('workflow step receives a frozen wrapper and context without member authority', async () => {
  let inspected = false
  const op = operation('UPDATE users SET name=name WHERE id=?', ['reviewer'])
  const workflows = createWorkflowRegistry([{ name: 'users/inspect', version: '1', input: z.strictObject({}), steps: [{ id: 'inspect', operation: op, sideEffect: false, policy: { maxAttempts: 1, backoffMs: 0, timeoutMs: 1000, deadlineMs: 10000 }, run: async args => {
    expect(Object.isFrozen(args)).toBe(true)
    inspectCallback(args.context)
    inspected = true
    return executeAtomic(op, {}, args.context)
  } }] }])
  const app = await setup({ commands: createCommandRegistry([op]), workflows })
  expect((await request(app, '/workflows/users/inspect', 'POST', { idempotencyKey: 'frozen-step' }, 'reviewer')).status).toBe(202)
  expect((await request(app, '/internal/workflows/run', 'POST', {}, 'reviewer', 'org-a', { 'X-Internal-Token': runtime().INTERNAL_TOKEN })).status).toBe(200)
  expect(inspected).toBe(true)
})
it('rejected assignment forms retain 422 unsupported_atomic_operation', async () => {
  const op = operation('UPDATE memberships AS m SET role=? WHERE m.user_id=?', ['administrator', 'reviewer'])
  const app = await setup({ commands: createCommandRegistry([op]) })
  const response = await request(app, '/commands/users/change', 'POST', {}, 'reviewer')
  expect(response.status).toBe(422)
  expect(await json(response)).toMatchObject({ error: 'unsupported_atomic_operation' })
})
