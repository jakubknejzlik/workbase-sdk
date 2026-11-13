import { MigrationDiagnostic } from '../migrations/diagnostics'
import type { InstanceConfig } from '../config'

/** Bind lock data before exporting a runtime config; safe in Worker bundles (no IO). */
export function bindSchemaLock<T extends InstanceConfig>(config: T, lock: unknown): T {
  if (config.baseline !== 'workbase-sdk') throw new Error('Schema locks require a workbase-sdk config')
  const value = lock as { lockVersion: number; revision: number; parent: unknown; tables: unknown[] }
  if (!value || value.lockVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1 || value.parent !== null || !Array.isArray(value.tables)) throw new Error('Invalid schema.lock.json')
  Object.defineProperty(config, 'revision', { value: value.revision, enumerable: true, configurable: true, writable: false })
  return config
}

/** Data check also covers copies, JSON and configs evaluated in separate module realms. */
export function assertSchemaLockBound(config: { baseline?: string; revision?: number }): void {
  if (config.baseline === 'workbase-sdk' && (!Number.isSafeInteger(config.revision) || config.revision! < 1)) throw new MigrationDiagnostic({ code: 'schema_lock_not_bound' })
}
