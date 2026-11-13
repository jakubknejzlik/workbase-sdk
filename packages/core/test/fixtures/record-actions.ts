import { z } from 'zod'
import { defineCommand } from '../../src/commands'
import { defineAccess, defineConfig, defineEntity, accountLink, accessEntities, accessSystemActions } from '../../src/schema'
import { identity } from '@workbasehq/plugins/identity'
import { localAuth } from '@workbasehq/plugins/local-auth'
import { legacyPermissions } from '@workbasehq/plugins/permissions'
import type { WorkbasePlugin } from '../../src/kernel/plugin'

const all = { read: 'allow', create: 'allow', update: 'allow', delete: 'allow' } as const
export const closeRecord = defineCommand({
  name: 'record/close', permission: { entity: 'record', operation: 'update' }, input: z.strictObject({ id: z.string() }),
  plan: (_ctx, { id }) => ({ rules: [{ name: 'close', statements: [{ sql: 'UPDATE record SET state=?,version=version+1 WHERE id=?', bindings: ['closed', id], expectRows: 1 }] }],
    event: { entity: 'record', entityId: id, operation: 'record.closed' }, result: { status: 200, body: { ok: true } } }),
})
export function actionFixture(actions: any = {
  close: { command: 'record/close', available: [{ when: { use: 'open' }, reason: 'record.closed' }] },
  secret: { command: 'record/close', available: [{ when: { secret: { eq: 'yes' } }, reason: 'record.secret' }] },
  ordered: { command: 'record/close', available: [{ when: { state: { ne: null } }, reason: 'record.missing' }, { when: { use: 'open' }, reason: 'record.closed' }] },
}, commands = [closeRecord], declared = commands.map(command => command.name)) {
  const server: WorkbasePlugin = { name: 'record-fixture', version: '1.0.0', commands }
  return defineConfig({ id: 'record_test', revision: 1, roles: ['admin', 'staff', 'viewer'], organizationOwnerRole: 'admin', languages: ['en'],
    plugins: [identity, localAuth, legacyPermissions, server], interactive: false, commands: declared,
    entities: {
      worker: defineEntity({ fields: { name: { type: 'text' } }, access: { admin: all, staff: all, viewer: all } }),
      record: defineEntity({ displayField: 'state', fields: { state: { type: 'text' }, secret: { type: 'text' }, user: accountLink() }, actions,
        access: { admin: all, staff: { ...all, read: { where: { user: { eq: '$actor.id' } }, fields: ['id', 'state', 'version'] }, update: { where: { state: { ne: 'locked' } } } }, viewer: { ...all, update: 'deny' } } }),
    },
    access: defineAccess({ predicates: { open: { state: { eq: 'open' } } },
      roles: Object.fromEntries(['admin', 'staff', 'viewer'].map(role => [role, { system: Object.fromEntries(accessSystemActions.map(action => [action, 'deny'])) }])),
      entities: Object.fromEntries(accessEntities.map(entity => [entity, { admin: all, staff: all, viewer: all }])),
    }),
  })
}
export default actionFixture()
