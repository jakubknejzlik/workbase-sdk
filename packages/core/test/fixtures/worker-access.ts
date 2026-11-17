import { defineAccess, defineConfig, bindSchemaLock, defineEntity, accountLink, accessEntities, accessSystemActions } from '../../src/schema'
import { schemaLock } from '../../src/migrations/schema-lock'
import { identity } from '@workbasehq/plugins/identity'
import { localAuth } from '@workbasehq/plugins/local-auth'
import { legacyPermissions } from '@workbasehq/plugins/permissions'
import { createOrganizations } from '@workbasehq/plugins/organizations'
import { members } from '@workbasehq/plugins/members'
import { mailOutbox } from '@workbasehq/plugins/mail-outbox'

const all = { read: 'allow', create: 'allow', update: 'allow', delete: 'allow' } as const
export function workerAccessFixture(invitationRole = 'staff', staffRead = true, authoredActions?: any) {
  const config = defineConfig({ id: 'worker_access', roles: ['admin', 'staff'], organizationOwnerRole: 'admin', languages: ['en'],
    plugins: [identity, localAuth, legacyPermissions, members, createOrganizations(), mailOutbox()], interactive: false,
    entities: { worker: defineEntity({ fields: { name: { type: 'text', required: true }, user: accountLink() }, actions: authoredActions,
      access: { admin: all, staff: { read: staffRead ? { where: { user: { eq: '$actor.id' } } } : 'deny', create: 'deny', update: 'deny', delete: 'deny' } },
    }) },
    access: defineAccess({ accountLinks: { worker: { invitationRole } }, predicates: {},
      roles: Object.fromEntries(['admin', 'staff'].map(role => [role, { system: Object.fromEntries(accessSystemActions.map(action => [action, role === 'admin' || action === 'invitations.accept' ? 'allow' : 'deny'])) }])),
      entities: Object.fromEntries(accessEntities.map(entity => [entity, { admin: all, staff: entity === 'invitations' ? { read: 'deny', create: 'allow', update: 'deny', delete: 'deny' } : 'deny' }])),
    }),
  })
  return bindSchemaLock(config, schemaLock(config))
}
export default workerAccessFixture()
