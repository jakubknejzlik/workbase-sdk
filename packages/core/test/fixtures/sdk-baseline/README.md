# Released legacy migration fixtures

`released-1d09aee4.json` was captured by extracting git commit `1d09aee4`,
loading its own `defineInstance`, `initialSchema`, `KernelRegistry` and
`migrateInstance`, and migrating an empty SQLite database with
`{ id: 'legacy', revision: 1, entities: {} }`. No current migration generator
was used. `released-1f88765.json` was captured identically from `1f88765`,
before the operational evidence migration existed. Both SDKs stamp `0.2.15`.

Each fixture contains the exact generated migration file and checksum, a SQL
dump of the resulting database (tables, data, then indexes/triggers), and the
captured domain ledger, plugin receipts and revision row. The dump retains
captured timestamps. Tests load this frozen dump without invoking the current
SDK to synthesize historical state.

Both initial SQL files are 8676 bytes with SHA-256
`e9f01a0c333eeac9ae63a449fac1691bad86f1172403dcf797481ebc3f86e544`.
The released `workbase-core/001_model_b` receipt is
`3fcef56418b09997aa04007ed1256ab78a35fecf6829fad0326bc05071e35eab`;
`1d09aee4` additionally has `002_operational_evidence` with checksum
`c1be8371a4e441474e8afba886976fa67b5301f80c2ff5737f7bd1f56bdc7ea4`.

The legacy generator stamps the creating SDK version into `instance_meta`.
Consequently a newly generated file changes checksum when that version changes.
This is intentional for new files, but released files must remain unchanged:
`readMigrationFiles` hashes the retained files, and `migrateD1` compares those
checksums against `_migrations`. Plugin migration SQL has its own append-only
checksum contract in `_plugin_migrations`. Neither ledger regenerates the
legacy initial SQL to detect an existing installation.

`expectLegacyInitialSQL` therefore pins the historical hash and compares every
byte under the explicit historical revision stamp, while separately checking
the current stamp. The upgrade contract also proves that substituting newly
generated SQL for the released file fails before writes; keeping the original
file upgrades successfully, preserves existing receipts byte-for-byte, applies
pending evidence once, and repeats without migration or stamp writes (the legacy engine still issues
its guarded ledger-table creation statement). Deployment intentionally
refreshes the latest `instance_meta.core_version` and `applied_at` after both
ledgers verify; that mutable deployment stamp is not a migration receipt.

The SDK reset baseline in `src/migrations/sdk-baseline.ts` is a separate,
immutable migration in the `workbase-sdk` namespace. Its checksum pin remains
unchanged. These fixtures exercise the retained legacy `workbase-core` path.
