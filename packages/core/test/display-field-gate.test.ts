import { expect, it } from 'vitest'
import { defineInstance, type InstanceInput } from '../src/config'

it('R1 exempts unreferenced entities without readers even when inference selects a sensitive field', () => {
  const config = defineInstance({ id: 'private', revision: 1, roles: ['owner'], permissions: {}, entities: {
    private_log: { commandsOnly: true, fields: { name: { type: 'string', sensitive: true } } },
  } })
  expect(config.entities.private_log.displayField).toBe('name')
})

it.each(['created_at', 'updated_at', 'version', 'organization_id', 'id'])('R2 resolves canonical system display field %s', displayField => {
  const config = defineInstance({ id: 'system', revision: 1, roles: ['viewer'], permissions: { viewer: { item: ['read'] } }, entities: {
    item: { displayField, fields: {} },
  } })
  expect(config.entities.item.displayField).toBe(displayField)
})

it('R5 suggests only a field readable by an entity reader and accepts that suggestion', () => {
  const input: InstanceInput = { id: 'suggestion', revision: 1, roles: ['viewer'], permissions: { viewer: { people: ['read'] } }, entities: {
    people: { fields: { jmeno: { type: 'string', required: true }, nazev: { type: 'string', required: true, sensitive: true } } },
  }, policies: { people: { viewer: { where: {}, fields: ['nazev'] } } } }
  expect(() => defineInstance(input)).toThrow("Invalid displayField: people; set displayField: 'nazev' to an existing readable field")
  expect(defineInstance({ ...input, entities: { people: { ...input.entities.people, displayField: 'nazev' } } }).entities.people.displayField).toBe('nazev')
})

const consumer: InstanceInput = {
  id: 'consumer', revision: 1, roles: ['owner'],
  entities: {
    zakaznik: { fields: { jmeno: { type: 'string', required: true } } },
    rezervace: { fields: { title: { type: 'string', required: true }, zakaznik_id: { type: 'ref', entity: 'zakaznik' } } },
  },
  permissions: { owner: { zakaznik: ['read'], rezervace: ['read'] } },
}

it('rejects a consumer Czech ref target without displayField and suggests its first required string', () => {
  expect(() => defineInstance(consumer)).toThrow('Invalid displayField: zakaznik; set displayField: \'jmeno\' to an existing readable field')
})

it('accepts the same consumer schema with an explicit displayField', () => {
  const config = defineInstance({ ...consumer, entities: { ...consumer.entities, zakaznik: { ...consumer.entities.zakaznik, displayField: 'jmeno' } } })
  expect(config.entities.zakaznik.displayField).toBe('jmeno')
})

it.each(['name', 'title'])('infers %s for canonical object schemas as well as shorthand', key => {
  expect(defineInstance({ ...consumer, entities: { item: { fields: { [key]: { type: 'string' } } } }, permissions: { owner: { item: ['read'] } } }).entities.item.displayField).toBe(key)
})

it.each([undefined, 'missing', 'secret', 'id'])('rejects an unusable displayField %s for a listed entity', displayField => {
  expect(() => defineInstance({ ...consumer, entities: { item: { displayField, fields: { jmeno: { type: 'string', required: true }, secret: { type: 'string', sensitive: true } } } }, permissions: { owner: { item: ['read'] } }, policies: { item: { owner: { where: {}, fields: ['jmeno'] } } } })).toThrow("Invalid displayField: item; set displayField: 'jmeno'")
})

it('permits an unlisted entity without a displayField until it becomes a relation target', () => {
  const input: InstanceInput = { ...consumer, entities: { log: { fields: { message: { type: 'text' } } } }, permissions: {} }
  expect(defineInstance(input).entities.log.displayField).toBeUndefined()
  expect(() => defineInstance({ ...input, entities: { ...input.entities, source: { fields: { log_id: { type: 'ref', entity: 'log' } }, relations: { log: { entity: 'log', field: 'log_id' } } } } })).toThrow('Invalid displayField: log')
})
