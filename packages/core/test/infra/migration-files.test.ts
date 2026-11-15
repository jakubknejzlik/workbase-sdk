import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readMigrationFiles, validateMigrationFilenames, sha256 } from '@workbasehq/core/infra'
import { MigrationDiagnostic } from '../../src/infra/diagnostics'

it.each([
  [['0002_r1.sql'], 'migration_sequence_gap_or_duplicate:0002_r1.sql'],
  [['0001_r1.sql', '0003_r2.sql'], 'migration_sequence_gap_or_duplicate:0003_r2.sql'],
  [['0001_r1.sql', '0001_r2.sql'], 'migration_sequence_gap_or_duplicate:0001_r2.sql'],
  [['initial.sql'], 'invalid_migration_filename'],
] as const)('shares typed filename preflight with the loader: %j', async (names, message) => {
  const root = await mkdtemp(join(tmpdir(), 'migration-files-'))
  try {
    await Promise.all(names.map(name => writeFile(join(root, name), 'SELECT 1;')))
    expect(() => validateMigrationFilenames(names)).toThrow(MigrationDiagnostic)
    expect(() => validateMigrationFilenames(names)).toThrow(message)
    await expect(readMigrationFiles(root)).rejects.toThrow(message)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('reads consecutive migrations in sorted order without changing SQL or checksums', async () => {
  const root = await mkdtemp(join(tmpdir(), 'migration-files-'))
  const sql = '-- exact bytes\nSELECT 1;\n'
  try {
    for (const name of ['0002_r2.sql', '0001_r1.sql']) await writeFile(join(root, name), sql)
    expect(await readMigrationFiles(root)).toEqual(['0001_r1.sql', '0002_r2.sql'].map(filename => ({ filename, sql, checksum: sha256(sql) })))
  } finally { await rm(root, { recursive: true, force: true }) }
})
