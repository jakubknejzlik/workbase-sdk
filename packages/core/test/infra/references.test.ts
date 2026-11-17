import { describe, expect, it } from 'vitest'
import { defineInstance } from '../../src/config'
import { accessEntities, accessSystemActions } from '../../src/access'
import { referenceInventory, validateRemoval, type ReferenceInput } from '../../src/references'

const source = { file: '/instance/schema/tasks.ts', line: 1, column: 1, start: 0, end: 5, endLine: 1, endColumn: 6 }
function input(): ReferenceInput {
  const config = defineInstance({ id: 'refs', revision: 1, roles: ['owner'], entities: {
    tasks: { displayField: 'title', fields: { title: { type: 'string' }, client_id: { type: 'ref', entity: 'clients' } }, relations: { client: { field: 'client_id', entity: 'clients' } } },
    clients: { fields: { name: { type: 'string' }, title: { type: 'string' } } },
  } })
  config.roles = ['owner']
  const access = { roles: { owner: { system: Object.fromEntries(accessSystemActions.map(a => [a, 'deny' as const])) } },
    entities: Object.fromEntries(accessEntities.map(e => [e, { owner: 'deny' as const }])), predicates: { named: { title: { eq: 'title' } } } }
  const grant: Exclude<import('../../src/access').EntityAccess[string], string> = { read: { where: { use: 'named' }, fields: ['id', 'title'] }, create: 'deny', update: 'deny', delete: 'deny' }
  return { config, source: () => source, access: { shared: access, entities: {
    tasks: { owner: { ...grant, read: { where: { and: [{ use: 'named' }, { client: { use: 'named' } }] }, fields: ['id', 'title'] } } },
    clients: { owner: grant },
  } }, references: [], diagnostics: [], contracts: [] }
}
describe('shared reference inventory', () => {
  it('resolves nested predicates in each entity context, retaining definition and every use site', () => {
    const result = referenceInventory(input())
    expect(result.diagnostics).toEqual([])
    const refs = result.references.filter(r => r.kind === 'predicate' && r.target.field === 'title')
    expect(refs.map(r => r.target.entity).sort()).toEqual(['clients', 'tasks'])
    expect(refs.find(r => r.target.entity === 'clients')!.useSites).toHaveLength(2)
    expect(refs.every(r => r.owner === 'access.predicates.named.title')).toBe(true)
    expect(result.references.some(r => r.owner.endsWith('.eq'))).toBe(false)
    expect(result.references.some(r => r.target.entity === 'tasks' && r.target.field === 'client_id' && r.kind === 'policy')).toBe(true)
  })
  it('returns all blockers together with repair hints, keeping contract names separate', () => {
    const data = input()
    for (const kind of ['layout', 'list-column', 'slot', 'plugin', 'instance-code', 'i18n'] as const) data.references!.push({ kind, target: { entity: 'tasks', field: 'title' }, entityContext: 'tasks', source, owner: kind, useSites: [] })
    data.contracts!.push({ plugin: 'test', contract: 'tasks', range: '^1', source, optional: false })
    const inventory = referenceInventory(data)
    const result = validateRemoval(inventory, { kind: 'remove_field', entity: 'tasks', field: 'title' })
    expect(new Set(result.diagnostics.map(d => d.kind))).toEqual(new Set(['display', 'predicate', 'mask', 'layout', 'list-column', 'slot', 'plugin', 'instance-code', 'i18n']))
    expect(result.ok).toBe(false)
    expect(result.diagnostics.every(d => d.source && d.repairHint)).toBe(true)
    expect(inventory.contracts).toHaveLength(1)
    expect(inventory.references.some(r => r.owner === 'test')).toBe(false)
  })
  it('includes every configured language and plural entry without inspecting translated values', () => {
    const data = input()
    data.config.languages = ['en', 'cs', 'ar']
    data.catalogs = Object.fromEntries(['en', 'cs', 'ar'].map(lang => [lang, { domain: { file: `/instance/locales/${lang}/domain.json`, text: JSON.stringify({
      'entity.tasks_one': 'tasks', 'entity.tasks_other': 'tasks', 'field.tasks.title': 'title', 'enum.tasks.title.one': 'title',
      ...(lang === 'ar' ? { 'entity.tasks_zero': 'tasks', 'entity.tasks_two': 'tasks', 'entity.tasks_few': 'tasks', 'entity.tasks_many': 'tasks' } : {}),
    }) } }]))
    const refs = referenceInventory(data).references.filter(r => r.kind === 'i18n')
    expect(refs).toHaveLength(16)
    expect(new Set(refs.map(r => r.source.file)).size).toBe(3)
    expect(refs.every(r => r.source.end > r.source.start)).toBe(true)
    expect(refs.filter(r => r.target.field === 'title')).toHaveLength(6)
  })
  it('is deterministic without mutating inputs and aggregates shared definition consumers', () => {
    const data = input()
    const before = JSON.stringify(data)
    const a = referenceInventory(data)
    const b = referenceInventory({ ...data, references: [...data.references!].reverse() })
    expect(a).toEqual(b)
    expect(JSON.stringify(data)).toBe(before)
    expect(validateRemoval(a, { kind: 'remove_entity', entity: 'clients' }).diagnostics.some(d => d.kind === 'relation')).toBe(true)
  })
})

