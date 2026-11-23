import { defineAccess, defineConfig, bindSchemaLock, defineEntity, accountLink, accessEntities, accessSystemActions } from '../../../core/src/schema'
import { schemaLock } from '../../../core/src/migrations/schema-lock'
import { identity } from '@workbasehq/plugins/identity'
import { localAuth } from '@workbasehq/plugins/local-auth'
import { legacyPermissions } from '@workbasehq/plugins/permissions'
import { createOrganizations } from '@workbasehq/plugins/organizations'
import { members } from '@workbasehq/plugins/members'
import { mailOutbox } from '@workbasehq/plugins/mail-outbox'
import { consoleUI } from '@workbasehq/plugins/console'
const all = { read: 'allow', create: 'allow', update: 'allow', delete: 'allow' } as const
const config = defineConfig({ id: 'list_v2_acceptance', roles: ['admin', 'staff', 'member'], organizationOwnerRole: 'admin', languages: ['en'], interactive: true,
  plugins: [identity, localAuth, legacyPermissions, members, createOrganizations(), mailOutbox(), consoleUI()],
  entities: {
    worker: defineEntity({ displayField: 'name', fields: { name: { type: 'string', required: true }, code: { type: 'string' }, status: { type: 'enum', values: ['active', 'inactive', 'archived'] }, team_id: { type: 'ref', entity: 'team' }, user: accountLink() }, access: { admin: all, member: 'deny', staff: { read: { where: { user: { eq: '$actor.id' } } }, create: 'deny', update: 'deny', delete: 'deny' } } }),
    team: defineEntity({ displayField: 'name', fields: { name: { type: 'string', required: true } }, access: { admin: all, member: 'deny', staff: { read: { where: { id: { eq: 'south' } } }, create: 'deny', update: 'deny', delete: 'deny' } } }),
  },
  access: defineAccess({ accountLinks: { worker: { invitationRole: 'staff' } }, predicates: {}, roles: Object.fromEntries(['admin', 'staff', 'member'].map(role => [role, { system: Object.fromEntries(accessSystemActions.map(action => [action, role === 'admin' || action === 'invitations.accept' ? 'allow' : 'deny'])) }])), entities: Object.fromEntries(accessEntities.map(entity => [entity, { admin: all, staff: 'deny', member: 'deny' }])) }),
  ui: { entities: { worker: { list: {
    columns: ['name', 'code', 'team_id', 'status', { field: 'created_at', defaultVisible: false }],
    filter: { code: false, created_at: false, team_id: { kind: 'relation', placement: 'toolbar', label: 'Team' }, status: { placement: 'panel', label: 'Status' }, name: { kind: 'text', placement: 'panel', label: 'Name' } },
    rowAccess: { column: true, placement: 'panel' }, search: ['name', 'code'], defaultSort: { key: 'name', direction: 'asc' }, pageSize: 10,
    views: [{ id: 'all', label: 'All workers', where: {}, default: true }, { id: 'active', label: 'Active workers', where: { status: { eq: 'active' } } }, { id: 'inactive', label: 'Inactive workers', where: { status: { eq: 'inactive' } } }, { id: 'empty', label: 'Archived workers', where: { status: { eq: 'archived' } } }, { id: 'invited', label: 'Pending invitations', where: {}, rowAccess: 'invited' }],
  } } } },
})
export const listV2Config = bindSchemaLock(config, schemaLock(config))
