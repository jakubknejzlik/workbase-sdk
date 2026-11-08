import { expect, it } from 'vitest'
import { sha256 } from '@workbasehq/core/crypto'
import { audit } from '../src'

// Names, order and SHA-256(sql) captured on base 40c6e2ac877537f7fbc7acfda192ff73fae8fbe0.
// Existing pins are immutable; append a pin when appending a migration.
it('pins the append-only migration names, order and SQL checksums', async () => {
  const actual = await Promise.all(audit().migrations!.map(async ({ name, sql }) => ({ name, sha256: await sha256(sql) })))
  expect(actual).toEqual([
    { name: '001_adopt_outbox', sha256: '0e87171386a77e6c2b4aa0c9fe3a605cef33088324eb02bfefb73d6c29d9205b' },
    { name: '002_delivery_backoff', sha256: 'e535099de0ed0e7ffd40bbbcea2bd829bc31318c3fee2162b64ddc070b8d8244' },
  ])
})
