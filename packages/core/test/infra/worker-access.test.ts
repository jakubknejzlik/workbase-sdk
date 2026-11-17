import { expect, it } from 'vitest'
import { workerAccessFixture } from '../fixtures/worker-access'
import { defineConfig, defineEntity } from '../../src/schema'
import { defineInstance } from '../../src/config'
import { KernelRegistry } from '../../src/kernel/registry'
import { serializeAccessLock } from '../../src/access-lock'

it('invitation role mapping rejects unknown, owner and unreadable roles', () => {
  expect(() => workerAccessFixture('missing')).toThrow('Unknown invitation role')
  expect(() => workerAccessFixture('admin')).toThrow('organizationOwnerRole')
  expect(() => workerAccessFixture('staff', false)).toThrow('requires read on worker')
})
it('invitation role mapping is serialized data in lock version 1 and survives cloning', () => {
  const kernel = new KernelRegistry(workerAccessFixture())
  const lock = serializeAccessLock(kernel, { root: process.cwd(), sources: { '': { file: 'packages/core/test/fixtures/worker-access.ts', line: 1, column: 1 } } })
  expect(JSON.parse(lock.json).effectiveAccess.accountLinks).toEqual({ worker: { invitationRole: 'staff' } })
  expect(structuredClone(kernel.config.effectiveAccess)!.accountLinks).toEqual({ worker: { invitationRole: 'staff' } })
  expect(lock.md).toContain('Account link invitation roles')
  expect(kernel.config.effectiveAccess!.version).toBe(1)
})
it('access is reserved in SDK fields and relations; legacy declarations still accept it', () => {
  const common = { id: 'reserved', roles: ['admin'], organizationOwnerRole: 'admin', languages: ['en'], permissions: {} }
  expect(() => defineConfig({ ...common, entities: { item: defineEntity({ fields: { access: { type: 'text' } } }) } })).toThrow('Reserved field: access')
  const entity = { fields: { parent: { type: 'ref' as const, entity: 'item' } }, relations: { access: { field: 'parent', entity: 'item' } } }
  expect(() => defineConfig({ ...common, entities: { item: defineEntity(entity) } })).toThrow('Reserved relation: access')
  expect(defineInstance({ ...common, revision: 1, entities: { item: { ...entity, displayField: 'access', fields: { ...entity.fields, access: { type: 'text' } } } } }).entities.item.fields.access).toBeDefined()
})
it('the committed worker access locks match the compiled policy and source locations', async () => {
  const { runAccessCli } = await import('../../src/access-lock/cli')
  expect(await runAccessCli(['--config', 'packages/core/test/fixtures/worker-access.ts', '--root', '.', '--directory', 'packages/core/test/fixtures/worker-access'])).toBe(0)
})
it('account conditions stay opaque serializable data, cannot be authored, and contain no credentials', () => {
  const config = workerAccessFixture()
  const cloned = { ...config, effectiveAccess: structuredClone(config.effectiveAccess) }
  const kernel = new KernelRegistry(cloned)
  const lock = serializeAccessLock(kernel, { root: process.cwd(), sources: { '': { file: 'packages/core/test/fixtures/worker-access.ts', line: 1, column: 1 } } })
  const actions = JSON.parse(lock.json).effectiveAccess.actions
  expect(actions.map((action: any) => action.name)).toEqual(['invite', 'cancel_invite', 'link_account', 'unlink_account'])
  expect(actions.every((action: any) => action.conditions.every((condition: any) => condition.opaque === true))).toBe(true)
  expect(lock.json).not.toMatch(/accept_url|token_hash|invitations\/accept/)
  expect(() => defineEntity({ fields: { name: { type: 'text' } }, actions: { forged: { command: 'worker/access_invite', available: [{ opaque: true, kind: 'clear', reason: 'access.pending' } as any] } } })).toThrow()
})
it('authored aliases cannot call a card adapter without its core SQL conditions', () => {
  expect(() => workerAccessFixture('staff', true, { alias: { command: 'worker/access_unlink_account' } })).toThrow('core registered action')
})
