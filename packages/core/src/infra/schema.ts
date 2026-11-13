import { CORE_VERSION, type InstanceConfig } from '../config'
import { expectedPluginMigrations } from '../kernel/migrations'
import { KernelRegistry } from '../kernel/registry'
import type { SchemaRevision } from '../schema-compatibility'
import { migrationHash, readMigrationFiles, sha256 } from './migration-files'

export interface ExpectedSchemaOptions {
  migrationsDirectory: string
  revision: number
  config?: InstanceConfig
  /** Override for non-Workbase SQL databases. Defaults to the installed core version. */
  coreVersion?: string
}

export async function expectedSchema({ migrationsDirectory, revision, config, coreVersion = CORE_VERSION }: ExpectedSchemaOptions): Promise<SchemaRevision> {
  const plugins = config ? new KernelRegistry(config).plugins : []
  return {
    revision, coreVersion, migrations: migrationHash(await readMigrationFiles(migrationsDirectory)),
    ...(config ? { pluginMigrations: sha256(JSON.stringify(await expectedPluginMigrations(plugins, config))) } : {}),
  }
}
