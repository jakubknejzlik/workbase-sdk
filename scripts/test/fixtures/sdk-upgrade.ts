import { CORE_VERSION } from '../../../packages/core/src/config'
import { sha256 } from '../../../packages/core/src/infra/migration-files'
import type { Migration } from '../../../packages/core/src/infra/d1-migrations'

// Historical producer SQL stays immutable. Disposable fixtures explicitly upgrade
// their latest instance metadata before exercising the current SDK's strict gate.
export function sdkUpgradeMigration(lastFilename: string): Migration {
  const sequence = String(Number(lastFilename.slice(0, 4)) + 1).padStart(4, '0')
  const sql = `UPDATE instance_meta SET core_version = '${CORE_VERSION}' WHERE revision = (SELECT MAX(revision) FROM instance_meta);\n`
  return { filename: `${sequence}_sdk_upgrade.sql`, sql, checksum: sha256(sql) }
}
export function withSdkUpgrade(files: Migration[]): Migration[] {
  return [...files, sdkUpgradeMigration(files.map(file => file.filename).sort().at(-1)!)]
}
