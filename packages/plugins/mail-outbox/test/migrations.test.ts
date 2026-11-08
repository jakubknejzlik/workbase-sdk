import { expect, it } from 'vitest'
import { sha256 } from '@workbasehq/core/crypto'
import { mailOutbox } from '../src'

// Names, order and SHA-256(sql) captured on base 40c6e2ac877537f7fbc7acfda192ff73fae8fbe0.
// Existing pins are immutable; append a pin when appending a migration.
it('pins the append-only migration names, order and SQL checksums', async () => {
  const actual = await Promise.all(mailOutbox().migrations!.map(async ({ name, sql }) => ({ name, sha256: await sha256(sql) })))
  expect(actual).toEqual([
    { name: '001_adopt_delivery', sha256: '07070358c21ec24a0487a4b5e943f30d356b75a6349847192a6d302d693e07cd' },
    { name: '002_sender_name', sha256: '0a8fb93647ccf7d0fc72eecf803b453a701cbf6dd3f3d925ca1a6690738d4c09' },
  ])
})
