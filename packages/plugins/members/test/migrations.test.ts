import { expect, it } from 'vitest'
import { sha256 } from '@workbasehq/core/crypto'
import { members } from '../src'

// Names, order and SHA-256(sql) captured on base 40c6e2ac877537f7fbc7acfda192ff73fae8fbe0.
// Existing pins are immutable; append a pin when appending a migration.
it('pins the append-only migration names, order and SQL checksums', async () => {
  const actual = await Promise.all(members.migrations!.map(async ({ name, sql }) => ({ name, sha256: await sha256(sql) })))
  expect(actual).toEqual([
    { name: '001_scopes', sha256: '9a5e04bdc76c3568d4ab96708e58e3f75b3706353d0267eca9c8f1dd75172c32' },
    { name: '002_pending_invitations', sha256: 'ed9b4dd26a84c31663752bc7d65ffe005be940e08e77e49d56b4cb495f147ccc' },
    { name: '003_recipients', sha256: '4cac1f377e300e468ce413f4fe2b9ea3f474ad893d109162d3891bd38a54185a' },
    { name: '004_row_invitations', sha256: '457f9c7ed8f8adc56bc14dc0e049e570514a5cc1048640c914dd9131f6fb40fc' },
  ])
})
