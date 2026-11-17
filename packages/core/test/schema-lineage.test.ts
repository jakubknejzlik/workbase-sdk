import { expect, it } from 'vitest'
import { createPhysicalNameResolver } from '../src/schema/physical-names'
import { validateLock } from '../src/schema/lock-format'

const input = () => ({ lockVersion: 1, revision: 1, parent: null, tables: [{ name: 'workers', columns: [
  { name: 'name', sqlType: 'TEXT', notNull: false, defaultSql: null, checks: [] },
], unique: [], checks: [], foreignKeys: [], indexes: [] }] })

it('resolves logical names through IDs to distinct pinned physical names in a Worker', () => {
  const lock = validateLock(input())
  lock.entities[0].logicalName = 'staff'
  lock.entities[0].fields[0].logicalName = 'full_name'
  const resolver = createPhysicalNameResolver(lock)
  const entityId = resolver.entityId('staff'), fieldId = resolver.fieldId(entityId, 'full_name')
  expect(resolver.table(entityId)).toBe('workers')
  expect(resolver.column(entityId, fieldId)).toBe('name')
  expect(() => resolver.entityId('workers')).toThrow('Unknown logical entity')
  expect(() => resolver.column(entityId, 'fld_missing')).toThrow('Unknown field ID')
  expect(() => resolver.table('ent_missing')).toThrow('Unknown entity ID')
})

it('takes an independent validated snapshot of v1 and v2 inputs', () => {
  const source = input(), lock = validateLock(source), resolver = createPhysicalNameResolver(lock)
  expect(validateLock(source)).toEqual(lock)
  const entityId = resolver.entityId('workers'), fieldId = resolver.fieldId(entityId, 'name')
  lock.entities[0].fields[0].physicalName = 'mutated'
  source.tables[0].columns[0].name = 'mutated'
  expect(resolver.column(entityId, fieldId)).toBe('name')
  expect(() => createPhysicalNameResolver(lock)).toThrow('schema.lock.json')
})

it.each(['expanded', 'switched', 'contracted'] as const)('reads the recorded %s phase without advancing it', phase => {
  const lock = validateLock(input()), entity = lock.entities[0], field = entity.fields[0]
  lock.transitions.push({ id: 'tr_example', entityId: entity.id, fieldIds: [field.id], from: { logical: 'name', physical: 'name' }, to: { logical: 'full_name', physical: 'full_name' }, bridge: 'field', phase })
  if (phase !== 'expanded') {
    field.logicalName = 'full_name'; field.physicalName = 'full_name'
    lock.tables[0].columns[0].name = 'full_name'
  }
  expect(validateLock(lock).transitions[0].phase).toBe(phase)
})
