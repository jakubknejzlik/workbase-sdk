import { describe, expect, it } from 'vitest'
import { defineInstance } from '@workbasehq/core/config'
import type { ListInput } from '../../core/src/list-config'
import { KernelRegistry } from '@workbasehq/core/kernel/registry'
import type { WorkbasePlugin } from '@workbasehq/core/kernel/plugin'
import { consoleUI } from '@workbasehq/plugins/console'
import { prepare, prepareChanges } from '../src/planning'
import { WorkflowError } from '../src/schemas'

const cases: [string, ListInput, string, string][] = [
  ['shorthand column', { columns: ['name'] }, 'records', 'columns.0.field'],
  ['object column', { columns: [{ field: 'name', label: 'name' }] }, 'records', 'columns.0.field'],
  ['secondary', { columns: [{ field: 'id', secondary: 'name' }] }, 'records', 'columns.0.secondary'],
  ['filter shorthand', { filter: { name: 'text' } }, 'records', 'filter.name'],
  ['filter object', { filter: { name: { kind: 'text', label: 'name' } } }, 'records', 'filter.name'],
  ['disabled filter', { filter: { name: false } }, 'records', 'filter.name'],
  ['view predicate', { views: [{ id: 'named', label: 'name', where: { and: [{ not: { name: { eq: 'name' } } }] } }] }, 'records', 'views.0.where.and.0.not.name'],
  ['rowAccess view predicate', { views: [{ id: 'named', label: 'name', rowAccess: 'expired', where: { name: { contains: 'name' } } }] }, 'records', 'views.0.where.name'],
  ['to-one predicate', { views: [{ id: 'named', label: 'name', where: { parent: { name: { eq: 'name' } } } }] }, 'parents', 'views.0.where.parent.name'],
  ['to-many predicate', { views: [{ id: 'named', label: 'name', where: { children: { some: { name: { eq: 'name' } } } } }] }, 'children', 'views.0.where.children.some.name'],
  ['search', { search: ['name'] }, 'records', 'search.0'],
  ['sort key', { sort: { name: false } }, 'records', 'sort.name'],
  ['sort operand', { sort: { id: { fields: ['name'] } } }, 'records', 'sort.id.fields.0'],
  ['default sort', { defaultSort: { key: 'name', direction: 'asc' } }, 'records', 'defaultSort.key'],
  ['related via', { relatedColumns: { ancestor: { via: 'parent_id', field: 'ancestor_id' } } }, 'via', 'relatedColumns.ancestor.via'],
  ['related field', { relatedColumns: { ancestor: { via: 'parent_id', field: 'ancestor_id' } } }, 'related', 'relatedColumns.ancestor.field'],
]

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

function fixture(list: ListInput, pluginOwned: boolean) {
  const plugin = freeze<WorkbasePlugin>({ name: 'static-list', version: '1', requires: { console: '^1' },
    contributes: { console: { entities: { records: { list } } } } })
  const config = defineInstance({ id: 'list_rename', revision: 1, roles: ['owner'], interactive: false,
    plugins: [consoleUI(), ...(pluginOwned ? [plugin] : [])],
    entities: {
      records: { fields: { name: { type: 'string' }, unused: { type: 'string' }, parent_id: { type: 'ref', entity: 'parents' } }, relations: { parent: { field: 'parent_id', entity: 'parents' }, children: { many: true, field: 'record_id', entity: 'children' } } },
      parents: { fields: { name: { type: 'string' }, ancestor_id: { type: 'ref', entity: 'parents' } } },
      children: { fields: { name: { type: 'string' }, record_id: { type: 'ref', entity: 'records' } } },
    }, permissions: { owner: { '*': ['read'] } },
    ...(!pluginOwned ? { ui: { entities: { records: { list } } } } : {}),
  })
  new KernelRegistry(config, { authorization: 'trust' })
  return { config, plugin }
}

const changeFor = (entity: string) => ({ kind: 'rename_field' as const,
  entity: entity === 'via' || entity === 'related' ? entity === 'via' ? 'records' : 'parents' : entity,
  from: entity === 'via' ? 'parent_id' : entity === 'related' ? 'ancestor_id' : 'name', to: 'title' })

