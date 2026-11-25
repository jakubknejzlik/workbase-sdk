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
const config = defineConfig({ id: 'list_v2_acceptance', roles: ['admin', 'staff', 'member'], organizationOwnerRole: 'admin', languages: ['en', 'cs'], timeZone: 'UTC', interactive: true,
  plugins: [identity, localAuth, legacyPermissions, members, createOrganizations(), mailOutbox(), consoleUI()],
  entities: {
    worker: defineEntity({ displayField: 'name', fields: { name: { type: 'string', required: true }, code: { type: 'string' }, status: { type: 'enum', values: ['active', 'inactive', 'archived', 'pending'] }, team_id: { type: 'ref', entity: 'team' }, amount: { type: 'int' }, due_on: { type: 'datetime' }, approved: { type: 'bool' }, description: { type: 'string' }, user: accountLink() }, access: { admin: all, member: 'deny', staff: { read: { where: { user: { eq: '$actor.id' } } }, create: 'deny', update: 'deny', delete: 'deny' } } }),
    team: defineEntity({ displayField: 'name', fields: { name: { type: 'string', required: true } }, access: { admin: all, member: 'deny', staff: { read: { where: { id: { eq: 'south' } } }, create: 'deny', update: 'deny', delete: 'deny' } } }),
  },
  access: defineAccess({ accountLinks: { worker: { invitationRole: 'staff' } }, predicates: {}, roles: Object.fromEntries(['admin', 'staff', 'member'].map(role => [role, { system: Object.fromEntries(accessSystemActions.map(action => [action, role === 'admin' || action === 'invitations.accept' ? 'allow' : 'deny'])) }])), entities: Object.fromEntries(accessEntities.map(entity => [entity, { admin: all, staff: 'deny', member: 'deny' }])) }),
  ui: { entities: { worker: { list: {
    columns: ['name', 'code', 'team_id', { field: 'status', cell: { kind: 'badge', tones: { active: 'positive', inactive: 'neutral', archived: 'negative', pending: 'warning' } } }, { field: 'amount', cell: { kind: 'number' } }, { field: 'due_on', cell: { kind: 'date' } }, 'approved', 'description', { field: 'created_at', defaultVisible: false }],
    filter: { code: false, created_at: false, team_id: { kind: 'relation', placement: 'toolbar', label: 'Team' }, status: { placement: 'toolbar' }, amount: { kind: 'number', placement: 'panel', label: 'Amount' }, due_on: { kind: 'date', placement: 'panel', label: 'Due date' }, approved: { kind: 'boolean', placement: 'panel' }, description: false, name: { kind: 'text', placement: 'panel', label: 'Name' } },
    rowAccess: { column: true, placement: 'panel' }, search: ['name', 'code'], defaultSort: { key: 'name', direction: 'asc' }, pageSize: 10,
    views: [{ id: 'all', label: 'All workers', where: {}, default: true }, { id: 'active', label: 'Active workers', where: { status: { eq: 'active' } } }, { id: 'inactive', label: 'Inactive workers', where: { status: { eq: 'inactive' } } }, { id: 'empty', label: 'Empty workers', where: { code: { eq: 'EMPTY' } } }, { id: 'invited', label: 'Pending invitations', where: {}, rowAccess: 'invited' }],
  } } } },
})
// The normalized runtime config accepts the same dictionaries loaded by the SDK.
// Contextual field keys are projected by console-model according to field grants.
config.enumLabels = {
  en: {
    field_status_worker: 'Status of the worker across all current organizational assignments',
    field_approved_worker: 'Approved for participation in the upcoming organizational planning period',
    field_created_at_worker: 'Created at the original registration date and time in this organization',
  },
  cs: {
    field_status_worker: 'Stav pracovníka napříč všemi aktuálními organizačními zařazeními a přidělenými činnostmi',
    field_approved_worker: 'Schválení účasti pracovníka v nadcházejícím období organizačního plánování a přidělování činností',
    field_created_at_worker: 'Datum a přesný čas původního vytvoření záznamu pracovníka v této organizační jednotce',
  },
}
export const listV2Config = bindSchemaLock(config, schemaLock(config))
