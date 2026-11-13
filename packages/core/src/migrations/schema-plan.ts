import type { InstanceConfig } from '../config'
import type { SourceMap } from '../schema/load'
import { sha256 } from '../crypto'
import { checkBundle, hasManual, manualEvidence, parseBundle, renderBundle } from './schema-bundle'
import { diffSpecs, lockBytes, parseLock, schemaLock, type SchemaLock } from './schema-lock'

export type MigrationFiles = Readonly<Record<string, string>>
export interface ExistingBundle { filename: string; sql: string }
export const bundleFilename = (revision: number) => `${String(revision).padStart(4, '0')}_r${revision}.sql`
export function fileRevision(filename: string): number {
  const match = /^(\d+)_r([1-9]\d*)\.sql$/.exec(filename)
  if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) !== Number(match[2])) throw new Error(`${filename}:1: filename N must equal rN`)
  return Number(match[2])
}
export function assertBaseFiles(base: MigrationFiles, current: MigrationFiles, replacing?: string) {
  for (const [file, sql] of Object.entries(base)) if (file !== replacing && current[file] !== sql) throw new Error(`${file}:1: base migration ${current[file] === undefined ? 'missing' : 'edited'}; restore base bytes`)
}
function assertColumnOrder(base: SchemaLock | undefined, lock: SchemaLock) {
  for (const table of base?.tables ?? []) {
    const current = lock.tables.find(t => t.name === table.name)
    if (!current) continue // diffSpecs reports unsupported table drops.
    for (const [i, column] of table.columns.entries()) if (current.columns[i]?.name !== column.name) {
      throw new Error(`schema.lock.json:1: ${table.name}.${column.name}: column order must preserve the base prefix; append new columns`)
    }
  }
}
/** Checks the single permitted transition from the ref tip, never a merge-base. */
export async function checkLinkage(baseLock: string | undefined, baseMigrations: MigrationFiles, currentLock: string, migrations: MigrationFiles) {
  if (baseLock === undefined && Object.keys(baseMigrations).length) throw new Error('Missing schema.lock.json in base with domain migrations; unsupported base history')
  assertBaseFiles(baseMigrations, migrations)
  const lock = parseLock(currentLock), base = baseLock === undefined ? undefined : parseLock(baseLock)
  assertColumnOrder(base, lock)
  const added = Object.keys(migrations).filter(file => !(file in baseMigrations))
  for (const [file, sql] of Object.entries(migrations)) {
    const bundle = await checkBundle(file, sql)
    if (fileRevision(file) !== bundle.revision) throw new Error(`${file}:1: header revision differs from filename`)
  }
  if (currentLock === baseLock && added.length === 0) return
  if (lock.parent !== (baseLock === undefined ? null : await sha256(baseLock))) throw new Error('schema.lock.json:1: wrong parent or stale base; regenerate against --base <ref> tip')
  if (lock.revision !== (base?.revision ?? 0) + 1) throw new Error('schema.lock.json:1: revision skip or stale base; expected base.revision + 1')
  if (added.length !== 1) throw new Error(`Expected exactly one new migration file; found ${added.length}`)
  const file = added[0], bundle = parseBundle(file, migrations[file])
  if (fileRevision(file) !== lock.revision) throw new Error(`${file}:1: migration gap; expected r${lock.revision}`)
  if (bundle.parent !== lock.parent) throw new Error(`${file}:1: wrong parent; header must match schema.lock.json`)
  const generated = diffSpecs(base?.tables ?? [], lock.tables)
  if (!generated) throw new Error(`${file}:1: empty schema diff; data-only migrations are unsupported`)
  if (bundle.generated !== generated) throw new Error(`${file}:1: generated region differs from lock diff; regenerate`)
}
/** Pure planning: all filesystem and Git state are supplied as bytes. */
export async function plan(input: {
  baseLock?: string; baseMigrations: MigrationFiles; config: InstanceConfig
  existingBundle?: ExistingBundle; confirmManual?: boolean; sources?: SourceMap
}) {
  const { baseLock, baseMigrations, config, existingBundle, confirmManual, sources } = input
  const base = baseLock === undefined ? undefined : parseLock(baseLock)
  const lock = schemaLock(config, base, sources)
  assertColumnOrder(base, lock)
  const generated = diffSpecs(base?.tables ?? [], lock.tables)
  const previous = existingBundle && parseBundle(existingBundle.filename, existingBundle.sql)
  if (!generated && base) {
    if (previous && hasManual(previous)) throw new Error(`${existingBundle!.filename}:1: empty schema diff has manual SQL; refusing to delete manual regions`)
    return { lock: baseLock!, bundle: undefined }
  }
  lock.parent = baseLock === undefined ? null : await sha256(baseLock)
  const bundle = { revision: lock.revision, parent: lock.parent, manual: 'none', pre: previous?.pre ?? '', generated, post: previous?.post ?? '' }
  if (hasManual(bundle)) {
    const unchanged = previous && previous.generated === generated && previous.parent === bundle.parent && previous.revision === bundle.revision
    bundle.manual = confirmManual ? await manualEvidence(bundle) : unchanged ? previous.manual : 'unconfirmed'
  }
  const filename = bundleFilename(lock.revision)
  if (filename in baseMigrations) throw new Error(`${filename}:1: new migration collides with base`)
  return { lock: lockBytes(lock), bundle: { filename, sql: renderBundle(bundle) } }
}
