import { beforeEach, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { z } from 'zod'
import { setup, runtime, policyGraph } from './fixtures/policy-graph/setup'
import { request, json } from '@workbasehq/test-support/helpers'
import { KernelRegistry } from '../src/kernel/registry'
import { resolveActor, requireScope } from '../src/authorization'
import { executeAtomic } from '../src/execution/atomic'
import { coreExecutionContext } from '../src/execution/context'
import { D1AtomicReader, D1AtomicStore } from '../src/execution/d1'
import { createCommandRegistry } from '../src/commands'
import { defineInstance, defaultOrganizationPermissions } from '../src/config'
import type { AtomicOperation } from '../src/execution/types'

beforeEach(async () => { await setup() })
it.each(['reviewer', 'administrator'])('generic %s plans retain account assignment and membership boundaries', async role => {
  for (const sql of [
    'UPDATE users SET "role"=? WHERE id=?',
    'UPDATE users SET name=upper(name),[team_id]=? WHERE id=?',
    'UPDATE memberships SET`role`=? WHERE user_id=? AND organization_id=\'org-a\'',
    'UPDATE memberships SET user_id=? WHERE user_id=? AND organization_id=\'org-a\'',
  ]) {
    const op: AtomicOperation = { name: 'users/change', permission: { entity: 'users', operation: 'update' }, input: z.strictObject({}), plan: () => ({
      rules: [{ name: 'change', statements: [{ sql, bindings: [sql.includes('team_id') ? 'team-b' : 'administrator', 'reviewer-colleague'], expectRows: 1 }] }],
      event: { entity: 'users', entityId: 'reviewer-colleague', operation: 'test.change' }, result: { status: 200, body: {} },
    }) }
    const kernel = new KernelRegistry(policyGraph, { commands: createCommandRegistry([op]) })
    const scope = await requireScope(await resolveActor(new Request('http://localhost', { headers: { Authorization: `Bearer synthetic-${role}` } }), runtime(), kernel.config), 'org-a', kernel.config)
    const execution = executeAtomic(op, {}, coreExecutionContext(kernel.config, scope, { run: plan => new D1AtomicStore(env.DB).run(structuredClone(plan)) }, new D1AtomicReader(env.DB)))
    await expect(execution).rejects.toMatchObject({ status: 403, code: 'field_forbidden' })
  }
  expect(await env.DB.prepare("SELECT role FROM memberships WHERE user_id='reviewer-colleague'").first('role')).toBe('reviewer')
  expect(await env.DB.prepare('SELECT count(*) AS n FROM audit_outbox').first('n')).toBe(0)
})
it('generic account CREATE cannot assign protected fields', async () => {
  const app = await setup()
  const response = await request(app, '/api/users', 'POST', { name: 'New', role: 'administrator', team_id: 'team-b' }, 'administrator')
  expect(response.status).toBe(403)
  expect(await json(response)).toMatchObject({ error: 'field_forbidden' })
})
it('a generic owner operation cannot forge member-route provenance with a system permission', async () => {
  await env.DB.prepare("UPDATE memberships SET role='owner' WHERE user_id='administrator'").run()
  const config = defineInstance({ ...policyGraph, roles: [...policyGraph.roles, 'owner'], organizationPermissions: { owner: defaultOrganizationPermissions.owner }, permissions: { ...policyGraph.permissions, owner: policyGraph.permissions.administrator } })
  const op: AtomicOperation = { name: 'members/update', permission: { system: 'members.update' }, input: z.strictObject({}), plan: () => ({
    rules: [{ name: 'role', statements: [{ sql: 'UPDATE memberships SET role=? WHERE user_id=? AND organization_id=?', bindings: ['administrator', 'reviewer-colleague', 'org-a'], expectRows: 1 }] }],
    event: { entity: 'memberships', entityId: 'reviewer-colleague', operation: 'test.change' }, result: { status: 200, body: {} },
  }) }
  const kernel = new KernelRegistry(config)
  const scope = await requireScope(await resolveActor(new Request('http://localhost', { headers: { Authorization: 'Bearer synthetic-administrator' } }), runtime(), kernel.config), 'org-a', kernel.config)
  await expect(executeAtomic(op, {}, coreExecutionContext(kernel.config, scope, new D1AtomicStore(env.DB), new D1AtomicReader(env.DB)))).rejects.toMatchObject({ status: 403, code: 'field_forbidden' })
  expect(await env.DB.prepare("SELECT role FROM memberships WHERE user_id='reviewer-colleague'").first('role')).toBe('reviewer')
})
