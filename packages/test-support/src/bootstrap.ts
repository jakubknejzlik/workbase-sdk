import type { InstanceConfig } from '../../core/src/config'
import { sha256 } from '../../core/src/crypto'
import { migrateInstance } from '../../core/src/infra/instance-migrations'
import { KernelRegistry } from '../../core/src/kernel/registry'
import { splitStatements } from '../../core/src/kernel/migrations'
import { initialSchema } from '../../core/src/migrations/schema'

/** Replay test databases through production's SDK -> plugins -> domain ordering. */
export async function bootstrap(db: D1Database, config: InstanceConfig) {
  const kernel = new KernelRegistry(config)
  const sql = initialSchema(kernel.config)
  await migrateInstance(
    sql => db.batch(splitStatements(sql).map(statement => db.prepare(statement))),
    [{ filename: '0001_r1.sql', sql, checksum: await sha256(sql) }], kernel,
  )
  return kernel
}
