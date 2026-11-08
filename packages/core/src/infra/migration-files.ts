import { MigrationDiagnostic } from './diagnostics'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Migration } from './d1-migrations'
export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
export async function readMigrationFiles(directory: string): Promise<Migration[]> {
  const names = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()
  if (!names.length) throw new MigrationDiagnostic({ code: 'no_migrations' })
  return Promise.all(names.map(async (filename, index) => {
    if (!/^[0-9]{4}_[a-zA-Z0-9_-]+\.sql$/.test(filename)) throw new MigrationDiagnostic({ code: 'invalid_migration_filename', filename: filename })
    if (Number(filename.slice(0, 4)) !== index + 1) throw new MigrationDiagnostic({ code: 'migration_sequence_gap_or_duplicate', filename: filename })
    const sql = await readFile(join(directory, filename), 'utf8')
    return { filename, sql, checksum: sha256(sql) }
  }))
}
export const migrationHash = (files: readonly Migration[]) => sha256(JSON.stringify(files.map(({ filename, checksum }) => ({ filename, checksum }))))