describe('list rename dependencies', () => {
  it.each(cases)('refuses plugin-owned %s before returning an invalid target', (_label, list, entity, path) => {
    const { config, plugin } = fixture(list, true)
    const before = JSON.stringify(plugin.contributes)
    expect(() => {
      const result = prepare(config, [], [changeFor(entity)])
      // Successful planning must always produce a constructible kernel.
      new KernelRegistry(result.target, { authorization: 'trust' })
    }).toThrow(expect.objectContaining({ code: 'field_in_use', status: 400,
      message: expect.stringContaining(`plugin static-list at contributes.console.entities.records.list.${path}`) }))
    expect(JSON.stringify(plugin.contributes)).toBe(before)
    expect(config.plugins).toContain(plugin)
    new KernelRegistry(config, { authorization: 'trust' })
  })

  it.each(cases)('rewrites config-owned %s into a valid target kernel', (_label, list, entity) => {
    const { config } = fixture(list, false)
    const before = JSON.stringify(config.ui)
    const result = prepare(config, [], [changeFor(entity)])
    expect(result.sql).toContain('RENAME COLUMN')
    new KernelRegistry(result.target, { authorization: 'trust' })
    expect(JSON.stringify(config.ui)).toBe(before)
  })

  it('allows unreferenced renames and preserves plugin code, literals and rowAccess-only views', () => {
    const { config, plugin } = fixture({ columns: [{ field: 'name', label: 'unused' }], filter: { name: { label: 'unused' } },
      views: [{ id: 'unused', label: 'unused', where: { name: { eq: 'unused' } } }, { id: 'access', label: 'unused', rowAccess: 'expired' }] }, true)
    const before = JSON.stringify(plugin.contributes)
    const result = prepare(config, [], [{ kind: 'rename_field', entity: 'records', from: 'unused', to: 'title' }])
    expect(result.sql).toContain('RENAME COLUMN "unused" TO "title"')
    expect(result.target.plugins).toContain(plugin)
    new KernelRegistry(result.target, { authorization: 'trust' })
    expect(JSON.stringify(plugin.contributes)).toBe(before)
  })
})

describe('lists on plugin-contributed entities', () => {
  const fixture = (list: ListInput) => {
    const plugin = freeze<WorkbasePlugin>({ name: 'inventory', version: '1', requires: { console: '^1' },
      entities: { inventory: { fields: { name: { type: 'string' }, record_id: { type: 'ref', entity: 'records' } },
        relations: { record: { field: 'record_id', entity: 'records' } } } },
      contributes: { console: { entities: { inventory: { list } } } } })
    const config = defineInstance({ id: 'plugin_entity_rename', revision: 1, roles: ['owner'], interactive: false,
      // Deliberately install the consumer before its provider.
      plugins: [plugin, consoleUI()],
      entities: { records: { fields: { name: { type: 'string' }, unused: { type: 'string' }, another: { type: 'string' },
        parent_id: { type: 'ref', entity: 'records' } } } } })
    new KernelRegistry(config, { authorization: 'trust' })
    return { config: freeze(config), plugin }
  }

  it('allows unrelated chained renames and constructs the target kernel without mutating plugins', () => {
    const { config, plugin } = fixture({ columns: ['name'] })
    const before = JSON.stringify(config)
    const result = prepare(config, [], [
      { kind: 'rename_field', entity: 'records', from: 'unused', to: 'renamed' },
      { kind: 'rename_field', entity: 'records', from: 'another', to: 'second' },
    ])
    const kernel = new KernelRegistry(result.target, { authorization: 'trust' })
    expect(kernel.config.entities.records.fields).toHaveProperty('renamed')
    expect(kernel.config.entities.records.fields).toHaveProperty('second')
    expect(kernel.config.entities.inventory.fields).toHaveProperty('name')
    expect(result.target.plugins).toContain(plugin)
    expect(result.target.entities).not.toHaveProperty('inventory')
    expect(JSON.stringify(config)).toBe(before)
  })

  it.each([
    ['related column', { relatedColumns: { ancestor: { via: 'record_id', field: 'parent_id' } } }, 'parent_id', 'relatedColumns.ancestor.field'],
    ['relation predicate', { views: [{ id: 'named', label: 'Named', where: { record: { not: { name: { eq: 'literal' } } } } }] }, 'name', 'views.0.where.record.not.name'],
  ] satisfies [string, ListInput, string, string][])('refuses cross-entity %s dependencies with field_in_use', (_label, list, from, path) => {
    const { config, plugin } = fixture(list)
    const before = JSON.stringify(config)
    for (const planner of [prepare, prepareChanges]) {
      expect(() => planner(config, [], [
        { kind: 'rename_field', entity: 'records', from: 'unused', to: 'renamed' },
        { kind: 'rename_field', entity: 'records', from, to: 'title' },
      ])).toThrow(expect.objectContaining({ constructor: WorkflowError, code: 'field_in_use', status: 400,
        message: expect.stringContaining(`plugin inventory at contributes.console.entities.inventory.list.${path}`) }))
    }
    expect(config.plugins).toContain(plugin)
    expect(JSON.stringify(config)).toBe(before)
    new KernelRegistry(config, { authorization: 'trust' })
  })
})
