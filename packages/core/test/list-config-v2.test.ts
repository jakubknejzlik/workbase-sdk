import { expect, it } from 'vitest'
import { defineInstance } from '../src/config'

const input = { id: 'list_v2', revision: 1, roles: ['owner'], permissions: { owner: { '*': ['read'] as ['read'] } }, entities: {
  workers: { fields: { name: { type: 'string' as const }, code: { type: 'string' as const, ui: { format: 'identifier' as const } }, status: { type: 'enum' as const, values: ['active', 'inactive'] }, enabled: { type: 'bool' as const }, team_id: { type: 'ref' as const, entity: 'teams' } } },
  teams: { fields: { name: { type: 'string' as const } } },
} }
const parse = (list: unknown) => defineInstance({ ...input, ui: { entities: { workers: { list: list as never } } } }).ui!.entities.workers.list!
it('normalizes shorthand without mutation and reparses canonical lists idempotently', () => {
  const list = { columns: ['name', 'code'], filter: { status: 'enum' } }
  const result = parse(list)
  expect(result).toEqual(parse({ columns: [{ field: 'name' }, { field: 'code' }], filter: { status: { kind: 'enum', operators: ['in'], placement: 'panel' } } }))
  expect(result.columns).toEqual([{ field: 'name' }, { field: 'code' }])
  expect(parse(result)).toEqual(result)
  expect(list).toEqual({ columns: ['name', 'code'], filter: { status: 'enum' } })
})
it('accepts unconditional all and row-access-only views and keeps full query DSL', () => {
  const result = parse({ views: [{ id: 'all', label: 'All', where: {}, default: true }, { id: 'invited', label: 'Invited', rowAccess: 'invited' }, { id: 'advanced', label: 'Advanced', where: { name: { ne: 'literal' } } }] })
  expect(result.views![1].where).toEqual({})
})
it.each([
  { columns: [{ field: 'missing' }] }, { columns: [{ field: 'name', secondary: 'missing' }] },
  { columns: [{ field: 'name', secondary: ['code'] }] }, { columns: [{ field: 'name', label: { en: 'Name', cs: 'Jméno' } }] },
  { columns: [{ field: 'name', cell: { kind: 'number' } }] }, { columns: [{ field: 'name', cell: { kind: 'badge' } }] },
  { columns: [{ field: 'status', cell: { kind: 'badge', tones: { missing: 'positive' } } }] },
  { columns: [{ field: 'status', cell: { kind: 'badge', tones: { active: 'green' } } }] },
  { columns: [{ field: 'code', cell: { kind: 'identifier', css: 'anything' } }] },
  { filter: { missing: false } }, { filter: { name: { operators: ['eq'] } } }, { filter: { status: { operators: ['gt'] } } },
  { filter: { created_at: { operators: ['eq'] } } }, { filter: { created_at: { operators: ['lte'] } } }, { filter: { enabled: { operators: ['isNull'] } } },
  { filter: { status: { operators: [] } } }, { filter: { status: { operators: ['in', 'in'] } } },
  { views: [{ id: 'all', label: 'All', where: { status: { eq: 'active' } } }] },
  { views: [{ id: 'all', label: 'All', where: {}, rowAccess: 'invited' }] },
  { views: [{ id: 'missing', label: 'Missing' }] }, { views: [{ id: 'all', label: 'All' }] },
  { search: ['organization_id'] },
  { views: [{ id: 'same', label: 'A', where: {} }, { id: 'same', label: 'B', where: {} }] },
  { views: [{ id: 'first', label: 'A', where: {}, default: true }, { id: 'second', label: 'B', where: {}, default: true }] },
  { views: Array.from({ length: 9 }, (_, i) => ({ id: `view_${i}`, label: 'View', where: {} })) },
])('rejects invalid list combination %j', list => expect(() => parse(list)).toThrow())
it('derives full control/model operator intersections and keeps row access opt-in', () => {
  const result = parse({ filter: { name: {}, enabled: {}, team_id: {}, created_at: {} }, rowAccess: { column: true } })
  expect(result.filter).toEqual({ name: { kind: 'text', placement: 'panel', operators: ['contains'] }, enabled: { kind: 'boolean', placement: 'panel', operators: ['eq', 'isNull'] }, team_id: { kind: 'relation', placement: 'panel', operators: ['in'] }, created_at: { kind: 'date', placement: 'panel', operators: ['gte', 'lt'] } })
  expect(result.rowAccess).toEqual({ column: true })
})
it('validates related filter keys and keeps them label-text only', () => {
  const base = defineInstance({ ...input, entities: { ...input.entities, teams: { fields: { ...input.entities.teams.fields, parent_id: { type: 'ref', entity: 'teams' } } } } })
  const related = { relatedColumns: { team_parent: { via: 'team_id', field: 'parent_id' } }, filter: { team_parent: { placement: 'toolbar' } } }
  const parsed = defineInstance({ ...base, ui: { entities: { workers: { list: related as never } } } })
  expect(parsed.ui!.entities.workers.list!.filter!.team_parent).toEqual({ kind: 'text', placement: 'toolbar', operators: ['contains'] })
  expect(() => defineInstance({ ...base, ui: { entities: { workers: { list: { ...related, filter: { team_parent: 'relation' } } as never } } } })).toThrow(/filter kind/)
})
it('accepts built-in cell overrides without changing field format metadata', () => {
  const parsed = parse({ columns: [{ field: 'code', cell: { kind: 'text' } }, { field: 'created_at', cell: { kind: 'datetime' } }, { field: 'name', cell: { kind: 'identifier', copy: false } }] })
  expect(parsed.columns![0].cell).toEqual({ kind: 'text' })
  expect(parsed.columns![2].cell).toEqual({ kind: 'identifier', copy: false })
  expect(input.entities.workers.fields.code.ui.format).toBe('identifier')
})
