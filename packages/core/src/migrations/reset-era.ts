import type { InstanceConfig } from '../config'
import { MigrationDiagnostic } from './diagnostics'
import { SDK_BASELINE, SDK_NAMESPACE } from './sdk-baseline'

export type MigrationConfig = Pick<InstanceConfig, 'entities'> & Partial<Pick<InstanceConfig, 'languages'>>
/** languages is retained by kernel normalization, unlike the loader's WeakSet brand. */
export function usesSdkBaseline(config?: Partial<Pick<InstanceConfig, 'languages'>>) {
  return config?.languages !== undefined
}

/** Read-only preflight, also used by direct kernel migration callers.
 * A failed first SDK file may leave an empty receipt table, which is safe to retry.
 * Every other pre-baseline application table/history requires an explicit reset. */
export async function assertResetEra(db: D1Database): Promise<boolean> {
  const { results: tables } = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY name").all<{ name: string }>()
  const ledger = tables.some(row => row.name === '_plugin_migrations')
  const receipts = ledger ? (await db.prepare('SELECT namespace,name,position FROM _plugin_migrations ORDER BY namespace,position').all<{ namespace: string; name: string; position: number }>()).results : []
  const baseline = receipts.some(row => row.namespace === SDK_NAMESPACE && row.name === SDK_BASELINE && row.position === 0)
  const legacy = receipts.some(row => row.namespace === 'workbase-core')
  const application = tables.filter(row => row.name !== '_plugin_migrations')
  if (legacy || (!baseline && (application.length || receipts.length))) {
    throw new MigrationDiagnostic({ code: 'migration_unsupported_history', found: [
      ...application.map(row => row.name),
      ...(ledger ? ['_plugin_migrations'] : []),
      ...(legacy ? ['workbase-core'] : []),
    ] })
  }
  return ledger
}
