# Historical positive SDK consumer

Generated on 2026-11-09 with Bun 1.4.3 on Darwin arm64, in a unique
`TMPDIR/wb186-historical-*` standalone directory outside the checkout.
All three packages were installed from https://registry.npmjs.org at **0.2.9**:

```sh
bun install --ignore-scripts --no-cache --linker hoisted --registry https://registry.npmjs.org
```

`package.json` and `bun.lock` are the actual installation inputs/output, copied
without rewriting. `config.ts` is a small authored consumer using the historical
`defineInstance` and published permissions factory. The generation script imported
only modules resolved inside that installation:

```ts
import config from './config.ts'
import { CORE_VERSION } from '@workbasehq/core/config'
import { initialSchema, quote } from '@workbasehq/core/migrations/schema'
import { versionData } from '@workbasehq/core/migrations/versions'
// Assert CORE_VERSION === '0.2.9'.
const indexes = [{ name: 'notes_title_idx', entity: 'notes', fields: ['title'] }]
const sql = initialSchema(config) + indexes.map(i =>
  `CREATE INDEX ${quote(i.name)} ON ${quote(i.entity)} (${['organization_id', ...i.fields].map(quote).join(', ')});\n`).join('')
// Write sql to migrations/0001_initial.sql and indexes as pretty JSON.
const history = [{ revision: config.revision, date: '2026-11-09T00:00:00.000Z', config: versionData(config) }]
// Write history as pretty JSON. The fixed date makes regeneration deterministic.
```

Before removing the historical installation, the MCP D1 primitives downloaded all
three registry archives, checked their dist.integrity and verified the complete
installed SDK file sets against those archives. This passed; no historical SQL or
lockfile was synthesized or repaired using the candidate SDK.

Frozen raw-byte SHA-256 values:

| File | SHA-256 |
| --- | --- |
| bun.lock | d36886bf4dcba552d1421f0b58934990ec16e23dbac6accc40f47921f3d1da65 |
| migrations/0001_initial.sql | 9d0cbdf589b6914d49640a118cb8789e68a1a6e5efe85b5ca06a6f77456287ff |

The direct bridge integration in `sdk-upgrade-worker.test.ts` installs published
0.2.10 and checks this fixture's physical schema (including its index), plugin
migration digests, unchanged revision, target marker and input hashes. The older
`scripts/test/fixtures/sdk-0.2.1-revision-3` fixture remains incompatible and is
covered as a rejection without editing it.
