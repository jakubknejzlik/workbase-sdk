import { expect, inject, it } from 'vitest'
import { CORE_VERSION, cloneInstanceConfig, defineInstance, serializableInstanceConfig, type InstanceConfig } from '../../../src/config'
import { DeclarationError, isSchemaConfig } from '../../../src/schema'
import { KernelRegistry } from '../../../src/kernel/registry'
import { expectedPluginMigrations } from '../../../src/kernel/migrations'
import { initialSchema } from '../../../src/migrations/schema'
import { usesSdkBaseline } from '../../../src/migrations/reset-era'
import { migrateInstance } from '../../../src/infra/instance-migrations'
import { hashMigrationRows, schemaStatus } from '../../../src/schema-compatibility'
import { sha256 } from '../../../src/crypto'
import type { BaselineDatabase } from '../sdk-baseline/contract'
import { permissions } from '../../../../plugins/permissions/src'
import config from './config'
import type {} from './provision-setup'

const copies: [string, (c: InstanceConfig) => InstanceConfig][] = [
  ['identity', c => c], ['spread', c => ({ ...c })],
  ['cloneInstanceConfig', cloneInstanceConfig], ['serializableInstanceConfig', serializableInstanceConfig],
  ['JSON round-trip', c => JSON.parse(JSON.stringify(serializableInstanceConfig(c)))],
  ['structuredClone', c => structuredClone(c)],
  ['KernelRegistry.config', c => new KernelRegistry(c).config], ['defineInstance', defineInstance],
]

/** Promoted from the final verification probes; shared by Node SQLite and native D1. */
export function eraContract(database: () => BaselineDatabase, freshDatabase = database) {
  it('provisioning child -> migrate -> schemaStatus preserves SDK era across tsImport realms', async () => {
    const { provisioned, shared, files } = inject('eraProvision')
    const { db, query } = database(), kernel = new KernelRegistry(config)
    expect(initialSchema(kernel.config)).toBe(files[0].sql)
    await migrateInstance(query, files, kernel)
    expect((await db.prepare('SELECT DISTINCT namespace FROM _plugin_migrations').all()).results).toEqual([{ namespace: 'workbase-sdk' }])
    expect(await schemaStatus({ DB: db, STAGE: 'staging', SCHEMA_EXPECTED: JSON.stringify(provisioned) }, kernel.config)).toMatchObject({ compatible: true, applied: provisioned })
    expect(provisioned.pluginMigrations).toBe(shared.pluginMigrations)
  })

  for (const languages of [null, ['en'], [], undefined]) {
    const sdk = languages === null
    const label = sdk ? 'SDK' : `legacy languages=${JSON.stringify(languages)}`
    it.each(copies)(`${label} round-trip %s preserves SQL, receipts and compatibility`, async (_name, copy) => {
      const original = sdk ? config : defineInstance({ id: 'legacy', revision: 1, entities: {}, ...(languages === undefined ? {} : { languages: languages! }) })
      const copied = copy(original), kernel = new KernelRegistry(original), target = new KernelRegistry(copied)
      expect(usesSdkBaseline(copied)).toBe(sdk)
      expect(isSchemaConfig(copied)).toBe(sdk)
      expect(Object.hasOwn(copied, 'baseline')).toBe(sdk)
      expect(Object.hasOwn(target.config, 'baseline')).toBe(sdk)
      const sql = initialSchema(original)
      expect(initialSchema(copied)).toBe(sql)
      expect(initialSchema(target.config)).toBe(sql)
      // Captured on main 1f88765 for all three legacy language inputs.
      if (!sdk) expect(await sha256(sql)).toBe('e9f01a0c333eeac9ae63a449fac1691bad86f1172403dcf797481ebc3f86e544')
      const expected = await expectedPluginMigrations(kernel.plugins, kernel.config)
      expect(await expectedPluginMigrations(target.plugins, copied)).toEqual(expected)
      expect(await expectedPluginMigrations(target.plugins, target.config)).toEqual(expected)
      const files = [{ filename: '0001_r1.sql', sql, checksum: await sha256(sql) }]
      const { db, query } = database()
      await migrateInstance(query, files, kernel)
      const revision = { revision: original.revision, coreVersion: CORE_VERSION,
        migrations: await hashMigrationRows(files), pluginMigrations: await sha256(JSON.stringify(expected)) }
      expect(await schemaStatus({ DB: db, STAGE: 'staging', SCHEMA_EXPECTED: JSON.stringify(revision) }, target.config)).toMatchObject({ compatible: true, applied: revision })
      const fresh = freshDatabase()
      await migrateInstance(fresh.query, files, target)
      expect((await fresh.db.prepare('SELECT DISTINCT namespace FROM _plugin_migrations').all()).results).toEqual([{ namespace: sdk ? 'workbase-sdk' : 'workbase-core' }])
    })
  }

  it.each(['sdk', 'legacy', true, false, '', null, 0, {}])('invalid baseline %j fails parsing', baseline => {
    expect(() => defineInstance({ id: 'invalid', revision: 1, entities: {}, baseline } as any)).toThrow()
  })
  for (const sdk of [true, false]) {
    it.each(['workbase-sdk', undefined] as const)(`plugin configure baseline=%s cannot change ${sdk ? 'SDK' : 'legacy'} era`, baseline => {
      const original = sdk ? config : defineInstance({ id: 'legacy', revision: 1, entities: {} })
      const normalized = defineInstance({ ...original, interactive: false, plugins: [{ ...permissions({ roles: original.roles, ownerRole: original.organizationOwnerRole }), configure: () => ({ roles: original.roles, baseline }) }] })
      expect(usesSdkBaseline(normalized)).toBe(sdk)
      expect(Object.hasOwn(normalized, 'baseline')).toBe(sdk)
      expect(initialSchema(normalized)).toBe(initialSchema(original))
    })
  }
  it('hand-marked SDK input without compiled access fails closed at KernelRegistry', () => {
    const marked = defineInstance({ id: 'marked', revision: 1, entities: {}, baseline: 'workbase-sdk' } as any)
    expect(() => new KernelRegistry(marked)).toThrow(DeclarationError)
  })
}

function invalidDefinitionType() {
  // @ts-expect-error Legacy authoring omits the era field; normalized configs remain runtime inputs.
  defineInstance({ id: 'marked', revision: 1, entities: {}, baseline: 'workbase-sdk' })
}
void invalidDefinitionType
