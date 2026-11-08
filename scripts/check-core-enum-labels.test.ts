import { expect, it } from 'vitest'
import { coreEnums } from '../packages/core/src/query/enum-values'
import catalog from '../packages/core/src/query/enum-labels.json'
import { assertCoreEnumLabels } from './check-core-enum-labels'

it.each([
  {}, [], null, 'catalog', 42,
  { en: {} }, { en: [] }, { en: null }, { en: 'labels' },
  { '': { value_owner: 'Owner' } },
  { en: { value_owner: null } }, { en: { value_owner: 42 } },
  { en: { value_owner: {} } }, { en: { value_owner: [] } },
  { en: catalog.en, cs: {} },
].map(value => [value]))('rejects malformed or empty catalogs: %j', value => {
  expect(() => assertCoreEnumLabels(value)).toThrow(/Core enum/)
})

it('rejects an empty derived runtime enum set explicitly', () => {
  const descriptor = Object.getOwnPropertyDescriptor(coreEnums, 'role')!
  try {
    Object.defineProperty(coreEnums, 'role', { ...descriptor, value: [] })
    expect(() => assertCoreEnumLabels(catalog)).toThrow('Core enum set must not be empty')
  } finally {
    Object.defineProperty(coreEnums, 'role', descriptor)
  }
  expect(() => assertCoreEnumLabels(catalog)).not.toThrow()
})

it('rejects labels outside the runtime role declaration', () => {
  expect(() => assertCoreEnumLabels({ en: { value_restaurant: 'Restaurant' } })).toThrow('Non-core enum label: en.value_restaurant')
  expect(() => assertCoreEnumLabels(catalog)).not.toThrow()
})

it('ignores enum lists that the runtime does not consume', () => {
  try {
    Object.defineProperty(coreEnums, 'guardOnly', { configurable: true, enumerable: true, value: ['restaurant'] })
    expect(() => assertCoreEnumLabels({ en: { value_restaurant: 'Restaurant' } })).toThrow('Non-core enum label: en.value_restaurant')
  } finally {
    Reflect.deleteProperty(coreEnums, 'guardOnly')
  }
})
