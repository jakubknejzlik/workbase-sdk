import { expect, it } from 'vitest'
import { sha256 } from '@workbasehq/core/crypto'
import { organizations } from '../src'

// Names, order and SHA-256(sql) captured on base 40c6e2ac877537f7fbc7acfda192ff73fae8fbe0.
// Existing pins are immutable; append a pin when appending a migration.
it('pins the append-only migration names, order and SQL checksums', async () => {
  const actual = await Promise.all(organizations.migrations!.map(async ({ name, sql }) => ({ name, sha256: await sha256(sql) })))
  expect(actual).toEqual([
    { name: '001_adopt_scopes', sha256: '4191994cd8b0029666df92057b40e1fdd4782921b5d336465042d2a069a6d1bd' },
  ])
})
