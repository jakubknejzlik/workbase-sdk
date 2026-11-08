import { expect, it } from 'vitest'
import { sha256 } from '@workbasehq/core/crypto'
import { identity } from '../src'

// Names, order and SHA-256(sql) captured on base 40c6e2ac877537f7fbc7acfda192ff73fae8fbe0.
// Existing pins are immutable; append a pin when appending a migration.
it('pins the append-only migration names, order and SQL checksums', async () => {
  const actual = await Promise.all(identity.migrations!.map(async ({ name, sql }) => ({ name, sha256: await sha256(sql) })))
  expect(actual).toEqual([
    { name: '001_profiles', sha256: 'eeb604d01d142d7f2cb256e95e10804f7e6776300cf5b70bcfd178df6b163d85' },
  ])
})
