import { defineInstance, type ListInput } from '@workbasehq/core/config'
import { identity } from '@workbasehq/plugins/identity'
import { localAuth } from '@workbasehq/plugins/local-auth'
import { legacyPermissions } from '@workbasehq/plugins/permissions'
import { members } from '@workbasehq/plugins/members'
import { consoleUI } from '@workbasehq/plugins/console'

/** Synthetic Workers directory. Run with Bun to execute the shipped validators. */
export const workerList = {
  columns: [
    { field: 'name', secondary: 'code' }, 'team_id', 'location_id', 'phone',
    { field: 'status', cell: { kind: 'badge', tones: { active: 'positive', inactive: 'neutral' } } },
    { field: 'created_at', cell: { kind: 'date' }, defaultVisible: false },
  ],
  filter: {
    team_id: { kind: 'relation', placement: 'toolbar' },
    location_id: { kind: 'relation', placement: 'panel' },
    status: { placement: 'panel' },
    created_at: { kind: 'date', placement: 'panel', operators: ['gte'], label: 'Created since' },
  },
  rowAccess: { column: true, placement: 'panel' },
  views: [
    { id: 'all', label: 'All workers', where: {}, default: true },
    { id: 'active', label: 'Active', where: { status: { eq: 'active' } } },
    { id: 'inactive', label: 'Inactive', where: { status: { eq: 'inactive' } } },
    { id: 'invited', label: 'Pending access', rowAccess: 'invited' },
  ],
  search: ['name', 'code'], defaultSort: { key: 'name', direction: 'asc' }, pageSize: 30,
} satisfies ListInput

const entities = {
  workers: { fields: {
    name: { type: 'string' as const, required: true },
    code: { type: 'string' as const, ui: { format: 'identifier' as const } },
    team_id: { type: 'ref' as const, entity: 'teams' },
    location_id: { type: 'ref' as const, entity: 'locations' },
    phone: { type: 'string' as const },
    status: { type: 'enum' as const, values: ['active', 'inactive'] },
    user: { type: 'ref' as const, entity: 'users', userLink: true },
  }, relations: { account: { field: 'user', entity: 'users' } } },
  teams: { fields: { name: { type: 'string' as const } } },
  locations: { fields: { name: { type: 'string' as const } } },
  users: { fields: { name: { type: 'string' as const } } },
}

// Row access is opt-in and requires the account link, members provider,
// entity create grant and invitations.read. No consumer or database is changed.
export default defineInstance({
  id: 'workers_example', revision: 1, roles: ['owner'], interactive: true,
  account: { entity: 'users' },
  plugins: [identity, localAuth, legacyPermissions, members, consoleUI()],
  entities,
  permissions: { owner: { '*': ['read', 'create'] } },
  policies: Object.fromEntries(Object.keys(entities).map(entity => [entity, { owner: 'all' as const }])),
  organizationPermissions: { owner: ['invitations.read', 'invitations.create'] },
  ui: { entities: { workers: { list: workerList } } },
})
