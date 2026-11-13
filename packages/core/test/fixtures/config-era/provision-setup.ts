import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TestProject } from 'vitest/node'
import { checkSchema, parseLock } from '../../../src/migrations/schema-lock'
import { readFileSync } from 'node:fs'
import { loadConfig } from '../../../src/schema/load'
import { KernelRegistry } from '../../../src/kernel/registry'
import { plan } from '../../../src/migrations/planner'
import { tsImport } from 'tsx/esm/api'
import { expectedSchema } from '../../../src/infra/schema'
import { sha256 } from '../../../src/infra/migration-files'
import type { Migration } from '../../../src/infra/d1-migrations'
import type { SchemaRevision } from '../../../src/schema-compatibility'

declare module 'vitest' {
  interface ProvidedContext {
    eraProvision: { provisioned: SchemaRevision; shared: SchemaRevision; files: Migration[] }
  }
}

// Node host setup runs the real provisioning child, including both tsImport realms.
// Only serializable fingerprints/files cross into the workerd test runner.
export default async function setup({ provide }: TestProject) {
  const root = fileURLToPath(new URL('.', import.meta.url).href)
  const directory = mkdtempSync(join(tmpdir(), 'workbase-era-'))
  try {
    const { config } = await loadConfig(join(root, 'config.ts'))
    checkSchema(config, parseLock(readFileSync(join(root, 'schema.lock.json'), 'utf8')))
    const kernel = new KernelRegistry(config)
    const sql = plan(null, kernel.config).sql
    const files = [{ filename: '0001_r1.sql', sql, checksum: sha256(sql) }]
    writeFileSync(join(directory, files[0].filename), sql)
    // Native import preserves import.meta.resolve used by installed package lookup.
    const { createProvisionPlan } = await tsImport(new URL('../../../src/infra/provision-plan.ts', import.meta.url).href, import.meta.url)
    const provision = await createProvisionPlan({
      projectRoot: root, configPath: './config.ts', handler: './worker.ts', migrationsDir: directory,
      resourcePrefix: 'era', stage: 'staging', authBaseUrl: 'https://era.example.test',
      authSecret: 'synthetic-test-secret-at-least-32-characters',
    })
    const shared = await expectedSchema({ migrationsDirectory: directory, revision: config.revision, config: kernel.config })
    provide('eraProvision', { provisioned: JSON.parse(provision.environment.SCHEMA_EXPECTED), shared, files })
  } finally { rmSync(directory, { recursive: true, force: true }) }
}
