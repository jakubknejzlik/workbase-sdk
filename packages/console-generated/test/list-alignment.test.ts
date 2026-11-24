import { expect, it } from 'vitest'
import { listColumnAlignment } from '../src/list-presentation'
import type { Model } from '../src/read'
import type { ListCell } from '../../core/src/list-contract'

const cases: { name: string; type: string; cell?: ListCell; expected: string }[] = [
  { name: 'text', type: 'string', cell: { kind: 'text' }, expected: 'left' },
  { name: 'identifier', type: 'string', cell: { kind: 'identifier' }, expected: 'left' },
  { name: 'badge', type: 'enum', cell: { kind: 'badge' }, expected: 'left' },
  { name: 'date', type: 'datetime', cell: { kind: 'date' }, expected: 'center' },
  { name: 'date-only metadata', type: 'date', expected: 'center' },
  { name: 'datetime', type: 'datetime', cell: { kind: 'datetime' }, expected: 'center' },
  { name: 'number', type: 'number', cell: { kind: 'number' }, expected: 'right' },
  { name: 'boolean', type: 'bool', expected: 'center' },
  { name: 'relation rendered as text', type: 'ref', cell: { kind: 'text' }, expected: 'center' },
  { name: 'int rendered as identifier', type: 'int', cell: { kind: 'identifier' }, expected: 'right' },
  { name: 'float rendered as text', type: 'float', cell: { kind: 'text' }, expected: 'right' },
  { name: 'text rendered as number', type: 'string', cell: { kind: 'number' }, expected: 'left' },
  { name: 'text rendered as date', type: 'text', cell: { kind: 'date' }, expected: 'left' },
]
function model(type: string, cell?: ListCell): Model {
  return { instance: 'alignment', revision: 1, limits: { root: 100, children: 20, relations: 4, exists: 4 }, entities: {
    entries: { fields: { value: { type } }, columns: ['value'], relations: {}, routes: { list: '', detail: '' },
      list: { columns: [{ field: 'value', cell }], relatedColumns: { clinic: { via: 'value', field: 'clinic_id' } } } },
  } }
}
it.each(cases)('defaults $name by schema type', ({ type, cell, expected }) => {
  expect(listColumnAlignment(model(type, cell), 'entries', 'value')).toBe(expected)
})
it('centers related label columns without local scalar metadata', () => {
  expect(listColumnAlignment(model('ref'), 'entries', 'clinic')).toBe('center')
})
it('falls back to left for unknown metadata', () => {
  expect(listColumnAlignment(model('json'), 'entries', 'value')).toBe('left')
  expect(listColumnAlignment(model('string'), 'entries', 'missing')).toBe('left')
})
