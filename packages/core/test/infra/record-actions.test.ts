import { expect, it } from 'vitest'
import { actionFixture, closeRecord } from '../fixtures/record-actions'
import { defineEntity, defineConfig, actionReasonKeys } from '../../src/schema'
import { defineInstance } from '../../src/config'
import { KernelRegistry } from '../../src/kernel/registry'
import { serializeAccessLock } from '../../src/access-lock'

it.each([
  ['unknown command', { command: 'record/missing' }, 'Unknown action command'],
  ['outside config.commands', { command: 'record/outside' }, 'outside config.commands'],
  ['unknown when field', { command: 'record/close', available: [{ when: { missing: { eq: true } }, reason: 'record.missing' }] }, 'Unrecognized key'],
  ['missing reason', { command: 'record/close', available: [{ when: {} }] }, 'reason'],
])('action compile rejects %s', (name, action, message) => {
  expect(() => actionFixture({ probe: action }, [closeRecord], name === 'unknown command' ? ['record/missing'] : undefined)).toThrow(message)
})
it('actions reject system permissions and non-data declarations', () => {
  expect(() => actionFixture({ probe: { command: closeRecord.name } }, [{ ...closeRecord, permission: { system: 'tokens.read' } } as any])).toThrow('System-permission')
  expect(() => actionFixture({ probe: { command: closeRecord.name, available: [{ when: () => true, reason: 'record.key' }] } })).toThrow()
  expect(() => actionFixture({ probe: { command: closeRecord.name, extra: true } })).toThrow()
  expect(() => actionFixture({ probe: { command: closeRecord.name, available: [{ when: {}, reason: 'plain' }] } })).toThrow()
})
it('actions compile expanded SQL inputs and finite reason keys into the lock', () => {
  const kernel = new KernelRegistry(actionFixture())
  expect(kernel.config.effectiveAccess!.actions[0]).toMatchObject({ entity: 'record', name: 'close', conditions: [{ when: { state: { eq: 'open' } }, reason: 'record.closed' }], dependencies: ['record.state'] })
  expect(actionReasonKeys(kernel.config)).toEqual(['record.closed', 'record.missing', 'record.secret'])
  const lock = serializeAccessLock(kernel, { root: process.cwd(), sources: { '': { file: 'packages/core/test/fixtures/record-actions.ts', line: 1, column: 1 } } })
  expect(JSON.parse(lock.json).effectiveAccess.actions).toEqual(kernel.config.effectiveAccess!.actions)
  expect(lock.md).toContain('record.closed')
  expect(kernel.config.effectiveAccess!.guards.find(guard => guard.name === closeRecord.name)?.opaque).toBe(true)
  expect(kernel.config.effectiveAccess!.version).toBe(1)
})
it('actions is reserved for fields and relations in SDK era even without effectiveAccess; legacy unchanged', () => {
  const common = { id: 'reserved', roles: ['admin'], organizationOwnerRole: 'admin', languages: ['en'], permissions: {} }
  expect(() => defineConfig({ ...common, entities: { item: defineEntity({ fields: { actions: { type: 'text' } } }) } })).toThrow('Reserved field: actions')
  const entity = { fields: { parent: { type: 'ref' as const, entity: 'item' } }, relations: { actions: { field: 'parent', entity: 'item' } } }
  expect(() => defineConfig({ ...common, entities: { item: defineEntity(entity) } })).toThrow('Reserved relation: actions')
  expect(defineInstance({ ...common, revision: 1, entities: { item: { ...entity, displayField: 'actions', fields: { ...entity.fields, actions: { type: 'text' } } } } }).entities.item.fields.actions).toEqual({ type: 'text', required: false })
})
// Compile-time checks remain in the root typecheck gate.
if (false) {
  defineEntity({ fields: { state: { type: 'text' } }, actions: { close: { command: 'record/close', available: [
    // @ts-expect-error action filters cannot name an unknown root field
    { when: { absent: { eq: 'open' } }, reason: 'record.closed' },
  ] } } })
}
