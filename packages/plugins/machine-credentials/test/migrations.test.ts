import { expect, it } from 'vitest'
import { sha256 } from '@workbasehq/core/crypto'
import { machineCredentials } from '../src'

// Names, order and SHA-256(sql) captured on base 40c6e2ac877537f7fbc7acfda192ff73fae8fbe0.
// Existing pins are immutable; append a pin when appending a migration.
it('pins the append-only migration names, order and SQL checksums', async () => {
  const actual = await Promise.all(machineCredentials().migrations!.map(async ({ name, sql }) => ({ name, sha256: await sha256(sql) })))
  expect(actual).toEqual([
    { name: '001_adopt_tokens', sha256: '5080b7aa8ad82802c122c5e55bfabaa1f82dffc265ab3f234a2ca9a6551ec580' },
  ])
})
