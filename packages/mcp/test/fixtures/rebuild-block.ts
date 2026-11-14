import { defineInstance } from '@workbasehq/core/config'
import { defineConfig, defineEntity, bindSchemaLock, defineAccess, accessEntities, accessSystemActions } from '@workbasehq/core/schema'
import { schemaLock } from '@workbasehq/core/migrations/schema-lock'
import { initialSchema } from '@workbasehq/core/migrations/schema'
import type { Change } from '../../src/schemas'

export const genericBlock = 'Rebuild blocked: physical schema or foreign key validation requires a manually reviewed migration'
export const columnsBlock = 'Rebuild blocked for records: physical columns differs from the fresh configured schema; a manually reviewed migration is required'
export const referenceChange: Change[] = [{ kind: 'add_relation', entity: 'records', name: 'parent', field: 'parent_id', target: 'records' }]
export function rebuildFixture(v3: boolean) {
  const raw = defineConfig({ id: 'blocked_fixture', interactive: false, languages: ['en'], roles: ['owner'], organizationOwnerRole: 'owner',
    entities: { records: defineEntity({ fields: { name: { type: 'string' } }, access: { owner: 'deny' }, displayField: 'name' }) },
    access: defineAccess({ predicates: {}, entities: Object.fromEntries(accessEntities.map(entity => [entity, { owner: 'deny' }])),
      roles: { owner: { system: Object.fromEntries(accessSystemActions.map(action => [action, 'deny'])) } } }),
  })
  const config = v3 ? bindSchemaLock(raw, schemaLock(raw)) : defineInstance({ id: 'blocked_fixture', revision: 1, interactive: false,
    roles: ['owner'], entities: { records: { fields: { name: { type: 'string' } } } }, permissions: {} })
  // The nullable column is absent from config. Adding an optional self-reference
  // must trip the real generated rebuild guard before any data can be rebuilt.
  const sql = initialSchema(config) + '\nALTER TABLE records ADD COLUMN unexpected_nullable TEXT;'
  return { config, migrations: [{ name: v3 ? '0001_r1.sql' : '0001_initial.sql', sql }], indexes: [], fingerprint: '', guards: {} }
}
