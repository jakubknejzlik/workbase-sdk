import { pluginMigrationStatus } from './kernel/migrations'
import { resolvePlugins } from './kernel/composition'
import { CORE_VERSION, type InstanceConfig } from './config'
export interface SchemaEnvironment { SCHEMA_EXPECTED?: string; STAGE?: string }
export interface SchemaRevision { revision: number; coreVersion: string; migrations: string; pluginMigrations?: string }
export interface SchemaStatus { enabled: boolean; compatible: boolean; expected: SchemaRevision | null; applied: SchemaRevision | null }
export async function hashMigrationRows(rows: { filename: string; checksum: string }[]) {
  const bytes = new TextEncoder().encode(JSON.stringify(rows.map(({ filename, checksum }) => ({ filename, checksum }))))
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(byte => byte.toString(16).padStart(2, '0')).join('')
}
async function migrationRevision(db: D1Database) {
  const rows = await db.prepare('SELECT filename,checksum FROM _migrations ORDER BY filename').all<{ filename: string; checksum: string }>()
  return hashMigrationRows(rows.results)
}
// Full validation for health, deployment verification and explicit diagnostic callers.
// Ordinary request handling never checks schema compatibility.
// SCHEMA_EXPECTED is injected by SST for every deployed Worker. Local workerd/Wrangler uses its own migration ledger.
export async function schemaStatus(env: SchemaEnvironment & { DB: D1Database; AUDIT_KV?: KVNamespace }, config?: Pick<InstanceConfig, 'revision'> & Partial<Pick<InstanceConfig, 'plugins' | 'interactive' | 'entities'>>): Promise<SchemaStatus> {
  if (!env.SCHEMA_EXPECTED) return { enabled: false, compatible: !env.STAGE || env.STAGE === 'local', expected: null, applied: null }
  let expected: SchemaRevision | null = null
  try {
    expected = JSON.parse(env.SCHEMA_EXPECTED) as SchemaRevision
    if (!Number.isInteger(expected.revision) || typeof expected.coreVersion !== 'string' || !/^[a-f0-9]{64}$/.test(expected.migrations)) throw new Error('invalid_expected_revision')
    const meta = config || env.AUDIT_KV ? await env.DB.prepare('SELECT revision,core_version FROM instance_meta ORDER BY revision DESC LIMIT 1').first<{ revision: number; core_version: string }>() : { revision: 1, core_version: 'receiver-v1' }
    const applied: SchemaRevision = { revision: meta?.revision ?? -1, coreVersion: meta?.core_version ?? '', migrations: await migrationRevision(env.DB) }
    let pluginsCompatible = true
    if (config?.plugins?.length || expected.pluginMigrations) {
      if (!config?.plugins || !/^[a-f0-9]{64}$/.test(expected.pluginMigrations ?? '')) throw new Error('missing_plugin_revision')
      const plugins = resolvePlugins(config.plugins, config.interactive).plugins
      if (!config.entities) throw new Error('missing_instance_schema')
      const pluginStatus = await pluginMigrationStatus(env.DB, plugins, { entities: config.entities })
      for (const plugin of plugins) await plugin.checkEnvironment?.(env)
      applied.pluginMigrations = pluginStatus.applied
      pluginsCompatible = expected.pluginMigrations === pluginStatus.expected && pluginStatus.applied === pluginStatus.expected
    }
    const compatible = pluginsCompatible && applied.revision === expected.revision && applied.coreVersion === expected.coreVersion && applied.migrations === expected.migrations
      && (!config || (config.revision === expected.revision && CORE_VERSION === expected.coreVersion))
    return { enabled: true, compatible, expected, applied }
  } catch {
    // A missing ledger/binding or unreadable DB fails closed, without leaking database exceptions.
    return { enabled: true, compatible: false, expected, applied: null }
  }
}
