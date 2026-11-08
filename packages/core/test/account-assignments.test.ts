import { beforeEach, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { z } from 'zod'
import { setup, runtime, policyGraph } from './fixtures/policy-graph/setup'
import { request, json } from '@workbasehq/test-support/helpers'
import { defineInstance, type InstanceConfig } from '../src/config'
import { KernelRegistry } from '../src/kernel/registry'
import { createApp } from '../src/app'
import { createCommandRegistry } from '../src/commands'
import { defineAtomicOperation, executeAtomic } from '../src/execution/atomic'
import { coreExecutionContext } from '../src/execution/context'
import { D1AtomicReader, D1AtomicStore } from '../src/execution/d1'
import { resolveActor, requireScope } from '../src/authorization'
import { protectedActorFields } from '../src/policies'

beforeEach(async () => { await setup(); await env.DB.exec('ALTER TABLE users ADD COLUMN practice_id TEXT') })
function model(managedBy?: string[], assignments?: string[]) {
  return defineInstance({ ...policyGraph, account: { entity: 'users', managedBy, assignments },
    entities: { ...policyGraph.entities, users: { ...policyGraph.entities.users, fields: { ...policyGraph.entities.users.fields, practice_id: { type: 'string' } } } },
    policies: { ...policyGraph.policies, records: { ...policyGraph.policies.records, reviewer: { where: { team_id: { eq: '$actor.practice_id' } } } } },
  })
}
async function change(config: InstanceConfig, path: string, role: string, field: string) {
  const value = field === 'assignable_to_job' ? true : field === 'team_id' ? 'team-b' : 'practice-b'
  const op = defineAtomicOperation({ name: 'users/change', permission: { entity: 'users', operation: 'update' }, input: z.strictObject({}), plan: () => ({
    rules: [{ name: 'assignment', statements: [{ sql: `UPDATE users SET ${field}=? WHERE id=? AND organization_id=?`, bindings: [typeof value === 'boolean' ? Number(value) : value, 'reviewer-colleague', 'org-a'], expectRows: 1 }] }],
    result: { status: 200, body: {} }, event: { operation: 'test.assignment', entity: 'users', entityId: 'reviewer-colleague' },
  }) })
  const commands = createCommandRegistry([op])
  const app = createApp(config, runtime(), { commands })
  if (path === 'atomic') {
    const kernel = new KernelRegistry(config, { commands })
    const actor = await resolveActor(new Request('http://localhost', { headers: { Authorization: `Bearer synthetic-${role}` } }), runtime(), kernel.config)
    const scope = await requireScope(actor, 'org-a', kernel.config)
    try { return await executeAtomic(op, {}, coreExecutionContext(kernel.config, scope, new D1AtomicStore(env.DB), new D1AtomicReader(env.DB))) }
    catch (error) { return { status: (error as { status: number }).status, body: { error: (error as { code: string }).code } } }
  }
  const response = await request(app, path === 'CRUD' ? '/api/users/reviewer-colleague' : '/commands/users/change', path === 'CRUD' ? 'PATCH' : 'POST', path === 'CRUD' ? { version: 1, [field]: value } : {}, role)
  return { status: response.status, body: await json(response) }
}
it.each(['CRUD', 'command', 'atomic'])('undeclared instance with administrator has no assignment allowance / %s', async path => {
  expect(await change(model(), path, 'administrator', 'team_id')).toMatchObject({ status: 403, body: { error: 'field_forbidden' } })
})
it.each(['CRUD', 'command', 'atomic'])('declared non-administrator manager can edit practice_id assignment / %s', async path => {
  expect((await change(model(['coordinator'], ['practice_id']), path, 'coordinator', 'practice_id')).status).toBe(200)
  expect(await env.DB.prepare("SELECT practice_id FROM users WHERE id='reviewer-colleague'").first('practice_id')).toBe('practice-b')
})
it.each(['CRUD', 'command', 'atomic'])('undeclared actor dependency stays protected and unmanageable / %s', async path => {
  expect(await change(model(['administrator'], ['practice_id']), path, 'administrator', 'team_id')).toMatchObject({ status: 403, body: { error: 'field_forbidden' } })
})
it.each(['CRUD', 'command', 'atomic'])('convention field-name changes determine protection and the allowance / %s', async path => {
  const config = model()
  expect(protectedActorFields(config).has('practice_id')).toBe(true)
  expect(protectedActorFields(config).has('assignable_to_job')).toBe(false)
  expect(protectedActorFields(config).has('role')).toBe(false)
  expect((await change(config, path, 'coordinator', 'assignable_to_job')).status).toBe(200)
})
it.each([
  { managedBy: ['missing'], assignments: ['team_id'] },
  { managedBy: ['coordinator'], assignments: ['missing'] },
])('assignment declarations reject unknown roles or fields during contribute/validate %#', account => {
  expect(() => new KernelRegistry({ ...policyGraph, account: { entity: 'users', ...account } })).toThrow(/Unknown account/)
})