it('follows a to-many quantifier and every foreign-key hop through a named predicate chain', () => {
  const data = input()
  data.config.entities.groups = { fields: { title: { type: 'string', required: false }, client_id: { type: 'ref', entity: 'clients', required: false } }, relations: {}, checks: [], displayField: 'title' }
  data.config.entities.clients.relations.groups = { entity: 'groups', field: 'client_id', many: true }
  data.access!.shared!.predicates = { named: { title: { eq: 'title' } }, chain: { use: 'named' } }
  data.access!.entities.groups = { owner: 'deny' }
  data.access!.entities.tasks = { owner: { read: { where: { client: { groups: { some: { use: 'chain' } } } } }, create: 'deny', update: 'deny', delete: 'deny' } }
  const result = referenceInventory(data)
  expect(result.diagnostics).toEqual([])
  expect(result.references).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'policy', target: { entity: 'tasks', field: 'client_id' } }),
    expect.objectContaining({ kind: 'policy', target: { entity: 'groups', field: 'client_id' } }),
    expect.objectContaining({ kind: 'predicate', target: { entity: 'groups', field: 'title' }, owner: 'access.predicates.named.title' }),
  ]))
  const group = result.references.find(r => r.kind === 'predicate' && r.target.entity === 'groups' && r.target.field === 'title')!
  expect(group.useSites.map(u => u.owner)).toEqual(expect.arrayContaining(['access.predicates.chain.use', 'entities.tasks.access.owner.read.where.client.groups.some.use']))
})
it('reads declared plugin requirements without treating matching contract names as entities', () => {
  const data = input()
  data.config.plugins = [{ name: 'custom', version: '1', requires: { tasks: '^1' }, schemaReferences: [{ entity: 'clients', field: 'name' }] }]
  const result = referenceInventory(data)
  expect(result.contracts).toMatchObject([{ plugin: 'custom', contract: 'tasks' }])
  expect(result.references.filter(r => r.kind === 'plugin')).toMatchObject([{ target: { entity: 'clients', field: 'name' } }])
})
it('blocks uncertain executable coverage along with every known blocker, never declaring removal safe', () => {
  const data = input()
  data.uncovered = [{ code: 'opaque-instance-code', kind: 'instance-code', source, message: 'Needs target typecheck', repairHint: 'Repair typed dependencies and check.' }]
  const result = validateRemoval(referenceInventory(data), { kind: 'remove_field', entity: 'clients', field: 'name' })
  expect(result.ok).toBe(false)
  expect(result.diagnostics.map(d => d.code)).toContain('opaque-instance-code')
  expect(result.diagnostics.map(d => d.kind)).toContain('display')
})
it('does not count serialized expression literals equal to field identifiers as dependencies', () => {
  const data = input()
  data.config.entities.tasks.fields.summary = { type: 'string', required: false, computed: 'FN(["CONCAT","title","!!!\\"name\\""])' }
  const refs = referenceInventory(data).references.filter(r => r.kind === 'computed' && r.owner === 'entities.tasks.fields.summary.computed')
  expect(refs.map(r => r.target)).toEqual([{ entity: 'tasks', field: 'title' }])
})
it('distinguishes real identifiers ending in plural suffixes and ignores references owned by a removed entity declaration', () => {
  const data = input()
  data.config.languages = ['en']
  data.config.entities.tasks.fields.title_one = { type: 'string', required: false }
  data.catalogs = { en: { domain: { file: '/instance/locales/en/domain.json', text: '{"field.tasks.title_one":"title"}' } } }
  const inventory = referenceInventory(data)
  expect(inventory.references.filter(r => r.kind === 'i18n').map(r => r.target.field)).toEqual(['title_one'])
  const result = validateRemoval(inventory, { kind: 'remove_entity', entity: 'tasks' })
  expect(result.diagnostics.some(d => d.kind === 'display' && d.owner === 'entities.tasks.displayField')).toBe(false)
  expect(result.diagnostics.some(d => d.kind === 'mask')).toBe(true)
})
it('keeps unused predicates valid but blocks removal while their entity context is unknown', () => {
  const data = input()
  data.access!.shared!.predicates.unused = { title: { eq: 'title' } }
  const inventory = referenceInventory(data)
  expect(inventory.diagnostics).toEqual([])
  expect(inventory.uncovered.map(d => d.code)).toEqual(['unbound-predicate'])
  expect(validateRemoval(inventory, { kind: 'remove_field', entity: 'tasks', field: 'title' }).diagnostics.map(d => d.code)).toContain('unbound-predicate')
})
