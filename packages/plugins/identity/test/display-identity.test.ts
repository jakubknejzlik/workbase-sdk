import { expect, it } from 'vitest'
import { displayIdentity } from '../src/index'

it.each([
  [{ firstName: ' Ada ', lastName: ' Lovelace ', email: 'ada@example.test', token: 'never-project', subject: 'secret' }, { displayName: 'Ada Lovelace', source: 'profile' }],
  [{ name: ' Legacy Display ', email: 'legacy@example.test' }, { displayName: 'Legacy Display', source: 'legacy_name' }],
  [{ name: ' ', email: ' legacy@example.test ' }, { displayName: 'legacy@example.test', source: 'email' }],
  [null, { displayName: null, source: 'unavailable' }],
  [{}, { displayName: null, source: 'unavailable' }],
])('projects only authorized display fields with an honest fallback: %j', (row, expected) => {
  expect(displayIdentity(row)).toEqual(expected)
})
